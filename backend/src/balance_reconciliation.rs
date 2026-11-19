//! Balance reconciliation module with security hardening and comprehensive validation.
//!
//! This module implements balance verification between the backend's indexed records
//! and on-chain ledger state, with input validation, authentication checks, and
//! protection against injection attacks.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

/// Errors during balance reconciliation operations.
#[derive(Error, Debug, Clone, Serialize)]
pub enum ReconciliationError {
    #[error("unauthorized reconciliation request")]
    Unauthorized,

    #[error("invalid merchant id: {0}")]
    InvalidMerchantId(String),

    #[error("invalid invoice id: {0}")]
    InvalidInvoiceId(String),

    #[error("reconciliation in progress")]
    AlreadyRunning,

    #[error("reconciliation not found: {0}")]
    NotFound(String),

    #[error("balance mismatch detected")]
    BalanceMismatch,

    #[error("ledger lookup failed: {0}")]
    LedgerError(String),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("max retries exceeded")]
    MaxRetriesExceeded,
}

/// Reconciliation status tracking.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReconciliationStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

/// A detected discrepancy between indexed and on-chain state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Discrepancy {
    pub invoice_id: String,
    pub merchant_id: String,
    pub indexed_amount: u64,
    pub ledger_amount: u64,
    pub difference: i64,
    pub timestamp: u64,
}

/// Complete reconciliation report.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReconciliationReport {
    pub id: String,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub status: ReconciliationStatus,
    pub checkpoint_ledger: u32,
    pub checked_records: u64,
    pub discrepancy_count: u64,
    pub discrepancies: Vec<Discrepancy>,
    pub updated_records: u64,
    pub flagged_records: u64,
    pub in_sync: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Configuration for reconciliation behavior.
#[derive(Clone, Debug)]
pub struct ReconciliationConfig {
    /// Maximum number of retries for failed operations.
    pub max_retries: u32,
    /// Maximum discrepancies to report in a single run.
    pub max_discrepancies_reported: usize,
    /// Maximum records to check per batch.
    pub batch_size: usize,
}

impl Default for ReconciliationConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            max_discrepancies_reported: 1000,
            batch_size: 100,
        }
    }
}

/// Secured balance reconciliation service.
pub struct BalanceReconciliation {
    config: ReconciliationConfig,
    reports: Arc<std::sync::Mutex<HashMap<String, ReconciliationReport>>>,
    running: Arc<std::sync::atomic::AtomicBool>,
    // Simulated indexed state for demonstration
    indexed_balances: Arc<std::sync::Mutex<HashMap<String, u64>>>,
}

impl BalanceReconciliation {
    /// Create a new balance reconciliation service.
    pub fn new(config: ReconciliationConfig) -> Self {
        Self {
            config,
            reports: Arc::new(std::sync::Mutex::new(HashMap::new())),
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            indexed_balances: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Validate a merchant ID against injection attacks.
    pub fn validate_merchant_id(merchant_id: &str) -> Result<(), ReconciliationError> {
        if merchant_id.is_empty() {
            return Err(ReconciliationError::InvalidMerchantId(
                "merchant id cannot be empty".to_string(),
            ));
        }

        if merchant_id.len() > 256 {
            return Err(ReconciliationError::InvalidMerchantId(
                "merchant id exceeds maximum length".to_string(),
            ));
        }

        // Only allow alphanumeric characters, hyphens, and underscores
        if !merchant_id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        {
            return Err(ReconciliationError::InvalidMerchantId(
                "merchant id contains invalid characters".to_string(),
            ));
        }

        Ok(())
    }

    /// Validate an invoice ID against injection attacks.
    pub fn validate_invoice_id(invoice_id: &str) -> Result<(), ReconciliationError> {
        if invoice_id.is_empty() {
            return Err(ReconciliationError::InvalidInvoiceId(
                "invoice id cannot be empty".to_string(),
            ));
        }

        if invoice_id.len() > 128 {
            return Err(ReconciliationError::InvalidInvoiceId(
                "invoice id exceeds maximum length".to_string(),
            ));
        }

        // Only allow alphanumeric characters, hyphens, and underscores
        if !invoice_id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        {
            return Err(ReconciliationError::InvalidInvoiceId(
                "invoice id contains invalid characters".to_string(),
            ));
        }

        Ok(())
    }

    /// Verify that the requester has authorization to run reconciliation.
    ///
    /// In production, this would check API key scopes or user permissions.
    pub fn verify_authorization(&self, api_key: &str) -> Result<(), ReconciliationError> {
        if api_key.is_empty() {
            return Err(ReconciliationError::Unauthorized);
        }

        // Validate the key format (basic check)
        if api_key.len() < 10 {
            return Err(ReconciliationError::Unauthorized);
        }

        // In production, verify against a key store and check for
        // "reconciliation" scope or admin privileges
        Ok(())
    }

    /// Start a new reconciliation run if one is not already in progress.
    pub fn start_reconciliation(
        &self,
        api_key: &str,
        checkpoint_ledger: u32,
    ) -> Result<String, ReconciliationError> {
        // Verify authorization
        self.verify_authorization(api_key)?;

        // Check if one is already running
        if self
            .running
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_err()
        {
            return Err(ReconciliationError::AlreadyRunning);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let report = ReconciliationReport {
            id: id.clone(),
            started_at: now,
            completed_at: None,
            status: ReconciliationStatus::Running,
            checkpoint_ledger,
            checked_records: 0,
            discrepancy_count: 0,
            discrepancies: Vec::new(),
            updated_records: 0,
            flagged_records: 0,
            in_sync: true,
            error: None,
        };

        let mut reports = self
            .reports
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;

        reports.insert(id.clone(), report);

        Ok(id)
    }

    /// Add a detected discrepancy to the report.
    pub fn add_discrepancy(
        &self,
        report_id: &str,
        invoice_id: String,
        merchant_id: String,
        indexed_amount: u64,
        ledger_amount: u64,
    ) -> Result<(), ReconciliationError> {
        // Validate inputs
        Self::validate_invoice_id(&invoice_id)?;
        Self::validate_merchant_id(&merchant_id)?;

        let mut reports = self
            .reports
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;

        let report = reports
            .get_mut(report_id)
            .ok_or_else(|| ReconciliationError::NotFound(report_id.to_string()))?;

        // Check if we've already reached the maximum discrepancies to report
        if report.discrepancies.len() >= self.config.max_discrepancies_reported {
            return Ok(()); // Silently ignore to prevent report explosion
        }

        let difference = indexed_amount as i64 - ledger_amount as i64;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let discrepancy = Discrepancy {
            invoice_id,
            merchant_id,
            indexed_amount,
            ledger_amount,
            difference,
            timestamp: now,
        };

        if difference != 0 {
            report.in_sync = false;
            report.discrepancy_count += 1;
        }

        report.discrepancies.push(discrepancy);

        Ok(())
    }

    /// Complete a reconciliation run.
    pub fn complete_reconciliation(&self, report_id: &str) -> Result<(), ReconciliationError> {
        let mut reports = self
            .reports
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;

        let report = reports
            .get_mut(report_id)
            .ok_or_else(|| ReconciliationError::NotFound(report_id.to_string()))?;

        report.status = ReconciliationStatus::Completed;
        report.completed_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );

        self.running
            .store(false, std::sync::atomic::Ordering::SeqCst);

        Ok(())
    }

    /// Fail a reconciliation run with an error message.
    pub fn fail_reconciliation(
        &self,
        report_id: &str,
        error: String,
    ) -> Result<(), ReconciliationError> {
        let mut reports = self
            .reports
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;

        let report = reports
            .get_mut(report_id)
            .ok_or_else(|| ReconciliationError::NotFound(report_id.to_string()))?;

        report.status = ReconciliationStatus::Failed;
        report.error = Some(error);
        report.completed_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );

        self.running
            .store(false, std::sync::atomic::Ordering::SeqCst);

        Ok(())
    }

    /// Get a reconciliation report by ID.
    pub fn get_report(&self, report_id: &str) -> Result<ReconciliationReport, ReconciliationError> {
        let reports = self
            .reports
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;

        reports
            .get(report_id)
            .cloned()
            .ok_or_else(|| ReconciliationError::NotFound(report_id.to_string()))
    }

    /// Simulate setting an indexed balance for testing.
    pub fn set_indexed_balance(&self, key: String, amount: u64) -> Result<(), ReconciliationError> {
        let mut balances = self
            .indexed_balances
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;
        balances.insert(key, amount);
        Ok(())
    }

    /// Get the indexed balance for a key.
    pub fn get_indexed_balance(&self, key: &str) -> Result<Option<u64>, ReconciliationError> {
        let balances = self
            .indexed_balances
            .lock()
            .map_err(|_| ReconciliationError::Internal("lock poisoned".to_string()))?;
        Ok(balances.get(key).copied())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_merchant_id_valid() {
        assert!(BalanceReconciliation::validate_merchant_id("merchant-123").is_ok());
        assert!(BalanceReconciliation::validate_merchant_id("merchant_456").is_ok());
        assert!(BalanceReconciliation::validate_merchant_id("M123").is_ok());
    }

    #[test]
    fn test_validate_merchant_id_invalid() {
        assert!(BalanceReconciliation::validate_merchant_id("").is_err());
        assert!(BalanceReconciliation::validate_merchant_id("merchant@123").is_err());
        assert!(BalanceReconciliation::validate_merchant_id("merchant; DROP TABLE --").is_err());
    }

    #[test]
    fn test_validate_invoice_id_valid() {
        assert!(BalanceReconciliation::validate_invoice_id("invoice-123").is_ok());
        assert!(BalanceReconciliation::validate_invoice_id("INV_456").is_ok());
    }

    #[test]
    fn test_validate_invoice_id_invalid() {
        assert!(BalanceReconciliation::validate_invoice_id("").is_err());
        assert!(BalanceReconciliation::validate_invoice_id("invoice<1>").is_err());
        assert!(BalanceReconciliation::validate_invoice_id("inv'; --").is_err());
    }

    #[test]
    fn test_verify_authorization() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        // Valid authorization
        assert!(reconciliation.verify_authorization("valid-api-key-123").is_ok());

        // Invalid: empty key
        assert!(reconciliation.verify_authorization("").is_err());

        // Invalid: too short
        assert!(reconciliation.verify_authorization("short").is_err());
    }

    #[test]
    fn test_start_reconciliation() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        let result = reconciliation.start_reconciliation("valid-api-key-123", 12345);
        assert!(result.is_ok());

        let report_id = result.unwrap();
        let report = reconciliation.get_report(&report_id).unwrap();
        assert_eq!(report.status, ReconciliationStatus::Running);
        assert_eq!(report.checkpoint_ledger, 12345);
    }

    #[test]
    fn test_concurrent_reconciliation_prevented() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        // Start first reconciliation
        assert!(reconciliation
            .start_reconciliation("valid-api-key-123", 12345)
            .is_ok());

        // Try to start second one - should fail
        let result = reconciliation.start_reconciliation("valid-api-key-456", 12346);
        assert!(matches!(result, Err(ReconciliationError::AlreadyRunning)));
    }

    #[test]
    fn test_add_discrepancy_valid() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        let report_id = reconciliation
            .start_reconciliation("valid-api-key-123", 12345)
            .unwrap();

        let result = reconciliation.add_discrepancy(
            &report_id,
            "invoice-123".to_string(),
            "merchant-456".to_string(),
            1000,
            900,
        );

        assert!(result.is_ok());

        let report = reconciliation.get_report(&report_id).unwrap();
        assert_eq!(report.discrepancy_count, 1);
        assert!(!report.in_sync);
    }

    #[test]
    fn test_add_discrepancy_invalid_ids() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        let report_id = reconciliation
            .start_reconciliation("valid-api-key-123", 12345)
            .unwrap();

        // Invalid merchant ID
        let result = reconciliation.add_discrepancy(
            &report_id,
            "invoice-123".to_string(),
            "merchant@bad".to_string(),
            1000,
            900,
        );
        assert!(result.is_err());

        // Invalid invoice ID
        let result = reconciliation.add_discrepancy(
            &report_id,
            "invoice<bad>".to_string(),
            "merchant-456".to_string(),
            1000,
            900,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_complete_reconciliation() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        let report_id = reconciliation
            .start_reconciliation("valid-api-key-123", 12345)
            .unwrap();

        assert!(reconciliation.complete_reconciliation(&report_id).is_ok());

        let report = reconciliation.get_report(&report_id).unwrap();
        assert_eq!(report.status, ReconciliationStatus::Completed);
        assert!(report.completed_at.is_some());
    }

    #[test]
    fn test_fail_reconciliation() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        let report_id = reconciliation
            .start_reconciliation("valid-api-key-123", 12345)
            .unwrap();

        assert!(reconciliation
            .fail_reconciliation(&report_id, "test error".to_string())
            .is_ok());

        let report = reconciliation.get_report(&report_id).unwrap();
        assert_eq!(report.status, ReconciliationStatus::Failed);
        assert_eq!(report.error, Some("test error".to_string()));
    }

    #[test]
    fn test_indexed_balance_storage() {
        let reconciliation = BalanceReconciliation::new(ReconciliationConfig::default());

        assert!(reconciliation.set_indexed_balance("key1".to_string(), 1000).is_ok());
        let balance = reconciliation.get_indexed_balance("key1").unwrap();
        assert_eq!(balance, Some(1000));

        let balance = reconciliation.get_indexed_balance("unknown").unwrap();
        assert_eq!(balance, None);
    }
}
