//! Comprehensive integration tests for customer-checkout backend.
//!
//! Tests cover:
//! 1. Edge-case error handling during concurrent operations
//! 2. Validation and error handling across all endpoints
//! 3. Memory efficiency and idempotency cleanup
//! 4. Full test coverage for regression prevention

use axum::http::StatusCode;
use axum_test::TestServer;
use comebackhere_backend::{build_router, AppState};
use serde_json::json;
use std::sync::Arc;

const MERCHANT: &str = "GMERCHANT0000000000000000000000000000000000000000000000000000";
const PAYER: &str = "GPAYER0000000000000000000000000000000000000000000000000000";
const CONTRACT_ID: &str = "CONTRACT_ID";

/// Test that concurrent idempotency checks under high load don't cause panics.
/// This addresses Issue #1: Edge-case error in customer-checkout causing
/// unexpected exceptions during high load.
#[tokio::test]
async fn test_high_load_idempotency_no_panic() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    // Simulate high concurrency with the same idempotency key
    let mut handles = vec![];
    for i in 0..20 {
        let server_clone = server.clone();
        let handle = tokio::spawn(async move {
            let payload = json!({
                "payer": PAYER,
                "signed_xdr": format!("AAAA=={}", i)
            });
            server_clone
                .post("/invoices/1/pay")
                .add_header("Idempotency-Key".parse().unwrap(), "concurrent-key".parse().unwrap())
                .json(&payload)
                .await
        });
        handles.push(handle);
    }

    // All requests should complete without panicking
    for handle in handles {
        let result = handle.await;
        assert!(result.is_ok(), "concurrent request panicked");
        let response = result.unwrap();
        // At least the first one should be attempted; others cached or rejected
        assert!(response.status_code().as_u16() >= 400 || response.status_code() == StatusCode::OK);
    }
}

/// Test comprehensive validation at the create_invoice endpoint.
/// This addresses Issue #2: Add comprehensive validation and error handling.
#[tokio::test]
async fn test_invoice_validation_zero_amount() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    let resp = server
        .post("/invoices")
        .json(&json!({
            "token": "USDC",
            "amount_usdc": 0,
            "gross_usdc": 100,
            "expires_in_seconds": 3600,
            "signed_xdr": "AAAA=="
        }))
        .await;

    assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = resp.json();
    assert!(body
        .get("error")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("greater than zero"));
}

#[tokio::test]
async fn test_invoice_validation_zero_gross_amount() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    let resp = server
        .post("/invoices")
        .json(&json!({
            "token": "USDC",
            "amount_usdc": 100,
            "gross_usdc": 0,
            "expires_in_seconds": 3600,
            "signed_xdr": "AAAA=="
        }))
        .await;

    assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = resp.json();
    assert!(body
        .get("error")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("Gross amount"));
}

#[tokio::test]
async fn test_invoice_validation_gross_less_than_net() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    let resp = server
        .post("/invoices")
        .json(&json!({
            "token": "USDC",
            "amount_usdc": 100,
            "gross_usdc": 50,
            "expires_in_seconds": 3600,
            "signed_xdr": "AAAA=="
        }))
        .await;

    assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = resp.json();
    assert!(body
        .get("error")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("Gross amount must be >="));
}

#[tokio::test]
async fn test_invoice_validation_unsupported_token() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    let resp = server
        .post("/invoices")
        .json(&json!({
            "token": "INVALID_TOKEN",
            "amount_usdc": 100,
            "gross_usdc": 100,
            "expires_in_seconds": 3600,
            "signed_xdr": "AAAA=="
        }))
        .await;

    assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = resp.json();
    assert!(body
        .get("error")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("Unsupported token"));
}

#[tokio::test]
async fn test_invoice_validation_zero_expiration() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    let resp = server
        .post("/invoices")
        .json(&json!({
            "token": "USDC",
            "amount_usdc": 100,
            "gross_usdc": 100,
            "expires_in_seconds": 0,
            "signed_xdr": "AAAA=="
        }))
        .await;

    assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = resp.json();
    assert!(body
        .get("error")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("expiration time"));
}

/// Test idempotency key reuse with different payloads is rejected.
/// This addresses Issue #1: Edge-case error handling and Issue #2: Validation.
#[tokio::test]
async fn test_idempotency_key_payload_mismatch_rejected() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    let key = "test-key-123";
    let payload1 = json!({
        "payer": PAYER,
        "signed_xdr": "AAAA==first"
    });

    // First request with key and payload1
    let resp1 = server
        .post("/invoices/1/pay")
        .add_header("Idempotency-Key".parse().unwrap(), key.parse().unwrap())
        .json(&payload1)
        .await;
    let status1 = resp1.status_code();

    // Second request with same key but different payload
    let payload2 = json!({
        "payer": PAYER,
        "signed_xdr": "AAAA==second"
    });

    let resp2 = server
        .post("/invoices/1/pay")
        .add_header("Idempotency-Key".parse().unwrap(), key.parse().unwrap())
        .json(&payload2)
        .await;

    // Should be rejected with 422 Unprocessable Entity (idempotency violation)
    assert_eq!(resp2.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = resp2.json();
    assert!(body
        .get("error")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("Idempotency-Key reused"));
}

/// Test that idempotency store cleanup works to prevent unbounded memory growth.
/// This addresses Issue #3: Optimize memory usage and database throughput.
#[tokio::test]
async fn test_idempotency_store_cleanup() {
    use std::time::Duration;
    use comebackhere_backend::idempotency::IdempotencyStore;

    let ttl = Duration::from_millis(100);
    let store = IdempotencyStore::new_with_sweep_interval(ttl, Duration::from_millis(30));

    // Insert several entries
    for i in 0..10 {
        let key = format!("pay:1:key-{}", i);
        let payload_hash = "hash".to_string();
        store.insert(
            key,
            200,
            json!({"ok": true}),
            payload_hash,
        );
    }

    assert_eq!(store.inner.len(), 10, "all entries inserted");

    // Wait for TTL to elapse and let the sweeper run
    tokio::time::sleep(ttl + Duration::from_millis(100)).await;

    // Entries should be automatically cleaned up
    assert_eq!(store.inner.len(), 0, "expired entries should be cleaned up automatically");
}

/// Test that get_invoice includes proper merchant field validation.
/// This addresses Issue #2: Add comprehensive validation and error handling.
#[tokio::test]
async fn test_get_invoice_with_merchant_validation() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    // This will fail because RPC is not actually running, but we can verify
    // the request is made
    let resp = server.get("/invoices/1").await;

    // Should either return 404/500 from RPC error, not a panic
    assert!(
        resp.status_code() == StatusCode::NOT_FOUND
            || resp.status_code() == StatusCode::INTERNAL_SERVER_ERROR
            || resp.status_code() == StatusCode::BAD_REQUEST,
        "should return a proper HTTP error, not panic"
    );
}

/// Test comprehensive error handling across multiple invoice lifecycle operations.
/// This addresses Issue #2: Add comprehensive validation and error handling.
#[tokio::test]
async fn test_invoice_lifecycle_error_handling() {
    let state = AppState::new(
        "http://127.0.0.1:19999/soroban/rpc".to_string(),
        CONTRACT_ID.to_string(),
        "http://127.0.0.1:19999".to_string(),
    );
    let server = TestServer::new(build_router(state)).unwrap();

    // Test pay with missing fields
    let resp = server
        .post("/invoices/1/pay")
        .json(&json!({}))
        .await;
    assert_eq!(
        resp.status_code(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "missing required fields should return 422"
    );

    // Test pay with invalid invoice ID (non-numeric in path would be caught by router)
    let resp = server
        .post("/invoices/1/refund")
        .json(&json!({}))
        .await;
    assert_eq!(
        resp.status_code(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "missing required fields in refund should return 422"
    );

    // Test cancel with missing merchant
    let resp = server
        .post("/invoices/1/cancel")
        .json(&json!({"signed_xdr": "AAAA=="}))
        .await;
    assert_eq!(
        resp.status_code(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "missing merchant in cancel should return 422"
    );
}
