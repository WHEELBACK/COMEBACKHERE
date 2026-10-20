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

## Typed API Client

The backend publishes an OpenAPI schema at `docs/openapi.yaml`. A typed client
is generated from that schema so request and response types stay synchronized
with the published API.

### Generate the client

```bash
npm run generate:client
```

This regenerates the client into `packages/api-client/` from
`docs/openapi.yaml`. Do not edit generated files by hand — change the spec and
regenerate.

### CI staleness check

CI runs `npm run generate:client` and fails if the regenerated output differs
from what is committed. If the check fails locally, regenerate and commit the
result:

```bash
npm run generate:client
git add packages/api-client
git commit -m "chore: regenerate API client"
```

### Consumer example

```typescript
import { createClient } from "@comebackhere/api-client"

const client = createClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.MERCHANT_API_KEY,
})

// Request and response types are derived from the OpenAPI schema.
const invoice = await client.createInvoice({
  token: "USDC",
  amount: 1000000,
  due_date: 1720000000,
})

console.log(invoice.invoice_id)
```

> Full request/response shapes: [docs/api-reference.md](docs/api-reference.md)

---

## Quickstart for Merchants

Integrate COMEBACKHERE payments in three steps: create an invoice, set up
webhooks, and process the payment. This section links to the full reference
docs rather than duplicating them.

### 1. Create an invoice

```bash
curl -X POST http://localhost:3000/invoices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MERCHANT_API_KEY" \
  -d '{
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

All outbound webhook POSTs are signed with HMAC-SHA256 over the exact raw body
bytes. Verify the `X-COMEBACKHERE-Signature` header before processing:

```typescript
import { createHmac, timingSafeEqual } from "crypto"

function verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  const expectedBuf = Buffer.from(expected, "hex")
  const actualBuf = Buffer.from(signature, "hex")

  // timingSafeEqual throws on a length mismatch, so reject short or
  // malformed signatures before comparing.
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}
```

The body-only digest is temporarily available as `X-COMEBACKHERE-Legacy-Signature`
for one release while receivers migrate.

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

```mermaid
sequenceDiagram
    participant Payer
    participant Merchant as Merchant Backend
    participant Invoice as Invoice Contract
    participant Treasury
    participant Compliance

    Payer->>Merchant: Initiate payment
    Merchant->>Invoice: create_invoice(amount, token)
    activate Invoice
    Invoice->>Treasury: deposit(amount)
    activate Treasury
    Treasury->>Payer: request authorization
    Payer->>Treasury: authorize & transfer
    Treasury->>Treasury: escrow tokens
    Treasury-->>Invoice: deposit confirmed
    deactivate Treasury
    Invoice->>Compliance: verify_payer()
    activate Compliance
    Compliance-->>Invoice: compliance status
    deactivate Compliance
    Invoice-->>Merchant: invoice_id
    deactivate Invoice

    Merchant->>Payer: payment link
    Payer->>Invoice: confirm_payment()
    activate Invoice
    Invoice->>Treasury: release(invoice_id)
    activate Treasury
    Treasury->>Treasury: transfer to merchant
    Treasury-->>Invoice: transfer confirmed
    deactivate Treasury
    Invoice-->>Merchant: payment confirmed
    deactivate Invoice

    Merchant->>Payer: receipt
```

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

## Required Environment Variables Checklist

Before starting the stack, ensure your local `.env` (or service-specific `.env` files) defines these required values:

### Backend (`comebackhere-backend` or Docker `backend`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SOROBAN_RPC_URL` | Yes | `http://localhost:8000/soroban/rpc` | Soroban RPC endpoint |
| `INVOICE_CONTRACT_ID` | Yes* | — | Deployed invoice contract address (required when calling invoice routes) |
| `TREASURY_CONTRACT_ID` | Yes* | — | Deployed treasury contract address (required when calling treasury routes) |
| `USDC_CONTRACT_ID` | Yes* | — | USDC token contract address |
| `SIGNER_SECRET_KEY` | Yes | — | Stellar secret key used for signing transactions |
| `MONGODB_URI` | No | `mongodb://localhost:27017` | MongoDB connection URI for indexer state |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL for rate limiting & event channels |
| `PORT` | No | `3000` (host) / `3001` (Docker) | HTTP server listen port |

\* Required at runtime when invoking the respective contract-backed endpoints.

### Frontend (`comebackhere-frontend` or Docker `frontend`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VITE_API_URL` | Yes | `http://localhost:3000` | Backend API base URL |
| `VITE_SOROBAN_RPC` | Yes | `http://localhost:8000/soroban/rpc` | Soroban RPC endpoint for wallet interactions |
| `VITE_HORIZON_URL` | No | `http://localhost:8000` | Horizon API URL |
| `VITE_NETWORK_PASSPHRASE` | No | `Standalone Network ; February 2025` | Stellar network passphrase |

---

## Start the Development Environment

Launch all required services:

```bash
docker-compose up -d
```

This starts the following services:

| Service | Description | Default Port | Health Check |
| --- | --- | --- | --- |
| `soroban` | Stellar Quickstart standalone node + RPC + Horizon | `8000`, `11625`, `11626` | `curl -f http://localhost:8000/health` |
| `redis` | Redis 7 cache and event queue | `6379` | `redis-cli ping` |
| `mongodb` | MongoDB 7 persistence for indexer state | `27017` | `mongosh --eval "db.adminCommand('ping')"` |
| `backend` | Protocol backend API | `3001` | `curl -f http://localhost:3001/health/rpc` |
| `frontend` | Protocol web dashboard / UI | `5173` | `curl -f http://localhost:5173/` |

---

## Verify the Services

### 1. Check Container Health with `docker-compose ps`

Check that all containers are running and in a `(healthy)` status:

```bash
docker-compose ps
```

Expected output:

```text
NAME                      IMAGE                       COMMAND                  SERVICE    CREATED          STATUS                    PORTS
comebackh
```
