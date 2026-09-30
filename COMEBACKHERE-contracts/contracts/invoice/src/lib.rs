#![no_std]

mod events;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, IntoVal, String,
    Symbol, Vec,
};

/// Maximum length, in bytes, allowed for the optional `reference` field on an invoice.
const MAX_REFERENCE_LEN: u32 = 64;

/// Maximum number of invoice IDs accepted by a single batch operation.
const MAX_BATCH_SIZE: u32 = 50;

/// Minimum invoice amount, in stroops (10,000,000 stroops == 1 USDC given 7 decimals).
const MIN_AMOUNT_USDC: i128 = 10_000_000;

/// Maximum grace window allowed: 90 days (7,776,000 seconds).
/// Bounds the delay before escrow can be released so funds cannot be locked indefinitely.
const MAX_GRACE_WINDOW: u64 = 90 * 24 * 60 * 60;

// At five seconds per ledger, these keep state alive for roughly 335 days before
// renewal and extend it to roughly 359 days after an access or mutation.
const INSTANCE_TTL_THRESHOLD: u32 = 5_800_000;
const INSTANCE_TTL_EXTEND_TO: u32 = 6_200_000;
const INVOICE_TTL_THRESHOLD: u32 = 5_800_000;
const INVOICE_TTL_EXTEND_TO: u32 = 6_200_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    Unauthorized = 1,
    ContractPaused = 2,
    AlreadyInitialized = 3,
    InvoiceNotFound = 4,
    InvoiceAlreadyPaid = 5,
    InvoiceExpired = 6,
    InvoiceCancelled = 7,
    NotMerchant = 8,
    NotCustomer = 9,
    RefundNotRequested = 10,
    AlreadyRefundRequested = 11,
    GraceWindowNotExpired = 12,
    DuplicateNonce = 13,
    TreasuryNotConfigured = 14,
    NotAParty = 15,
    Overflow = 16,
    AddressBlocked = 17,
    /// A state-changing call was rejected because the invoice is in a terminal
    /// or refund-related state that does not permit the requested transition
    /// (e.g. `mark_paids` called on an invoice that is `RefundRequested`,
    /// `Released`, `Cancelled`, or `Expired`).
    InvalidStateTransition = 18,
    /// A batch operation was called with more than `MAX_BATCH_SIZE` invoice IDs.
    BatchTooLarge = 19,
    /// The invoice amount is below the minimum (`MIN_AMOUNT_USDC`).
    AmountPrecision = 20,
    /// The `reference` field exceeds `MAX_REFERENCE_LEN` bytes.
    ReferenceTooLong = 21,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Expired,
    Cancelled,
    RefundRequested,
    Released,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invoice {
    pub id: u64,
    pub merchant: Address,
    pub customer: Address,
    pub amount: i128,
    pub token: Address,
    pub status: InvoiceStatus,
    pub created_at: u64,
    pub expires_at: u64,
    /// Optional merchant-supplied reference (e.g. an order or invoice number
    /// from the merchant's own system), capped at `MAX_REFERENCE_LEN` bytes.
    pub reference: Option<String>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Paused,
    Invoice(u64),
    InvoiceCount,
    GraceWindow,
    Nonce(Address, u64),
    TreasuryContract,
    ComplianceContract,
    CustomerInvoices(Address),
}

fn admin(env: &Env) -> Address {
    env.storage().persistent().get(&DataKey::Admin).unwrap()
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn check_not_paused(env: &Env) -> Result<(), ContractError> {
    if is_paused(env) {
        Err(ContractError::ContractPaused)
    } else {
        extend_instance_ttl(env);
        Ok(())
    }
}

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

fn extend_invoice_ttl(env: &Env, invoice_id: u64) {
    env.storage().persistent().extend_ttl(
        &DataKey::Invoice(invoice_id),
        INVOICE_TTL_THRESHOLD,
        INVOICE_TTL_EXTEND_TO,
    );
}

fn extend_customer_invoices_ttl(env: &Env, customer: &Address) {
    env.storage().persistent().extend_ttl(
        &DataKey::CustomerInvoices(customer.clone()),
        INVOICE_TTL_THRESHOLD,
        INVOICE_TTL_EXTEND_TO,
    );
}

fn store_invoice(env: &Env, invoice_id: u64, invoice: &Invoice) {
    env.storage()
        .persistent()
        .set(&DataKey::Invoice(invoice_id), invoice);
    extend_invoice_ttl(env, invoice_id);
}

fn check_admin(env: &Env, addr: &Address) -> Result<(), ContractError> {
    if addr != &admin(env) {
        Err(ContractError::Unauthorized)
    } else {
        Ok(())
    }
}

/// The invoice contract manages the full lifecycle of on-chain invoices:
/// creation, payment, cancellation, refund requests, escrow release, and disputes.
///
/// Disputes are resolved via a cross-contract call to the configured treasury contract.
/// Most mutating operations are guarded by a pause mechanism that only the admin can toggle.
#[contract]
pub struct InvoiceContract;

#[contractimpl]
impl InvoiceContract {
    /// Replaces this contract's Wasm while preserving its address and storage.
    /// The stored admin must authorize the call.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        let contract_admin = admin(&env);
        contract_admin.require_auth();
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        events::upgraded(&env, new_wasm_hash);
        Ok(())
    }

    /// Initiates a two-step admin transfer by recording `new_admin` as the pending
    /// admin. The change does **not** take effect until `accept_admin` is called by
    /// `new_admin`.
    ///
    /// Only the current admin may call this. The contract must not be paused.
    ///
    /// # Parameters
    /// - `caller`: Must be the current admin.
    /// - `new_admin`: The address that will be able to accept admin rights.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the current admin.
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    ///
    /// # Events
    /// Emits `admin_transfer_initiated(caller, new_admin)` on success.
    pub fn transfer_admin(
        env: Env,
        caller: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        caller.require_auth();
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &new_admin);
        events::admin_transfer_initiated(&env, &caller, &new_admin);
        Ok(())
    }

    /// Completes a two-step admin transfer by accepting the pending nomination.
    ///
    /// The caller must be the address previously nominated via `transfer_admin`.
    /// On success the caller becomes the new admin, the old admin loses all
    /// privileges immediately, and the `PendingAdmin` key is cleared.
    ///
    /// The contract must not be paused.
    ///
    /// # Parameters
    /// - `new_admin`: Must be the pending admin address previously set by `transfer_admin`.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `new_admin` does not match the stored
    ///   `PendingAdmin`, or if no transfer has been initiated.
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    ///
    /// # Events
    /// Emits `admin_transfer_accepted(new_admin)` on success.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        new_admin.require_auth();
        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .ok_or(ContractError::Unauthorized)?;
        if new_admin != pending {
            return Err(ContractError::Unauthorized);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Admin, &new_admin);
        env.storage()
            .persistent()
            .remove(&DataKey::PendingAdmin);
        events::admin_transfer_accepted(&env, &new_admin);
        Ok(())
    }

    /// Initialises the contract, setting the admin address and default configuration.
    ///
    /// # Parameters
    /// - `admin`: The address that will have administrative privileges (pause/unpause,
    ///   set grace window, set treasury, etc.).
    ///
    /// # Errors
    /// - [`ContractError::AlreadyInitialized`] if `initialize` has already been called.
    ///
    /// # Storage written
    /// Sets `Admin`, `GraceWindow` (default 86 400 s), `InvoiceCount` (0), and `Paused` (false).
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().persistent().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::GraceWindow, &86400u64);
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &0u64);
        env.storage().persistent().set(&DataKey::Paused, &false);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Creates a new invoice and stores it in persistent storage.
    ///
    /// Requires the merchant to have authorised this call (`merchant.require_auth()`).
    /// The `nonce` is scoped per-merchant, so two different merchants may use the same
    /// nonce value without collision.
    ///
    /// # Parameters
    /// - `merchant`: The address of the invoice creator; must authorise the transaction.
    /// - `customer`: The address of the intended payer.
    /// - `amount`: The invoice amount in the smallest unit of `token`.
    /// - `token`: The Stellar asset contract address used for payment.
    /// - `expires_at`: Absolute ledger timestamp (seconds since Unix epoch) after which
    ///   the invoice can no longer be paid.
    /// - `nonce`: A per-merchant unique value used to prevent duplicate submissions.
    /// - `reference`: An optional merchant-supplied reference (e.g. an order ID from the
    ///   merchant's own system), capped at `MAX_REFERENCE_LEN` (64) bytes.
    ///
    /// # Returns
    /// The newly assigned invoice ID (a `u64` counter starting at 1).
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::AmountPrecision`] if `amount` is below `MIN_AMOUNT_USDC`
    ///   (10,000,000 stroops, i.e. 1 USDC).
    /// - [`ContractError::DuplicateNonce`] if `(merchant, nonce)` has already been used.
    /// - [`ContractError::ReferenceTooLong`] if `reference` exceeds `MAX_REFERENCE_LEN` bytes.
    ///
    /// # Events
    /// Emits `invoice_created(merchant, invoice_id)` on success.
    pub fn create_invoice(
        env: Env,
        merchant: Address,
        customer: Address,
        amount: i128,
        token: Address,
        expires_at: u64,
        nonce: u64,
        reference: Option<String>,
    ) -> Result<u64, ContractError> {
        check_not_paused(&env)?;
        merchant.require_auth();

        if amount < MIN_AMOUNT_USDC {
            return Err(ContractError::AmountPrecision);
        }

        if let Some(ref r) = reference {
            if r.len() > MAX_REFERENCE_LEN {
                return Err(ContractError::ReferenceTooLong);
            }
        }

        let nonce_key = DataKey::Nonce(merchant.clone(), nonce);
        if env.storage().persistent().has(&nonce_key) {
            return Err(ContractError::DuplicateNonce);
        }
        env.storage().persistent().set(&nonce_key, &true);

        // Compliance check: reject if merchant or customer is blocked.
        // Skipped when no compliance contract has been configured so that
        // local dev and existing test setups keep working without change.
        if let Some(compliance_addr) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::ComplianceContract)
        {
            let merchant_allowed: bool = env.invoke_contract(
                &compliance_addr,
                &Symbol::new(&env, "is_allowed"),
                soroban_sdk::vec![&env, merchant.clone().into_val(&env)],
            );
            if !merchant_allowed {
                return Err(ContractError::AddressBlocked);
            }
            let customer_allowed: bool = env.invoke_contract(
                &compliance_addr,
                &Symbol::new(&env, "is_allowed"),
                soroban_sdk::vec![&env, customer.clone().into_val(&env)],
            );
            if !customer_allowed {
                return Err(ContractError::AddressBlocked);
            }
        }

        let mut count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::InvoiceCount)
            .unwrap_or(0);
        count = count.checked_add(1).ok_or(ContractError::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &count);

        let now = env.ledger().timestamp();
        let invoice = Invoice {
            id: count,
            merchant: merchant.clone(),
            customer: customer.clone(),
            amount,
            token,
            status: InvoiceStatus::Pending,
            created_at: now,
            expires_at,
            reference,
        };
        store_invoice(&env, count, &invoice);

        let mut customer_invoices: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::CustomerInvoices(customer.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        customer_invoices.push_back(count);
        env.storage()
            .persistent()
            .set(&DataKey::CustomerInvoices(customer.clone()), &customer_invoices);
        extend_customer_invoices_ttl(&env, &customer);

        events::invoice_created(&env, &merchant, &count);
        Ok(count)
    }

    /// Returns the full [`Invoice`] struct for a given ID.
    ///
    /// # Parameters
    /// - `invoice_id`: The numeric ID returned by `create_invoice`.
    ///
    /// # Errors
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    pub fn get_invoice(env: Env, invoice_id: u64) -> Result<Invoice, ContractError> {
        let invoice = env
            .storage()
            .persistent()
            .get(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        extend_invoice_ttl(&env, invoice_id);
        Ok(invoice)
    }

    /// Returns only the [`InvoiceStatus`] for a given invoice ID, without fetching
    /// the full invoice. Useful for lightweight status polling.
    ///
    /// # Parameters
    /// - `invoice_id`: The numeric invoice ID.
    ///
    /// # Errors
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    pub fn get_invoice_status(env: Env, invoice_id: u64) -> Result<InvoiceStatus, ContractError> {
        let invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        extend_invoice_ttl(&env, invoice_id);
        Ok(invoice.status)
    }

    /// Returns the number of invoices ever created, including cancelled and expired invoices.
    ///
    /// This is a read-only view of the counter used to allocate invoice IDs.
    pub fn get_invoice_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::InvoiceCount)
            .unwrap_or(0)
    }

    /// Returns a paginated list of invoice IDs belonging to a given merchant, most useful
    /// for callers (e.g. the backend indexer) that need to enumerate a merchant's invoices
    /// without tracking IDs off-chain.
    ///
    /// Follows the same pagination shape as [`Self::get_pending_settlements`]-style calls
    /// on the treasury contract: `start_after` is the number of matching invoices to skip,
    /// and `limit` bounds the page size.
    ///
    /// # Parameters
    /// - `merchant`: The merchant address to filter invoices by.
    /// - `start_after`: Number of matching invoices to skip before collecting the page
    ///   (defaults to 0 when `None`).
    /// - `limit`: Maximum number of invoice IDs to return. Capped at 100 regardless of the
    ///   value passed in.
    ///
    /// # Returns
    /// A `Vec<u64>` of invoice IDs belonging to `merchant`, oldest first.
    pub fn get_invoices_by_merchant(
        env: Env,
        merchant: Address,
        start_after: Option<u32>,
        limit: u32,
    ) -> Vec<u64> {
        const MAX_PAGE_SIZE: u32 = 100;
        let cap: u32 = if limit > MAX_PAGE_SIZE {
            MAX_PAGE_SIZE
        } else {
            limit
        };
        let skip: u32 = start_after.unwrap_or(0);

        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::InvoiceCount)
            .unwrap_or(0);

        let mut result: Vec<u64> = Vec::new(&env);
        let mut matched: u32 = 0;
        let mut collected: u32 = 0;

        for id in 1..=count {
            if let Some(invoice) = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
            {
                if invoice.merchant == merchant {
                    if matched >= skip {
                        if collected >= cap {
                            break;
                        }
                        result.push_back(id);
                        collected += 1;
                    }
                    matched += 1;
                }
            }
        }
        result
    }

    /// Returns a paginated list of invoice IDs addressed to a given customer,
    /// enabling payers to inspect their invoice history without scanning all IDs.
    ///
    /// Follows the same pagination shape and caps as [`Self::get_invoices_by_merchant`].
    /// Note: Invoices created before this index was introduced will not appear here.
    ///
    /// # Parameters
    /// - `customer`: The customer address to filter invoices by.
    /// - `start_after`: Number of matching invoices to skip before collecting the page
    ///   (defaults to 0 when `None`).
    /// - `limit`: Maximum number of invoice IDs to return. Capped at 100 regardless of the
    ///   value passed in.
    ///
    /// # Returns
    /// A `Vec<u64>` of invoice IDs addressed to `customer`, oldest first.
    pub fn get_invoices_by_customer(
        env: Env,
        customer: Address,
        start_after: Option<u32>,
        limit: u32,
    ) -> Vec<u64> {
        const MAX_PAGE_SIZE: u32 = 100;
        let cap: u32 = if limit > MAX_PAGE_SIZE {
            MAX_PAGE_SIZE
        } else {
            limit
        };
        let skip: u32 = start_after.unwrap_or(0);

        let list: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::CustomerInvoices(customer.clone()))
            .unwrap_or_else(|| Vec::new(&env));

        if list.is_empty() {
            return Vec::new(&env);
        }

        extend_customer_invoices_ttl(&env, &customer);

        let mut result: Vec<u64> = Vec::new(&env);
        let len = list.len();
        if skip >= len {
            return result;
        }

        let end = if skip.saturating_add(cap) < len {
            skip.saturating_add(cap)
        } else {
            len
        };
        for i in skip..end {
            if let Some(id) = list.get(i) {
                result.push_back(id);
            }
        }
        result
    }

    /// Marks a batch of invoices as [`InvoiceStatus::Paid`] in a single transaction.
    ///
    /// Each invoice in the batch must be in `Pending` status and must not have expired.
    /// Processing stops and returns an error on the first failure — no partial updates
    /// are committed when an error is returned.
    ///
    /// # Parameters
    /// - `invoice_ids`: A vector of invoice IDs to mark as paid.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if any ID in the batch does not exist.
    /// - [`ContractError::BatchTooLarge`] if `invoice_ids` has more than `MAX_BATCH_SIZE` IDs.
    /// - [`ContractError::InvalidStateTransition`] if any invoice is `RefundRequested`,
    ///   `Released`, `Cancelled`, or `Expired` — a payment confirmation must never
    ///   silently override a refund already in progress or a closed invoice.
    /// - [`ContractError::InvoiceAlreadyPaid`] if any invoice is already `Paid`.
    /// - [`ContractError::InvoiceExpired`] if any invoice's `expires_at` has passed.
    ///
    /// # Events
    /// Emits `invoice_paid(invoice_id)` for each successfully marked invoice.
    pub fn mark_paids(env: Env, invoice_ids: Vec<u64>) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        if invoice_ids.len() > MAX_BATCH_SIZE {
            return Err(ContractError::BatchTooLarge);
        }

        // Resolve compliance contract once; if set, every invoice
        // customer must be allowed.
        let compliance: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::ComplianceContract);

        for id in invoice_ids.iter() {
            let mut invoice = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
                .ok_or(ContractError::InvoiceNotFound)?;
            // Terminal and refund-related states must never be silently
            // overridden by a stale payment confirmation: a payer's refund
            // request (or an already-settled/cancelled/expired invoice) is
            // rejected with a distinct error rather than falling through to
            // the generic "already paid" case below.
            if matches!(
                invoice.status,
                InvoiceStatus::RefundRequested
                    | InvoiceStatus::Released
                    | InvoiceStatus::Cancelled
                    | InvoiceStatus::Expired
            ) {
                return Err(ContractError::InvalidStateTransition);
            }
            if invoice.status != InvoiceStatus::Pending {
                return Err(ContractError::InvoiceAlreadyPaid);
            }
            if env.ledger().timestamp() >= invoice.expires_at {
                return Err(ContractError::InvoiceExpired);
            }

            // Compliance check: reject if customer or merchant is blocked.
            if let Some(ref compliance_addr) = compliance {
                let merchant_allowed: bool = env.invoke_contract(
                    compliance_addr,
                    &Symbol::new(&env, "is_allowed"),
                    soroban_sdk::vec![&env, invoice.merchant.clone().into_val(&env)],
                );
                if !merchant_allowed {
                    return Err(ContractError::AddressBlocked);
                }
                let is_allowed: bool = env.invoke_contract(
                    compliance_addr,
                    &Symbol::new(&env, "is_allowed"),
                    soroban_sdk::vec![&env, invoice.customer.clone().into_val(&env)],
                );
                if !is_allowed {
                    return Err(ContractError::AddressBlocked);
                }
            }

            invoice.status = InvoiceStatus::Paid;
            store_invoice(&env, id, &invoice);
            events::invoice_paid(&env, &id);
        }
        Ok(())
    }

    /// Pays a `Pending` invoice on-chain by transferring the invoice amount from
    /// `payer` to the contract itself (held in escrow until `release_escrow` or a
    /// refund).
    ///
    /// This is the on-chain payment path. For backend-confirmed off-chain payments
    /// use [`Self::mark_paids`] instead — both paths emit the same `invoice_paid`
    /// event and apply identical state guards, so the indexer does not need to
    /// distinguish between them.
    ///
    /// The `payer` does not have to be the invoice's `customer` field — any address
    /// may settle an invoice on behalf of the customer. The compliance check (when a
    /// compliance contract is configured) is applied to `payer`, not the stored
    /// `customer`.
    ///
    /// # Parameters
    /// - `payer`: The address funding the payment; must authorise this transaction.
    /// - `invoice_id`: The invoice being paid.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    /// - [`ContractError::InvalidStateTransition`] if the invoice is in
    ///   `RefundRequested`, `Released`, `Cancelled`, or `Expired`.
    /// - [`ContractError::InvoiceAlreadyPaid`] if the invoice is already `Paid`.
    /// - [`ContractError::InvoiceExpired`] if `expires_at` has passed.
    /// - [`ContractError::AddressBlocked`] if a compliance contract is configured and
    ///   `payer` is not allowed.
    ///
    /// # Events
    /// Emits `invoice_paid(invoice_id)` on success.
    pub fn pay_invoice(env: Env, payer: Address, invoice_id: u64) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        payer.require_auth();

        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;

        // Reuse the same state guards as mark_paids so the state machine stays
        // consistent regardless of which payment path was used.
        if matches!(
            invoice.status,
            InvoiceStatus::RefundRequested
                | InvoiceStatus::Released
                | InvoiceStatus::Cancelled
                | InvoiceStatus::Expired
        ) {
            return Err(ContractError::InvalidStateTransition);
        }
        if invoice.status != InvoiceStatus::Pending {
            return Err(ContractError::InvoiceAlreadyPaid);
        }
        if env.ledger().timestamp() >= invoice.expires_at {
            return Err(ContractError::InvoiceExpired);
        }

        // Compliance check — skipped when no compliance contract is configured.
        if let Some(compliance_addr) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::ComplianceContract)
        {
            let is_allowed: bool = env.invoke_contract(
                &compliance_addr,
                &Symbol::new(&env, "is_allowed"),
                soroban_sdk::vec![&env, payer.clone().into_val(&env)],
            );
            if !is_allowed {
                return Err(ContractError::AddressBlocked);
            }
        }

        // Transfer invoice.amount from payer → this contract (escrow).
        let _: () = env.invoke_contract(
            &invoice.token,
            &Symbol::new(&env, "transfer"),
            soroban_sdk::vec![
                &env,
                payer.into_val(&env),
                env.current_contract_address().into_val(&env),
                invoice.amount.into_val(&env),
            ],
        );

        invoice.status = InvoiceStatus::Paid;
        store_invoice(&env, invoice_id, &invoice);
        events::invoice_paid(&env, &invoice_id);
        Ok(())
    }

    /// Cancels a `Pending` invoice. Either the merchant or the customer may call this.
    ///
    /// # Parameters
    /// - `invoice_id`: The ID of the invoice to cancel.
    /// - `caller`: The address requesting the cancellation; must be the merchant or customer.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    /// - [`ContractError::Unauthorized`] if `caller` is neither the merchant nor the customer.
    /// - [`ContractError::InvoiceCancelled`] if the invoice is not in `Pending` status.
    ///
    /// # Events
    /// Emits `invoice_cancelled(invoice_id)` on success.
    pub fn cancel_invoiced(env: Env, invoice_id: u64, caller: Address) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        caller.require_auth();
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.merchant && caller != invoice.customer {
            return Err(ContractError::Unauthorized);
        }

        match invoice.status {
            // No funds have moved yet — simple cancellation.
            InvoiceStatus::Pending => {
                invoice.status = InvoiceStatus::Cancelled;
                store_invoice(&env, invoice_id, &invoice);
                events::invoice_cancelled(&env, &invoice_id);
                Ok(())
            }
            // Funds are held in escrow. Cancellation initiates the refund path by
            // transitioning to RefundRequested so the release_escrow flow can
            // complete the refund without leaving funds stuck.
            InvoiceStatus::Paid => {
                invoice.status = InvoiceStatus::RefundRequested;
                store_invoice(&env, invoice_id, &invoice);
                events::invoice_refund_req(&env, &invoice_id);
                Ok(())
            }
            // A refund is already in progress — return a descriptive error.
            InvoiceStatus::RefundRequested => Err(ContractError::AlreadyRefundRequested),
            // Terminal states: Expired, Released, Cancelled cannot be cancelled again.
            InvoiceStatus::Expired | InvoiceStatus::Released | InvoiceStatus::Cancelled => {
                Err(ContractError::InvoiceCancelled)
            }
        }
    }

    /// Requests a refund for a `Paid` invoice. Only the customer may call this.
    ///
    /// Transitions the invoice from [`InvoiceStatus::Paid`] to
    /// [`InvoiceStatus::RefundRequested`], which then allows the merchant to call
    /// `release_escrow` once the grace window has elapsed.
    ///
    /// # Parameters
    /// - `invoice_id`: The ID of the invoice to refund.
    /// - `caller`: Must be the invoice's `customer` address.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists or the
    ///   invoice is not in `Paid` status.
    /// - [`ContractError::NotCustomer`] if `caller` is not the invoice customer.
    /// - [`ContractError::AlreadyRefundRequested`] if a refund has already been requested.
    ///
    /// # Events
    /// Emits `invoice_refund_req(invoice_id)` on success.
    pub fn request_refund(
        env: Env,
        invoice_id: u64,
        caller: Address,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.customer {
            return Err(ContractError::NotCustomer);
        }
        if invoice.status != InvoiceStatus::Paid {
            return Err(ContractError::InvoiceNotFound);
        }
        if invoice.status == InvoiceStatus::RefundRequested {
            return Err(ContractError::AlreadyRefundRequested);
        }
        invoice.status = InvoiceStatus::RefundRequested;
        store_invoice(&env, invoice_id, &invoice);
        events::invoice_refund_req(&env, &invoice_id);
        Ok(())
    }

    /// Releases an escrow hold after the refund grace window has expired.
    /// Only the merchant may call this, and only when the invoice is in
    /// [`InvoiceStatus::RefundRequested`].
    ///
    /// The grace window (default 86 400 s) is measured from `invoice.created_at`.
    /// Adjustable by the admin via `set_grace_window`.
    ///
    /// # Parameters
    /// - `invoice_id`: The ID of the invoice whose escrow is to be released.
    /// - `caller`: Must be the invoice's `merchant` address.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with that ID exists.
    /// - [`ContractError::NotMerchant`] if `caller` is not the invoice merchant.
    /// - [`ContractError::RefundNotRequested`] if the invoice is not in `RefundRequested` status.
    /// - [`ContractError::GraceWindowNotExpired`] if the current ledger timestamp is still
    ///   within `created_at + grace_window`.
    ///
    /// # Events
    /// Emits `escrow_released(invoice_id)` on success.
    pub fn release_escrow(
        env: Env,
        invoice_id: u64,
        caller: Address,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.merchant {
            return Err(ContractError::NotMerchant);
        }
        if invoice.status != InvoiceStatus::RefundRequested {
            return Err(ContractError::RefundNotRequested);
        }
        let grace_window: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::GraceWindow)
            .unwrap();
        let release_at = invoice
            .created_at
            .checked_add(grace_window)
            .ok_or(ContractError::Overflow)?;
        if env.ledger().timestamp() < release_at {
            return Err(ContractError::GraceWindowNotExpired);
        }
        invoice.status = InvoiceStatus::Released;
        store_invoice(&env, invoice_id, &invoice);
        events::escrow_released(&env, &invoice_id);
        Ok(())
    }

    /// Expires a batch of `Pending` invoices whose `expires_at` timestamp has passed.
    ///
    /// Invoices that are not `Pending` or have not yet expired are silently skipped,
    /// so this function is safe to call with a broad set of IDs.
    ///
    /// # Parameters
    /// - `invoice_ids`: A vector of invoice IDs to check and potentially expire.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if any ID in the batch does not exist.
    /// - [`ContractError::BatchTooLarge`] if `invoice_ids` has more than `MAX_BATCH_SIZE` IDs.
    ///
    /// # Events
    /// Emits `invoice_expired(invoice_id)` for each invoice that transitions to `Expired`.
    pub fn batch_expire(env: Env, invoice_ids: Vec<u64>) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        if invoice_ids.len() > MAX_BATCH_SIZE {
            return Err(ContractError::BatchTooLarge);
        }
        let now = env.ledger().timestamp();
        for id in invoice_ids.iter() {
            let mut invoice = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
                .ok_or(ContractError::InvoiceNotFound)?;
            if invoice.status == InvoiceStatus::Pending && now >= invoice.expires_at {
                invoice.status = InvoiceStatus::Expired;
                store_invoice(&env, id, &invoice);
                events::invoice_expired(&env, &id);
            }
        }
        Ok(())
    }

    /// Configure the treasury contract address (admin only).
    ///
    /// The treasury address is required before `raise_dispute`
    /// can be called. Cross-contract calls to the treasury use this stored address.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    /// - `treasury`: The address of the deployed treasury contract.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    pub fn set_treasury(env: Env, caller: Address, treasury: Address) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::TreasuryContract, &treasury);
        Ok(())
    }

    /// Returns the currently configured treasury contract address, if any.
    ///
    /// Returns `None` if `set_treasury` has not been called yet.
    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::TreasuryContract)
    }

    /// Configures the compliance contract address used to gate invoice creation
    /// and payment. Admin-only. The contract must not be paused.
    ///
    /// When set, `create_invoice` calls `compliance.is_allowed` for both the
    /// merchant and the customer before creating the invoice. `mark_paids` calls
    /// `is_allowed` for both the merchant and the customer before marking each
    /// invoice paid. If either party is blocked the operation returns
    /// [`ContractError::AddressBlocked`].
    ///
    /// Pass `compliance = contract_address` to enable checks. To disable checks
    /// entirely (e.g. for local dev), call `set_compliance` with the zero address
    /// or simply never call it — if the key is absent the checks are skipped.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    /// - `compliance`: The address of the deployed compliance contract.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    pub fn set_compliance(
        env: Env,
        caller: Address,
        compliance: Address,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::ComplianceContract, &compliance);
        Ok(())
    }

    /// Returns the currently configured compliance contract address, if any.
    ///
    /// Returns `None` if `set_compliance` has not been called yet.
    /// When `None`, compliance checks are skipped.
    pub fn get_compliance(env: Env) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::ComplianceContract)
    }

    /// Raises a dispute on an invoice via a cross-contract call to the treasury.
    ///
    /// **Cross-contract call:** invokes `treasury.raise_dispute(claimant, settlement_id, reason)`.
    /// The treasury contract address must have been set via `set_treasury`.
    ///
    /// Requires `claimant` to authorise the call (`claimant.require_auth()`).
    ///
    /// # Parameters
    /// - `invoice_id`: The invoice the dispute relates to; must exist.
    /// - `settlement_id`: The ID of the settlement record in the treasury contract.
    /// - `claimant`: The address raising the dispute; must authorise the transaction.
    /// - `reason`: An opaque reason code interpreted by the treasury contract.
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::InvoiceNotFound`] if no invoice with `invoice_id` exists.
    /// - [`ContractError::TreasuryNotConfigured`] if no treasury address has been set.
    ///
    /// # Events
    /// Emits `dispute_raised(invoice_id, settlement_id, claimant)` on success.
    pub fn raise_dispute(
        env: Env,
        invoice_id: u64,
        settlement_id: u64,
        claimant: Address,
        reason: u32,
    ) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        claimant.require_auth();

        let invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if claimant != invoice.merchant && claimant != invoice.customer {
            return Err(ContractError::NotAParty);
        }

        let treasury: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TreasuryContract)
            .ok_or(ContractError::TreasuryNotConfigured)?;

        // Cross-contract: treasury.raise_dispute(claimant, settlement_id, reason)
        let _: () = env.invoke_contract(
            &treasury,
            &Symbol::new(&env, "raise_dispute"),
            soroban_sdk::vec![
                &env,
                claimant.clone().into_val(&env),
                settlement_id.into_val(&env),
                reason.into_val(&env),
            ],
        );

        events::dispute_raised(&env, &invoice_id, &settlement_id, &claimant);
        Ok(())
    }

    /// Pauses the contract, blocking all mutating operations until `unpause`
    /// is called. Admin-only.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    ///
    /// # Events
    /// Emits `contract_paused()` on success.
    pub fn pause(env: Env, caller: Address) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage().persistent().set(&DataKey::Paused, &true);
        extend_instance_ttl(&env);
        events::contract_paused(&env);
        Ok(())
    }

    /// Unpauses the contract, restoring all mutating operations. Admin-only.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    ///
    /// # Errors
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    ///
    /// # Events
    /// Emits `contract_unpaused()` on success.
    pub fn unpause(env: Env, caller: Address) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage().persistent().set(&DataKey::Paused, &false);
        extend_instance_ttl(&env);
        events::contract_unpaused(&env);
        Ok(())
    }

    /// Sets the grace window duration used by `release_escrow`.
    /// Admin-only. The contract must not be paused.
    ///
    /// # Parameters
    /// - `caller`: Must be the contract admin.
    /// - `window`: Grace window in seconds measured from `invoice.created_at`.
    ///   Defaults to 86 400 (24 h) on initialisation. Capped at [`MAX_GRACE_WINDOW`].
    ///
    /// # Errors
    /// - [`ContractError::ContractPaused`] if the contract is currently paused.
    /// - [`ContractError::Unauthorized`] if `caller` is not the admin.
    /// - [`ContractError::GraceWindowTooLarge`] if `window` exceeds [`MAX_GRACE_WINDOW`].
    ///
    /// # Events
    /// Emits `grace_window_updated(old_window, new_window)` on success.
    pub fn set_grace_window(env: Env, caller: Address, window: u64) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        check_admin(&env, &caller)?;
        if window > MAX_GRACE_WINDOW {
            return Err(ContractError::GraceWindowTooLarge);
        }
        let old_window = env
            .storage()
            .persistent()
            .get(&DataKey::GraceWindow)
            .unwrap_or(86400);
        env.storage()
            .persistent()
            .set(&DataKey::GraceWindow, &window);
        events::grace_window_updated(&env, &old_window, &window);
        Ok(())
    }

    /// Returns the currently configured grace window in seconds.
    ///
    /// Falls back to 86 400 (24 h) if the value has never been written (e.g. before
    /// `initialize` is called).
    pub fn get_grace_window(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::GraceWindow)
            .unwrap_or(86400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Ledger};
    use soroban_sdk::Env;

    fn setup_contract(ts: u64) -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(InvoiceContract, ());
        InvoiceContractClient::new(&env, &contract_id).initialize(&admin);
        env.ledger().with_mut(|li| li.timestamp = ts);
        (env, contract_id, admin)
    }

    #[test]
    fn test_get_invoice_count_tracks_created_invoices() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        assert_eq!(client.get_invoice_count(), 0);
        client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &2, &None);

        assert_eq!(client.get_invoice_count(), 2);
    }

    #[test]
    fn test_create_invoice_with_unique_nonce_succeeds() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id = client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        assert_eq!(invoice_id, 1);
    }

    #[test]
    fn test_invoice_storage_remains_readable_after_many_ledgers() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id = client.create_invoice(
            &merchant,
            &customer,
            &10_000_000i128,
            &token,
            &5000,
            &1,
            &None,
        );

        env.ledger().with_mut(|li| {
            li.sequence_number = INVOICE_TTL_EXTEND_TO - INVOICE_TTL_THRESHOLD + 1;
        });
        assert_eq!(client.get_invoice(&invoice_id).id, invoice_id);
        assert_eq!(client.get_invoice_status(&invoice_id), InvoiceStatus::Pending);
    }

    #[test]
    fn test_create_invoice_with_duplicate_nonce_returns_error() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);

        let result = client.try_create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        assert_eq!(result, Err(Ok(ContractError::DuplicateNonce)));
    }

    #[test]
    fn test_set_grace_window_when_paused_returns_contract_paused() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        client.pause(&admin);
        let res = client.try_set_grace_window(&admin, &3600u64);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn test_different_merchants_can_reuse_same_nonce() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant_a = Address::generate(&env);
        let merchant_b = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        client.create_invoice(&merchant_a, &customer, &10_000_000i128, &token, &5000, &1, &None);
        client.create_invoice(&merchant_b, &customer, &10_000_000i128, &token, &5000, &1, &None);

        let invoice_a = client.get_invoice(&1);
        let invoice_b = client.get_invoice(&2);
        assert_eq!(invoice_a.merchant, merchant_a);
        assert_eq!(invoice_b.merchant, merchant_b);
    }

    #[test]
    fn test_pause_blocks_create_invoice() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);

        let result = client.try_create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn test_create_invoice_near_u64_max_count_returns_overflow() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &u64::MAX);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let result = client.try_create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        assert_eq!(result, Err(Ok(ContractError::Overflow)));
    }

    #[test]
    fn test_release_escrow_overflow_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        env.ledger().with_mut(|li| li.timestamp = u64::MAX - 1);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id = client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        client.mark_paids(&soroban_sdk::vec![&env, invoice_id]);
        client.request_refund(&invoice_id, &customer);
        let result = client.try_release_escrow(&invoice_id, &merchant);
        assert_eq!(result, Err(Ok(ContractError::Overflow)));
    }

    #[test]
    fn test_unpause_restores_create_invoice() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);
        let result = client.try_create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &1, &None);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));

        client.unpause(&admin);
        let invoice_id = client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &5000, &2, &None);
        assert_eq!(invoice_id, 1);
    }

    #[test]
    fn test_pause_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = client.try_pause(&non_admin);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_unpause_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        let contract_id = env.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);

        let result = client.try_unpause(&non_admin);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    // ── raise_dispute integration tests ─────────────────────────────────────

    mod treasury_stub {
        use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

        #[contracterror]
        #[derive(Copy, Clone, Debug, Eq, PartialEq)]
        pub enum StubError {
            Paused = 1,
        }

        #[contracttype]
        pub enum StubKey {
            Held(u64),
        }

        #[contract]
        pub struct TreasuryStub;

        #[contractimpl]
        impl TreasuryStub {
            pub fn raise_dispute(
                e: Env,
                _signer: Address,
                settlement_id: u64,
                _reason: u32,
            ) -> Result<(), StubError> {
                e.storage()
                    .instance()
                    .set(&StubKey::Held(settlement_id), &true);
                Ok(())
            }

            pub fn was_held(e: Env, settlement_id: u64) -> bool {
                e.storage()
                    .instance()
                    .get(&StubKey::Held(settlement_id))
                    .unwrap_or(false)
            }
        }
    }

    use treasury_stub::{TreasuryStub, TreasuryStubClient};

    fn setup_with_treasury(ts: u64) -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let invoice_cid = env.register(InvoiceContract, ());
        let treasury_cid = env.register(TreasuryStub, ());
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        invoice_client.initialize(&admin);
        invoice_client.set_treasury(&admin, &treasury_cid);
        env.ledger().with_mut(|li| li.timestamp = ts);
        let customer = Address::generate(&env);
        (env, invoice_cid, treasury_cid, admin, customer)
    }

    #[test]
    fn test_raise_dispute_places_settlement_on_hold() {
        let (env, invoice_cid, treasury_cid, _admin, _claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let treasury_client = TreasuryStubClient::new(&env, &treasury_cid);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &9999, &1, &None);

        invoice_client.raise_dispute(&invoice_id, &1u64, &merchant, &1u32);

        assert!(
            treasury_client.was_held(&1u64),
            "settlement should be on hold"
        );
    }

    #[test]
    fn test_raise_dispute_emits_event() {
        let (env, invoice_cid, _treasury_cid, _admin, _claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &9999, &1, &None);

        invoice_client.raise_dispute(&invoice_id, &2u64, &merchant, &1u32);

        // invoice_created + dispute_raised = at least 2 events
        let all_events = env.events().all();
        assert!(
            all_events.len() >= 2,
            "dispute_raised event should be emitted"
        );
    }

    #[test]
    fn test_raise_dispute_invoice_not_found_fails() {
        let (env, invoice_cid, _treasury_cid, _admin, claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);

        let result = invoice_client.try_raise_dispute(&999u64, &1u64, &claimant, &1u32);
        assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
    }

    #[test]
    fn test_raise_dispute_without_treasury_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let invoice_cid = env.register(InvoiceContract, ());
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        invoice_client.initialize(&admin);
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let claimant = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &9999, &1, &None);

        let result = invoice_client.try_raise_dispute(&invoice_id, &1u64, &claimant, &1u32);
        assert_eq!(result, Err(Ok(ContractError::TreasuryNotConfigured)));
    }

    #[test]
    fn test_raise_dispute_when_paused_fails() {
        let (env, invoice_cid, _treasury_cid, admin, claimant) = setup_with_treasury(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        let invoice_id =
            invoice_client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &9999, &1, &None);

        invoice_client.pause(&admin);

        let result = invoice_client.try_raise_dispute(&invoice_id, &1u64, &claimant, &1u32);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
    }

    // ── cancellation refund-path tests ───────────────────────────────────────

    fn create_test_invoice(
        client: &InvoiceContractClient,
        env: &Env,
    ) -> (Address, Address, u64) {
        let merchant = Address::generate(env);
        let customer = Address::generate(env);
        let token = Address::generate(env);
        let id = client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &9999, &1, &None);
        (merchant, customer, id)
    }

    /// Cancelling a Pending invoice (no funds moved) succeeds and sets Cancelled.
    /// Both merchant and customer are authorised to cancel.
    #[test]
    fn test_cancel_pending_invoice_no_fund_movement() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &merchant);

        let invoice = client.get_invoice(&id);
        assert_eq!(invoice.status, InvoiceStatus::Cancelled);
    }

    /// Customer can also cancel a Pending invoice.
    #[test]
    fn test_cancel_pending_invoice_by_customer_succeeds() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (_merchant, customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &customer);

        let invoice = client.get_invoice(&id);
        assert_eq!(invoice.status, InvoiceStatus::Cancelled);
    }

    /// Cancelling a Paid invoice initiates the refund path (→ RefundRequested).
    /// Ensures funds are not left stuck with no valid state transition.
    #[test]
    fn test_cancel_paid_invoice_transitions_to_refund_requested() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        // Pay the invoice (funds are now escrowed).
        client.mark_paids(&soroban_sdk::vec![&env, id]);
        let after_pay = client.get_invoice(&id);
        assert_eq!(after_pay.status, InvoiceStatus::Paid);

        // Merchant cancels — must open the refund path, not leave funds stuck.
        client.cancel_invoiced(&id, &merchant);

        let after_cancel = client.get_invoice(&id);
        assert_eq!(
            after_cancel.status,
            InvoiceStatus::RefundRequested,
            "cancelling a paid invoice must initiate the refund path"
        );
    }

    /// Cancelling an invoice where a refund is already in progress returns
    /// AlreadyRefundRequested.
    #[test]
    fn test_cancel_refund_requested_invoice_returns_already_refund_requested() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.mark_paids(&soroban_sdk::vec![&env, id]);
        // First cancel: opens refund path.
        client.cancel_invoiced(&id, &merchant);
        // Second cancel: refund already in progress.
        let res = client.try_cancel_invoiced(&id, &merchant);
        assert_eq!(res, Err(Ok(ContractError::AlreadyRefundRequested)));
    }

    /// Cancelling an already-Cancelled invoice returns InvoiceCancelled (terminal state).
    #[test]
    fn test_cancel_already_cancelled_invoice_returns_invoice_cancelled() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &merchant);
        let res = client.try_cancel_invoiced(&id, &merchant);
        assert_eq!(res, Err(Ok(ContractError::InvoiceCancelled)));
    }

    /// A stranger (neither merchant nor customer) cannot cancel an invoice.
    #[test]
    fn test_cancel_by_stranger_returns_unauthorized() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (_merchant, _customer, id) = create_test_invoice(&client, &env);
        let stranger = Address::generate(&env);

        let res = client.try_cancel_invoiced(&id, &stranger);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    /// Cancelling a non-existent invoice returns InvoiceNotFound.
    #[test]
    fn test_cancel_nonexistent_invoice_returns_not_found() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let caller = Address::generate(&env);

        let res = client.try_cancel_invoiced(&9999u64, &caller);
        assert_eq!(res, Err(Ok(ContractError::InvoiceNotFound)));
    }

    /// Cancelling when the contract is paused returns ContractPaused.
    #[test]
    fn test_cancel_when_paused_returns_contract_paused() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.pause(&admin);
        let res = client.try_cancel_invoiced(&id, &merchant);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    // ── mark_paids terminal/refund-state guard tests ─────────────────────────

    /// A stale mark_paids call must not silently override a refund already
    /// requested by the customer — it should be rejected, not re-marked Paid.
    #[test]
    fn test_mark_paids_on_refund_requested_returns_invalid_state_transition() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (_merchant, customer, id) = create_test_invoice(&client, &env);

        client.mark_paids(&soroban_sdk::vec![&env, id]);
        client.request_refund(&id, &customer);

        let res = client.try_mark_paids(&soroban_sdk::vec![&env, id]);
        assert_eq!(res, Err(Ok(ContractError::InvalidStateTransition)));

        // The refund request must survive the stale confirmation untouched.
        let invoice = client.get_invoice(&id);
        assert_eq!(invoice.status, InvoiceStatus::RefundRequested);
    }

    /// mark_paids on a Released (escrow already released) invoice is rejected.
    #[test]
    fn test_mark_paids_on_released_returns_invalid_state_transition() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, customer, id) = create_test_invoice(&client, &env);

        client.mark_paids(&soroban_sdk::vec![&env, id]);
        client.request_refund(&id, &customer);
        client.set_grace_window(&admin, &0u64);
        client.release_escrow(&id, &merchant);

        let res = client.try_mark_paids(&soroban_sdk::vec![&env, id]);
        assert_eq!(res, Err(Ok(ContractError::InvalidStateTransition)));
    }

    /// mark_paids on a Cancelled invoice is rejected with the same distinct error.
    #[test]
    fn test_mark_paids_on_cancelled_returns_invalid_state_transition() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (merchant, _customer, id) = create_test_invoice(&client, &env);

        client.cancel_invoiced(&id, &merchant);

        let res = client.try_mark_paids(&soroban_sdk::vec![&env, id]);
        assert_eq!(res, Err(Ok(ContractError::InvalidStateTransition)));
    }

    /// mark_paids on an already-Paid invoice still returns the more specific
    /// InvoiceAlreadyPaid error, distinct from the terminal/refund-state guard.
    #[test]
    fn test_mark_paids_on_already_paid_returns_invoice_already_paid() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let (_merchant, _customer, id) = create_test_invoice(&client, &env);

        client.mark_paids(&soroban_sdk::vec![&env, id]);

        let res = client.try_mark_paids(&soroban_sdk::vec![&env, id]);
        assert_eq!(res, Err(Ok(ContractError::InvoiceAlreadyPaid)));
    }

    // ── two-step admin transfer tests ────────────────────────────────────────

    /// Happy path: current admin initiates transfer, new admin accepts.
    /// After acceptance the new admin is effective and the old admin loses privileges.
    #[test]
    fn test_transfer_and_accept_admin_full_flow() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);

        // Step 1: current admin nominates new_admin
        client.transfer_admin(&admin, &new_admin);

        // Step 2: new_admin accepts
        client.accept_admin(&new_admin);

        // new_admin can now exercise admin privileges (e.g. pause)
        client.pause(&new_admin);

        // old admin can no longer pause
        let res = client.try_unpause(&admin);
        assert_eq!(
            res,
            Err(Ok(ContractError::Unauthorized)),
            "old admin must lose privileges immediately after accept_admin"
        );
    }

    /// transfer_admin must reject a caller that is not the current admin.
    #[test]
    fn test_transfer_admin_unauthorized_caller_fails() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let non_admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        let res = client.try_transfer_admin(&non_admin, &new_admin);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    /// accept_admin must reject any address other than the pending admin.
    #[test]
    fn test_accept_admin_wrong_caller_fails() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);

        let res = client.try_accept_admin(&impostor);
        assert_eq!(
            res,
            Err(Ok(ContractError::Unauthorized)),
            "impostor must not be able to accept a pending admin transfer"
        );
    }

    /// accept_admin must return Unauthorized when no transfer is pending.
    #[test]
    fn test_accept_admin_with_no_pending_transfer_fails() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let random = Address::generate(&env);

        let res = client.try_accept_admin(&random);
        assert_eq!(
            res,
            Err(Ok(ContractError::Unauthorized)),
            "accept_admin without a prior transfer_admin must fail"
        );
    }

    /// transfer_admin must fail when the contract is paused.
    #[test]
    fn test_transfer_admin_when_paused_fails() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);

        client.pause(&admin);

        let res = client.try_transfer_admin(&admin, &new_admin);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    /// accept_admin must fail when the contract is paused.
    #[test]
    fn test_accept_admin_when_paused_fails() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        client.pause(&admin);

        let res = client.try_accept_admin(&new_admin);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    /// transfer_admin emits admin_transfer_initiated event.
    #[test]
    fn test_transfer_admin_emits_event() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);

        let all_events = env.events().all();
        assert!(
            all_events
                .iter()
                .any(|ev| ev.0 == (cid.clone(), "admin_transfer_initiated".into())),
            "admin_transfer_initiated event must be emitted"
        );
    }

    /// accept_admin emits admin_transfer_accepted event.
    #[test]
    fn test_accept_admin_emits_event() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        client.accept_admin(&new_admin);

        let all_events = env.events().all();
        assert!(
            all_events
                .iter()
                .any(|ev| ev.0 == (cid.clone(), "admin_transfer_accepted".into())),
            "admin_transfer_accepted event must be emitted"
        );
    }

    /// Pending admin is cleared after acceptance — a second accept_admin call fails.
    #[test]
    fn test_accept_admin_clears_pending_after_acceptance() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        client.accept_admin(&new_admin);

        // PendingAdmin key should be gone; second accept must fail.
        let res = client.try_accept_admin(&new_admin);
        assert_eq!(
            res,
            Err(Ok(ContractError::Unauthorized)),
            "PendingAdmin must be cleared after a successful accept_admin"
        );
    }

    /// The old admin cannot use admin-gated functions after transfer is accepted.
    /// Tests pause, unpause, set_grace_window, and set_treasury.
    #[test]
    fn test_old_admin_loses_all_privileges_after_acceptance() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let new_admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        client.accept_admin(&new_admin);

        assert_eq!(
            client.try_pause(&admin),
            Err(Ok(ContractError::Unauthorized)),
            "old admin must not be able to pause"
        );
        assert_eq!(
            client.try_set_grace_window(&admin, &7200u64),
            Err(Ok(ContractError::Unauthorized)),
            "old admin must not be able to set_grace_window"
        );
        assert_eq!(
            client.try_set_treasury(&admin, &treasury),
            Err(Ok(ContractError::Unauthorized)),
            "old admin must not be able to set_treasury"
        );
    }

    // ── compliance integration tests ─────────────────────────────────────────

    /// A minimal compliance stub: each address is individually allowed or blocked
    /// via in-test storage writes, and `is_allowed` checks that flag.
    mod compliance_stub {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contracttype]
        pub enum StubKey {
            Allowed(Address),
        }

        #[contract]
        pub struct ComplianceStub;

        #[contractimpl]
        impl ComplianceStub {
            pub fn allow(e: Env, addr: Address) {
                e.storage()
                    .instance()
                    .set(&StubKey::Allowed(addr), &true);
            }

            pub fn block(e: Env, addr: Address) {
                e.storage()
                    .instance()
                    .set(&StubKey::Allowed(addr), &false);
            }

            pub fn is_allowed(e: Env, addr: Address) -> bool {
                e.storage()
                    .instance()
                    .get(&StubKey::Allowed(addr))
                    .unwrap_or(false)
            }
        }
    }

    use compliance_stub::{ComplianceStub, ComplianceStubClient};

    /// Helper: register the compliance stub and allow both merchant and customer by default.
    fn setup_with_compliance(
        ts: u64,
    ) -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let invoice_cid = env.register(InvoiceContract, ());
        let compliance_cid = env.register(ComplianceStub, ());

        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        invoice_client.initialize(&admin);
        invoice_client.set_compliance(&admin, &compliance_cid);

        env.ledger().with_mut(|li| li.timestamp = ts);

        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let compliance_client = ComplianceStubClient::new(&env, &compliance_cid);
        // Allow both parties by default so individual tests can selectively block one.
        compliance_client.allow(&merchant);
        compliance_client.allow(&customer);

        (env, invoice_cid, compliance_cid, admin, merchant, customer)
    }

    /// set_compliance must be admin-only.
    #[test]
    fn test_set_compliance_admin_only() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let non_admin = Address::generate(&env);
        let compliance_addr = Address::generate(&env);

        let res = client.try_set_compliance(&non_admin, &compliance_addr);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    /// set_compliance must fail when the contract is paused.
    #[test]
    fn test_set_compliance_when_paused_fails() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let compliance_addr = Address::generate(&env);

        client.pause(&admin);
        let res = client.try_set_compliance(&admin, &compliance_addr);
        assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
    }

    /// get_compliance returns None before set_compliance is called.
    #[test]
    fn test_get_compliance_returns_none_when_not_configured() {
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        assert_eq!(client.get_compliance(), None);
    }

    /// get_compliance returns the address after set_compliance.
    #[test]
    fn test_get_compliance_returns_configured_address() {
        let (env, cid, admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let compliance_addr = Address::generate(&env);

        client.set_compliance(&admin, &compliance_addr);
        assert_eq!(client.get_compliance(), Some(compliance_addr));
    }

    /// A blocked merchant cannot create an invoice.
    #[test]
    fn test_blocked_merchant_cannot_create_invoice() {
        let (env, invoice_cid, compliance_cid, _admin, merchant, customer) =
            setup_with_compliance(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let compliance_client = ComplianceStubClient::new(&env, &compliance_cid);
        let token = Address::generate(&env);

        compliance_client.block(&merchant);

        let res = invoice_client.try_create_invoice(
            &merchant,
            &customer,
            &10_000_000i128,
            &token,
            &9999,
            &1,
            &None,
        );
        assert_eq!(res, Err(Ok(ContractError::AddressBlocked)));
    }

    /// A blocked customer cannot be the payer on a new invoice.
    #[test]
    fn test_blocked_customer_cannot_create_invoice() {
        let (env, invoice_cid, compliance_cid, _admin, merchant, customer) =
            setup_with_compliance(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let compliance_client = ComplianceStubClient::new(&env, &compliance_cid);
        let token = Address::generate(&env);

        compliance_client.block(&customer);

        let res = invoice_client.try_create_invoice(
            &merchant,
            &customer,
            &10_000_000i128,
            &token,
            &9999,
            &1,
            &None,
        );
        assert_eq!(res, Err(Ok(ContractError::AddressBlocked)));
    }

    /// A blocked customer is rejected at mark_paids even if they were allowed at
    /// invoice creation time (e.g. blocked after the invoice was created).
    #[test]
    fn test_blocked_customer_blocked_at_mark_paids() {
        let (env, invoice_cid, compliance_cid, _admin, merchant, customer) =
            setup_with_compliance(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let compliance_client = ComplianceStubClient::new(&env, &compliance_cid);
        let token = Address::generate(&env);

        // Invoice is created while both are allowed.
        let invoice_id = invoice_client.create_invoice(
            &merchant,
            &customer,
            &10_000_000i128,
            &token,
            &9999,
            &1,
            &None,
        );

        // Customer is blocked after creation.
        compliance_client.block(&customer);

        let res = invoice_client.try_mark_paids(&soroban_sdk::vec![&env, invoice_id]);
        assert_eq!(res, Err(Ok(ContractError::AddressBlocked)));

        // Invoice must remain Pending — the block must not leave it in a bad state.
        let invoice = invoice_client.get_invoice(&invoice_id);
        assert_eq!(invoice.status, InvoiceStatus::Pending);
    }

    /// A blocked merchant is rejected at mark_paids even if allowed at creation time.
    #[test]
    fn test_blocked_merchant_blocked_at_mark_paids() {
        let (env, invoice_cid, compliance_cid, _admin, merchant, customer) =
            setup_with_compliance(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let compliance_client = ComplianceStubClient::new(&env, &compliance_cid);
        let token = Address::generate(&env);

        let invoice_id = invoice_client.create_invoice(
            &merchant,
            &customer,
            &10_000_000i128,
            &token,
            &9999,
            &1,
            &None,
        );

        compliance_client.block(&merchant);

        let res = invoice_client.try_mark_paids(&soroban_sdk::vec![&env, invoice_id]);
        assert_eq!(res, Err(Ok(ContractError::AddressBlocked)));

        let invoice = invoice_client.get_invoice(&invoice_id);
        assert_eq!(invoice.status, InvoiceStatus::Pending);
    }

    /// When no compliance contract is configured the checks are skipped entirely —
    /// existing test setups and local dev keep working without any change.
    #[test]
    fn test_no_compliance_contract_skips_checks() {
        // setup_contract does NOT call set_compliance.
        let (env, cid, _admin) = setup_contract(1000);
        let client = InvoiceContractClient::new(&env, &cid);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        // Both create and mark_paids must succeed with no compliance address set.
        let invoice_id =
            client.create_invoice(&merchant, &customer, &10_000_000i128, &token, &9999, &1, &None);
        client.mark_paids(&soroban_sdk::vec![&env, invoice_id]);

        let invoice = client.get_invoice(&invoice_id);
        assert_eq!(invoice.status, InvoiceStatus::Paid);
    }

    /// Allowed merchant and customer pass both checkpoints without error.
    #[test]
    fn test_allowed_parties_can_create_and_pay_invoice() {
        let (env, invoice_cid, _compliance_cid, _admin, merchant, customer) =
            setup_with_compliance(1000);
        let invoice_client = InvoiceContractClient::new(&env, &invoice_cid);
        let token = Address::generate(&env);

        let invoice_id = invoice_client.create_invoice(
            &merchant,
            &customer,
            &10_000_000i128,
            &token,
            &9999,
            &1,
            &None,
        );
        invoice_client.mark_paids(&soroban_sdk::vec![&env, invoice_id]);

        let invoice = invoice_client.get_invoice(&invoice_id);
        assert_eq!(invoice.status, InvoiceStatus::Paid);
    }
}
}