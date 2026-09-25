# Local End-to-End Walkthrough

This guide takes you from a fresh clone to a paid invoice on a local network in a single session.

## Prerequisites

Ensure you have:

- **Rust 1.70+** with `wasm32-unknown-unknown` target:
  ```sh
  rustup install stable
  rustup target add wasm32-unknown-unknown
  ```
- **Soroban CLI**: `cargo install soroban-cli`
- **Node.js 18+**: for frontend development
- **Docker & Docker Compose**: for local services (Soroban, Redis, MongoDB)
- **Freighter wallet extension**: installed in your browser (or use a test wallet)

## Step 1: Clone the Repositories

Create a workspace directory and clone all repos in order:

```sh
mkdir -p ~/comebackhere && cd ~/comebackhere

git clone https://github.com/WHEELBACK/COMEBACKHERE-contracts.git
git clone https://github.com/WHEELBACK/COMEBACKHERE.git
git clone https://github.com/WHEELBACK/comebackhere-backend.git
git clone https://github.com/WHEELBACK/comebackhere-frontend.git

cd COMEBACKHERE
```

**Expected output:** Four directories cloned without errors. You are now in the `COMEBACKHERE` root directory.

## Step 2: Start the Local Stack

Start all services (Soroban, Redis, MongoDB) in one command:

```sh
docker-compose up -d
```

**Expected output:**
```
Creating network "comebackhere_default" with the default driver
Creating comebackhere_soroban_1 ... done
Creating comebackhere_redis_1 ... done
Creating comebackhere_mongodb_1 ... done
```

Wait for services to be healthy:

```sh
docker-compose ps
```

**Expected output:** All three containers show `Up` and health check (✓) after ~30 seconds:
```
NAME              COMMAND             STATUS
comebackhere_soroban_1    "start --standalone"  Up (healthy)
comebackhere_redis_1      "redis-server"        Up (healthy)
comebackhere_mongodb_1    "mongod"              Up (healthy)
```

## Step 3: Configure Soroban Identity

Create a local development identity and set the RPC endpoint:

```sh
soroban config identity generate dev --network standalone
soroban config set --scope standalone RPC_URL http://localhost:8000
soroban config set --scope standalone NETWORK_PASSPHRASE "Standalone Network ; February 2025"
```

Verify the identity was created:

```sh
soroban config identity show dev
```

**Expected output:** A 56-character Stellar public key (starts with `G`):
```
GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Export it for later use:

```sh
export ADMIN_PUBLIC_KEY=$(soroban config identity show dev)
echo "Admin key: $ADMIN_PUBLIC_KEY"
```

## Step 4: Build and Deploy Contracts Locally

Build the contract WASM artifacts:

```sh
cd ../COMEBACKHERE-contracts
cargo build --target wasm32-unknown-unknown --release 2>&1 | tail -5
```

**Expected output:** Compilation succeeds with messages like:
```
   Compiling invoice v0.1.0
   Compiling treasury v0.1.0
   Compiling compliance v0.1.0
    Finished release [optimized] target(s) in XXs
```

Return to the COMEBACKHERE root and deploy:

```sh
cd ../COMEBACKHERE
./scripts/deploy_local.sh
```

**Expected output:**
```
Deploying invoice contract...
Contract ID: CBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Deploying treasury contract...
Contract ID: CBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Deploying compliance contract...
Contract ID: CBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
✓ Deployed all contracts to local network
```

Export the contract IDs:

```sh
source <(./scripts/export_deployed_addresses.sh)
echo "Invoice: $INVOICE_CONTRACT_ID"
echo "Treasury: $TREASURY_CONTRACT_ID"
echo "Compliance: $COMPLIANCE_CONTRACT_ID"
```

## Step 5: Configure and Start the Backend

Configure the backend environment:

```sh
cat > ../comebackhere-backend/.env <<EOF
STELLAR_NETWORK=standalone
SOROBAN_RPC_URL=http://localhost:8000
HORIZON_URL=http://localhost:8000
ADMIN_PUBLIC_KEY=$ADMIN_PUBLIC_KEY
INVOICE_CONTRACT_ID=$INVOICE_CONTRACT_ID
TREASURY_CONTRACT_ID=$TREASURY_CONTRACT_ID
COMPLIANCE_CONTRACT_ID=$COMPLIANCE_CONTRACT_ID
USDC_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
MONGO_URI=mongodb://localhost:27017/comebackhere
REDIS_URL=redis://localhost:6379
WEBHOOK_SECRET=$(openssl rand -base64 32)
EOF
```

Validate the configuration:

```sh
./scripts/validate_backend_env.sh ../comebackhere-backend/.env
```

**Expected output:**
```
✓ All required environment variables are set
✓ Optional contract variables are populated
```

Start the backend in a new terminal window/tab:

```sh
cd ../comebackhere-backend
npm ci
npm run dev
```

**Expected output:**
```
> comebackhere-backend@0.1.0 dev
> tsx watch src/index.ts

[watch] src/index.ts
[dev] Server running at http://localhost:3000
```

The backend is now listening on `http://localhost:3000`.

## Step 6: Configure and Start the Frontend

In another terminal, configure and start the frontend:

```sh
cd ~/comebackhere/comebackhere-frontend
cat > .env.local <<EOF
VITE_SOROBAN_RPC_URL=http://localhost:8000
VITE_HORIZON_URL=http://localhost:8000
VITE_STELLAR_NETWORK=standalone
VITE_STELLAR_NETWORK_PASSPHRASE="Standalone Network ; February 2025"
VITE_INVOICE_CONTRACT_ID=$INVOICE_CONTRACT_ID
VITE_TREASURY_CONTRACT_ID=$TREASURY_CONTRACT_ID
VITE_COMPLIANCE_CONTRACT_ID=$COMPLIANCE_CONTRACT_ID
VITE_BACKEND_URL=http://localhost:3000
EOF

npm ci
npm run dev
```

**Expected output:**
```
> comebackhere-frontend@0.1.0 dev
> vite

  VITE v4.x.x  ready in XXX ms

  ➜  Local:   http://localhost:5173/
  ➜  press h to show help
```

The frontend is now running on `http://localhost:5173`.

## Step 7: Connect Freighter to Local Network

1. Open Freighter wallet extension in your browser.
2. Click **Settings** → **Networks**.
3. Add a custom network:
   - **Name:** `Standalone`
   - **RPC URL:** `http://localhost:8000`
   - **Horizon URL:** `http://localhost:8000`
   - **Passphrase:** `Standalone Network ; February 2025`
4. Switch to the `Standalone` network.
5. Ensure your wallet has the admin public key we configured earlier. If not, import it into Freighter.

**Expected state:** Freighter shows your balance on the standalone network (should be non-zero after account creation).

## Step 8: Create an Invoice

1. Open `http://localhost:5173` in your browser.
2. Login with Freighter (click **Connect Wallet** and approve).
3. Navigate to **Create Invoice**.
4. Fill in the form:
   - **Merchant:** Your Freighter public key
   - **Payer:** Another Stellar account (or use the same key for testing)
   - **Amount:** `100` USDC
   - **Description:** `Test Invoice`
   - **Expiry:** 30 days from now
5. Click **Create Invoice**.

**Expected output in browser:**
```
✓ Invoice created successfully
Invoice ID: IBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Status: Pending
Amount: 100 USDC
```

**Check the backend logs:** You should see:
```
[info] Invoice event received: invoice_created
[info] Storing invoice in MongoDB
```

**Check MongoDB:**
```sh
docker exec comebackhere_mongodb_1 mongosh --eval \
  "db.invoices.findOne({}, {_id: 0, id: 1, amount: 1, status: 1})"
```

**Expected output:**
```
{
  id: "IBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  amount: 100000000,  # in stroops (100 * 10^7)
  status: "Pending"
}
```

## Step 9: Pay the Invoice

1. In the frontend, navigate to **Pending Invoices** or find the invoice you just created.
2. Click **Pay Now**.
3. In Freighter, approve the transaction to transfer 100 USDC to the escrow contract.
4. Wait for the transaction to be confirmed (5–10 seconds on local network).

**Expected output in browser:**
```
✓ Payment received
Invoice Status: Paid
Amount: 100 USDC
```

**Check the backend logs:**
```
[info] Payment event received: invoice_paid
[info] Updating invoice status to Paid
```

**Verify invoice status in MongoDB:**
```sh
docker exec comebackhere_mongodb_1 mongosh --eval \
  "db.invoices.findOne({}, {_id: 0, id: 1, status: 1})"
```

**Expected output:**
```
{
  id: "IBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  status: "Paid"
}
```

## Troubleshooting

### Services not starting

```sh
# Check service status
docker-compose ps

# View logs
docker-compose logs soroban
docker-compose logs backend
docker-compose logs mongodb
```

### Contract deployment fails

```sh
# Verify Soroban CLI is configured correctly
soroban config env list

# Verify RPC is accessible
curl -s http://localhost:8000/health | jq .
```

### Freighter shows zero balance

1. Ensure the admin public key in Freighter matches the one from `soroban config identity show dev`.
2. Restart Freighter extension (close and reopen the extension).
3. Verify the standalone network is selected.

### Frontend can't connect to backend

```sh
# Check backend is running
curl -s http://localhost:3000/health

# Verify VITE_BACKEND_URL is set correctly
cat ~/.comebackhere-frontend/.env.local | grep VITE_BACKEND_URL
```

### MongoDB connection error

```sh
# Restart MongoDB
docker-compose restart mongodb
```

## Cleanup

To stop all services:

```sh
docker-compose down
```

To remove volumes (reset all data):

```sh
docker-compose down -v
```

## Next Steps

- Explore the contract ABI in the **ABI Explorer** within the frontend.
- Try creating multiple invoices and settling them.
- Check the Redis event log: `docker exec comebackhere_redis_1 redis-cli LRANGE events 0 -1`.
- Run the backend tests: `cd comebackhere-backend && npm test`.
- Run the contract tests: `cd COMEBACKHERE-contracts && cargo test`.

## References

- [docs/dev-environment.md](./dev-environment.md) — detailed prerequisites and configuration.
- [docs/TESTNET_ONBOARDING.md](./TESTNET_ONBOARDING.md) — deploying to Stellar Testnet.
- [docs/contract-interaction-guide.md](./contract-interaction-guide.md) — smart contract API reference.
