# COMEBACKHERE Protocol

> **The Stripe for Stellar**
> Secure, scalable, and developer-friendly payment infrastructure built on the Stellar network.

This repository contains the tooling, deployment scripts, contract ABIs, documentation, and integration resources required to develop, deploy, and maintain the **COMEBACKHERE Protocol**.

---

## Overview

COMEBACKHERE provides the infrastructure needed to build seamless payment experiences on Stellar. This repository serves as the central workspace for:

* Smart contract deployment
* ABI generation and management
* Developer documentation
* Local development tooling
* Integration and deployment scripts
* Workspace-level testing

---

## Quickstart for Merchants

Integrate COMEBACKHERE payments in three steps: create an invoice, set up
webhooks, and process the payment. This section links to the full reference
docs rather than duplicating them.

### 1. Create an invoice

```bash
curl -X POST http://localhost:3000/invoices \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_address": "G...",
    "token": "USDC",
    "amount": 1000000,
    "due_date": 1720000000
  }'
```

The response includes `invoice_id` — share this with your payer.

> Full request/response shapes: [docs/api-reference.md](docs/api-reference.md#post-invoices)

### 2. Set up webhooks

Configure `WEBHOOK_URL` and `WEBHOOK_SIGNING_SECRET` in your environment so
the backend can notify your system when payments land.

All outbound webhook POSTs are signed with HMAC-SHA256. Verify the
`X-COMEBACKHERE-Signature` header before processing:

```typescript
import { createHmac, timingSafeEqual } from "crypto"

function verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
}
```

> Webhook events and configuration: [docs/api-reference.md](docs/api-reference.md#webhooks)

### 3. Minimal payment flow

```text
Merchant            Backend              Payer
  |                   |                    |
  |-- create_invoice ->|                    |
  |                   |                    |
  |  (share invoice_id with payer)         |
  |                   |                    |
  |                   |<-- pay off-chain ---|
  |                   |                    |
  |<-- webhook POST --|                    |
  |  (settlement_executed)                 |
```

For the full end-to-end testnet walkthrough (funding accounts, deploying
contracts, paying with USDC, and executing a settlement), see
[docs/TESTNET_ONBOARDING.md](docs/TESTNET_ONBOARDING.md).

> Rate limits apply to all API endpoints. See [docs/rate-limits.md](docs/rate-limits.md).

---

## Architecture

The diagram below illustrates the primary payment flow through the COMEBACKHERE Protocol.

> *(Insert architecture or sequence diagram here.)*

---

## Repository Structure

```text
.
├── abis/          # Contract ABI files consumed by the backend
├── docs/          # Developer guides and deployment documentation
├── scripts/       # Deployment, verification, and utility scripts
└── tests/         # Workspace-level integration tests
```

| Directory  | Description                                            |
| ---------- | ------------------------------------------------------ |
| `abis/`    | Generated contract ABIs used by `comebackhere-backend` |
| `scripts/` | Deployment, verification, and ABI generation scripts   |
| `docs/`    | Technical documentation and deployment guides          |
| `tests/`   | Integration and workspace-level test suites            |

---

# Local Development

## Prerequisites

Before getting started, ensure you have:

* Docker
* Docker Compose

---

## Start the Development Environment

Launch all required services:

```bash
docker-compose up -d
```

This starts the following services:

| Service      | Description                                           | Default Port |
| ------------ | ----------------------------------------------------- | ------------ |
| Soroban Node | Stellar Quickstart environment (includes Horizon API) | `8000`       |
| Redis        | Event consumer backing service                        | `6379`       |

---

## Verify the Services

Check that the containers are running:

```bash
docker-compose ps
```

Verify the Soroban node is healthy:

```bash
curl http://localhost:8000/health
```

---

## Using `docker-compose.override.yml`

This repository includes a `docker-compose.override.yml` file.

Docker Compose automatically merges this file with `docker-compose.yml` whenever you run:

```bash
docker-compose up
```

The override configuration adds the following development services:

* Backend
* Frontend

This allows you to run the complete application stack locally without modifying the base compose configuration.

### Common Customizations

Developers often update the override file to:

* Change `VITE_API_URL`
* Change `VITE_SOROBAN_RPC`
* Modify port mappings
* Mount local source directories for hot reloading
* Customize environment-specific settings

To view the final merged configuration:

```bash
docker-compose config
```

---

# ABI Snapshot Verification

Before committing changes, ensure the generated ABI snapshots are up to date.

Using Make:

```bash
make check-abi-snapshots
```

Or with Just:

```bash
just check-snapshot
```

Finally, verify there are no uncommitted ABI changes:

```bash
git diff --exit-code abis/
```

---

# Deployment

## Testnet Deployment

Copy the example environment file:

```bash
cp .env.testnet.example .env.testnet
```

Deploy the contracts:

```bash
scripts/deploy_testnet.sh
```

After deployment, contract addresses are exported to:

```text
artifacts/addresses.json
```

This file is intentionally ignored by Git because it contains environment-specific deployment data.

For the expected structure, refer to:

```text
artifacts/addresses.json.example
```

---

## Mainnet Deployment

Mainnet deployments are intentionally **manual** and require approval through the project's multisignature governance process.

Before deploying to production, follow the complete deployment checklist and signing ceremony documented in:

```text
docs/MAINNET_DEPLOYMENT.md
```

---

# Contributing

Before opening a pull request:

* Keep ABI snapshots up to date.
* Verify all tests pass.
* Review deployment documentation if modifying contracts or deployment scripts.
* Ensure your branch is clean and free of unintended changes.

---

# License

This project is licensed under the **MIT License**.
