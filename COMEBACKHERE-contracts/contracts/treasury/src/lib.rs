#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, Symbol, Vec};

#[contracttype]
pub enum SettlementStatus {
    Pending,
    Executed,
    PartiallyExecuted,
    OnHold,
    Cancelled,
}

#[contracttype]
pub struct Settlement {
    pub token: Address,
    pub amount: u64,
    pub merchant: Address,
    pub status: SettlementStatus,
    pub approval_weight: u64,
    pub proposer: Address,
}

#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    pub fn initialize(e: Env, signers: Vec<(Address, u64)>, threshold: u64, admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        e.storage().instance().set(&DataKey::Paused, &false);
        e.storage().instance().set(&DataKey::NextSettlementId, &1u64);
        for (signer, weight) in signers.iter() {
            e.storage().instance().set(&DataKey::Signer(signer.clone()), &weight);
        }
    }

    pub fn set_signer(e: Env, admin: Address, signer: Address, weight: u64) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Signer(signer), &weight);
    }

    pub fn propose_settlement(
        e: Env,
        signer: Address,
        token: Address,
        amount: u64,
        merchant: Address,
    ) -> u64 {
        signer.require_auth();

        if e.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            panic_with_error!(&e, TreasuryError::ContractPaused);
        }

        let allowlist: Vec<Address> = e.storage().instance().get(&DataKey::TokenAllowlist).unwrap_or_else(|| Vec::new(&e));
        if !allowlist.is_empty() && !allowlist.contains(&token) {
            panic_with_error!(&e, TreasuryError::TokenNotAllowed);
        }

        let settlement_id = e
            .storage()
            .instance()
            .get(&DataKey::NextSettlementId)
            .unwrap_or(1u64);

        let settlement = Settlement {
            token: token.clone(),
            amount,
            merchant: merchant.clone(),
            status: SettlementStatus::Pending,
            approval_weight: 0u64,
            proposer: signer.clone(),
        };

        e.storage().instance().set(&DataKey::Settlement(settlement_id), &settlement);
        e.storage().instance().set(&DataKey::NextSettlementId, &(settlement_id + 1));

        settlement_id
    }

    pub fn approve_settlement(e: Env, signer: Address, settlement_id: u64) {
        signer.require_auth();
        let mut settlement = Self::get_settlement_internal(&e, settlement_id);
        if settlement.status != SettlementStatus::Pending {
            panic_with_error!(&e, TreasuryError::NotPending);
        }
        let weight: u64 = e
            .storage()
            .instance()
            .get(&DataKey::Signer(signer.clone()))
            .unwrap_or(0u64);
        settlement.approval_weight += weight;
        e.storage().instance().set(&DataKey::Settlement(settlement_id), &settlement);
    }

    pub fn execute_settlement(e: Env, signer: Address, settlement_id: u64, token_contract: Address) {
        signer.require_auth();
        let settlement = Self::get_settlement_internal(&e, settlement_id);
        if settlement.status != SettlementStatus::Pending {
            panic_with_error!(&e, TreasuryError::NotPending);
        }
        let threshold: u64 = e.storage().instance().get(&DataKey::Threshold).unwrap_or(0u64);
        if settlement.approval_weight < threshold {
            panic_with_error!(&e, TreasuryError::InsufficientApprovals);
        }
    }

    pub fn get_pending_settlements(
        e: Env,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<u64> {
        let next_id: u64 = e
            .storage()
            .instance()
            .get(&DataKey::NextSettlementId)
            .unwrap_or(1u64);
        let cap: u32 = limit.unwrap_or(100).min(100);
        let skip: u32 = offset.unwrap_or(0);

        let mut result: Vec<u64> = Vec::new(&e);
        let mut matched: u32 = 0;
        let mut collected: u32 = 0;

        for id in 1..next_id {
            if let Some(s) = e
                .storage()
                .instance()
                .get::<DataKey, Settlement>(&DataKey::Settlement(id))
            {
                if matches!(s.status, SettlementStatus::Pending) {
                    if matched >= skip {
                        if collected >= cap {
                            break;
                        }
                        result.push_back(id);
                        collected += 1;
                    }
                    matched += 1;
                }
            }
        }
        result
    }

    fn check_admin(e: &Env, admin: &Address) {
        admin.require_auth();
        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap();
        if stored_admin != *admin {
            panic_with_error!(&e, TreasuryError::Unauthorized);
        }
    }

    pub fn pause(e: Env, admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(e: Env, admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn update_threshold(e: Env, admin: Address, new_threshold: u32) {
        Self::check_admin(&e, &admin);
        if new_threshold == 0 {
            panic_with_error!(&e, TreasuryError::InvalidThreshold);
        }
        let old_threshold: u64 = e.storage().instance().get(&DataKey::Threshold).unwrap_or(0u64);
        let threshold = new_threshold as u64;
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        e.events().publish(
            (Symbol::new(&e, "threshold_updated"),),
            (old_threshold, threshold),
        );
    }

    pub fn raise_dispute(e: Env, signer: Address, settlement_id: u64, reason: u32) {
        signer.require_auth();
        let mut settlement = Self::get_settlement_internal(&e, settlement_id);
        settlement.status = SettlementStatus::OnHold;
        e.storage().instance().set(&DataKey::Settlement(settlement_id), &settlement);
    }

    pub fn resolve_dispute(e: Env, signer: Address, settlement_id: u64, resolve_in_favor: bool) {
        signer.require_auth();
    }

    pub fn deposit(e: Env, from: Address, amount: u64) {
        from.require_auth();
    }

    pub fn withdraw(e: Env, admin: Address, to: Address, amount: u64) {
        admin.require_auth();
    }

    pub fn add_token_to_allowlist(e: Env, admin: Address, token: Address) {
        admin.require_auth();
        let mut allowlist: Vec<Address> = e.storage().instance().get(&DataKey::TokenAllowlist).unwrap_or_else(|| Vec::new(&e));
        if !allowlist.contains(&token) {
            allowlist.push_back(token);
        }
        e.storage().instance().set(&DataKey::TokenAllowlist, &allowlist);
    }

    pub fn remove_token_from_allowlist(e: Env, admin: Address, token: Address) {
        admin.require_auth();
        let allowlist: Vec<Address> = e.storage().instance().get(&DataKey::TokenAllowlist).unwrap_or_else(|| Vec::new(&e));
        let mut updated = Vec::new(&e);
        for t in allowlist.iter() {
            if t != token {
                updated.push_back(t);
            }
        }
        e.storage().instance().set(&DataKey::TokenAllowlist, &updated);
    }

    fn get_settlement_internal(e: &Env, settlement_id: u64) -> Settlement {
        e.storage()
            .instance()
            .get(&DataKey::Settlement(settlement_id))
            .unwrap()
    }
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    ContractPaused = 1,
    NotPending = 2,
    InsufficientApprovals = 3,
    TokenNotAllowed = 4,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Signer(Address),
    Settlement(u64),
    NextSettlementId,
    Threshold,
    TokenAllowlist,
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, soroban_sdk::Address) {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register_contract(None, TreasuryContract);
        (e, contract_id)
    }

    fn client(e: &Env, id: &soroban_sdk::Address) -> TreasuryContractClient {
        TreasuryContractClient::new(e, id)
    }

    #[test]
    fn test_empty_returns_empty() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        c.initialize(&soroban_sdk::vec![&e], &1, &admin);
        let result = c.get_pending_settlements(&None, &None);
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_single_pending() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(
            &soroban_sdk::vec![&e, (signer.clone(), 1u64)],
            &1,
            &admin,
        );
        let sid = c.propose_settlement(&signer, &token, &1000u64, &merchant);
        let result = c.get_pending_settlements(&None, &None);
        assert_eq!(result.len(), 1);
        assert_eq!(result.get(0).unwrap(), sid);
    }

    #[test]
    fn test_mixed_statuses_filtered() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(
            &soroban_sdk::vec![&e, (signer.clone(), 2u64)],
            &1,
            &admin,
        );
        let s1 = c.propose_settlement(&signer, &token, &1000u64, &merchant);
        let s2 = c.propose_settlement(&signer, &token, &2000u64, &merchant);
        // execute s1 so it is no longer Pending
        c.approve_settlement(&signer, &s1);
        c.execute_settlement(&signer, &s1, &token);
        let result = c.get_pending_settlements(&None, &None);
        assert_eq!(result.len(), 1);
        assert_eq!(result.get(0).unwrap(), s2);
    }

    #[test]
    fn test_pagination_offset_and_limit() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(
            &soroban_sdk::vec![&e, (signer.clone(), 1u64)],
            &1,
            &admin,
        );
        for _ in 0..5 {
            c.propose_settlement(&signer, &token, &100u64, &merchant);
        }
        // offset=2, limit=2 → ids 3 and 4
        let page = c.get_pending_settlements(&Some(2u32), &Some(2u32));
        assert_eq!(page.len(), 2);
        assert_eq!(page.get(0).unwrap(), 3u64);
        assert_eq!(page.get(1).unwrap(), 4u64);
    }

    #[test]
    fn test_limit_capped_at_100() {
        let (e, id) = setup();
        let c = client(&e, &id);
        let admin = soroban_sdk::Address::generate(&e);
        let token = soroban_sdk::Address::generate(&e);
        let merchant = soroban_sdk::Address::generate(&e);
        let signer = soroban_sdk::Address::generate(&e);
        c.initialize(
            &soroban_sdk::vec![&e, (signer.clone(), 1u64)],
            &1,
            &admin,
        );
        for _ in 0..5 {
            c.propose_settlement(&signer, &token, &100u64, &merchant);
        }
        // limit=200 should be capped to 100, returning all 5
        let result = c.get_pending_settlements(&None, &Some(200u32));
        assert_eq!(result.len(), 5);
    }
}