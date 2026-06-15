# COMEBACKHERE Soroban Mainnet Deployment

Mainnet deployment must not run from a single local shell. The checked-in `scripts/deploy_mainnet.sh` intentionally refuses to deploy because live deployment requires governance approval, multi-sig signing, and a recorded signing ceremony.

## Preconditions

- `cargo fmt --all -- --check` (in `COMEBACKHERE-contracts/`)
- `cargo clippy -- -D warnings` (in `COMEBACKHERE-contracts/`)
- `cargo test` (in `COMEBACKHERE-contracts/`)
- WASM artifacts built with `cargo build --target wasm32-unknown-unknown --release`
- Admin, treasury, and compliance keys confirmed on Stellar mainnet
- AWS KMS or approved signing service configured for production signing
- Production USDC asset issuer verified against official Circle/Stellar documentation
- Mainnet Horizon and Soroban RPC health checks passing

## Required Environment Variables

- `SOROBAN_RPC_URL` — Soroban RPC endpoint (e.g., `https://soroban-mainnet.stellar.org`)
- `SOROBAN_NETWORK_PASSPHRASE` — Network passphrase for mainnet signing
- `INVOICE_CONTRACT_ID` — Deployed invoice contract ID
- `TREASURY_CONTRACT_ID` — Deployed treasury contract ID
- `COMPLIANCE_CONTRACT_ID` — Deployed compliance contract ID

Set these via environment variables or in a `.env.mainnet` file. Scripts will fail fast if required variables are missing.

## Ceremony

1. Open a deployment issue with target commit SHA, expected WASM hashes, admins, and treasury signers.
2. Collect required multi-sig approvals.
3. Build release artifacts from a clean checkout of `COMEBACKHERE-contracts/`.
4. Verify WASM hashes match the deployment issue.
5. Submit deployment transactions through the approved signer.
6. Record transaction hashes and deployed contract IDs.
7. Update backend production secrets with:
   - `INVOICE_CONTRACT_ID`
   - `TREASURY_CONTRACT_ID`
   - `COMPLIANCE_CONTRACT_ID`
8. Run backend `GET /health/rpc` and a low-value end-to-end invoice payment smoke test.

## Abort Conditions

- Any signer mismatch
- Any WASM hash mismatch
- Soroban RPC health degraded across all configured endpoints
- Any failed low-value payment smoke test
