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
