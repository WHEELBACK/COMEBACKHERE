#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SettlementError {
    NotFound = 1,
    NotPending = 2,
    InsufficientApprovals = 3,
    Unauthorized = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementStatus {
    Pending,
    Executed,
    PartiallyExecuted,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Transfer {
    pub recipient: Address,
    pub amount: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Settlement {
    pub proposer: Address,
    pub transfers: Vec<Transfer>,
    pub approval_weight: u64,
    pub threshold: u64,
    pub status: SettlementStatus,
    /// Indices of transfers that succeeded (populated after execution)
    pub succeeded: Vec<u32>,
    /// Indices of transfers that failed (populated after partial execution)
    pub failed: Vec<u32>,
    /// Simulated transaction hash (ledger sequence as proxy)
    pub tx_hash: Option<Bytes>,
}

#[contracttype]
pub enum DataKey {
    Settlement(u64),
    NextId,
}

/// Result returned by execute_settlement
#[contracttype]
#[derive(Clone, Debug)]
pub struct ExecuteResult {
    pub status: SettlementStatus,
    pub succeeded: Vec<u32>,
    pub failed: Vec<u32>,
    pub tx_hash: Option<Bytes>,
}

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    /// Propose a new settlement. Returns its ID.
    pub fn propose(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        threshold: u64,
    ) -> u64 {
        proposer.require_auth();
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        let settlement = Settlement {
            proposer,
            transfers,
            approval_weight: 0,
            threshold,
            status: SettlementStatus::Pending,
            succeeded: Vec::new(&env),
            failed: Vec::new(&env),
            tx_hash: None,
        };
        env.storage()
            .instance()
            .set(&DataKey::Settlement(id), &settlement);
        env.storage()
            .instance()
            .set(&DataKey::NextId, &(id + 1));
        id
    }

    /// Add approval weight from a signer.
    pub fn approve(env: Env, signer: Address, settlement_id: u64, weight: u64) {
        signer.require_auth();
        let mut s: Settlement = env
            .storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .unwrap();
        s.approval_weight += weight;
        env.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &s);
    }

    /// Execute the settlement.
    ///
    /// - Returns `InsufficientApprovals` when threshold is not met (HTTP 422 equivalent).
    /// - Returns `ExecuteResult` with `PartiallyExecuted` status when some transfers fail.
    /// - Returns `ExecuteResult` with `Executed` status on full success.
    ///
    /// Transfer success is deterministic in the contract: a transfer is considered
    /// failed when `amount == 0` (simulating a transfer-level failure), succeeded otherwise.
    pub fn execute_settlement(
        env: Env,
        caller: Address,
        settlement_id: u64,
    ) -> Result<ExecuteResult, SettlementError> {
        caller.require_auth();

        let mut s: Settlement = env
            .storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .ok_or(SettlementError::NotFound)?;

        if s.status != SettlementStatus::Pending {
            return Err(SettlementError::NotPending);
        }

        if s.approval_weight < s.threshold {
            return Err(SettlementError::InsufficientApprovals);
        }

        let mut succeeded: Vec<u32> = Vec::new(&env);
        let mut failed: Vec<u32> = Vec::new(&env);

        for (i, transfer) in s.transfers.iter().enumerate() {
            // A transfer with amount == 0 is treated as failed.
            if transfer.amount > 0 {
                succeeded.push_back(i as u32);
            } else {
                failed.push_back(i as u32);
            }
        }

        let final_status = if failed.is_empty() {
            SettlementStatus::Executed
        } else {
            SettlementStatus::PartiallyExecuted
        };

        // Use ledger sequence as a stand-in for the transaction hash.
        let seq = env.ledger().sequence();
        let seq_bytes = seq.to_be_bytes();
        let tx_hash = Bytes::from_array(&env, &seq_bytes);

        s.status = final_status.clone();
        s.succeeded = succeeded.clone();
        s.failed = failed.clone();
        s.tx_hash = Some(tx_hash.clone());

        env.storage()
            .instance()
            .set(&DataKey::Settlement(settlement_id), &s);

        Ok(ExecuteResult {
            status: final_status,
            succeeded,
            failed,
            tx_hash: Some(tx_hash),
        })
    }

    pub fn get_settlement(env: Env, settlement_id: u64) -> Result<Settlement, SettlementError> {
        env.storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .ok_or(SettlementError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Env};

    fn setup() -> (Env, soroban_sdk::Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, SettlementContract);
        (env, id)
    }

    fn client<'a>(env: &'a Env, id: &'a soroban_sdk::Address) -> SettlementContractClient<'a> {
        SettlementContractClient::new(env, id)
    }

    fn transfer(env: &Env, amount: u64) -> Transfer {
        Transfer {
            recipient: Address::generate(env),
            amount,
        }
    }

    // ── Case 1: InsufficientApprovals (HTTP 422 equivalent) ─────────────────
    #[test]
    fn test_execute_insufficient_approvals_returns_error() {
        let (env, cid) = setup();
        let c = client(&env, &cid);
        let proposer = Address::generate(&env);

        let transfers = vec![&env, transfer(&env, 1000)];
        let sid = c.propose(&proposer, &transfers, &10u64); // threshold = 10, weight = 0

        let result = c.try_execute_settlement(&proposer, &sid);
        assert_eq!(result, Err(Ok(SettlementError::InsufficientApprovals)));
    }

    // ── Case 2: PartiallyExecuted ────────────────────────────────────────────
    #[test]
    fn test_execute_partially_executed() {
        let (env, cid) = setup();
        let c = client(&env, &cid);
        let proposer = Address::generate(&env);

        // Two transfers: one valid (amount > 0), one invalid (amount == 0)
        let transfers = vec![
            &env,
            transfer(&env, 500),
            Transfer { recipient: Address::generate(&env), amount: 0 },
        ];
        let sid = c.propose(&proposer, &transfers, &1u64);
        c.approve(&proposer, &sid, &1u64); // meets threshold

        let result = c.execute_settlement(&proposer, &sid);

        assert_eq!(result.status, SettlementStatus::PartiallyExecuted);
        assert_eq!(result.succeeded.len(), 1);
        assert_eq!(result.succeeded.get(0).unwrap(), 0u32);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed.get(0).unwrap(), 1u32);
        assert!(result.tx_hash.is_some());
    }

    // ── Case 3: Full success ─────────────────────────────────────────────────
    #[test]
    fn test_execute_full_success() {
        let (env, cid) = setup();
        let c = client(&env, &cid);
        let proposer = Address::generate(&env);

        let transfers = vec![
            &env,
            transfer(&env, 1000),
            transfer(&env, 2000),
        ];
        let sid = c.propose(&proposer, &transfers, &2u64);
        c.approve(&proposer, &sid, &2u64);

        let result = c.execute_settlement(&proposer, &sid);

        assert_eq!(result.status, SettlementStatus::Executed);
        assert_eq!(result.succeeded.len(), 2);
        assert_eq!(result.failed.len(), 0);
        assert!(result.tx_hash.is_some());

        // Confirm stored state updated
        let stored = c.get_settlement(&sid);
        assert_eq!(stored.status, SettlementStatus::Executed);
    }

    // ── Guard: double-execute returns NotPending ─────────────────────────────
    #[test]
    fn test_execute_twice_returns_not_pending() {
        let (env, cid) = setup();
        let c = client(&env, &cid);
        let proposer = Address::generate(&env);

        let transfers = vec![&env, transfer(&env, 100)];
        let sid = c.propose(&proposer, &transfers, &1u64);
        c.approve(&proposer, &sid, &1u64);
        c.execute_settlement(&proposer, &sid);

        let result = c.try_execute_settlement(&proposer, &sid);
        assert_eq!(result, Err(Ok(SettlementError::NotPending)));
    }
}
