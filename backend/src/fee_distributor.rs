//! Fee distributor module for managing and validating fee calculations and distributions.
//!
//! This module handles the safe distribution of fees during high-load scenarios,
//! with comprehensive error handling, validation, and resilience against edge cases.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;

/// Errors that can occur during fee distribution operations.
#[derive(Error, Debug, Clone, Serialize)]
pub enum FeeDistributorError {
    #[error("fee amount exceeds gross amount")]
    FeeExceedsGross,

    #[error("invalid fee percentage: {0}")]
    InvalidFeePercentage(String),

    #[error("amount overflow during calculation")]
    AmountOverflow,

    #[error("zero amount not allowed")]
    ZeroAmount,

    #[error("distribution queue saturated, too many pending operations")]
    QueueSaturated,

    #[error("invalid receiver address: {0}")]
    InvalidReceiver(String),

    #[error("concurrent distribution limit exceeded")]
    ConcurrencyLimitExceeded,

    #[error("internal distribution error: {0}")]
    Internal(String),
}

/// Configuration for fee distribution behavior.
#[derive(Clone, Debug)]
pub struct FeeDistributorConfig {
    /// Maximum concurrent distribution operations during high load.
    pub max_concurrent_distributions: usize,
    /// Maximum pending distributions before rejecting new ones.
    pub max_queue_depth: usize,
    /// Fee percentage as parts per thousand (e.g., 50 = 5%).
    pub fee_percentage_ppt: u32,
    /// Minimum fee to charge, in stroops.
    pub min_fee_stroops: u64,
}

impl Default for FeeDistributorConfig {
    fn default() -> Self {
        Self {
            max_concurrent_distributions: 100,
            max_queue_depth: 10_000,
            fee_percentage_ppt: 50, // 5% default
            min_fee_stroops: 1000,
        }
    }
}

/// Validated fee calculation result.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeeCalculation {
    /// Gross amount in stroops (including fees).
    pub gross_amount: u64,
    /// Net amount after fees in stroops.
    pub net_amount: u64,
    /// Fee amount in stroops.
    pub fee_amount: u64,
}

impl FeeCalculation {
    /// Validate that the calculation is internally consistent.
    pub fn validate(&self) -> Result<(), FeeDistributorError> {
        // Check for overflow: gross = net + fee
        if let Some(calculated_gross) = self.net_amount.checked_add(self.fee_amount) {
            if calculated_gross != self.gross_amount {
                return Err(FeeDistributorError::Internal(
                    "fee calculation mismatch".to_string(),
                ));
            }
        } else {
            return Err(FeeDistributorError::AmountOverflow);
        }

        // Ensure fee is not greater than gross
        if self.fee_amount > self.gross_amount {
            return Err(FeeDistributorError::FeeExceedsGross);
        }

        Ok(())
    }
}

/// Distribution status tracking for a fee distribution operation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum DistributionStatus {
    Pending,
    Processing,
    Completed,
    Failed,
}

/// A fee distribution operation with tracking.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeeDistribution {
    pub id: String,
    pub merchant: String,
    pub amount: u64,
    pub calculation: FeeCalculation,
    pub status: DistributionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Safe fee distributor with validation and error recovery.
pub struct FeeDistributor {
    config: FeeDistributorConfig,
    distributions: Arc<std::sync::Mutex<Vec<FeeDistribution>>>,
    active_count: Arc<std::sync::atomic::AtomicUsize>,
}

impl FeeDistributor {
    /// Create a new fee distributor with the given configuration.
    pub fn new(config: FeeDistributorConfig) -> Self {
        Self {
            config,
            distributions: Arc::new(std::sync::Mutex::new(Vec::new())),
            active_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    /// Calculate fees for a given gross amount.
    pub fn calculate_fees(&self, gross_amount: u64) -> Result<FeeCalculation, FeeDistributorError> {
        // Validate input
        if gross_amount == 0 {
            return Err(FeeDistributorError::ZeroAmount);
        }

        // Calculate fee based on percentage
        let fee_from_percentage = gross_amount
            .checked_mul(self.config.fee_percentage_ppt as u64)
            .and_then(|f| f.checked_div(1000))
            .ok_or(FeeDistributorError::AmountOverflow)?;

        // Apply minimum fee threshold
        let fee_amount = fee_from_percentage.max(self.config.min_fee_stroops);

        // Calculate net amount
        let net_amount = gross_amount
            .checked_sub(fee_amount)
            .ok_or(FeeDistributorError::AmountOverflow)?;

        let calculation = FeeCalculation {
            gross_amount,
            net_amount,
            fee_amount,
        };

        // Validate the calculation
        calculation.validate()?;

        Ok(calculation)
    }

    /// Validate a fee percentage value.
    pub fn validate_fee_percentage(percentage_ppt: u32) -> Result<(), FeeDistributorError> {
        // Percentage should be between 0 and 100,000 (0% to 10,000%)
        if percentage_ppt > 100_000 {
            return Err(FeeDistributorError::InvalidFeePercentage(
                format!("percentage {} exceeds maximum 100000", percentage_ppt),
            ));
        }
        Ok(())
    }

    /// Validate a receiver address (basic checks).
    pub fn validate_receiver_address(address: &str) -> Result<(), FeeDistributorError> {
        if address.is_empty() {
            return Err(FeeDistributorError::InvalidReceiver(
                "receiver cannot be empty".to_string(),
            ));
        }

        if address.len() < 10 {
            return Err(FeeDistributorError::InvalidReceiver(
                "receiver address too short".to_string(),
            ));
        }

        // Verify address contains no control characters
        if address.chars().any(|c| c.is_control()) {
            return Err(FeeDistributorError::InvalidReceiver(
                "receiver address contains invalid characters".to_string(),
            ));
        }

        Ok(())
    }

    /// Queue a fee distribution operation.
    ///
    /// Returns an error if the system is under high load and cannot accept
    /// more operations, ensuring graceful degradation rather than failures.
    pub fn queue_distribution(
        &self,
        id: String,
        merchant: String,
        amount: u64,
    ) -> Result<FeeDistribution, FeeDistributorError> {
        // Check concurrency limits
        let active = self
            .active_count
            .load(std::sync::atomic::Ordering::Relaxed);
        if active >= self.config.max_concurrent_distributions {
            return Err(FeeDistributorError::ConcurrencyLimitExceeded);
        }

        // Check queue depth
        let mut distributions = self
            .distributions
            .lock()
            .map_err(|_| FeeDistributorError::Internal("lock poisoned".to_string()))?;

        if distributions.len() >= self.config.max_queue_depth {
            return Err(FeeDistributorError::QueueSaturated);
        }

        // Calculate fees
        let calculation = self.calculate_fees(amount)?;

        let distribution = FeeDistribution {
            id,
            merchant,
            amount,
            calculation,
            status: DistributionStatus::Pending,
            error: None,
        };

        distributions.push(distribution.clone());
        Ok(distribution)
    }

    /// Mark a distribution as completed.
    pub fn mark_completed(&self, id: &str) -> Result<(), FeeDistributorError> {
        let mut distributions = self
            .distributions
            .lock()
            .map_err(|_| FeeDistributorError::Internal("lock poisoned".to_string()))?;

        if let Some(dist) = distributions.iter_mut().find(|d| d.id == id) {
            dist.status = DistributionStatus::Completed;
            self.active_count
                .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        } else {
            Err(FeeDistributorError::Internal(format!(
                "distribution {} not found",
                id
            )))
        }
    }

    /// Mark a distribution as failed with an error message.
    pub fn mark_failed(&self, id: &str, error: String) -> Result<(), FeeDistributorError> {
        let mut distributions = self
            .distributions
            .lock()
            .map_err(|_| FeeDistributorError::Internal("lock poisoned".to_string()))?;

        if let Some(dist) = distributions.iter_mut().find(|d| d.id == id) {
            dist.status = DistributionStatus::Failed;
            dist.error = Some(error);
            self.active_count
                .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        } else {
            Err(FeeDistributorError::Internal(format!(
                "distribution {} not found",
                id
            )))
        }
    }

    /// Get the status of a distribution.
    pub fn get_status(&self, id: &str) -> Result<DistributionStatus, FeeDistributorError> {
        let distributions = self
            .distributions
            .lock()
            .map_err(|_| FeeDistributorError::Internal("lock poisoned".to_string()))?;

        distributions
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.status.clone())
            .ok_or_else(|| {
                FeeDistributorError::Internal(format!("distribution {} not found", id))
            })
    }

    /// Get the count of active distributions.
    pub fn active_count(&self) -> usize {
        self.active_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Get the current queue depth.
    pub fn queue_depth(&self) -> Result<usize, FeeDistributorError> {
        let distributions = self
            .distributions
            .lock()
            .map_err(|_| FeeDistributorError::Internal("lock poisoned".to_string()))?;
        Ok(distributions.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_fees_basic() {
        let distributor = FeeDistributor::new(FeeDistributorConfig::default());
        let result = distributor.calculate_fees(100_000).unwrap();

        assert_eq!(result.gross_amount, 100_000);
        assert!(result.fee_amount > 0);
        assert!(result.net_amount > 0);
        assert_eq!(result.gross_amount, result.net_amount + result.fee_amount);
    }

    #[test]
    fn test_calculate_fees_zero_amount() {
        let distributor = FeeDistributor::new(FeeDistributorConfig::default());
        assert!(matches!(
            distributor.calculate_fees(0),
            Err(FeeDistributorError::ZeroAmount)
        ));
    }

    #[test]
    fn test_calculate_fees_overflow() {
        let distributor = FeeDistributor::new(FeeDistributorConfig::default());
        let result = distributor.calculate_fees(u64::MAX);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_fee_percentage() {
        assert!(FeeDistributor::validate_fee_percentage(50).is_ok());
        assert!(FeeDistributor::validate_fee_percentage(100_000).is_ok());
        assert!(FeeDistributor::validate_fee_percentage(100_001).is_err());
    }

    #[test]
    fn test_validate_receiver_address() {
        assert!(FeeDistributor::validate_receiver_address("GVALIDADDRESS123456789").is_ok());
        assert!(FeeDistributor::validate_receiver_address("").is_err());
        assert!(FeeDistributor::validate_receiver_address("SHORT").is_err());
    }

    #[test]
    fn test_queue_distribution() {
        let distributor = FeeDistributor::new(FeeDistributorConfig::default());
        let result =
            distributor.queue_distribution("dist-1".to_string(), "merchant-1".to_string(), 100_000);

        assert!(result.is_ok());
        let dist = result.unwrap();
        assert_eq!(dist.status, DistributionStatus::Pending);
    }

    #[test]
    fn test_queue_saturation() {
        let config = FeeDistributorConfig {
            max_queue_depth: 2,
            ..Default::default()
        };
        let distributor = FeeDistributor::new(config);

        // Queue first distribution
        assert!(distributor
            .queue_distribution("dist-1".to_string(), "merchant-1".to_string(), 100_000)
            .is_ok());

        // Queue second distribution
        assert!(distributor
            .queue_distribution("dist-2".to_string(), "merchant-1".to_string(), 100_000)
            .is_ok());

        // Third should fail due to queue saturation
        let result =
            distributor.queue_distribution("dist-3".to_string(), "merchant-1".to_string(), 100_000);
        assert!(matches!(result, Err(FeeDistributorError::QueueSaturated)));
    }

    #[test]
    fn test_mark_completed() {
        let distributor = FeeDistributor::new(FeeDistributorConfig::default());
        let dist =
            distributor.queue_distribution("dist-1".to_string(), "merchant-1".to_string(), 100_000);

        assert!(dist.is_ok());
        assert!(distributor.mark_completed("dist-1").is_ok());
        assert_eq!(
            distributor.get_status("dist-1").unwrap(),
            DistributionStatus::Completed
        );
    }

    #[test]
    fn test_mark_failed() {
        let distributor = FeeDistributor::new(FeeDistributorConfig::default());
        distributor.queue_distribution("dist-1".to_string(), "merchant-1".to_string(), 100_000);

        assert!(distributor
            .mark_failed("dist-1", "test error".to_string())
            .is_ok());
        assert_eq!(
            distributor.get_status("dist-1").unwrap(),
            DistributionStatus::Failed
        );
    }
}
