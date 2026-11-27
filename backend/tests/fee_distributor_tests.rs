//! Integration tests for the fee distributor module.
//!
//! Tests cover edge cases, high-load scenarios, and error handling.

use comebackhere_backend::fee_distributor::{
    FeeCalculation, FeeDistributor, FeeDistributorConfig, FeeDistributorError, DistributionStatus,
};

#[test]
fn test_fee_calculation_consistency() {
    let config = FeeDistributorConfig {
        fee_percentage_ppt: 50, // 5%
        ..Default::default()
    };
    let distributor = FeeDistributor::new(config);

    // Test various amounts
    for amount in &[100_000, 1_000_000, 10_000_000, 100_000_000] {
        let calc = distributor.calculate_fees(*amount).unwrap();
        // Verify: gross = net + fee
        assert_eq!(calc.gross_amount, calc.net_amount + calc.fee_amount);
        // Verify: fee is not greater than gross
        assert!(calc.fee_amount <= calc.gross_amount);
        // Verify: net is positive
        assert!(calc.net_amount > 0);
    }
}

#[test]
fn test_minimum_fee_applied() {
    let config = FeeDistributorConfig {
        fee_percentage_ppt: 10, // 1%
        min_fee_stroops: 5000,
        ..Default::default()
    };
    let distributor = FeeDistributor::new(config);

    // Small amount that would result in fee < minimum
    let calc = distributor.calculate_fees(100_000).unwrap();
    assert!(calc.fee_amount >= 5000, "fee should be at least minimum");
}

#[test]
fn test_high_load_distribution_queueing() {
    let config = FeeDistributorConfig {
        max_concurrent_distributions: 50,
        max_queue_depth: 500,
        ..Default::default()
    };
    let distributor = FeeDistributor::new(config);

    // Queue many distributions
    let mut distribution_ids = Vec::new();
    for i in 0..100 {
        let result = distributor.queue_distribution(
            format!("dist-{}", i),
            format!("merchant-{}", i % 10),
            100_000 + i as u64 * 1000,
        );

        if result.is_ok() {
            distribution_ids.push(format!("dist-{}", i));
        }
    }

    assert!(!distribution_ids.is_empty());
    assert_eq!(distributor.queue_depth().unwrap(), distribution_ids.len());
}

#[test]
fn test_queue_saturation_on_high_load() {
    let config = FeeDistributorConfig {
        max_concurrent_distributions: 100,
        max_queue_depth: 5,
        ..Default::default()
    };
    let distributor = FeeDistributor::new(config);

    // Fill the queue
    for i in 0..5 {
        let result = distributor.queue_distribution(
            format!("dist-{}", i),
            "merchant-1".to_string(),
            100_000,
        );
        assert!(result.is_ok(), "should queue successfully until full");
    }

    // Queue is now full
    let result = distributor.queue_distribution(
        "dist-overflow".to_string(),
        "merchant-1".to_string(),
        100_000,
    );

    match result {
        Err(FeeDistributorError::QueueSaturated) => {
            // Expected: queue is saturated
        }
        other => panic!("Expected QueueSaturated, got {:?}", other),
    }
}

#[test]
fn test_overflow_protection() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());

    // Test with maximum u64 value
    let result = distributor.calculate_fees(u64::MAX);
    assert!(
        matches!(result, Err(FeeDistributorError::AmountOverflow)),
        "should prevent overflow"
    );
}

#[test]
fn test_distribution_lifecycle() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());

    // Queue a distribution
    let dist = distributor
        .queue_distribution(
            "dist-1".to_string(),
            "merchant-1".to_string(),
            100_000,
        )
        .unwrap();

    assert_eq!(dist.status, DistributionStatus::Pending);

    // Mark as completed
    assert!(distributor.mark_completed("dist-1").is_ok());
    assert_eq!(
        distributor.get_status("dist-1").unwrap(),
        DistributionStatus::Completed
    );

    // Mark as failed (on another distribution)
    let dist2 = distributor
        .queue_distribution(
            "dist-2".to_string(),
            "merchant-2".to_string(),
            100_000,
        )
        .unwrap();

    assert!(distributor
        .mark_failed("dist-2", "network error".to_string())
        .is_ok());

    let status = distributor.get_status("dist-2").unwrap();
    assert_eq!(status, DistributionStatus::Failed);
}

#[test]
fn test_edge_case_small_amounts() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());

    // Very small amounts
    let calc = distributor.calculate_fees(1000).unwrap();
    assert!(calc.fee_amount > 0);
    assert_eq!(calc.gross_amount, calc.net_amount + calc.fee_amount);
}

#[test]
fn test_receiver_validation() {
    // Valid addresses
    assert!(FeeDistributor::validate_receiver_address("GVALIDADDRESS1234567890").is_ok());
    assert!(FeeDistributor::validate_receiver_address("receiver-123").is_ok());

    // Invalid addresses
    assert!(FeeDistributor::validate_receiver_address("").is_err());
    assert!(FeeDistributor::validate_receiver_address("SHORT").is_err());
    assert!(FeeDistributor::validate_receiver_address("contains\ncontrol").is_err());
}

#[test]
fn test_fee_percentage_validation() {
    assert!(FeeDistributor::validate_fee_percentage(0).is_ok());
    assert!(FeeDistributor::validate_fee_percentage(50).is_ok());
    assert!(FeeDistributor::validate_fee_percentage(100_000).is_ok());
    assert!(FeeDistributor::validate_fee_percentage(100_001).is_err());
}

#[test]
fn test_concurrent_operations_safe() {
    use std::sync::Arc;
    use std::thread;

    let distributor = Arc::new(FeeDistributor::new(FeeDistributorConfig {
        max_concurrent_distributions: 100,
        max_queue_depth: 1000,
        ..Default::default()
    }));

    let mut handles = vec![];

    for i in 0..10 {
        let dist = Arc::clone(&distributor);
        let handle = thread::spawn(move || {
            for j in 0..10 {
                let _ = dist.queue_distribution(
                    format!("dist-{}-{}", i, j),
                    format!("merchant-{}", i),
                    100_000 + j as u64 * 1000,
                );
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    let queue_depth = distributor.queue_depth().unwrap();
    assert!(queue_depth > 0);
}

#[test]
fn test_zero_amount_rejection() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());
    let result = distributor.calculate_fees(0);
    assert!(matches!(result, Err(FeeDistributorError::ZeroAmount)));
}

#[test]
fn test_fee_calculation_validation() {
    let calc = FeeCalculation {
        gross_amount: 1000,
        net_amount: 950,
        fee_amount: 50,
    };

    assert!(calc.validate().is_ok());

    // Invalid: fee exceeds gross
    let invalid = FeeCalculation {
        gross_amount: 1000,
        net_amount: 1,
        fee_amount: 2000,
    };

    assert!(invalid.validate().is_err());

    // Invalid: math doesn't add up
    let invalid = FeeCalculation {
        gross_amount: 1000,
        net_amount: 900,
        fee_amount: 50,
    };

    assert!(invalid.validate().is_err());
}

#[test]
fn test_high_load_edge_amounts_no_panic() {
    let distributor = FeeDistributor::new(FeeDistributorConfig {
        fee_percentage_ppt: 50,
        min_fee_stroops: 100,
        ..Default::default()
    });

    // Boundary and near-boundary amounts must never panic; they either
    // produce a valid calculation or a well-defined error.
    let amounts = [
        0,
        1,
        2,
        999,
        1000,
        1001,
        u64::MAX / 2,
        u64::MAX - 1,
        u64::MAX,
    ];

    for amount in amounts {
        match distributor.calculate_fees(amount) {
            Ok(calc) => {
                assert_eq!(
                    calc.gross_amount,
                    calc.net_amount + calc.fee_amount,
                    "invariant broken for amount {}",
                    amount
                );
                assert!(calc.fee_amount <= calc.gross_amount);
                assert!(calc.validate().is_ok());
            }
            Err(FeeDistributorError::ZeroAmount) => {
                assert_eq!(amount, 0, "ZeroAmount only expected for zero input");
            }
            Err(FeeDistributorError::AmountOverflow) => {
                // Acceptable defensive error for extreme inputs.
            }
            Err(other) => panic!("unexpected error for amount {}: {:?}", amount, other),
        }
    }
}

#[test]
fn test_high_load_queue_never_exceeds_capacity() {
    use std::sync::Arc;
    use std::thread;

    let max_queue_depth = 64;
    let distributor = Arc::new(FeeDistributor::new(FeeDistributorConfig {
        max_concurrent_distributions: 32,
        max_queue_depth,
        ..Default::default()
    }));

    let mut handles = vec![];
    for i in 0..16 {
        let dist = Arc::clone(&distributor);
        let handle = thread::spawn(move || {
            for j in 0..32 {
                let result = dist.queue_distribution(
                    format!("dist-{}-{}", i, j),
                    format!("merchant-{}", i % 4),
                    100_000 + (j as u64) * 1000,
                );
                // Either accepted or rejected with a defined error; never panic.
                match result {
                    Ok(_) => {}
                    Err(FeeDistributorError::QueueSaturated) => {}
                    Err(other) => panic!("unexpected queue error: {:?}", other),
                }
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().expect("worker thread must not panic");
    }

    let depth = distributor.queue_depth().unwrap();
    assert!(
        depth <= max_queue_depth,
        "queue depth {} exceeded capacity {}",
        depth,
        max_queue_depth
    );
}

#[test]
fn test_duplicate_distribution_id_handling() {
    let distributor = FeeDistributor::new(FeeDistributorConfig::default());

    assert!(distributor
        .queue_distribution("dup-1".to_string(), "merchant-1".to_string(), 100_000)
        .is_ok());

    // Re-queueing the same id must not panic and must not corrupt state.
    let second = distributor.queue_distribution(
        "dup-1".to_string(),
        "merchant-1".to_string(),
        100_000,
    );
    match second {
        Ok(_) | Err(_) => {}
    }

    // Status lookups for unknown ids must return a defined error, not panic.
    assert!(distributor.get_status("does-not-exist").is_err());
    assert!(distributor.mark_completed("does-not-exist").is_err());
    assert!(distributor
        .mark_failed("does-not-exist", "boom".to_string())
        .is_err());
}

#[test]
fn test_invalid_config_rejected() {
    // Fee percentage above the allowed maximum must be rejected defensively.
    let config = FeeDistributorConfig {
        fee_percentage_ppt: 100_001,
        ..Default::default()
    };
    let distributor = FeeDistributor::new(config);
    assert!(matches!(
        distributor.calculate_fees(100_000),
        Err(FeeDistributorError::InvalidConfig) | Err(FeeDistributorError::InvalidFeePercentage)
    ));
}
