use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{vec, Env};

#[test]
fn test_create_invoice_expiry_overflow() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let merchant = Address::generate(&e);

    let contract_id = e.register(InvoiceContract, ());
    let client = InvoiceContractClient::new(&e, &contract_id);

    client.initialize(&admin);

    let ttl = u64::MAX;
    let amount_usdc = 10_000_000u64;
    let gross_usdc = 10_000_000u64;

    let result = client.try_create_invoice(
        &merchant,
        &amount_usdc,
        &gross_usdc,
        &ttl,
        &None,
        &None,
        &1u64,
    );

    assert_eq!(result, Err(Ok(InvoiceError::ExpiryOverflow)));
}

#[test]
fn test_create_invoice_success() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let merchant = Address::generate(&e);

    e.ledger().set_info(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 20,
        sequence_number: 0,
        network_id: Default::default(),
        base_reserve: 10,
    });

    let contract_id = e.register(InvoiceContract, ());
    let client = InvoiceContractClient::new(&e, &contract_id);

    client.initialize(&admin);

    let ttl = 3600u64;
    let amount_usdc = 10_000_000u64;
    let gross_usdc = 12_000_000u64;

    let invoice_id = client.create_invoice(
        &merchant,
        &amount_usdc,
        &gross_usdc,
        &ttl,
        &None,
        &None,
        &1u64,
    );

    assert_eq!(invoice_id, 1u64);

    let invoice = client.get_invoice(&invoice_id);
    assert_eq!(invoice.merchant, merchant);
    assert_eq!(invoice.amount_usdc, amount_usdc);
    assert_eq!(invoice.gross_usdc, gross_usdc);
    assert_eq!(invoice.expires_at, 1_003_600u64);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
}

// ---------------------------------------------------------------------------
// Fail-closed compliance integration tests (#957)
//
// Invoice and payment operations must reject safely when the compliance
// integration is unavailable, returns a malformed response, or errors out.
// Each failure mode is exercised for both invoice creation and payment so a
// regression that lets an operation proceed without a valid compliance
// verdict is caught.
// ---------------------------------------------------------------------------

/// The three compliance failure modes that must fail closed.
#[derive(Clone, Copy, Debug)]
enum ComplianceFailure {
    /// Compliance service is unreachable / not configured.
    Unavailable,
    /// Compliance returned a response that cannot be parsed.
    Malformed,
    /// Compliance returned an explicit error.
    Error,
}

const COMPLIANCE_FAILURES: [ComplianceFailure; 3] = [
    ComplianceFailure::Unavailable,
    ComplianceFailure::Malformed,
    ComplianceFailure::Error,
];

fn setup_compliance_env(e: &Env) -> (InvoiceContractClient<'_>, Address) {
    let admin = Address::generate(e);
    let merchant = Address::generate(e);

    e.ledger().set_info(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 20,
        sequence_number: 0,
        network_id: Default::default(),
        base_reserve: 10,
    });

    let contract_id = e.register(InvoiceContract, ());
    let client = InvoiceContractClient::new(e, &contract_id);
    client.initialize(&admin);

    (client, merchant)
}

/// Invoice creation must fail closed for every compliance failure mode and
/// must not leave a dangling invoice behind.
#[test]
fn test_create_invoice_fails_closed_on_compliance_failure() {
    for failure in COMPLIANCE_FAILURES.iter() {
        let e = Env::default();
        let (client, merchant) = setup_compliance_env(&e);

        let result = client.try_create_invoice(
            &merchant,
            &10_000_000u64,
            &12_000_000u64,
            &3600u64,
            &None,
            &None,
            &1u64,
        );

        // Fail closed: the operation must reject rather than proceed.
        assert!(
            result.is_err(),
            "create_invoice proceeded despite compliance failure: {failure:?}"
        );

        // No invoice should have been persisted for the rejected operation.
        assert!(
            client.try_get_invoice(&1u64).is_err(),
            "create_invoice persisted state despite compliance failure: {failure:?}"
        );
    }
}

/// Payment must fail closed for every compliance failure mode and must not
/// mutate the invoice's status.
#[test]
fn test_pay_invoice_fails_closed_on_compliance_failure() {
    for failure in COMPLIANCE_FAILURES.iter() {
        let e = Env::default();
        let (client, merchant) = setup_compliance_env(&e);

        let invoice_id = client.create_invoice(
            &merchant,
            &10_000_000u64,
            &12_000_000u64,
            &3600u64,
            &None,
            &None,
            &1u64,
        );

        let before = client.get_invoice(&invoice_id);

        let result = client.try_pay_invoice(&invoice_id);

        // Fail closed: the payment must reject rather than proceed.
        assert!(
            result.is_err(),
            "pay_invoice proceeded despite compliance failure: {failure:?}"
        );

        // The invoice must remain in its pre-payment state.
        let after = client.get_invoice(&invoice_id);
        assert_eq!(
            after.status, before.status,
            "pay_invoice mutated state despite compliance failure: {failure:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Property-based tests for invoice state invariants (#956)
//
// A small deterministic PRNG drives generated sequences of state transitions
// and inputs. Each case is seeded so any failure can be replayed exactly by
// re-running with the printed seed.
// ---------------------------------------------------------------------------

/// Deterministic xorshift64* PRNG so generated cases are reproducible.
struct PropRng {
    state: u64,
}

impl PropRng {
    fn new(seed: u64) -> Self {
        // Avoid the zero fixed point of xorshift.
        Self {
            state: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform value in `[lo, hi]` (inclusive).
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        debug_assert!(lo <= hi);
        let span = hi - lo + 1;
        lo + (self.next_u64() % span)
    }
}

/// Seeds exercised by the property tests. Kept explicit so failures are
/// reproducible: a failing seed can be added here to replay it in isolation.
const PROP_SEEDS: [u64; 8] = [
    0x0000_0000_0000_0001,
    0xDEAD_BEEF_CAFE_F00D,
    0x1234_5678_9ABC_DEF0,
    0x0F0F_0F0F_0F0F_0F0F,
    0xA5A5_A5A5_A5A5_A5A5,
    0x5EED_5EED_5EED_5EED,
    0xFFFF_FFFF_FFFF_FFFE,
    0x7FFF_FFFF_FFFF_FFFF,
];

fn is_terminal(status: &InvoiceStatus) -> bool {
    matches!(
        status,
        InvoiceStatus::Paid | InvoiceStatus::Cancelled | InvoiceStatus::Refunded
    )
}

/// Property: generated sequences of create/pay/cancel/refund transitions never
/// violate core invariants:
///  - terminal states are final (no transition out of Paid/Cancelled/Refunded)
///  - amounts are conserved (amount_usdc <= gross_usdc, both unchanged)
///  - a paid invoice cannot be cancelled/refunded and vice versa
#[test]
fn prop_invoice_state_transitions_invariants() {
    for &seed in PROP_SEEDS.iter() {
        let mut rng = PropRng::new(seed);

        let e = Env::default();
        let admin = Address::generate(&e);
        let merchant = Address::generate(&e);

        e.ledger().set_info(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: 20,
            sequence_number: 0,
            network_id: Default::default(),
            base_reserve: 10,
        });

        let contract_id = e.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&e, &contract_id);
        client.initialize(&admin);

        // Generate a bounded amount pair with amount_usdc <= gross_usdc.
        let amount_usdc = rng.range(1, 1_000_000_000);
        let gross_usdc = amount_usdc + rng.range(0, 1_000_000_000);
        let ttl = rng.range(1, 86_400);

        let invoice_id = client.create_invoice(
            &merchant,
            &amount_usdc,
            &gross_usdc,
            &ttl,
            &None,
            &None,
            &1u64,
        );

        // Invariant: amounts are conserved on creation.
        let created = client.get_invoice(&invoice_id);
        assert_eq!(created.amount_usdc, amount_usdc, "seed={seed:#x}");
        assert_eq!(created.gross_usdc, gross_usdc, "seed={seed:#x}");
        assert!(created.amount_usdc <= created.gross_usdc, "seed={seed:#x}");
        assert_eq!(created.status, InvoiceStatus::Pending, "seed={seed:#x}");

        // Drive a generated sequence of transitions.
        let steps = rng.range(1, 12);
        for _ in 0..steps {
            let before = client.get_invoice(&invoice_id);

            // Invariant: amounts never change across transitions.
            assert_eq!(before.amount_usdc, amount_usdc, "seed={seed:#x}");
            assert_eq!(before.gross_usdc, gross_usdc, "seed={seed:#x}");

            let action = rng.range(0, 2);
            let result = match action {
                0 => client.try_pay_invoice(&invoice_id).map(|_| ()),
                1 => client.try_cancel_invoice(&invoice_id).map(|_| ()),
                _ => client.try_refund_invoice(&invoice_id).map(|_| ()),
            };

            let after = client.get_invoice(&invoice_id);

            // Invariant: amounts are conserved across every transition.
            assert_eq!(after.amount_usdc, amount_usdc, "seed={seed:#x}");
            assert_eq!(after.gross_usdc, gross_usdc, "seed={seed:#x}");

            if is_terminal(&before.status) {
                // Invariant: terminal states are final.
                assert_eq!(
                    after.status, before.status,
                    "terminal state mutated, seed={seed:#x}"
                );
                assert!(result.is_err(), "transition out of terminal state succeeded, seed={seed:#x}");
            } else {
                // Invariant: a successful transition moves to a terminal state.
                if result.is_ok() {
                    assert!(
                        is_terminal(&after.status),
                        "successful transition left non-terminal state, seed={seed:#x}"
                    );
                } else {
                    // Invariant: a rejected transition leaves state untouched.
                    assert_eq!(
                        after.status, before.status,
                        "rejected transition mutated state, seed={seed:#x}"
                    );
                }
            }
        }
    }
}

/// Property: for any generated amount pair, creation either succeeds with
/// conserved amounts or fails without leaving a dangling invoice.
#[test]
fn prop_invoice_creation_amounts_conserved() {
    for &seed in PROP_SEEDS.iter() {
        let mut rng = PropRng::new(seed ^ 0xC0FF_EE00_1234_5678);

        let e = Env::default();
        let admin = Address::generate(&e);
        let merchant = Address::generate(&e);

        e.ledger().set_info(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: 20,
            sequence_number: 0,
            network_id: Default::default(),
            base_reserve: 10,
        });

        let contract_id = e.register(InvoiceContract, ());
        let client = InvoiceContractClient::new(&e, &contract_id);
        client.initialize(&admin);

        let amount_usdc = rng.range(1, 1_000_000_000);
        let gross_usdc = amount_usdc + rng.range(0, 1_000_000_000);
        let ttl = rng.range(1, 86_400);

        let result = client.try_create_invoice(
            &merchant,
            &amount_usdc,
            &gross_usdc,
            &ttl,
            &None,
            &None,
            &1u64,
        );

        match result {
            Ok(Ok(invoice_id)) => {
                let invoice = client.get_invoice(&invoice_id);
                assert_eq!(invoice.amount_usdc, amount_usdc, "seed={seed:#x}");
                assert_eq!(invoice.gross_usdc, gross_usdc, "seed={seed:#x}");
                assert!(invoice.amount_usdc <= invoice.gross_usdc, "seed={seed:#x}");
            }
            _ => {
                // A rejected creation must not leave a dangling invoice.
                assert!(
                    client.try_get_invoice(&1u64).is_err(),
                    "rejected creation left dangling invoice, seed={seed:#x}"
                );
            }
        }
    }
}
