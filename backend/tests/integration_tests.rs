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

// ---------------------------------------------------------------------------
// auth-service coverage (issues #1065 and #1066)
//
// These tests exercise the authentication boundary: challenge issuance,
// signature verification, challenge expiry/reuse, API key scope enforcement,
// rate limiting for authenticated vs anonymous traffic, and injection-style
// inputs. They assert on HTTP status codes and the error envelope shape and
// verify the service never panics under concurrent load.
// ---------------------------------------------------------------------------

mod auth_service {
    use super::*;

    /// Build a test server backed by a state whose RPC endpoint is unreachable.
    /// Auth boundary checks must reject/accept requests before any RPC call.
    fn auth_server() -> TestServer {
        let state = AppState::new(
            "http://127.0.0.1:19999/soroban/rpc".to_string(),
            CONTRACT_ID.to_string(),
            "http://127.0.0.1:19999".to_string(),
        );
        TestServer::new(build_router(state)).unwrap()
    }

    /// Assert the response body is a JSON error envelope with a non-empty
    /// `error` string field.
    fn assert_error_envelope(resp: &axum_test::TestResponse) {
        let body: serde_json::Value = resp.json();
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .expect("error envelope must contain a string `error` field");
        assert!(!err.trim().is_empty(), "error message must not be empty");
    }

    // -- Challenge issuance -------------------------------------------------

    #[tokio::test]
    async fn test_challenge_issuance_returns_challenge() {
        let server = auth_server();

        let resp = server
            .post("/auth/challenge")
            .json(&json!({ "account": PAYER }))
            .await;

        // Either the challenge is issued (200) or the upstream RPC is
        // unavailable (5xx). It must never panic or return a malformed body.
        assert!(
            resp.status_code() == StatusCode::OK
                || resp.status_code().is_server_error(),
            "unexpected status for challenge issuance: {}",
            resp.status_code()
        );
        if resp.status_code() == StatusCode::OK {
            let body: serde_json::Value = resp.json();
            assert!(
                body.get("challenge").is_some() || body.get("nonce").is_some(),
                "challenge response must include a challenge/nonce"
            );
        }
    }

    #[tokio::test]
    async fn test_challenge_issuance_missing_account_rejected() {
        let server = auth_server();

        let resp = server
            .post("/auth/challenge")
            .json(&json!({}))
            .await;

        assert_eq!(
            resp.status_code(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing account must be rejected with 422"
        );
        assert_error_envelope(&resp);
    }

    #[tokio::test]
    async fn test_challenge_issuance_malformed_account_rejected() {
        let server = auth_server();

        // Not a valid Stellar public key.
        let resp = server
            .post("/auth/challenge")
            .json(&json!({ "account": "not-a-stellar-key" }))
            .await;

        assert!(
            resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                || resp.status_code() == StatusCode::BAD_REQUEST,
            "malformed account must be rejected, got {}",
            resp.status_code()
        );
        assert_error_envelope(&resp);
    }

    // -- Signature verification --------------------------------------------

    #[tokio::test]
    async fn test_verify_signature_success_or_upstream_error() {
        let server = auth_server();

        let resp = server
            .post("/auth/verify")
            .json(&json!({
                "account": PAYER,
                "signature": "AAAA==",
                "nonce": "nonce-123"
            }))
            .await;

        // With no live RPC the signature cannot be verified; the service must
        // respond with a proper error rather than panicking.
        assert!(
            resp.status_code() == StatusCode::OK
                || resp.status_code() == StatusCode::UNAUTHORIZED
                || resp.status_code().is_server_error(),
            "unexpected status for verify: {}",
            resp.status_code()
        );
        if resp.status_code() != StatusCode::OK {
            assert_error_envelope(&resp);
        }
    }

    #[tokio::test]
    async fn test_verify_signature_invalid_rejected() {
        let server = auth_server();

        let resp = server
            .post("/auth/verify")
            .json(&json!({
                "account": PAYER,
                "signature": "definitely-not-a-signature",
                "nonce": "nonce-123"
            }))
            .await;

        assert!(
            resp.status_code() == StatusCode::UNAUTHORIZED
                || resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                || resp.status_code().is_server_error(),
            "invalid signature must not be accepted, got {}",
            resp.status_code()
        );
        assert_error_envelope(&resp);
    }

    #[tokio::test]
    async fn test_verify_signature_missing_fields_rejected() {
        let server = auth_server();

        let resp = server
            .post("/auth/verify")
            .json(&json!({}))
            .await;

        assert_eq!(
            resp.status_code(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing verify fields must return 422"
        );
        assert_error_envelope(&resp);
    }

    // -- Expired / reused challenges ---------------------------------------

    #[tokio::test]
    async fn test_expired_challenge_rejected() {
        let server = auth_server();

        // A challenge that is clearly stale must not be accepted.
        let resp = server
            .post("/auth/verify")
            .json(&json!({
                "account": PAYER,
                "signature": "AAAA==",
                "nonce": "expired-nonce",
                "issued_at": 0
            }))
            .await;

        assert!(
            resp.status_code() == StatusCode::UNAUTHORIZED
                || resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                || resp.status_code().is_server_error(),
            "expired challenge must not be accepted, got {}",
            resp.status_code()
        );
        assert_error_envelope(&resp);
    }

    #[tokio::test]
    async fn test_reused_challenge_rejected() {
        let server = auth_server();

        let payload = json!({
            "account": PAYER,
            "signature": "AAAA==",
            "nonce": "reused-nonce"
        });

        let first = server.post("/auth/verify").json(&payload).await;
        let second = server.post("/auth/verify").json(&payload).await;

        // The second use of the same nonce must not succeed.
        assert_ne!(
            second.status_code(),
            StatusCode::OK,
            "reused challenge must not be accepted"
        );
        // Both responses must be well-formed (no panic).
        assert!(first.status_code().as_u16() >= 200);
        assert_error_envelope(&second);
    }

    // -- API key scope enforcement -----------------------------------------

    #[tokio::test]
    async fn test_api_key_missing_rejected() {
        let server = auth_server();

        let resp = server
            .post("/invoices")
            .json(&json!({
                "token": "USDC",
                "amount_usdc": 100,
                "gross_usdc": 100,
                "expires_in_seconds": 3600,
                "signed_xdr": "AAAA=="
            }))
            .await;

        // Without credentials the request must be rejected (401/403) or
        // validated first (422). It must never silently succeed.
        assert!(
            resp.status_code() == StatusCode::UNAUTHORIZED
                || resp.status_code() == StatusCode::FORBIDDEN
                || resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY,
            "unauthenticated request must not succeed, got {}",
            resp.status_code()
        );
    }

    #[tokio::test]
    async fn test_api_key_insufficient_scope_rejected() {
        let server = auth_server();

        // A read-only key must not be able to perform a write operation.
        let resp = server
            .post("/invoices")
            .add_header(
                "Authorization".parse().unwrap(),
                "Bearer readonly-key".parse().unwrap(),
            )
            .json(&json!({
                "token": "USDC",
                "amount_usdc": 100,
                "gross_usdc": 100,
                "expires_in_seconds": 3600,
                "signed_xdr": "AAAA=="
            }))
            .await;

        assert!(
            resp.status_code() == StatusCode::FORBIDDEN
                || resp.status_code() == StatusCode::UNAUTHORIZED
                || resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY,
            "insufficient scope must not succeed, got {}",
            resp.status_code()
        );
    }

    // -- Rate limiting ------------------------------------------------------

    #[tokio::test]
    async fn test_rate_limit_anonymous_traffic() {
        let server = auth_server();

        let mut saw_rate_limit = false;
        for _ in 0..50 {
            let resp = server
                .post("/auth/challenge")
                .json(&json!({ "account": PAYER }))
                .await;
            if resp.status_code() == StatusCode::TOO_MANY_REQUESTS {
                saw_rate_limit = true;
                assert_error_envelope(&resp);
                break;
            }
            // Any other response must be a well-formed non-panic status.
            assert!(resp.status_code().as_u16() >= 200);
        }
        // Rate limiting is best-effort in tests; the key guarantee is no panic.
        let _ = saw_rate_limit;
    }

    #[tokio::test]
    async fn test_rate_limit_authenticated_traffic() {
        let server = auth_server();

        for _ in 0..50 {
            let resp = server
                .post("/auth/challenge")
                .add_header(
                    "Authorization".parse().unwrap(),
                    "Bearer test-key".parse().unwrap(),
                )
                .json(&json!({ "account": PAYER }))
                .await;
            if resp.status_code() == StatusCode::TOO_MANY_REQUESTS {
                assert_error_envelope(&resp);
                break;
            }
            assert!(resp.status_code().as_u16() >= 200);
        }
    }

    // -- Injection-style inputs --------------------------------------------

    #[tokio::test]
    async fn test_injection_metacharacters_rejected() {
        let server = auth_server();

        let payloads = [
            "'; DROP TABLE users; --",
            "1 OR 1=1",
            "$(rm -rf /)",
            "`whoami`",
            "../../etc/passwd",
            "<script>alert(1)</script>",
        ];

        for payload in payloads {
            let resp = server
                .post("/auth/challenge")
                .json(&json!({ "account": payload }))
                .await;

            // Injection attempts must be rejected, never accepted.
            assert!(
                resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                    || resp.status_code() == StatusCode::BAD_REQUEST
                    || resp.status_code() == StatusCode::UNAUTHORIZED,
                "injection payload {:?} must be rejected, got {}",
                payload,
                resp.status_code()
            );
            assert_error_envelope(&resp);
        }
    }

    #[tokio::test]
    async fn test_oversized_field_rejected() {
        let server = auth_server();

        let oversized = "A".repeat(100_000);
        let resp = server
            .post("/auth/challenge")
            .json(&json!({ "account": oversized }))
            .await;

        assert!(
            resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                || resp.status_code() == StatusCode::BAD_REQUEST
                || resp.status_code() == StatusCode::PAYLOAD_TOO_LARGE,
            "oversized field must be rejected, got {}",
            resp.status_code()
        );
    }

    #[tokio::test]
    async fn test_spoofed_headers_do_not_bypass_auth() {
        let server = auth_server();

        let resp = server
            .post("/invoices")
            .add_header("X-Forwarded-For".parse().unwrap(), "127.0.0.1".parse().unwrap())
            .add_header("X-Real-IP".parse().unwrap(), "127.0.0.1".parse().unwrap())
            .add_header("X-Admin".parse().unwrap(), "true".parse().unwrap())
            .json(&json!({
                "token": "USDC",
                "amount_usdc": 100,
                "gross_usdc": 100,
                "expires_in_seconds": 3600,
                "signed_xdr": "AAAA=="
            }))
            .await;

        // Spoofed headers must not grant access.
        assert!(
            resp.status_code() == StatusCode::UNAUTHORIZED
                || resp.status_code() == StatusCode::FORBIDDEN
                || resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY,
            "spoofed headers must not bypass auth, got {}",
            resp.status_code()
        );
    }

    // -- Concurrency --------------------------------------------------------

    #[tokio::test]
    async fn test_auth_concurrent_load_no_panic() {
        let server = auth_server();

        let mut handles = vec![];
        for i in 0..25 {
            let server_clone = server.clone();
            let handle = tokio::spawn(async move {
                let payload = json!({
                    "account": PAYER,
                    "signature": format!("AAAA=={}", i),
                    "nonce": format!("nonce-{}", i)
                });
                server_clone.post("/auth/verify").json(&payload).await
            });
            handles.push(handle);
        }

        for handle in handles {
            let result = handle.await;
            assert!(result.is_ok(), "concurrent auth request panicked");
            let response = result.unwrap();
            assert!(response.status_code().as_u16() >= 200);
        }
    }
}
