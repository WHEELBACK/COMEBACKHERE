#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    Unauthorized = 1,
    ContractPaused = 2,
    AlreadyInitialized = 3,
}

#[contracttype]
pub enum AddressStatus {
    Allowed,
    AllowedUntil(u64),
    Blocked,
    Cleared,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Status(Address),
}

#[contract]
pub struct ComplianceContract;

#[contractimpl]
impl ComplianceContract {
    pub fn initialize(e: Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn is_allowed(e: Env, addr: Address) -> bool {
        match e
            .storage()
            .instance()
            .get(&DataKey::Status(addr))
            .unwrap_or(AddressStatus::Cleared)
        {
            AddressStatus::Allowed => true,
            AddressStatus::AllowedUntil(until) => e.ledger().timestamp() < until,
            AddressStatus::Blocked | AddressStatus::Cleared => false,
        }
    }

    pub fn get_address_status(e: Env, addr: Address) -> AddressStatus {
        e.storage()
            .instance()
            .get(&DataKey::Status(addr))
            .unwrap_or(AddressStatus::Cleared)
    }

    pub fn allow_address(e: Env, admin: Address, addr: Address) {
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Status(addr), &AddressStatus::Allowed);
        e.events()
            .publish((Symbol::new(&e, "address_allowed"),), addr);
    }

    pub fn block_address(e: Env, admin: Address, addr: Address) {
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Status(addr), &AddressStatus::Blocked);
        e.events()
            .publish((Symbol::new(&e, "address_blocked"),), addr);
    }

    pub fn allow_address_until(e: Env, admin: Address, addr: Address, until: u64) {
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Status(addr), &AddressStatus::AllowedUntil(until));
        e.events().publish(
            (Symbol::new(&e, "address_allowed_until"),),
            (addr, until),
        );
    }

    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn accept_admin(e: Env, new_admin: Address) {
        new_admin.require_auth();
    }

    pub fn clear_address(e: Env, admin: Address, addr: Address) {
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Status(addr), &AddressStatus::Cleared);
        e.events()
            .publish((Symbol::new(&e, "address_cleared"),), addr);
    }

    pub fn pause(e: Env, admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(e: Env, admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Paused, &false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    fn setup(ts: u64) -> (Env, ComplianceContractClient, Address, Address) {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register_contract(None, ComplianceContract);
        let c = ComplianceContractClient::new(&e, &contract_id);
        let admin = Address::generate(&e);
        let addr = Address::generate(&e);
        c.initialize(&admin);
        e.ledger().set_timestamp(ts);
        (e, c, admin, addr)
    }

    #[test]
    fn test_is_allowed_not_expired() {
        let (_e, c, admin, addr) = setup(1000);
        c.allow_address_until(&admin, &addr, &2000u64);
        assert!(c.is_allowed(&addr));
    }

    #[test]
    fn test_is_allowed_exactly_at_expiry_returns_false() {
        let (_e, c, admin, addr) = setup(1000);
        c.allow_address_until(&admin, &addr, &1000u64);
        assert!(!c.is_allowed(&addr));
    }

    #[test]
    fn test_is_allowed_past_expiry_returns_false() {
        let (_e, c, admin, addr) = setup(1001);
        c.allow_address_until(&admin, &addr, &1000u64);
        assert!(!c.is_allowed(&addr));
    }
}
