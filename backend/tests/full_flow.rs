//! End-to-end integration test for the legacy Rust backend.
//!
//! Exercises the realistic sequence a client follows — check health, create an
//! invoice, pay it, then request a refund — across the backend's *own* HTTP
//! routes (`build_router`), backed by an in-process mock Soroban RPC and
//! Horizon endpoint instead of a live chain.
//!
//! Run with:
//! ```sh
//! cargo test -p comebackhere-backend --test full_flow
//! ```

use axum::{
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use axum_test::TestServer;
use comebackhere_backend::{build_router, AppState};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;

const MERCHANT: &str = "GMERCHANT0000000000000000000000000000000000000000000000000000";
const PAYER: &str = "GPAYER0000000000000000000000000000000000000000000000000000";
const CONTRACT_ID: &str = "CONTRACT_ID";

/// Simulated on-chain invoice state kept by the mock RPC.
///
/// `status` mirrors the contract's `InvoiceStatus` encoding:
/// 0 = Pending, 1 = Paid, 4 = RefundRequested.
struct MockChain {
    next_id: u64,
    status: u32,
}

/// Invoice ledger entry returned for `simulateTransaction` (used by the
/// backend's `get_invoice` calls).
fn invoice_map(status: u32) -> Value {
    json!([
        {"key": "id", "val": 1u64},
        {"key": "merchant", "val": MERCHANT},
        {"key": "payer", "val": PAYER},
        {"key": "status", "val": status},
        {"key": "amount_usdc", "val": 10_000_000u64},
        {"key": "gross_usdc", "val": 10_500_000u64},
        {"key": "expires_at", "val": 1_725_000_000u64},
    ])
}

/// The mock RPC handler. It implements the JSON-RPC methods the backend's
/// `SorobanClient` actually calls:
///
/// - `getLatestLedger`  → Soroban RPC health probe.
/// - `simulateTransaction` → returns the current invoice state.
/// - `sendTransaction`  → simulates the contract transition. The backend only
///   forwards pre-signed XDR, so the mock distinguishes the operation by the
///   `create` / `pay` / `refund` marker embedded in the test's `signed_xdr`
///   payloads (real XDR would encode the contract function name instead).
fn handle_rpc(chain: &Mutex<MockChain>, payload: &Value) -> impl axum::response::IntoResponse {
    let method = payload
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");

    let body = match method {
        "getLatestLedger" => json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": { "sequence": 42 }
        }),
        "simulateTransaction" => {
            let status = chain.lock().unwrap().status;
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": { "map": invoice_map(status) }
            })
        }
        "sendTransaction" => {
            let tx = payload
                .pointer("/params/transaction")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let mut chain = chain.lock().unwrap();
            if tx.contains("create") {
                let id = chain.next_id;
                chain.next_id += 1;
                chain.status = 0; // Pending
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": { "hash": "create-tx-1", "invoice_id": id }
                })
            } else if tx.contains("pay") {
                chain.status = 1; // Paid
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": { "hash": "pay-tx-1" }
                })
            } else if tx.contains("refund") {
                chain.status = 4; // RefundRequested
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": { "hash": "refund-tx-1" }
                })
            } else {
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "error": { "code": -32601, "message": "unsupported operation" }
                })
            }
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32601, "message": "method not found" }
        }),
    };

    Json(body)
}

/// Spawn the mock Soroban RPC (POST `/soroban/rpc`) and Horizon (GET
/// `/health`) on a local port and return its address plus the shared chain.
async fn spawn_mock_dependencies() -> (SocketAddr, Arc<Mutex<MockChain>>) {
    let chain = Arc::new(Mutex::new(MockChain {
        next_id: 1,
        status: 0,
    }));
    let chain_for_app = Arc::clone(&chain);

    let app = Router::new()
        .route(
            "/soroban/rpc",
            post(move |Json(payload): Json<Value>| {
                let chain = Arc::clone(&chain_for_app);
                async move { handle_rpc(&chain, &payload) }
            }),
        )
        .route("/health", get(|| async { StatusCode::OK }));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (addr, chain)
}

/// Boot the real backend router pointed at the mock dependencies.
async fn spawn_backend(mock_addr: SocketAddr) -> TestServer {
    let state = AppState::new(
        format!("http://{mock_addr}/soroban/rpc"),
        CONTRACT_ID.to_string(),
        format!("http://{mock_addr}"),
    );
    TestServer::new(build_router(state)).unwrap()
}

#[tokio::test]
async fn full_lifecycle_health_create_pay_refund() {
    let (mock_addr, chain) = spawn_mock_dependencies().await;
    let server = spawn_backend(mock_addr).await;

    // ── 1. Check health ─────────────────────────────────────────────────────
    let health = server.get("/health/rpc").await;
    assert_eq!(health.status_code(), StatusCode::OK);
    let health_body: Value = health.json();
    assert_eq!(health_body["status"], "healthy");
    assert_eq!(health_body["dependencies"]["soroban_rpc"]["status"], "healthy");
    assert_eq!(health_body["dependencies"]["horizon"]["status"], "healthy");

    // ── 2. Create an invoice ────────────────────────────────────────────────
    let create = server
        .post("/invoices")
        .json(&json!({
            "merchant": MERCHANT,
            "token": "USDC",
            "amount_usdc": 10_000_000,
            "gross_usdc": 10_500_000,
            "expires_in_seconds": 3600,
            "signed_xdr": "AAAA==create-invoice-1"
        }))
        .await;
    assert_eq!(
        create.status_code(),
        StatusCode::CREATED,
        "create should return 201"
    );
    let create_body: Value = create.json();
    let invoice_id = create_body["invoice_id"]
        .as_u64()
        .expect("created invoice should have an id");
    assert_eq!(invoice_id, 1, "first created invoice gets id 1");
    assert_eq!(create_body["status"], "pending");
    assert_eq!(create_body["transaction_hash"], "create-tx-1");

    // ── 3. Fetch the fresh invoice ──────────────────────────────────────────
    let fetched = server.get(&format!("/invoices/{invoice_id}")).await;
    assert_eq!(fetched.status_code(), StatusCode::OK);
    let fetched_body: Value = fetched.json();
    assert_eq!(fetched_body["id"], invoice_id);
    assert_eq!(fetched_body["merchant"], MERCHANT);
    assert_eq!(fetched_body["payer"], PAYER);
    assert_eq!(fetched_body["status"], "pending");

    // ── 4. Pay the invoice ──────────────────────────────────────────────────
    let pay = server
        .post(&format!("/invoices/{invoice_id}/pay"))
        .json(&json!({ "payer": PAYER, "signed_xdr": "AAAA==pay-invoice-1" }))
        .await;
    assert_eq!(pay.status_code(), StatusCode::OK, "pay should succeed");
    let pay_body: Value = pay.json();
    assert_eq!(pay_body["status"], "paid");
    assert_eq!(pay_body["transaction_hash"], "pay-tx-1");

    // ── 5. Fetch the paid invoice ───────────────────────────────────────────
    let fetched = server.get(&format!("/invoices/{invoice_id}")).await;
    assert_eq!(fetched.status_code(), StatusCode::OK);
    assert_eq!(fetched.json::<Value>()["status"], "paid");

    // ── 6. Request a refund ─────────────────────────────────────────────────
    let refund = server
        .post(&format!("/invoices/{invoice_id}/refund"))
        .json(&json!({ "payer": PAYER, "signed_xdr": "AAAA==refund-invoice-1" }))
        .await;
    assert_eq!(refund.status_code(), StatusCode::OK, "refund should succeed");
    let refund_body: Value = refund.json();
    assert_eq!(refund_body["status"], "refund_requested");
    assert_eq!(refund_body["transaction_hash"], "refund-tx-1");

    // ── 7. Fetch the refunded invoice ───────────────────────────────────────
    let fetched = server.get(&format!("/invoices/{invoice_id}")).await;
    assert_eq!(fetched.status_code(), StatusCode::OK);
    assert_eq!(fetched.json::<Value>()["status"], "refund_requested");

    // The mock chain must have advanced exactly as the client flow dictates.
    let chain = chain.lock().unwrap();
    assert_eq!(chain.next_id, 2, "exactly one invoice was created");
    assert_eq!(chain.status, 4, "invoice ended in RefundRequested");
}
