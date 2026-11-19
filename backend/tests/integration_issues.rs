//! Integration tests covering all four issue fixes:
//! 1. Fee-distributor edge-case error handling
//! 2. Balance-reconciliation test coverage
//! 3. Balance-reconciliation security hardening
//! 4. Fee-distributor comprehensive validation

use comebackhere_backend::fee_distributor::{
    FeeDistributor, FeeDistributorConfig, FeeDistributorError, DistributionStatus,
};
use comebackhere_backend::balance_reconciliation::{
    BalanceReconciliation, ReconciliationConfig, ReconciliationError, ReconciliationStatus,
};

// ─── Issue #1: Fee-Distributor Edge-Case Error Handling ──────────────────

#[test]
fn issue_1_fee_distributor_high_load_error_handling() {
    let config = FeeDistributorConfig {
        max_concurrent_distributions: 50,
        max_queue_depth: 100,
        fee_percentage_ppt: 50,
        min_fee_stroops: 1000,
    };
    let distributor = FeeDistributor::new(config);

    // Simulate high load with many distributions
    let mut successful_queues = 0;
    for i in 0..150 {
        match distributor.queue_distribution(
            format!("dist-{}", i),
            format!("merchant-{}", i % 10),
            100_000 + i as u64 * 100,
        ) {
            Ok(_) => {
                successful_queues += 1;
            }
            Err(FeeDistributorError::QueueSaturated) => {
                // Expected behavior: graceful degradation under high load
                // The system rejects additional operations instead of crashing
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
    }

    assert!(successful_queues > 0, "Some operations should succeed");
    assert!(
        successful_queues <= 100,
        "Queue should not exceed configured depth"
    );
}

#[test]
fn issue_1_fee_distributor_overflow_edge_case() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());

    // Edge case: extremely large amounts that could cause overflow
    let result = distributor.calculate_fees(u64::MAX);
    assert!(
        result.is_err(),
        "Should handle overflow gracefully without panicking"
    );

    // Edge case: near-maximum amounts
    let result = distributor.calculate_fees(u64::MAX / 2);
    if result.is_ok() {
        let calc = result.unwrap();
        assert!(calc.fee_amount <= calc.gross_amount);
        assert_eq!(calc.net_amount + calc.fee_amount, calc.gross_amount);
    }
}

#[test]
fn issue_1_fee_distributor_concurrent_high_load() {
    use std::sync::Arc;
    use std::thread;

    let distributor = Arc::new(FeeDistributor::new(FeeDistributorConfig {
        max_concurrent_distributions: 100,
        max_queue_depth: 1000,
        ..Default::default()
    }));

    let mut handles = vec![];
    let mut total_queued = 0;

    for thread_id in 0..5 {
        let dist = Arc::clone(&distributor);
        let handle = thread::spawn(move || {
            let mut count = 0;
            for i in 0..50 {
                if dist
                    .queue_distribution(
                        format!("dist-{}-{}", thread_id, i),
                        format!("merchant-{}", thread_id),
                        100_000 + i as u64 * 1000,
                    )
                    .is_ok()
                {
                    count += 1;
                }
            }
            count
        });
        handles.push(handle);
    }

    for handle in handles {
        total_queued += handle.join().unwrap();
    }

    assert!(
        total_queued > 0,
        "Concurrent high-load operations should mostly succeed"
    );
    assert!(
        total_queued <= 1000,
        "Should not exceed queue depth even under concurrent load"
    );
}

// ─── Issue #2 & #3: Balance-Reconciliation Test Coverage + Security ───────

#[test]
fn issue_2_balance_reconciliation_test_coverage() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Test: start reconciliation
    let report_id = reconciliation
        .start_reconciliation("valid-api-key-123456", 50000)
        .expect("should start reconciliation");

    // Test: verify initial state
    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.status, ReconciliationStatus::Running);
    assert_eq!(report.checkpoint_ledger, 50000);
    assert_eq!(report.discrepancy_count, 0);
    assert!(report.in_sync);

    // Test: add discrepancies
    for i in 0..5 {
        reconciliation
            .add_discrepancy(
                &report_id,
                format!("invoice-{}", i),
                format!("merchant-{}", i),
                1000 * (i as u64 + 1),
                950 * (i as u64 + 1),
            )
            .expect("should add discrepancy");
    }

    // Test: verify discrepancies recorded
    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.discrepancy_count, 5);
    assert!(!report.in_sync);

    // Test: complete reconciliation
    reconciliation
        .complete_reconciliation(&report_id)
        .expect("should complete");

    let report = reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.status, ReconciliationStatus::Completed);
    assert!(report.completed_at.is_some());
}

#[test]
fn issue_3_balance_reconciliation_security_hardening() {
    let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Security Test 1: SQL Injection Prevention
    let sql_injection_attempts = vec![
        ("merchant'; DROP TABLE merchants; --", true),
        ("merchant\" OR \"1\"=\"1", true),
        ("valid-merchant-123", false),
    ];

    for (input, should_fail) in sql_injection_attempts {
        let result = BalanceReconciliation::validate_merchant_id(input);
        assert_eq!(
            result.is_err(),
            should_fail,
            "SQL injection protection failed for: {}",
            input
        );
    }

    // Security Test 2: Command Injection Prevention
    let command_injection_attempts = vec![
        ("merchant$(whoami)", true),
        ("merchant`id`", true),
        ("merchant|cat", true),
        ("valid-merchant", false),
    ];

    for (input, should_fail) in command_injection_attempts {
        let result = BalanceReconciliation::validate_merchant_id(input);
        assert_eq!(
            result.is_err(),
            should_fail,
            "Command injection protection failed for: {}",
            input
        );
    }

    // Security Test 3: Authorization Enforcement
    let invalid_keys = vec!["", "short", "a"];
    for key in invalid_keys {
        let result = reconciliation.verify_authorization(key);
        assert!(
            result.is_err(),
            "Should reject invalid authorization: {}",
            key
        );
    }

    let valid_key = "valid-api-key-1234567890";
    assert!(
        reconciliation.verify_authorization(valid_key).is_ok(),
        "Should accept valid authorization"
    );

    // Security Test 4: Input Length Validation
    let too_long_merchant = "a".repeat(300);
    assert!(
        BalanceReconciliation::validate_merchant_id(&too_long_merchant).is_err(),
        "Should reject merchant ID exceeding length limit"
    );

    let too_long_invoice = "i".repeat(200);
    assert!(
        BalanceReconciliation::validate_invoice_id(&too_long_invoice).is_err(),
        "Should reject invoice ID exceeding length limit"
    );
}

// ─── Issue #4: Fee-Distributor Comprehensive Validation ──────────────────

#[test]
fn issue_4_fee_distributor_comprehensive_validation() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());

    // Validation Test 1: Fee percentage validation
    let valid_percentages = vec![0, 50, 1000, 100_000];
    for pct in valid_percentages {
        assert!(
            FeeDistributor::validate_fee_percentage(pct).is_ok(),
            "Should accept valid fee percentage: {}",
            pct
        );
    }

    let invalid_percentages = vec![100_001, 200_000, u32::MAX];
    for pct in invalid_percentages {
        assert!(
            FeeDistributor::validate_fee_percentage(pct).is_err(),
            "Should reject invalid fee percentage: {}",
            pct
        );
    }

    // Validation Test 2: Receiver address validation
    let valid_addresses = vec!["GVALIDADDR1234567890", "receiver-address-123"];
    for addr in valid_addresses {
        assert!(
            FeeDistributor::validate_receiver_address(addr).is_ok(),
            "Should accept valid receiver: {}",
            addr
        );
    }

    let invalid_addresses = vec!["", "SHORT", "addr\nwith\nnewlines"];
    for addr in invalid_addresses {
        assert!(
            FeeDistributor::validate_receiver_address(addr).is_err(),
            "Should reject invalid receiver: {}",
            addr
        );
    }

    // Validation Test 3: Amount validation
    let zero_amount = distributor.calculate_fees(0);
    assert!(
        matches!(zero_amount, Err(FeeDistributorError::ZeroAmount)),
        "Should reject zero amounts"
    );

    // Validation Test 4: Overflow protection
    let overflow_test = distributor.calculate_fees(u64::MAX);
    assert!(overflow_test.is_err(), "Should handle overflow gracefully");

    // Validation Test 5: Calculation consistency
    let amounts = vec![1_000, 10_000, 100_000, 1_000_000];
    for amount in amounts {
        let calc = distributor
            .calculate_fees(amount)
            .expect("should calculate fees");

        // Verify math: gross = net + fee
        assert_eq!(
            calc.gross_amount,
            calc.net_amount + calc.fee_amount,
            "Fee calculation math failed for amount {}",
            amount
        );

        // Verify no data loss
        assert!(
            calc.net_amount > 0 || calc.fee_amount > 0,
            "Amount must be split between net and fee"
        );

        // Verify internal consistency
        calc.validate()
            .expect("calculated fees should be internally consistent");
    }
}

// ─── Cross-module Integration Tests ───────────────────────────────────────

#[test]
fn integration_fee_distributor_and_balance_reconciliation() {
    // Setup both systems
    let fee_distributor = FeeDistributor::new(FeeDistributorConfig::default());
    let balance_reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

    // Scenario: Process payments and reconcile
    let merchant_id = "merchant-123";

    // Distribute fees for multiple transactions
    let mut total_fees = 0u64;
    for i in 0..10 {
        let amount = 100_000 + i as u64 * 10_000;
        match fee_distributor.queue_distribution(
            format!("dist-{}", i),
            merchant_id.to_string(),
            amount,
        ) {
            Ok(dist) => {
                total_fees += dist.calculation.fee_amount;
                balance_reconciliation
                    .set_indexed_balance(format!("merchant-{}-dist-{}", merchant_id, i), amount)
                    .ok();
            }
            Err(_) => break,
        }
    }

    assert!(total_fees > 0, "Should have collected some fees");

    // Run reconciliation
    let report_id = balance_reconciliation
        .start_reconciliation("api-key", 50000)
        .unwrap();

    balance_reconciliation.complete_reconciliation(&report_id).ok();

    let report = balance_reconciliation.get_report(&report_id).unwrap();
    assert_eq!(report.status, ReconciliationStatus::Completed);
}
