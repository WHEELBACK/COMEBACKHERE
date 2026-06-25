#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

/// 1 stroops minimum, 1_000_000_000_000 stroops (100k USDC) maximum
const MIN_AMOUNT: u64 = 1;
const MAX_AMOUNT: u64 = 1_000_000_000_000;

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum SettlementStatus {
    Pending = 0,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SettlementReceipt {
    pub settlement_id: u64,
    pub status: SettlementStatus,
    pub tx_hash: soroban_sdk::Bytes,
}

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SettlementError {
    UnauthorizedSigner = 10,
    TokenNotAllowed = 12,
    InvalidAmount = 7,
}

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    /// POST /settlements — validate and propose a new settlement.
    ///
    /// * `signer`         — must be in `authorized_signers`
    /// * `token`          — must be in `allowed_tokens`
    /// * `amount`         — must be > 0 and ≤ MAX_AMOUNT
    /// * `authorized_signers` / `allowed_tokens` — passed by the backend from env / on-chain config
    pub fn propose_settlement(
        env: Env,
        signer: Address,
        token: Address,
        amount: u64,
        authorized_signers: Vec<Address>,
        allowed_tokens: Vec<Address>,
    ) -> Result<SettlementReceipt, SettlementError> {
        // 1. Authorized-signer check
        if !authorized_signers.contains(&signer) {
            return Err(SettlementError::UnauthorizedSigner);
        }

        // 2. Token allowlist check
        if !allowed_tokens.contains(&token) {
            return Err(SettlementError::TokenNotAllowed);
        }

        // 3. Amount validation
        if amount < MIN_AMOUNT || amount > MAX_AMOUNT {
            return Err(SettlementError::InvalidAmount);
        }

        // 4. Derive a deterministic settlement ID from the ledger sequence
        let settlement_id: u64 = env.ledger().sequence() as u64;

        // 5. Emit the propose_settlement event (mirrors on-chain convention)
        env.events().publish(
            (soroban_sdk::symbol_short!("settle"), soroban_sdk::symbol_short!("propose")),
            (settlement_id, signer.clone(), token.clone(), amount),
        );

        // Return settlement ID, initial status, and a placeholder tx hash
        // (in production the backend layer replaces this with the real RPC response hash)
        let tx_hash = env.crypto().sha256(
            &soroban_sdk::Bytes::from_slice(&env, &settlement_id.to_be_bytes()),
        );

        Ok(SettlementReceipt {
            settlement_id,
            status: SettlementStatus::Pending,
            tx_hash: tx_hash.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::AddressGenerator;
    use soroban_sdk::{vec, Env};

    fn setup() -> (Env, Address, Address, Vec<Address>, Vec<Address>) {
        let env = Env::default();
        env.mock_all_auths();
        let signer = Address::generate(&env);
        let token = Address::generate(&env);
        let signers = vec![&env, signer.clone()];
        let tokens = vec![&env, token.clone()];
        (env, signer, token, signers, tokens)
    }

    #[test]
    fn test_propose_settlement_success() {
        let (env, signer, token, signers, tokens) = setup();
        let contract_id = env.register_contract(None, SettlementContract);
        let client = SettlementContractClient::new(&env, &contract_id);

        let receipt = client
            .propose_settlement(&signer, &token, &10_000_000u64, &signers, &tokens)
            .unwrap();

        assert_eq!(receipt.status, SettlementStatus::Pending);
        assert!(!receipt.tx_hash.is_empty());
    }

    #[test]
    fn test_unauthorized_signer_rejected() {
        let (env, _signer, token, signers, tokens) = setup();
        let contract_id = env.register_contract(None, SettlementContract);
        let client = SettlementContractClient::new(&env, &contract_id);

        let stranger = Address::generate(&env);
        let err = client
            .try_propose_settlement(&stranger, &token, &10_000_000u64, &signers, &tokens)
            .unwrap_err()
            .unwrap();

        assert_eq!(err, SettlementError::UnauthorizedSigner);
    }

    #[test]
    fn test_token_not_on_allowlist_rejected() {
        let (env, signer, _token, signers, tokens) = setup();
        let contract_id = env.register_contract(None, SettlementContract);
        let client = SettlementContractClient::new(&env, &contract_id);

        let bad_token = Address::generate(&env);
        let err = client
            .try_propose_settlement(&signer, &bad_token, &10_000_000u64, &signers, &tokens)
            .unwrap_err()
            .unwrap();

        assert_eq!(err, SettlementError::TokenNotAllowed);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let (env, signer, token, signers, tokens) = setup();
        let contract_id = env.register_contract(None, SettlementContract);
        let client = SettlementContractClient::new(&env, &contract_id);

        let err = client
            .try_propose_settlement(&signer, &token, &0u64, &signers, &tokens)
            .unwrap_err()
            .unwrap();

        assert_eq!(err, SettlementError::InvalidAmount);
    }

    #[test]
    fn test_amount_exceeds_max_rejected() {
        let (env, signer, token, signers, tokens) = setup();
        let contract_id = env.register_contract(None, SettlementContract);
        let client = SettlementContractClient::new(&env, &contract_id);

        let err = client
            .try_propose_settlement(&signer, &token, &(MAX_AMOUNT + 1), &signers, &tokens)
            .unwrap_err()
            .unwrap();

        assert_eq!(err, SettlementError::InvalidAmount);
    }
}
