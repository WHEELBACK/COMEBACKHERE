//! Integration tests for the balance reconciliation module.
//!
//! Tests cover security hardening, input validation, and the reconciliation workflow.

use comebackhere_backend::balance_reconciliation::{
    BalanceReconciliation, ReconciliationConfig, ReconciliationError, ReconciliationStatus,
};
use std::sync::Arc;
use std::thread;

#[test]
fn test_sql_injection_protection_merchant_id() {
    // Attempt SQL injection
    assert!(BalanceReconciliation::validate_merchant_id("merchant'; DROP TABLE merchants; --")
        .is_err());
    assert!(BalanceReconciliation::validate_merchant_id("merchant\" OR \"1\"=\"1").is_err());
    assert!(BalanceReconciliation::validate_merchant_id("merchant\x00test").is_err());
}

#[test]
fn test_sql_injection_protection_invoice_id() {
    // Attempt SQL injection
    assert!(BalanceReconciliation::validate_invoice_id("invoice' OR '1'='1").is_err());
    assert!(BalanceReconciliation::validate_invoice_id("invoice\"; DROP TABLE --").is_err());
}

#[test]
fn test_command_injection_protection() {
    // Attempt command injection patterns
    assert!(BalanceReconciliation::validate_merchant_id("merchant$(whoami)").is_err());
    assert!(BalanceReconciliation::validate_merchant_id("merchant`id`").is_err());
    assert!(BalanceReconciliation::validate_merchant_id("merchant|cat /etc/passwd").is_err());
}

#[test]
fn test_xss_protection_in_ids() {
    // Attempt XSS patterns (these should be rejected due to character restrictions)
    assert!(BalanceReconciliation::validate_merchant_id("merchant<script>alert(1)</script>")
        .is_err());
    assert!(BalanceReconciliation::validate_invoice_id("invoice&lt;img src=x onerror=alert(1)&gt;")
        .is_err());
}

#[test]
fn test_authorization_hardening() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Missing authorization
    assert!(reconciliation.verify_authorization("").is_err());

    // Too short (potential truncation attack)
    assert!(reconciliation.verify_authorization("short").is_err());

    // Valid authorization
    assert!(reconciliation.verify_authorization("valid-api-key-1234567890").is_ok());
}

#[test]
fn test_reconciliation_workflow() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Start reconciliation
    let report_id = reconciliation
        .start_reconciliation("valid-api-key", 12345)
        .unwrap();

    // Verify it's in Running state
    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.status, ReconciliationStatus::Running);
    assert_eq!(report.checkpoint_ledger, 12345);

    // Add discrepancies
    assert!(reconciliation
        .add_discrepancy(
            &report_id,
            "invoice-1".to_string(),
            "merchant-1".to_string(),
            1000,
            950
        )
        .is_ok());

    assert!(reconciliation
        .add_discrepancy(
            &report_id,
            "invoice-2".to_string(),
            "merchant-2".to_string(),
            2000,
            2100
        )
        .is_ok());

    // Verify discrepancies are recorded
    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.discrepancy_count, 2);
    assert!(!report.in_sync);

    // Complete reconciliation
    assert!(reconciliation.complete_reconciliation(&report_id).is_ok());

    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.status, ReconciliationStatus::Completed);
    assert!(report.completed_at.is_some());
}

#[test]
fn test_unauthorized_reconciliation() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Try without valid API key
    let result = reconciliation.start_reconciliation("", 12345);
    assert!(matches!(result, Err(ReconciliationError::Unauthorized)));
}

#[test]
fn test_concurrent_reconciliation_prevention() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Start first reconciliation
    let report_id_1 = reconciliation
        .start_reconciliation("api-key-1", 12345)
        .unwrap();

    // Attempt to start second one while first is running
    let result = reconciliation.start_reconciliation("api-key-2", 12346);
    assert!(matches!(
        result,
        Err(ReconciliationError::AlreadyRunning)
    ));

    // Complete first reconciliation
    assert!(reconciliation.complete_reconciliation(&report_id_1).is_ok());

    // Now we should be able to start a new one
    let report_id_2 = reconciliation
        .start_reconciliation("api-key-3", 12347)
        .unwrap();
    assert!(!report_id_1.eq(&report_id_2));
}

#[test]
fn test_discrepancy_validation_in_workflow() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    let report_id = reconciliation
        .start_reconciliation("api-key", 12345)
        .unwrap();

    // Try to add discrepancy with invalid merchant ID
    let result = reconciliation.add_discrepancy(
        &report_id,
        "invoice-1".to_string(),
        "merchant@bad".to_string(),
        1000,
        950,
    );
    assert!(result.is_err());

    // Try to add discrepancy with invalid invoice ID
    let result = reconciliation.add_discrepancy(
        &report_id,
        "invoice<bad>".to_string(),
        "merchant-1".to_string(),
        1000,
        950,
    );
    assert!(result.is_err());

    // Try with both IDs valid
    let result = reconciliation.add_discrepancy(
        &report_id,
        "invoice-1".to_string(),
        "merchant-1".to_string(),
        1000,
        950,
    );
    assert!(result.is_ok());
}

#[test]
fn test_discrepancy_cap() {
    let config = ReconciliationConfig {
        max_discrepancies_reported: 5,
        ..Default::default()
    };
    let reconciliation = BalanceReconciliation::new(config);

    let report_id = reconciliation
        .start_reconciliation("api-key", 12345)
        .unwrap();

    // Add more discrepancies than the cap
    for i in 0..10 {
        let _ = reconciliation.add_discrepancy(
            &report_id,
            format!("invoice-{}", i),
            format!("merchant-{}", i),
            1000,
            900,
        );
    }

    // Report should only contain up to max_discrepancies_reported
    let report = reconciliation.get_report(&report_id).unwrap();
    assert!(report.discrepancies.len() <= 5);
}

#[test]
fn test_error_recovery() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    let report_id = reconciliation
        .start_reconciliation("api-key", 12345)
        .unwrap();

    // Add some discrepancies
    assert!(reconciliation
        .add_discrepancy(
            &report_id,
            "invoice-1".to_string(),
            "merchant-1".to_string(),
            1000,
            950
        )
        .is_ok());

    // Fail the reconciliation with an error
    assert!(reconciliation
        .fail_reconciliation(&report_id, "network timeout".to_string())
        .is_ok());

    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.status, ReconciliationStatus::Failed);
    assert_eq!(report.error, Some("network timeout".to_string()));

    // Now we should be able to start a new reconciliation
    let report_id_2 = reconciliation
        .start_reconciliation("api-key-2", 12346)
        .unwrap();
    assert!(!report_id.eq(&report_id_2));
}

#[test]
fn test_concurrent_starts_thread_safe() {
    use std::sync::Arc;

    let reconciliation = Arc::new(BalanceReconciliation::new(ReconciliationConfig::default()));

    let mut handles = vec![];

    for i in 0..5 {
        let recon = Arc::clone(&reconciliation);
        let handle = thread::spawn(move || {
            recon.start_reconciliation(&format!("api-key-{}", i), 12345 + i as u32)
        });
        handles.push(handle);
    }

    let mut successful = 0;
    for handle in handles {
        if handle.join().unwrap().is_ok() {
            successful += 1;
        }
    }

    // Only one should succeed due to concurrency prevention
    assert_eq!(successful, 1);
}

#[test]
fn test_indexed_balance_management() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Store balance
    assert!(reconciliation
        .set_indexed_balance("invoice-1-merchant-1".to_string(), 1000)
        .is_ok());

    // Retrieve balance
    let balance = reconciliation
        .get_indexed_balance("invoice-1-merchant-1")
        .unwrap();
    assert_eq!(balance, Some(1000));

    // Non-existent balance
    let balance = reconciliation.get_indexed_balance("non-existent").unwrap();
    assert_eq!(balance, None);

    // Update balance
    assert!(reconciliation
        .set_indexed_balance("invoice-1-merchant-1".to_string(), 2000)
        .is_ok());

    let balance = reconciliation
        .get_indexed_balance("invoice-1-merchant-1")
        .unwrap();
    assert_eq!(balance, Some(2000));
}

#[test]
fn test_merchant_id_length_limits() {
    // Valid: at maximum length
    let long_id = "a".repeat(256);
    assert!(BalanceReconciliation::validate_merchant_id(&long_id).is_ok());

    // Invalid: exceeds maximum length
    let too_long = "a".repeat(257);
    assert!(BalanceReconciliation::validate_merchant_id(&too_long).is_err());
}

#[test]
fn test_invoice_id_length_limits() {
    // Valid: at maximum length
    let long_id = "a".repeat(128);
    assert!(BalanceReconciliation::validate_invoice_id(&long_id).is_ok());

    // Invalid: exceeds maximum length
    let too_long = "a".repeat(129);
    assert!(BalanceReconciliation::validate_invoice_id(&too_long).is_err());
}

#[test]
fn test_discrepancy_difference_calculation() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    let report_id = reconciliation
        .start_reconciliation("api-key", 12345)
        .unwrap();

    // Add discrepancy where indexed > ledger
    assert!(reconciliation
        .add_discrepancy(
            &report_id,
            "invoice-1".to_string(),
            "merchant-1".to_string(),
            2000,
            1000
        )
        .is_ok());

    // Add discrepancy where indexed < ledger
    assert!(reconciliation
        .add_discrepancy(
            &report_id,
            "invoice-2".to_string(),
            "merchant-1".to_string(),
            500,
            1000
        )
        .is_ok());

    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.discrepancies[0].difference, 1000); // 2000 - 1000
    assert_eq!(report.discrepancies[1].difference, -500); // 500 - 1000
}

#[test]
fn test_special_characters_in_valid_ids() {
    // Hyphens and underscores are allowed
    assert!(BalanceReconciliation::validate_merchant_id("merchant-with-hyphens").is_ok());
    assert!(BalanceReconciliation::validate_merchant_id("merchant_with_underscores").is_ok());
    assert!(BalanceReconciliation::validate_merchant_id("merchant-123_abc").is_ok());

    // Other special characters are not allowed
    assert!(BalanceReconciliation::validate_merchant_id("merchant.with.dots").is_err());
    assert!(BalanceReconciliation::validate_merchant_id("merchant/path").is_err());
    assert!(BalanceReconciliation::validate_merchant_id("merchant\\path").is_err());
}
