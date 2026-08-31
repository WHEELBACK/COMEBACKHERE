# Development Environment Setup

This guide covers setting up a full local development environment for the COMEBACKHERE protocol, spanning the contracts, backend, and frontend repositories.

## Prerequisites

- Rust 1.70+ with `wasm32-unknown-unknown` target:

  ```sh
  rustup install stable
  rustup target add wasm32-unknown-unknown
  ```

- Soroban CLI: `cargo install soroban-cli`
- Node.js 18+ (for frontend)
- Docker (for local Soroban sandbox)
- Stellar testnet account with funded testnet USDC

## Directory Layout

Create a workspace directory and clone in this order:

```
~/comebackhere/
  ├── COMEBACKHERE-contracts/   # Smart contracts repo
  ├── COMEBACKHERE/             # Tooling, scripts, ABIs repo
  ├── comebackhere-backend/     # Backend API
  └── comebackhere-frontend/    # Frontend UI
```

```sh
mkdir ~/comebackhere && cd ~/comebackhere
git clone https://github.com/dreamgeneX/COMEBACKHERE-contracts.git
git clone https://github.com/dreamgeneX/COMEBACKHERE.git
git clone https://github.com/dreamgeneX/comebackhere-backend.git
git clone https://github.com/dreamgeneX/comebackhere-frontend.git
```

## Local Soroban Sandbox

Start a local Soroban sandbox for testing without testnet:

```sh
soroban-cli start --standalone
```

This runs Soroban RPC on `http://localhost:8000` and Horizon on `http://localhost:8001`.

## Environment Setup

### Contracts

Copy the testnet configuration and generate a test account:

```sh
cd COMEBACKHERE
cp .env.testnet.example .env.testnet
```

Generate a new testnet keypair for local testing:

```sh
soroban config identity generate dev
soroban config set --scope testnet RPC_URL http://localhost:8000
soroban config set --scope testnet NETWORK_PASSPHRASE "Standalone Network ; February 2025"
```

Export your account ID for use in backend/frontend configuration:

```sh
ADMIN_PUBLIC_KEY=$(soroban config identity show dev)
echo "ADMIN_PUBLIC_KEY=$ADMIN_PUBLIC_KEY"
```

### Deploy Contracts Locally

```sh
cd COMEBACKHERE

# Build WASM artifacts (from the contracts repo)
(cd ../COMEBACKHERE-contracts && cargo build --target wasm32-unknown-unknown --release)

# Deploy to local sandbox
./scripts/deploy_testnet.sh
```

This outputs contract IDs. Save them:

```sh
export INVOICE_CONTRACT_ID=<id>
export TREASURY_CONTRACT_ID=<id>
export COMPLIANCE_CONTRACT_ID=<id>
```

### Backend

```sh
cd comebackhere-backend

cat > .env <<EOF
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=http://localhost:8000
HORIZON_URL=http://localhost:8001
ADMIN_PUBLIC_KEY=$ADMIN_PUBLIC_KEY
INVOICE_CONTRACT_ID=$INVOICE_CONTRACT_ID
TREASURY_CONTRACT_ID=$TREASURY_CONTRACT_ID
COMPLIANCE_CONTRACT_ID=$COMPLIANCE_CONTRACT_ID
USDC_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
MONGO_URI=mongodb://localhost:27017/comebackhere
REDIS_URL=redis://localhost:6379
WEBHOOK_SECRET=<generate-a-32-char-or-longer-secret>
EOF
```

Before starting the backend, validate all required environment variables:

```sh
cd ../COMEBACKHERE
scripts/validate_backend_env.sh ../comebackhere-backend/.env
```

A missing or blank required variable causes the script to exit with a clear error message.
To also enforce the optional contract ID variables (e.g. in CI), run with `STRICT=1`:

```sh
STRICT=1 scripts/validate_backend_env.sh ../comebackhere-backend/.env
```

Then start the backend:

```sh
cd ../comebackhere-backend
cargo build && cargo run
```

Backend listens on `http://localhost:3000`.

#### Required backend variables

| Variable         | Description                                                        |
|------------------|--------------------------------------------------------------------|
| `MONGO_URI`      | MongoDB connection string (`mongodb://` or `mongodb+srv://`)       |
| `REDIS_URL`      | Redis connection string (`redis://`)                               |
| `WEBHOOK_SECRET` | HMAC secret for signing outgoing webhook payloads (≥ 32 chars)     |

#### Optional contract integration variables

| Variable                | Description                             |
|-------------------------|-----------------------------------------|
| `INVOICE_CONTRACT_ID`   | Deployed invoice contract address       |
| `TREASURY_CONTRACT_ID`  | Deployed treasury contract address      |
| `COMPLIANCE_CONTRACT_ID`| Deployed compliance contract address    |

### Frontend

```sh
cd comebackhere-frontend

cat > .env <<EOF
VITE_API_URL=http://localhost:3000
VITE_SOROBAN_RPC=http://localhost:8000
VITE_HORIZON_URL=http://localhost:8001
VITE_NETWORK_PASSPHRASE=Standalone Network ; February 2025
EOF

npm install && npm run dev
```

Frontend runs on `http://localhost:5173`.

## Full Environment Variable Reference

The tables below list every environment variable used across the repository.
Variables marked **Required** must be set for the service to start.
Variables marked **Optional** have sensible defaults or are only needed for
specific features.

### Backend — `comebackhere-backend` (TypeScript/Express)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SOROBAN_RPC_URL` | Yes | — | Soroban RPC endpoint (e.g. `http://localhost:8000/soroban/rpc`) |
| `INVOICE_CONTRACT_ID` | Yes* | — | Deployed invoice contract address |
| `TREASURY_CONTRACT_ID` | Yes* | — | Deployed treasury contract address |
| `USDC_CONTRACT_ID` | Yes* | — | USDC token contract address |
| `SETTLEMENT_CONTRACT_ID` | Yes* | — | Settlement contract address (disputes) |
| `SIGNER_SECRET_KEY` | Yes | — | Stellar secret key for signing transactions |
| `NETWORK_PASSPHRASE` | No | `Standalone Network ; February 2025` | Stellar network passphrase |
| `MONGODB_URI` | No | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGODB_DB` | No | `comebackhere` | MongoDB database name |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string for rate limiting and caching |
| `WEBHOOK_URL` | No | — | Merchant endpoint that receives webhook POSTs |
| `WEBHOOK_SIGNING_SECRET` | No | — | HMAC-SHA256 signing secret for outbound webhooks |
| `PORT` | No | `3000` | HTTP server port |
| `SHUTDOWN_TIMEOUT_MS` | No | `10000` | Graceful shutdown timeout in milliseconds |
| `RATE_LIMIT_POINTS` | No | `60` | Max requests per IP per window |
| `RATE_LIMIT_DURATION` | No | `60` | Rate limit window in seconds |
| `DISPUTE_VOTE_THRESHOLD` | No | `2` | Minimum votes to resolve a dispute |
| `INDEXER_START_CURSOR` | No | `0` | Starting cursor for the event indexer |
| `ADMIN_KEY` | No | — | Admin public key for compliance and escrow operations |

* Required when the corresponding contract route is called; the backend
  returns 503 if the variable is missing at request time.

### Backend — `backend` (Rust/Axum, legacy)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SOROBAN_RPC_URL` | Yes | — | Soroban RPC endpoint |
| `STELLAR_NETWORK` | No | `standalone` | Stellar network name (`standalone`, `testnet`, `mainnet`) |
| `HORIZON_URL` | No | — | Horizon server URL |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `ADMIN_PUBLIC_KEY` | Yes* | — | Admin public key |
| `INVOICE_CONTRACT_ID` | Yes* | — | Invoice contract address |
| `TREASURY_CONTRACT_ID` | Yes* | — | Treasury contract address |
| `COMPLIANCE_CONTRACT_ID` | Yes* | — | Compliance contract address |
| `USDC_CONTRACT_ID` | Yes* | — | USDC token contract address |
| `HOST` | No | `0.0.0.0` | Server bind address |
| `PORT` | No | `3000` | Server port |
| `RATE_LIMIT_POINTS` | No | `60` | Max requests per IP per window |
| `RATE_LIMIT_DURATION` | No | `60` | Rate limit window in seconds |

### Frontend — `comebackhere-frontend` (React/Vite)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VITE_API_URL` | Yes | — | Backend API base URL (e.g. `http://localhost:3000`) |
| `VITE_SOROBAN_RPC` | Yes | — | Soroban RPC endpoint for wallet interactions |
| `VITE_HORIZON_URL` | No | — | Horizon server URL |
| `VITE_NETWORK_PASSPHRASE` | No | `Standalone Network ; February 2025` | Stellar network passphrase |

### Root-level configuration files

| File | Purpose |
| --- | --- |
| `.env.local.example` | Local development (standalone sandbox) |
| `.env.testnet.example` | Stellar testnet configuration |
| `.env.mainnet.example` | Stellar mainnet configuration (manual, requires multisig approval) |
| `backend/.env.example` | Legacy Rust backend configuration |

## Running Contract Tests

```sh
cd COMEBACKHERE-contracts

# Run all contract tests
cargo test

# Generate coverage report
cd ../COMEBACKHERE && scripts/coverage.sh
```

## Development Workflow

1. **Make contract changes** in `COMEBACKHERE-contracts/contracts/*/src/`
2. **Rebuild and redeploy**:

   ```sh
   cd COMEBACKHERE-contracts
   cargo build --target wasm32-unknown-unknown --release
   cd ../COMEBACKHERE && ./scripts/deploy_testnet.sh
   ```

3. **Regenerate ABI metadata**:

   ```sh
   cd COMEBACKHERE && make update-abi-snapshots
   ```

4. **Restart backend** to reload new contract IDs (if changed)
5. **Test in frontend** UI

## Troubleshooting

- **"Soroban RPC not reachable"**: Ensure sandbox is running with `soroban-cli start --standalone`
- **"Contract not found"**: Verify contract IDs in `.env` match deployed IDs from deployment script
- **"USDC balance insufficient"**: Fund your testnet account at [Stellar Lab](https://laboratory.stellar.org/#create-account)
- **Port already in use**: Change the port in backend/frontend env files if 3000 or 5173 are taken

## Further Reading

- [Soroban Docs](https://developers.stellar.org/soroban)
- [Mainnet Deployment](./MAINNET_DEPLOYMENT.md)
