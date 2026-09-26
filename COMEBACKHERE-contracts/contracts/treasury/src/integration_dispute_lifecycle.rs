#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env, IntoVal, Symbol};

fn setup_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TreasuryContract);
    (env, contract_id)
}

fn make_client<'a>(env: &'a Env, id: &Address) -> TreasuryContractClient<'a> {
    TreasuryContractClient::new(env, id)
}

fn create_approved_settlement(
    client: &TreasuryContractClient,
    _env: &Env,
    signer_a: &Address,
    signer_b: &Address,
    token: &Address,
    merchant: &Address,
) -> u64 {
    let settlement_id = client.propose_settlement(signer_a, token, &5_000_000u64, merchant);
    client.approve_settlement(signer_a, &settlement_id);
    client.approve_settlement(signer_b, &settlement_id);
    settlement_id
}

#[test]
fn test_raise_dispute_moves_settlement_to_onhold() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &5_000_000u64, &merchant);

    client.raise_dispute(&merchant, &settlement_id, &1u32);

    let pending = client.get_pending_settlements(&None, &None);
    assert_eq!(
        pending.len(),
        0,
        "disputed settlement should no longer appear in pending list (status is OnHold)"
    );
}

#[test]
fn test_dispute_prevents_execution() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &5_000_000u64, &merchant);
    client.approve_settlement(&signer_a, &settlement_id);
    client.approve_settlement(&signer_b, &settlement_id);

    client.raise_dispute(&merchant, &settlement_id, &1u32);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_settlement(&signer_a, &settlement_id, &token);
    }));
    assert!(
        result.is_err(),
        "execution should fail on a disputed (OnHold) settlement"
    );
}

#[test]
fn test_dispute_on_pending_settlement_status_transition() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let s1 = client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);
    let s2 = client.propose_settlement(&signer_a, &token, &2_000_000u64, &merchant);

    let pending_before = client.get_pending_settlements(&None, &None);
    assert_eq!(pending_before.len(), 2);

    client.raise_dispute(&merchant, &s1, &2u32);

    let pending_after = client.get_pending_settlements(&None, &None);
    assert_eq!(
        pending_after.len(),
        1,
        "only the non-disputed settlement should remain pending"
    );
    assert_eq!(pending_after.get(0).unwrap(), s2);
}

#[test]
fn test_resolve_dispute_callable_by_signer() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let settlement_id = client.propose_settlement(&signer_a, &token, &5_000_000u64, &merchant);

    client.raise_dispute(&merchant, &settlement_id, &1u32);

    client.resolve_dispute(&signer_a, &settlement_id, &true);
    assert_eq!(
        client.get_settlement(&settlement_id).unwrap().status,
        SettlementStatus::Pending
    );

    let events = env.events().all();
    let (_, topics, data) = events.get(events.len() - 1).unwrap();
    assert_eq!(topics.get(0).unwrap(), Symbol::new(&env, "dispute_resolved").into_val(&env));
    assert_eq!(data, (settlement_id, true, 0u64).into_val(&env));
}

#[test]
fn test_resolve_dispute_against_merchant_cancels_settlement() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);
    let admin = Address::generate(&env);
    let signer = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);
    client.initialize(&vec![&env, (signer.clone(), 1u64)], &1u64, &admin);
    let settlement_id = client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);
    client.raise_dispute(&merchant, &settlement_id, &1u32);

    client.resolve_dispute(&signer, &settlement_id, &false);

    assert_eq!(
        client.get_settlement(&settlement_id).unwrap().status,
        SettlementStatus::Cancelled
    );
    let events = env.events().all();
    let (_, _, data) = events.get(events.len() - 1).unwrap();
    assert_eq!(data, (settlement_id, false, 0u64).into_val(&env));
}

#[test]
fn test_resolve_non_disputed_settlement_returns_error() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);
    let admin = Address::generate(&env);
    let signer = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);
    client.initialize(&vec![&env, (signer.clone(), 1u64)], &1u64, &admin);
    let settlement_id = client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);

    assert_eq!(
        client.try_resolve_dispute(&signer, &settlement_id, &true),
        Err(Ok(TreasuryError::NotDisputed))
    );
    assert_eq!(
        client.get_settlement(&settlement_id).unwrap().status,
        SettlementStatus::Pending
    );
}

#[test]
fn test_treasury_version_returns_package_version() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);
    assert_eq!(
        client.version(),
        soroban_sdk::String::from_str(&env, env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn test_multiple_disputes_independent() {
    let (env, contract_id) = setup_env();
    let client = make_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);
    let signer_c = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    let signers = vec![
        &env,
        (signer_a.clone(), 1u64),
        (signer_b.clone(), 1u64),
        (signer_c.clone(), 1u64),
    ];
    client.initialize(&signers, &2u64, &admin);

    let s1 = client.propose_settlement(&signer_a, &token, &1_000_000u64, &merchant);
    let s2 = client.propose_settlement(&signer_a, &token, &2_000_000u64, &merchant);
    let s3 = client.propose_settlement(&signer_a, &token, &3_000_000u64, &merchant);

    client.raise_dispute(&merchant, &s1, &1u32);
    client.raise_dispute(&merchant, &s2, &2u32);

    let pending = client.get_pending_settlements(&None, &None);
    assert_eq!(pending.len(), 1, "only s3 should remain pending");
    assert_eq!(pending.get(0).unwrap(), s3);

    client.resolve_dispute(&signer_a, &s1, &true);
    client.resolve_dispute(&signer_b, &s1, &true);
}
