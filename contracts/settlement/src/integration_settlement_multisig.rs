#![cfg(test)]

//! Multi-sig propose/approve integration coverage for the legacy settlement
//! contract, mirroring
//! `COMEBACKHERE-contracts/contracts/treasury/src/integration_settlement_multisig.rs`
//! in the canonical tree (see #31 / CONTRIBUTING.md on keeping the two trees
//! in sync).
//!
//! Unlike the canonical treasury contract, this legacy contract has no
//! separate `execute_settlement` entry point: `approve_settlement` returns
//! the accumulated `approval_weight` and `threshold` directly, and a caller
//! reaching quorum (`approval_weight >= threshold`) *is* the execute signal
//! this simpler contract exposes. These tests treat "quorum reached" as the
//! execute step the canonical tests exercise explicitly via
//! `execute_settlement`.

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup_env() -> (Env, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register_contract(None, SettlementContract);
    (e, contract_id)
}

fn make_client<'a>(e: &'a Env, id: &Address) -> SettlementContractClient<'a> {
    SettlementContractClient::new(e, id)
}

#[test]
fn test_multisig_propose_collect_2_of_3_reaches_quorum() {
    let (e, id) = setup_env();
    let c = make_client(&e, &id);

    let signer_a = Address::generate(&e);
    let signer_b = Address::generate(&e);
    let signer_c = Address::generate(&e);
    let merchant = Address::generate(&e);

    c.initialize(
        &soroban_sdk::vec![
            &e,
            (signer_a.clone(), 1u64),
            (signer_b.clone(), 1u64),
            (signer_c.clone(), 1u64),
        ],
        &2u64,
    );

    let sid = c.propose(&signer_a, &merchant, &5_000_000u64);

    let r1 = c.approve_settlement(&signer_a, &sid);
    assert_eq!(r1.approval_weight, 1);
    assert!(
        r1.approval_weight < r1.threshold,
        "quorum should not be reached after 1-of-2 approvals"
    );

    let r2 = c.approve_settlement(&signer_b, &sid);
    assert_eq!(r2.approval_weight, 2);
    assert!(
        r2.approval_weight >= r2.threshold,
        "quorum should be reached after 2-of-2 approvals"
    );
}

#[test]
fn test_single_signer_insufficient_for_threshold_2() {
    let (e, id) = setup_env();
    let c = make_client(&e, &id);

    let signer_a = Address::generate(&e);
    let signer_b = Address::generate(&e);
    let signer_c = Address::generate(&e);
    let merchant = Address::generate(&e);

    c.initialize(
        &soroban_sdk::vec![
            &e,
            (signer_a.clone(), 1u64),
            (signer_b.clone(), 1u64),
            (signer_c.clone(), 1u64),
        ],
        &2u64,
    );

    let sid = c.propose(&signer_a, &merchant, &1_000_000u64);
    let res = c.approve_settlement(&signer_a, &sid);

    assert!(
        res.approval_weight < res.threshold,
        "a single signer must not be able to reach a threshold of 2 alone"
    );
}

#[test]
fn test_weighted_signers_reach_threshold() {
    let (e, id) = setup_env();
    let c = make_client(&e, &id);

    let signer_a = Address::generate(&e);
    let signer_b = Address::generate(&e);
    let signer_c = Address::generate(&e);
    let merchant = Address::generate(&e);

    c.initialize(
        &soroban_sdk::vec![
            &e,
            (signer_a.clone(), 2u64),
            (signer_b.clone(), 1u64),
            (signer_c.clone(), 1u64),
        ],
        &2u64,
    );

    let sid = c.propose(&signer_a, &merchant, &3_000_000u64);
    let res = c.approve_settlement(&signer_a, &sid);

    assert_eq!(res.approval_weight, 2);
    assert!(
        res.approval_weight >= res.threshold,
        "a single signer with weight=2 should meet threshold=2 alone"
    );
}

#[test]
fn test_multiple_settlements_independent_approvals() {
    let (e, id) = setup_env();
    let c = make_client(&e, &id);

    let signer_a = Address::generate(&e);
    let signer_b = Address::generate(&e);
    let merchant = Address::generate(&e);

    c.initialize(
        &soroban_sdk::vec![&e, (signer_a.clone(), 1u64), (signer_b.clone(), 1u64)],
        &2u64,
    );

    let s1 = c.propose(&signer_a, &merchant, &1_000_000u64);
    let s2 = c.propose(&signer_a, &merchant, &2_000_000u64);

    c.approve_settlement(&signer_a, &s1);
    let r1 = c.approve_settlement(&signer_b, &s1);
    assert!(
        r1.approval_weight >= r1.threshold,
        "s1 should reach quorum"
    );

    let r2 = c.approve_settlement(&signer_a, &s2);
    assert!(
        r2.approval_weight < r2.threshold,
        "s2 should still be short of quorum with only one approval"
    );
}

#[test]
fn test_quorum_reached_settlement_can_still_be_cancelled() {
    // The legacy contract has no `execute_settlement` call that flips
    // status to `Executed`; a settlement stays `Pending` (and thus
    // cancellable) even after quorum is reached on-chain. Execution is
    // expected to be driven by an off-chain caller reacting to
    // `ApproveResult`.
    let (e, id) = setup_env();
    let c = make_client(&e, &id);

    let signer_a = Address::generate(&e);
    let signer_b = Address::generate(&e);
    let merchant = Address::generate(&e);

    c.initialize(
        &soroban_sdk::vec![&e, (signer_a.clone(), 1u64), (signer_b.clone(), 1u64)],
        &2u64,
    );

    let sid = c.propose(&signer_a, &merchant, &10_000_000u64);
    c.approve_settlement(&signer_a, &sid);
    let res = c.approve_settlement(&signer_b, &sid);
    assert!(res.approval_weight >= res.threshold);

    c.cancel(&signer_a, &sid);

    let cancel_again = c.try_cancel(&signer_a, &sid);
    assert_eq!(cancel_again, Err(Ok(SettlementError::NotPending)));
}
