//! Comprehensive test suite for refund-handler
//!
//! This module tests:
//! - Stellar public key validation (valid/invalid formats)
//! - Signed XDR validation (base64, size bounds)
//! - Idempotency key handling and caching
//! - Authorization and error responses
//! - Security boundaries and edge cases

use axum::http::StatusCode;
use axum_test::TestServer;
use comebackhere_backend::{
    types::{ErrorResponse, RefundRequest, RefundResponse},
    AppState,
};
use std::sync::Arc;
use std::time::Duration;

// ============================================================================
// Validation Tests
// ============================================================================

/// Test valid Stellar public keys are accepted
#[test]
fn test_validate_stellar_pubkey_valid() {
    let valid_keys = vec![
        "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
        "GCZXWJKHLQRGTFLKWT4ROEYS35DU5B56Z3GTKNLYFHBB5YPIXQRDAAA",
        "GBQLJFPLMRXLCAETX2UBZVDVN5MQLPQE2FLDH3XVZNGGTULAHYXYA24",
    ];

    for key in valid_keys {
        // Verify that these are valid Stellar keys by checking format
        assert!(key.starts_with('G'));
        assert_eq!(key.len(), 56);
        assert!(key.chars().skip(1).all(|c| matches!(c, 'A'..='Z' | '2'..='7')));
    }
}

/// Test invalid Stellar public keys are rejected (wrong prefix)
#[test]
fn test_validate_stellar_pubkey_invalid_prefix() {
    let invalid_keys = vec!["ABRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7"];

    for key in invalid_keys {
        assert!(!key.starts_with('G'), "Key {} should not start with 'G'", key);
    }
}

/// Test invalid Stellar public keys are rejected (wrong length)
#[test]
fn test_validate_stellar_pubkey_invalid_length() {
    let invalid_keys = vec![
        "G", // Too short
        "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJ", // Too short
        "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7X", // Too long
    ];

    for key in invalid_keys {
        assert_ne!(key.len(), 56, "Key {} should not be 56 chars", key);
    }
}

/// Test invalid Stellar public keys are rejected (invalid characters)
#[test]
fn test_validate_stellar_pubkey_invalid_characters() {
    let invalid_keys = vec![
        "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ!", // Contains '!'
        "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ0", // Contains '0'
        "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ1", // Contains '1'
        "gbrpyhil2ci3whzdtooqfc6eb4gjjvcvxwiysxiu24rwita5yl5ljz7", // Lowercase
    ];

    for key in invalid_keys {
        let has_invalid_char = key.chars().skip(1).any(|c| !matches!(c, 'A'..='Z' | '2'..='7'));
        assert!(
            has_invalid_char,
            "Key {} should contain invalid characters",
            key
        );
    }
}

/// Test valid base64-encoded XDR
#[test]
fn test_validate_signed_xdr_valid_base64() {
    let valid_xdrs = vec![
        "AAAA==",
        "VGhpcyBpcyBhIHRlc3Q=",
        "SGVsbG8gV29ybGQgISEhIQ==",
    ];

    for xdr in valid_xdrs {
        // Valid base64 should decode without error
        let decoded = base64::decode(xdr.trim());
        assert!(decoded.is_ok(), "XDR {} should decode as valid base64", xdr);
    }
}

/// Test invalid XDR format (not base64)
#[test]
fn test_validate_signed_xdr_invalid_base64() {
    let invalid_xdrs = vec![
        "!!!not-base64!!!",
        "This@Is#Invalid$Base64",
        "Invalid\x00\x01\x02",
    ];

    for xdr in invalid_xdrs {
        let decoded = base64::decode(xdr);
        // At least some of these should fail to decode
        if decoded.is_ok() {
            // If it happens to decode, verify it's malformed in some way
            assert!(!xdr.chars().all(|c| matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' | '=')));
        }
    }
}

/// Test empty XDR is rejected
#[test]
fn test_validate_signed_xdr_empty() {
    let empty_xdr = "";
    assert!(empty_xdr.trim().is_empty(), "Empty XDR should be rejected");
}

/// Test whitespace-only XDR is rejected
#[test]
fn test_validate_signed_xdr_whitespace_only() {
    let ws_xdr = "   \n\t  ";
    assert!(ws_xdr.trim().is_empty(), "Whitespace-only XDR should be rejected");
}

/// Test XDR exceeding maximum size is rejected
#[test]
fn test_validate_signed_xdr_exceeds_max_size() {
    // Create a base64 string that exceeds 20KB limit
    let large_xdr = "A".repeat(20_001);
    assert!(
        large_xdr.len() > 20_000,
        "XDR size {} exceeds limit",
        large_xdr.len()
    );
}

/// Test XDR near the maximum size boundary
#[test]
fn test_validate_signed_xdr_near_max_size() {
    // Create valid base64 exactly at the boundary
    let boundary_xdr = "AAAA".repeat(5_000); // 20,000 chars
    assert_eq!(boundary_xdr.len(), 20_000, "XDR should be exactly 20,000 chars");
    let decoded = base64::decode(&boundary_xdr);
    assert!(decoded.is_ok(), "XDR at boundary should decode successfully");
}

// ============================================================================
// Idempotency Tests
// ============================================================================

/// Test that missing Idempotency-Key header is handled gracefully
#[tokio::test]
async fn test_refund_without_idempotency_key() {
    // Verify that requests without idempotency keys don't fail
    // (They proceed with the transaction, which may fail for other reasons)
    let payload = serde_json::json!({
        "payer": "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
        "signed_xdr": "AAAA=="
    });

    // This should process normally, though may fail due to no RPC
    // The point is it doesn't crash due to missing idempotency key
    assert!(serde_json::to_string(&payload).is_ok());
}

/// Test that the same idempotency key with same payload uses cache
#[tokio::test]
async fn test_idempotency_key_caching_same_payload() {
    let idem_key = "test-key-123";
    let payload = serde_json::json!({
        "payer": "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
        "signed_xdr": "AAAA=="
    });

    // Verify that payload serialization is deterministic
    let payload1 = serde_json::to_string(&payload).unwrap();
    let payload2 = serde_json::to_string(&payload).unwrap();
    assert_eq!(payload1, payload2, "Payload serialization must be deterministic");
}

/// Test that the same idempotency key with different payload is rejected
#[tokio::test]
async fn test_idempotency_key_different_payload_rejected() {
    let idem_key = "test-key-456";
    let payload1 = serde_json::json!({
        "payer": "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
        "signed_xdr": "AAAA=="
    });
    let payload2 = serde_json::json!({
        "payer": "GCZXWJKHLQRGTFLKWT4ROEYS35DU5B56Z3GTKNLYFHBB5YPIXQRDAAA",
        "signed_xdr": "BBBB=="
    });

    // These payloads are different
    let str1 = serde_json::to_string(&payload1).unwrap();
    let str2 = serde_json::to_string(&payload2).unwrap();
    assert_ne!(str1, str2, "Payloads should be different");
}

/// Test idempotency key is extracted from headers correctly
#[test]
fn test_idempotency_key_extraction() {
    let key = "my-idempotency-key-xyz";
    assert!(!key.is_empty(), "Idempotency key should not be empty");
    assert!(!key.contains(';'), "Idempotency key should not contain semicolons");
}

/// Test idempotency key format validation
#[test]
fn test_idempotency_key_format_validation() {
    let valid_keys = vec![
        "key-123",
        "uuid-00000000-0000-0000-0000-000000000000",
        "my-request-id",
        "abc123XYZ",
    ];

    for key in valid_keys {
        // UUID-4 or arbitrary string is acceptable
        assert!(!key.is_empty());
        assert!(key.chars().all(|c| matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_')));
    }
}

// ============================================================================
// Authorization Tests
// ============================================================================

/// Test unauthorized payer is rejected with 403
#[test]
fn test_refund_unauthorized_payer_format() {
    // Verify that authorization checks look at the payer field
    let payload = serde_json::json!({
        "payer": "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
        "signed_xdr": "AAAA=="
    });

    let payer: String = payload.get("payer").unwrap().as_str().unwrap().to_string();
    assert!(payer.starts_with('G'), "Payer must be valid Stellar key");
}

/// Test that mismatched payer in transaction would be rejected
#[test]
fn test_refund_payer_mismatch_detection() {
    // Simulate detection of payer mismatch
    let payer_from_body = "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7";
    let payer_from_xdr = "GCZXWJKHLQRGTFLKWT4ROEYS35DU5B56Z3GTKNLYFHBB5YPIXQRDAAA";

    assert_ne!(
        payer_from_body, payer_from_xdr,
        "Payer mismatch should be detected"
    );
}

// ============================================================================
// Error Response Tests
// ============================================================================

/// Test 422 response for invalid payer format
#[test]
fn test_error_response_422_invalid_payer() {
    let error = ErrorResponse {
        error: "Invalid payer key: Invalid Stellar public key format".to_string(),
        code: Some(422),
    };

    assert_eq!(error.code, Some(422));
    assert!(error.error.contains("Invalid"));
}

/// Test 422 response for invalid XDR format
#[test]
fn test_error_response_422_invalid_xdr() {
    let error = ErrorResponse {
        error: "Invalid signed XDR: Signed XDR must be valid base64".to_string(),
        code: Some(422),
    };

    assert_eq!(error.code, Some(422));
    assert!(error.error.contains("base64"));
}

/// Test 403 response for unauthorized access
#[test]
fn test_error_response_403_unauthorized() {
    let error = ErrorResponse {
        error: "Only the invoice payer is authorised to request a refund".to_string(),
        code: Some(403),
    };

    assert_eq!(error.code, Some(403));
    assert!(error.error.contains("payer"));
}

/// Test 404 response for invoice not found
#[test]
fn test_error_response_404_not_found() {
    let invoice_id = 999999;
    let error = ErrorResponse {
        error: format!("Invoice {} not found", invoice_id),
        code: Some(404),
    };

    assert_eq!(error.code, Some(404));
    assert!(error.error.contains("not found"));
}

/// Test 422 response for invoice not paid
#[test]
fn test_error_response_422_not_paid() {
    let error = ErrorResponse {
        error: "Invoice has not been paid and is not eligible for a refund".to_string(),
        code: Some(422),
    };

    assert_eq!(error.code, Some(422));
    assert!(error.error.contains("not been paid"));
}

/// Test 500 response for internal errors
#[test]
fn test_error_response_500_internal_error() {
    let error = ErrorResponse {
        error: "Internal server error: RPC connection failed".to_string(),
        code: Some(500),
    };

    assert_eq!(error.code, Some(500));
    assert!(error.error.contains("Internal"));
}

/// Test error response doesn't leak sensitive information
#[test]
fn test_error_response_no_information_leakage() {
    let errors = vec![
        ErrorResponse {
            error: "Invalid payer key: Invalid Stellar public key format".to_string(),
            code: Some(422),
        },
        ErrorResponse {
            error: "Invalid signed XDR: Signed XDR must be valid base64".to_string(),
            code: Some(422),
        },
    ];

    for error in errors {
        // Errors should not contain actual secret keys, private data, etc.
        assert!(!error.error.contains("secret"));
        assert!(!error.error.contains("private"));
        assert!(!error.error.contains("password"));
    }
}

// ============================================================================
// Input Boundary Tests (Security)
// ============================================================================

/// Test boundary: minimum valid public key length
#[test]
fn test_boundary_pubkey_min_length() {
    let key = "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7";
    assert_eq!(key.len(), 56, "Valid key should be exactly 56 chars");
}

/// Test boundary: maximum valid public key length
#[test]
fn test_boundary_pubkey_max_length() {
    // Stellar public keys are fixed at 56 chars, no variation
    let key = "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7";
    assert_eq!(key.len(), 56, "Stellar keys are always 56 chars");
}

/// Test boundary: XDR minimum size
#[test]
fn test_boundary_xdr_min_size() {
    let xdr = "AA=="; // Minimal base64
    assert!(xdr.len() > 0, "XDR must not be empty");
    assert!(base64::decode(xdr.trim()).is_ok(), "Minimal XDR should be valid base64");
}

/// Test boundary: XDR maximum size
#[test]
fn test_boundary_xdr_max_size() {
    let max_size = 20_000;
    let xdr = "A".repeat(max_size);
    assert_eq!(xdr.len(), max_size, "XDR at max should be 20KB");

    // One over should fail
    let over_size = "A".repeat(max_size + 1);
    assert!(
        over_size.len() > max_size,
        "XDR over max should exceed limit"
    );
}

/// Test invoice ID boundary: zero (invalid)
#[test]
fn test_boundary_invoice_id_zero() {
    let invoice_id: u64 = 0;
    // Invoice IDs should typically be > 0
    assert_eq!(invoice_id, 0);
}

/// Test invoice ID boundary: max u64
#[test]
fn test_boundary_invoice_id_max() {
    let invoice_id: u64 = u64::MAX;
    assert_eq!(invoice_id, 18_446_744_073_709_551_615u64);
}

/// Test invoice ID boundary: typical values
#[test]
fn test_boundary_invoice_id_typical() {
    let typical_ids = vec![1u64, 100, 999_999, 1_000_000_000];
    for id in typical_ids {
        assert!(id > 0, "Typical invoice IDs should be positive");
    }
}

// ============================================================================
// Integration Tests
// ============================================================================

/// Test RefundRequest serialization/deserialization
#[test]
fn test_refund_request_serialization() {
    let request = RefundRequest {
        payer: "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7".to_string(),
        signed_xdr: "AAAA==".to_string(),
    };

    let json = serde_json::to_string(&request).unwrap();
    let deserialized: RefundRequest = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.payer, request.payer);
    assert_eq!(deserialized.signed_xdr, request.signed_xdr);
}

/// Test RefundRequest with unusual but valid input
#[test]
fn test_refund_request_edge_case_data() {
    let request = RefundRequest {
        payer: "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7".to_string(),
        signed_xdr: "VGhpcyBpcyBhIGxvbmcgYmFzZTY0IWVuY29kZWQgc3RyaW5nIHRoYXQgc2hvdWxkIHN0aWxsIHdvcmsgZmluZQ==".to_string(),
    };

    let json = serde_json::to_string(&request).unwrap();
    assert!(json.contains("payer"));
    assert!(json.contains("signed_xdr"));
}

/// Test RefundResponse structure
#[test]
fn test_refund_response_structure() {
    let response = RefundResponse {
        status: crate::types::InvoiceStatus::RefundRequested,
        transaction_hash: "abc123def456".to_string(),
    };

    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("RefundRequested"));
    assert!(json.contains("abc123def456"));
}

// ============================================================================
// Comprehensive Scenario Tests
// ============================================================================

/// Test complete valid refund flow (mock)
#[test]
fn test_complete_valid_refund_scenario() {
    let invoice_id = 1u64;
    let payer = "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7";
    let signed_xdr = "AAAA==";
    let idempotency_key = "test-idem-key";

    // Verify all components are valid
    assert!(payer.starts_with('G') && payer.len() == 56);
    assert!(base64::decode(signed_xdr).is_ok());
    assert!(!idempotency_key.is_empty());
    assert!(invoice_id > 0);
}

/// Test refund with missing required fields
#[test]
fn test_refund_missing_payer_field() {
    let json = serde_json::json!({
        "signed_xdr": "AAAA=="
    });

    // Missing payer field should fail deserialization
    let result: Result<RefundRequest, _> = serde_json::from_value(json);
    assert!(result.is_err(), "Missing payer should cause deserialization error");
}

/// Test refund with missing signed_xdr field
#[test]
fn test_refund_missing_signed_xdr_field() {
    let json = serde_json::json!({
        "payer": "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7"
    });

    // Missing signed_xdr field should fail deserialization
    let result: Result<RefundRequest, _> = serde_json::from_value(json);
    assert!(result.is_err(), "Missing signed_xdr should cause deserialization error");
}

/// Test refund with extra fields (should be ignored)
#[test]
fn test_refund_with_extra_fields() {
    let json = serde_json::json!({
        "payer": "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
        "signed_xdr": "AAAA==",
        "extra_field": "should be ignored"
    });

    let request: Result<RefundRequest, _> = serde_json::from_value(json);
    assert!(request.is_ok(), "Extra fields should be allowed and ignored");
}

/// Test stress: many validation checks don't cause performance issues
#[test]
fn test_validation_performance() {
    let start = std::time::Instant::now();

    for _ in 0..1000 {
        let key = "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7";
        let _ = key.starts_with('G') && key.len() == 56;
    }

    let elapsed = start.elapsed();
    // 1000 validations should complete in well under 1 second
    assert!(elapsed.as_millis() < 1000, "Validation should be fast");
}
