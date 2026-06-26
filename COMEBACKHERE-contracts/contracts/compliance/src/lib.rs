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
    PendingAdmin,
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

    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap();
        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }
        e.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        e.events().publish(
            (Symbol::new(&e, "transfer_admin"),),
            (&admin, &new_admin),
        );
        Ok(())
    }

    pub fn accept_admin(e: Env, new_admin: Address) -> Result<(), ContractError> {
        new_admin.require_auth();
        let pending: Address = e
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(ContractError::Unauthorized)?;
        if new_admin != pending {
            return Err(ContractError::Unauthorized);
        }
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        e.storage()
            .instance()
            .remove(&DataKey::PendingAdmin);
        e.events().publish(
            (Symbol::new(&e, "accept_admin"),),
            &new_admin,
        );
        Ok(())
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

    fn setup() -> (Env, Address, ComplianceContractClient<'static>) {
        let e = Env::default();
        e.mock_all_auths();
        let admin = Address::generate(&e);
        let contract_id = e.register_contract(None, ComplianceContract);
        let client = ComplianceContractClient::new(&e, &contract_id);
        client.initialize(&admin);
        (e, admin, client)
    }

    #[test]
    fn test_allow_then_is_allowed() {
        let (e, admin, client) = setup();
        let addr = Address::generate(&e);

        assert!(!client.is_allowed(&addr));

        client.allow_address(&admin, &addr);

        assert!(client.is_allowed(&addr));
    }

    #[test]
    fn test_block_then_is_not_allowed() {
        let (e, admin, client) = setup();
        let addr = Address::generate(&e);

        client.allow_address(&admin, &addr);
        assert!(client.is_allowed(&addr));

        client.block_address(&admin, &addr);
        assert!(!client.is_allowed(&addr));
    }

    #[test]
    fn test_allow_until_then_expires() {
        let (e, admin, client) = setup();
        let addr = Address::generate(&e);

        e.ledger().set_timestamp(1000);
        client.allow_address_until(&admin, &addr, &2000);

        assert!(client.is_allowed(&addr));

        e.ledger().set_timestamp(2000);
        assert!(!client.is_allowed(&addr));

        e.ledger().set_timestamp(3000);
        assert!(!client.is_allowed(&addr));
    }

    #[test]
    fn test_full_compliance_lifecycle() {
        let (e, admin, client) = setup();
        let addr = Address::generate(&e);

        assert!(!client.is_allowed(&addr));

        client.allow_address(&admin, &addr);
        assert!(client.is_allowed(&addr));

        client.block_address(&admin, &addr);
        assert!(!client.is_allowed(&addr));

        e.ledger().set_timestamp(1000);
        client.allow_address_until(&admin, &addr, &2000);
        assert!(client.is_allowed(&addr));

        e.ledger().set_timestamp(2001);
        assert!(!client.is_allowed(&addr));

        client.clear_address(&admin, &addr);
        assert!(!client.is_allowed(&addr));
    }

    #[test]
    fn test_transfer_admin_unauthorized() {
        let (e, admin, client) = setup();
        let non_admin = Address::generate(&e);
        let new_admin = Address::generate(&e);

        let result = client.try_transfer_admin(&non_admin, &new_admin);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_accept_admin_unauthorized() {
        let (e, admin, client) = setup();
        let new_admin = Address::generate(&e);
        let impostor = Address::generate(&e);

        client.transfer_admin(&admin, &new_admin);

        let result = client.try_accept_admin(&impostor);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_two_step_admin_transfer() {
        let (e, admin, client) = setup();
        let new_admin = Address::generate(&e);
        let addr = Address::generate(&e);

        client.transfer_admin(&admin, &new_admin);

        client.allow_address(&admin, &addr);
        assert!(client.is_allowed(&addr));

        client.accept_admin(&new_admin);

        client.allow_address(&new_admin, &addr);
    }

    #[test]
    fn test_pause_and_unpause() {
        let (e, admin, client) = setup();

        client.pause(&admin);
        client.unpause(&admin);

        let addr = Address::generate(&e);
        client.allow_address(&admin, &addr);
        assert!(client.is_allowed(&addr));
    }
}
