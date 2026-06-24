#![no_std]

mod events;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

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
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Invoice(u64),
    InvoiceCount,
    GraceWindow,
    Nonce(Address, u64),
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
        Ok(())
    }
}

fn check_admin(env: &Env, addr: &Address) -> Result<(), ContractError> {
    if addr != &admin(env) {
        Err(ContractError::Unauthorized)
    } else {
        Ok(())
    }
}

#[contract]
pub struct InvoiceContract;

#[contractimpl]
impl InvoiceContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().persistent().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::GraceWindow, &86400u64);
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &0u64);
        env.storage()
            .persistent()
            .set(&DataKey::Paused, &false);
        Ok(())
    }

    pub fn create_invoice(
        env: Env,
        merchant: Address,
        customer: Address,
        amount: i128,
        token: Address,
        expires_at: u64,
        nonce: u64,
    ) -> Result<u64, ContractError> {
        check_not_paused(&env)?;
        merchant.require_auth();

        let nonce_key = DataKey::Nonce(merchant.clone(), nonce);
        if env.storage().persistent().has(&nonce_key) {
            return Err(ContractError::DuplicateNonce);
        }
        env.storage()
            .persistent()
            .set(&nonce_key, &true);

        let mut count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::InvoiceCount)
            .unwrap_or(0);
        count += 1;
        env.storage()
            .persistent()
            .set(&DataKey::InvoiceCount, &count);

        let now = env.ledger().timestamp();
        let invoice = Invoice {
            id: count,
            merchant: merchant.clone(),
            customer,
            amount,
            token,
            status: InvoiceStatus::Pending,
            created_at: now,
            expires_at,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(count), &invoice);

        events::invoice_created(&env, &merchant, &count);
        Ok(count)
    }

    pub fn get_invoice(env: Env, invoice_id: u64) -> Result<Invoice, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)
    }

    pub fn get_invoice_status(env: Env, invoice_id: u64) -> Result<InvoiceStatus, ContractError> {
        let invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        Ok(invoice.status)
    }

    pub fn mark_paids(env: Env, invoice_ids: Vec<u64>) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        for id in invoice_ids.iter() {
            let mut invoice = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
                .ok_or(ContractError::InvoiceNotFound)?;
            if invoice.status != InvoiceStatus::Pending {
                return Err(ContractError::InvoiceAlreadyPaid);
            }
            if env.ledger().timestamp() >= invoice.expires_at {
                return Err(ContractError::InvoiceExpired);
            }
            invoice.status = InvoiceStatus::Paid;
            env.storage()
                .persistent()
                .set(&DataKey::Invoice(id), &invoice);
            events::invoice_paid(&env, &id);
        }
        Ok(())
    }

    pub fn cancel_invoiced(env: Env, invoice_id: u64, caller: Address) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let mut invoice = env
            .storage()
            .persistent()
            .get::<DataKey, Invoice>(&DataKey::Invoice(invoice_id))
            .ok_or(ContractError::InvoiceNotFound)?;
        if caller != invoice.merchant && caller != invoice.customer {
            return Err(ContractError::Unauthorized);
        }
        if invoice.status != InvoiceStatus::Pending {
            return Err(ContractError::InvoiceCancelled);
        }
        invoice.status = InvoiceStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        events::invoice_cancelled(&env, &invoice_id);
        Ok(())
    }

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
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        events::invoice_refund_req(&env, &invoice_id);
        Ok(())
    }

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
        if env.ledger().timestamp() < invoice.created_at + grace_window {
            return Err(ContractError::GraceWindowNotExpired);
        }
        invoice.status = InvoiceStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        events::escrow_released(&env, &invoice_id);
        Ok(())
    }

    pub fn batch_expire(env: Env, invoice_ids: Vec<u64>) -> Result<(), ContractError> {
        check_not_paused(&env)?;
        let now = env.ledger().timestamp();
        for id in invoice_ids.iter() {
            let mut invoice = env
                .storage()
                .persistent()
                .get::<DataKey, Invoice>(&DataKey::Invoice(id))
                .ok_or(ContractError::InvoiceNotFound)?;
            if invoice.status == InvoiceStatus::Pending && now >= invoice.expires_at {
                invoice.status = InvoiceStatus::Expired;
                env.storage()
                    .persistent()
                    .set(&DataKey::Invoice(id), &invoice);
                events::invoice_expired(&env, &id);
            }
        }
        Ok(())
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::Paused, &true);
        events::contract_paused(&env);
        Ok(())
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::Paused, &false);
        events::contract_unpaused(&env);
        Ok(())
    }

    pub fn set_grace_window(env: Env, caller: Address, window: u64) -> Result<(), ContractError> {
        check_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::GraceWindow, &window);
        Ok(())
    }

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
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{testutils::Events, vec, Env, IntoVal};

    fn setup_env() -> (Env, Address, Address) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();

        let contract_id = env.register_contract(None, InvoiceContract);
        let client = InvoiceContractClient::new(&env, &contract_id);

        client.initialize(&admin);

        // set ledger time
        env.ledger().set_timestamp(1000);

        (env, merchant, customer, token)
    }

    #[test]
    fn test_create_invoice_with_unique_nonce_succeeds() {
        let (_env, merchant, customer, token) = setup_env();

        // first call with nonce=1 should succeed
        // the env & contract_id are consumed by setup_env, so we need the client
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register_contract(None, InvoiceContract);
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let invoice_id = client.create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(invoice_id, 1);
    }

    #[test]
    fn test_create_invoice_with_duplicate_nonce_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register_contract(None, InvoiceContract);
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        // first call succeeds
        client.create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);

        // second call with same nonce should fail with DuplicateNonce
        let result = client.try_create_invoice(&merchant, &customer, &1000i128, &token, &5000, &1);
        assert_eq!(result, Err(Ok(ContractError::DuplicateNonce)));
    }

    #[test]
    fn test_different_merchants_can_reuse_same_nonce() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let merchant_a = Address::generate(&env);
        let merchant_b = Address::generate(&env);
        let customer = Address::generate(&env);
        let token = Address::generate(&env);
        env.ledger().set_timestamp(1000);

        let contract_id = env.register_contract(None, InvoiceContract);
        let client = InvoiceContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        // both merchants can use nonce=1
        client.create_invoice(&merchant_a, &customer, &1000i128, &token, &5000, &1);
        client.create_invoice(&merchant_b, &customer, &1000i128, &token, &5000, &1);

        let invoice_a = client.get_invoice(&1).unwrap();
        let invoice_b = client.get_invoice(&2).unwrap();
        assert_eq!(invoice_a.merchant, merchant_a);
        assert_eq!(invoice_b.merchant, merchant_b);
    }
}
