#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

const APPROVE_BASELINE: &str = include_str!("../resources/approve_settlement_baseline.json");
const EXECUTE_BASELINE: &str = include_str!("../resources/execute_settlement_baseline.json");

fn assert_cost_within_baseline(baseline_json: &str, cpu: u64, memory: u64) {
    let baseline: serde_json::Value =
        serde_json::from_str(baseline_json).expect("benchmark baseline must be valid JSON");
    let tolerance_percent = baseline["tolerance_percent"]
        .as_u64()
        .expect("benchmark baseline must define tolerance_percent");
    let cpu_limit = baseline["cpu_instructions"]
        .as_u64()
        .expect("benchmark baseline must define cpu_instructions")
        .saturating_mul(100 + tolerance_percent)
        / 100;
    let memory_limit = baseline["memory_bytes"]
        .as_u64()
        .expect("benchmark baseline must define memory_bytes")
        .saturating_mul(100 + tolerance_percent)
        / 100;

    assert!(cpu <= cpu_limit, "CPU instructions ({cpu}) exceeded baseline tolerance ({cpu_limit})");
    assert!(
        memory <= memory_limit,
        "Memory bytes ({memory}) exceeded baseline tolerance ({memory_limit})"
    );
}

fn setup_bench_env() -> (Env, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&e, &contract_id);

    let admin = Address::generate(&e);
    let signer = Address::generate(&e);
    client.initialize(&vec![&e, (signer.clone(), 1u64)], &1, &admin);

    (e, contract_id)
}

#[test]
fn bench_propose_settlement() {
    let (e, id) = setup_bench_env();
    let client = TreasuryContractClient::new(&e, &id);
    let signer = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);

    e.budget().reset_unlimited();
    let cpu_before = e.budget().cpu_instruction_cost();
    let mem_before = e.budget().memory_bytes_cost();

    let sid = client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);

    let cpu_after = e.budget().cpu_instruction_cost();
    let mem_after = e.budget().memory_bytes_cost();

    let cpu_delta = cpu_after - cpu_before;
    let mem_delta = mem_after - mem_before;

    let pending = client.get_pending_settlements(&None, &None);
    assert!(pending.contains(&sid), "settlement should be pending");

    assert!(
        cpu_delta < 5_000_000,
        "CPU instructions ({cpu_delta}) exceeded expected threshold"
    );
    assert!(
        mem_delta < 500_000,
        "Memory bytes ({mem_delta}) exceeded expected threshold"
    );
}

#[test]
fn bench_propose_settlement_deterministic() {
    let (e, id) = setup_bench_env();
    let client = TreasuryContractClient::new(&e, &id);
    let signer = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);

    e.budget().reset_unlimited();
    let cpu1_before = e.budget().cpu_instruction_cost();
    client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);
    let cpu1_after = e.budget().cpu_instruction_cost();
    let cpu1 = cpu1_after - cpu1_before;

    let signer2 = Address::generate(&e);
    e.budget().reset_unlimited();
    let cpu2_before = e.budget().cpu_instruction_cost();
    client.propose_settlement(&signer2, &token, &5_000_000u64, &merchant);
    let cpu2_after = e.budget().cpu_instruction_cost();
    let cpu2 = cpu2_after - cpu2_before;

    assert_eq!(
        cpu1, cpu2,
        "propose_settlement CPU cost should be deterministic"
    );
}

/// Regression benchmark for the reordering in #31: the token allowlist check
/// now runs before the pause and signer-auth checks in `propose_settlement`,
/// so a disallowed token should be rejected for meaningfully less than the
/// cost of a full accepted validation pass, rather than paying for
/// pause/auth work first and only then failing on the allowlist.
#[test]
fn bench_propose_settlement_rejected_token_cheaper_than_accepted() {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&e, &contract_id);

    let admin = Address::generate(&e);
    let signer = Address::generate(&e);
    let allowed_token = Address::generate(&e);
    let disallowed_token = Address::generate(&e);
    let merchant = Address::generate(&e);

    client.initialize(&vec![&e, (signer.clone(), 1u64)], &1, &admin);
    client.add_token_to_allowlist(&admin, &allowed_token);

    e.budget().reset_unlimited();
    let cpu_accept_before = e.budget().get_cpu_instructions_used();
    client.propose_settlement(&signer, &allowed_token, &5_000_000u64, &merchant);
    let cpu_accept_after = e.budget().get_cpu_instructions_used();
    let cpu_accept = cpu_accept_after - cpu_accept_before;

    e.budget().reset_unlimited();
    let cpu_reject_before = e.budget().get_cpu_instructions_used();
    let result =
        client.try_propose_settlement(&signer, &disallowed_token, &5_000_000u64, &merchant);
    let cpu_reject_after = e.budget().get_cpu_instructions_used();
    let cpu_reject = cpu_reject_after - cpu_reject_before;

    assert_eq!(result, Err(Ok(TreasuryError::TokenNotAllowed)));
    assert!(
        cpu_reject < cpu_accept,
        "rejecting a disallowed token ({cpu_reject} cpu) should cost less than a full \
         accepted proposal ({cpu_accept} cpu) now that the allowlist check runs first"
    );
}

#[test]
fn bench_approve_settlement() {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&e, &contract_id);
    let admin = Address::generate(&e);
    let signer = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);
    client.initialize(&vec![&e, (signer.clone(), 1u64)], &1, &admin);
    let settlement_id = client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);

    e.budget().reset_unlimited();
    let cpu_before = e.budget().cpu_instruction_cost();
    let memory_before = e.budget().memory_bytes_cost();
    client.approve_settlement(&signer, &settlement_id);
    let cpu = e.budget().cpu_instruction_cost() - cpu_before;
    let memory = e.budget().memory_bytes_cost() - memory_before;

    assert_cost_within_baseline(APPROVE_BASELINE, cpu, memory);
}

#[test]
fn bench_execute_settlement() {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&e, &contract_id);
    let admin = Address::generate(&e);
    let signer = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);
    client.initialize(&vec![&e, (signer.clone(), 1u64)], &1, &admin);
    let settlement_id = client.propose_settlement(&signer, &token, &5_000_000u64, &merchant);
    client.approve_settlement(&signer, &settlement_id);

    e.budget().reset_unlimited();
    let cpu_before = e.budget().cpu_instruction_cost();
    let memory_before = e.budget().memory_bytes_cost();
    client.execute_settlement(&signer, &settlement_id, &token);
    let cpu = e.budget().cpu_instruction_cost() - cpu_before;
    let memory = e.budget().memory_bytes_cost() - memory_before;

    assert_cost_within_baseline(EXECUTE_BASELINE, cpu, memory);
}
