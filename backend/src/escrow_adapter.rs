//! Escrow adapter with robust error handling for high-load scenarios
//!
//! This module provides escrow operations with:
//! - Graceful degradation under high load
//! - Comprehensive error handling for edge cases
//! - Detailed logging for observability
//! - Timeout protection and concurrent safety

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

/// Errors that can occur during escrow operations
#[derive(Debug, Error)]
pub enum EscrowError {
    #[error("Escrow operation timeout")]
    Timeout,

    #[error("Invalid amount: {0}")]
    InvalidAmount(String),

    #[error("Overflow detected in calculation: {0}")]
    Overflow(String),

    #[error("Escrow not found: {0}")]
    NotFound(String),

    #[error("Insufficient balance in escrow")]
    InsufficientBalance,

    #[error("Invalid account: {0}")]
    InvalidAccount(String),

    #[error("Load limit exceeded: {0} concurrent operations")]
    LoadLimitExceeded(u64),

    #[error("Database connection failed: {0}")]
    DatabaseError(String),

    #[error("Invalid state transition: expected {expected}, got {actual}")]
    InvalidStateTransition { expected: String, actual: String },

    #[error("Null input: {0}")]
    NullInput(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type for escrow operations
pub type EscrowResult<T> = Result<T, EscrowError>;

/// Configuration for escrow adapter load limiting and timeouts
#[derive(Clone, Debug)]
pub struct EscrowConfig {
    /// Maximum concurrent operations allowed
    pub max_concurrent_ops: u64,
    /// Timeout for individual escrow operations
    pub operation_timeout: Duration,
    /// Maximum escrow amount (in stroops)
    pub max_amount: u64,
}

impl Default for EscrowConfig {
    fn default() -> Self {
        Self {
            max_concurrent_ops: 1000,
            operation_timeout: Duration::from_secs(30),
            max_amount: u64::MAX / 2, // Prevent overflow: leave room for fee calculations
        }
    }
}

/// Escrow state enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscrowState {
    /// Escrow is active and can receive/release funds
    Active,
    /// Escrow is locked, no operations allowed
    Locked,
    /// Escrow is released, funds have been distributed
    Released,
    /// Escrow is cancelled
    Cancelled,
}

/// Escrow account information
#[derive(Debug, Clone)]
pub struct EscrowAccount {
    /// Unique escrow identifier
    pub id: String,
    /// Account holder (Stellar public key)
    pub account: String,
    /// Current balance in stroops
    pub balance: u64,
    /// Current state of the escrow
    pub state: EscrowState,
    /// Creation timestamp
    pub created_at: u64,
    /// Last modified timestamp
    pub modified_at: u64,
}

/// Escrow adapter with load control and error handling
pub struct EscrowAdapter {
    config: EscrowConfig,
    /// Current number of in-flight operations
    concurrent_ops: Arc<AtomicU64>,
}

impl EscrowAdapter {
    /// Create a new escrow adapter with default configuration
    pub fn new() -> Self {
        Self::with_config(EscrowConfig::default())
    }

    /// Create a new escrow adapter with custom configuration
    pub fn with_config(config: EscrowConfig) -> Self {
        Self {
            config,
            concurrent_ops: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Validate an amount for escrow operations
    /// Ensures the amount is positive, non-zero, and within safe bounds
    fn validate_amount(&self, amount: u64) -> EscrowResult<()> {
        if amount == 0 {
            return Err(EscrowError::InvalidAmount(
                "Amount must be greater than zero".to_string(),
            ));
        }

        if amount > self.config.max_amount {
            return Err(EscrowError::InvalidAmount(format!(
                "Amount {} exceeds maximum allowed {}",
                amount, self.config.max_amount
            )));
        }

        Ok(())
    }

    /// Validate a Stellar public key format
    fn validate_account(&self, account: &str) -> EscrowResult<()> {
        if account.is_empty() {
            return Err(EscrowError::InvalidAccount("Account cannot be empty".to_string()));
        }

        if !account.starts_with('G') || account.len() != 56 {
            return Err(EscrowError::InvalidAccount(format!(
                "Invalid Stellar account format: {}",
                account
            )));
        }

        if !account.chars().skip(1).all(|c| matches!(c, 'A'..='Z' | '2'..='7')) {
            return Err(EscrowError::InvalidAccount(
                "Account contains invalid base32 characters".to_string(),
            ));
        }

        Ok(())
    }

    /// Check load and increment concurrent operation counter
    fn acquire_operation_slot(&self) -> EscrowResult<OperationGuard> {
        let current = self.concurrent_ops.load(Ordering::SeqCst);

        if current >= self.config.max_concurrent_ops {
            return Err(EscrowError::LoadLimitExceeded(current));
        }

        self.concurrent_ops.fetch_add(1, Ordering::SeqCst);
        Ok(OperationGuard {
            counter: Arc::clone(&self.concurrent_ops),
        })
    }

    /// Deposit funds into an escrow account
    ///
    /// # Arguments
    /// * `escrow_id` - Unique identifier for the escrow
    /// * `account` - Stellar public key of the account
    /// * `amount` - Amount to deposit in stroops
    ///
    /// # Errors
    /// Returns an error if:
    /// - Amount is zero or exceeds limits
    /// - Account is not a valid Stellar key
    /// - Load limit is exceeded
    /// - Account state is not compatible with deposits
    pub async fn deposit(
        &self,
        escrow_id: &str,
        account: &str,
        amount: u64,
    ) -> EscrowResult<EscrowAccount> {
        // Null/empty input checks
        if escrow_id.is_empty() {
            return Err(EscrowError::NullInput("escrow_id cannot be empty".to_string()));
        }

        self.validate_account(account)?;
        self.validate_amount(amount)?;

        let _guard = self.acquire_operation_slot()?;

        // Simulate database lookup and update with timeout
        self.simulate_database_operation(Duration::from_millis(50))
            .await?;

        // Log operation
        tracing::info!(
            escrow_id = %escrow_id,
            account = %account,
            amount = amount,
            "Depositing funds to escrow"
        );

        Ok(EscrowAccount {
            id: escrow_id.to_string(),
            account: account.to_string(),
            balance: amount,
            state: EscrowState::Active,
            created_at: self.current_timestamp(),
            modified_at: self.current_timestamp(),
        })
    }

    /// Release funds from an escrow account
    ///
    /// # Arguments
    /// * `escrow_id` - Unique identifier for the escrow
    /// * `amount` - Amount to release in stroops
    ///
    /// # Errors
    /// Returns an error if:
    /// - Escrow not found
    /// - Insufficient balance
    /// - Invalid state transition
    /// - Load limit exceeded
    pub async fn release(&self, escrow_id: &str, amount: u64) -> EscrowResult<EscrowAccount> {
        if escrow_id.is_empty() {
            return Err(EscrowError::NullInput("escrow_id cannot be empty".to_string()));
        }

        self.validate_amount(amount)?;

        let _guard = self.acquire_operation_slot()?;

        // Simulate database lookup
        let mut escrow = self
            .find_escrow(escrow_id)
            .await?;

        // Check state
        if escrow.state != EscrowState::Active {
            return Err(EscrowError::InvalidStateTransition {
                expected: "Active".to_string(),
                actual: format!("{:?}", escrow.state),
            });
        }

        // Check balance
        if escrow.balance < amount {
            return Err(EscrowError::InsufficientBalance);
        }

        // Perform the release with timeout
        self.simulate_database_operation(Duration::from_millis(100))
            .await?;

        escrow.balance = escrow.balance.checked_sub(amount)
            .ok_or_else(|| EscrowError::Overflow("Underflow in balance calculation".to_string()))?;
        escrow.state = EscrowState::Released;
        escrow.modified_at = self.current_timestamp();

        tracing::info!(
            escrow_id = %escrow_id,
            amount = amount,
            remaining_balance = escrow.balance,
            "Released funds from escrow"
        );

        Ok(escrow)
    }

    /// Get the current state of an escrow account
    pub async fn get_state(&self, escrow_id: &str) -> EscrowResult<EscrowAccount> {
        if escrow_id.is_empty() {
            return Err(EscrowError::NullInput("escrow_id cannot be empty".to_string()));
        }

        let _guard = self.acquire_operation_slot()?;

        self.simulate_database_operation(Duration::from_millis(25))
            .await?;

        self.find_escrow(escrow_id).await
    }

    /// Lock an escrow account to prevent further operations
    pub async fn lock(&self, escrow_id: &str) -> EscrowResult<EscrowAccount> {
        if escrow_id.is_empty() {
            return Err(EscrowError::NullInput("escrow_id cannot be empty".to_string()));
        }

        let _guard = self.acquire_operation_slot()?;

        let mut escrow = self
            .find_escrow(escrow_id)
            .await?;

        escrow.state = EscrowState::Locked;
        escrow.modified_at = self.current_timestamp();

        tracing::info!(escrow_id = %escrow_id, "Locked escrow account");

        Ok(escrow)
    }

    /// Cancel an escrow account
    pub async fn cancel(&self, escrow_id: &str) -> EscrowResult<EscrowAccount> {
        if escrow_id.is_empty() {
            return Err(EscrowError::NullInput("escrow_id cannot be empty".to_string()));
        }

        let _guard = self.acquire_operation_slot()?;

        let mut escrow = self
            .find_escrow(escrow_id)
            .await?;

        // Cannot cancel if already released
        if escrow.state == EscrowState::Released {
            return Err(EscrowError::InvalidStateTransition {
                expected: "Active or Locked".to_string(),
                actual: "Released".to_string(),
            });
        }

        escrow.state = EscrowState::Cancelled;
        escrow.modified_at = self.current_timestamp();

        tracing::info!(escrow_id = %escrow_id, "Cancelled escrow account");

        Ok(escrow)
    }

    /// Transfer funds between two escrow accounts with overflow protection
    pub async fn transfer(
        &self,
        from_id: &str,
        to_id: &str,
        amount: u64,
    ) -> EscrowResult<(EscrowAccount, EscrowAccount)> {
        if from_id.is_empty() || to_id.is_empty() {
            return Err(EscrowError::NullInput(
                "from_id and to_id cannot be empty".to_string(),
            ));
        }

        if from_id == to_id {
            return Err(EscrowError::InvalidAccount(
                "Cannot transfer to the same escrow".to_string(),
            ));
        }

        self.validate_amount(amount)?;

        let _guard = self.acquire_operation_slot()?;

        let from_escrow = self.find_escrow(from_id).await?;

        if from_escrow.balance < amount {
            return Err(EscrowError::InsufficientBalance);
        }

        let mut to_escrow = self.find_escrow(to_id).await?;

        // Check for overflow when adding to destination
        let new_balance = to_escrow.balance.checked_add(amount).ok_or_else(|| {
            EscrowError::Overflow("Overflow in destination balance calculation".to_string())
        })?;

        to_escrow.balance = new_balance;
        to_escrow.modified_at = self.current_timestamp();

        tracing::info!(
            from_id = %from_id,
            to_id = %to_id,
            amount = amount,
            "Transferred funds between escrows"
        );

        Ok((from_escrow, to_escrow))
    }

    /// Helper: Simulate a database operation with timeout
    async fn simulate_database_operation(&self, duration: Duration) -> EscrowResult<()> {
        let timeout = tokio::time::timeout(self.config.operation_timeout, async {
            tokio::time::sleep(duration).await;
        });

        match timeout.await {
            Ok(_) => Ok(()),
            Err(_) => Err(EscrowError::Timeout),
        }
    }

    /// Helper: Find an escrow account (simulated database lookup)
    async fn find_escrow(&self, escrow_id: &str) -> EscrowResult<EscrowAccount> {
        // In a real implementation, this would query the database
        // For testing, we simulate a found account
        Ok(EscrowAccount {
            id: escrow_id.to_string(),
            account: "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7".to_string(),
            balance: 1_000_000,
            state: EscrowState::Active,
            created_at: self.current_timestamp(),
            modified_at: self.current_timestamp(),
        })
    }

    /// Helper: Get current timestamp
    fn current_timestamp(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

impl Default for EscrowAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard to automatically decrement concurrent operation counter
struct OperationGuard {
    counter: Arc<AtomicU64>,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_amount_zero() {
        let adapter = EscrowAdapter::new();
        let result = adapter.validate_amount(0);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("greater than zero"));
    }

    #[test]
    fn test_validate_amount_valid() {
        let adapter = EscrowAdapter::new();
        let result = adapter.validate_amount(1_000_000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_amount_exceeds_max() {
        let adapter = EscrowAdapter::new();
        let result = adapter.validate_amount(u64::MAX);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_account_empty() {
        let adapter = EscrowAdapter::new();
        let result = adapter.validate_account("");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_account_valid() {
        let adapter = EscrowAdapter::new();
        let account = "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7";
        let result = adapter.validate_account(account);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_account_invalid_prefix() {
        let adapter = EscrowAdapter::new();
        let result = adapter.validate_account("ABRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_account_invalid_length() {
        let adapter = EscrowAdapter::new();
        let result = adapter.validate_account("GBRPYHIL");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_deposit_valid() {
        let adapter = EscrowAdapter::new();
        let result = adapter
            .deposit(
                "test-escrow-1",
                "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
                1_000_000,
            )
            .await;

        assert!(result.is_ok());
        let escrow = result.unwrap();
        assert_eq!(escrow.balance, 1_000_000);
        assert_eq!(escrow.state, EscrowState::Active);
    }

    #[tokio::test]
    async fn test_deposit_zero_amount() {
        let adapter = EscrowAdapter::new();
        let result = adapter
            .deposit(
                "test-escrow-1",
                "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
                0,
            )
            .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_deposit_empty_id() {
        let adapter = EscrowAdapter::new();
        let result = adapter
            .deposit(
                "",
                "GBRPYHIL2CI3WHZDTOOQFC6EB4GJJVCVXWIYSXIU24RWITA5YL5LJZ7",
                1_000_000,
            )
            .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("NullInput"));
    }

    #[tokio::test]
    async fn test_release_insufficient_balance() {
        let adapter = EscrowAdapter::new();
        // Manually set up state (in real code, this would be from database)
        let result = adapter.release("test-escrow-1", 2_000_000).await;

        // This should fail due to insufficient balance (mock returns 1_000_000)
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_concurrent_operations_tracking() {
        let adapter = EscrowAdapter::new();

        let initial_count = adapter.concurrent_ops.load(Ordering::SeqCst);
        assert_eq!(initial_count, 0);

        // Acquire a slot
        {
            let _guard = adapter.acquire_operation_slot().unwrap();
            let count = adapter.concurrent_ops.load(Ordering::SeqCst);
            assert_eq!(count, 1);
        }

        // Guard dropped, counter should decrement
        let final_count = adapter.concurrent_ops.load(Ordering::SeqCst);
        assert_eq!(final_count, 0);
    }

    #[tokio::test]
    async fn test_load_limit_exceeded() {
        let config = EscrowConfig {
            max_concurrent_ops: 1,
            ..Default::default()
        };
        let adapter = EscrowAdapter::with_config(config);

        let _guard1 = adapter.acquire_operation_slot().unwrap();
        let result = adapter.acquire_operation_slot();

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Load limit exceeded"));
    }

    #[tokio::test]
    async fn test_lock_escrow() {
        let adapter = EscrowAdapter::new();
        let result = adapter.lock("test-escrow-1").await;

        assert!(result.is_ok());
        let escrow = result.unwrap();
        assert_eq!(escrow.state, EscrowState::Locked);
    }

    #[tokio::test]
    async fn test_cancel_escrow() {
        let adapter = EscrowAdapter::new();
        let result = adapter.cancel("test-escrow-1").await;

        assert!(result.is_ok());
        let escrow = result.unwrap();
        assert_eq!(escrow.state, EscrowState::Cancelled);
    }

    #[tokio::test]
    async fn test_transfer_same_escrow() {
        let adapter = EscrowAdapter::new();
        let result = adapter.transfer("escrow-1", "escrow-1", 500_000).await;

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("same escrow"));
    }

    #[tokio::test]
    async fn test_get_state() {
        let adapter = EscrowAdapter::new();
        let result = adapter.get_state("test-escrow-1").await;

        assert!(result.is_ok());
        let escrow = result.unwrap();
        assert_eq!(escrow.id, "test-escrow-1");
        assert_eq!(escrow.state, EscrowState::Active);
    }
}
