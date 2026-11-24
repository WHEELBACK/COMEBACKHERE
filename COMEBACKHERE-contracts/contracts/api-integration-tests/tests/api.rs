//! Backend API integration tests against the local Soroban sandbox.
//!
//! Requires the docker-compose environment to be running:
//!   docker-compose up -d
//!
//! Run with:
//!   cargo test -p api-integration-tests -- --test-threads=1

use comebackhere_treasury::{TreasuryContract, TreasuryContractClient};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde_json::{json, Value};
use soroban_sdk::{testutils::Address as _, Address, Env};

const HORIZON_URL: &str = "http://localhost:8000";
const RPC_URL: &str = "http://localhost:8000/soroban/rpc";

fn client() -> Client {
    Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to build HTTP client")
}

#[test]
fn health_rpc_returns_200() {
    let resp = client()
        .get(format!("{}/health", HORIZON_URL))
        .send()
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::OK);
}

#[test]
fn health_rpc_body_contains_status_ok() {
    let body: Value = client()
        .get(format!("{}/health", HORIZON_URL))
        .send()
        .expect("request failed")
        .json()
        .expect("non-JSON response");
    assert_eq!(body["status"], "ok", "unexpected health body: {body}");
}

#[test]
fn rpc_get_latest_ledger_returns_sequence() {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getLatestLedger"
    });
    let resp: Value = client()
        .post(RPC_URL)
        .json(&body)
        .send()
        .expect("request failed")
        .json()
        .expect("non-JSON response");
    assert!(
        resp["result"]["sequence"].is_number(),
        "missing ledger sequence: {resp}"
    );
}

#[test]
fn rpc_simulate_transaction_missing_params_returns_error() {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "simulateTransaction",
        "params": {}
    });
    let resp: Value = client()
        .post(RPC_URL)
        .json(&body)
        .send()
        .expect("request failed")
        .json()
        .expect("non-JSON response");
    assert!(
        resp["error"].is_object(),
        "expected error for missing params: {resp}"
    );
}

#[test]
fn horizon_accounts_contains_embedded_records() {
    let body: Value = client()
        .get(format!("{}/accounts", HORIZON_URL))
        .send()
        .expect("request failed")
        .json()
        .expect("non-JSON response");
    assert!(
        body["_embedded"]["records"].is_array(),
        "unexpected accounts body: {body}"
    );
}

#[test]
fn treasury_api_executes_a_proposed_settlement() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TreasuryContract);
    let treasury = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let signer = Address::generate(&env);
    let token = Address::generate(&env);
    let merchant = Address::generate(&env);

    treasury.initialize(&soroban_sdk::vec![&env, (signer.clone(), 1u64)], &1, &admin);
    let settlement_id = treasury.propose_settlement(&signer, &token, &1_000u64, &merchant);
    assert_eq!(treasury.get_pending_settlements(&None, &None).len(), 1);

    treasury.approve_settlement(&signer, &settlement_id);
    treasury.execute_settlement(&signer, &settlement_id, &token);

    assert_eq!(treasury.get_pending_settlements(&None, &None).len(), 0);
}

#[test]
fn rpc_get_ledger_entries_empty_keys_returns_200() {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "getLedgerEntries",
        "params": { "keys": [] }
    });
    let resp = client()
        .post(RPC_URL)
        .json(&body)
        .send()
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::OK);
}

#[test]
fn rpc_unknown_method_returns_method_not_found_error() {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "nonExistentMethod"
    });
    let resp: Value = client()
        .post(RPC_URL)
        .json(&body)
        .send()
        .expect("request failed")
        .json()
        .expect("non-JSON response");
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    assert_eq!(code, -32601, "expected method-not-found error: {resp}");
}

#[test]
fn sandbox_is_reachable() {
    let result = client().get(format!("{}/health", HORIZON_URL)).send();
    assert!(
        result.is_ok() && result.unwrap().status().is_success(),
        "Soroban sandbox is not reachable at {HORIZON_URL}. Start it with: docker-compose up -d"
    );
}