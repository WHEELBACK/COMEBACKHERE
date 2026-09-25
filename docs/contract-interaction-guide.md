# Contract Interaction Guide

Step-by-step guide for calling COMEBACKHERE Protocol contracts via `soroban-cli` and the backend API.

## Prerequisites

- Funded Stellar account on the target network
- Deployed contracts — IDs available in `artifacts/addresses.json`
- Configured `.env` (copy from `.env.local.example` or `.env.testnet.example`)
- `soroban-cli` installed: `cargo install soroban-cli`

Placeholder values used throughout:

| Placeholder           | Replace with                                     |
| --------------------- | ------------------------------------------------ |
| `$INVOICE_CONTRACT`   | Invoice contract ID from `artifacts/addresses.json` |
| `$TREASURY_CONTRACT`  | Treasury contract ID                             |
| `$COMPLIANCE_CONTRACT`| Compliance contract ID                           |
| `$SOURCE_ACCOUNT`     | Your funded Stellar public key                   |
| `$SECRET_KEY`         | Your Stellar secret key                          |
| `$RPC_URL`            | Soroban RPC endpoint (e.g. `http://localhost:8000/soroban/rpc`) |
| `$NETWORK_PASSPHRASE` | Network passphrase from your `.env`              |

---

## Invoice Contract

### Create an invoice

#### soroban-cli

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- create_invoice \
  --merchant $SOURCE_ACCOUNT \
  --customer GCUSTOMER... \
  --amount 1000000 \
  --token CUSDC... \
  --expires_at 1750000000 \
  --nonce 1
```

#### API

```sh
curl -X POST http://localhost:3000/invoices \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_address": "$SOURCE_ACCOUNT",
    "token": "USDC",
    "amount": 1000000,
    "due_date": 1750000000
  }'
```

Response includes `invoice_id` to use in subsequent calls.

---

### Get invoice status

#### soroban-cli

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_invoice_status \
  --invoice_id 1
```

#### API

```sh
curl http://localhost:3000/invoices/1
```

---

### Mark invoice as paid

#### soroban-cli

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- mark_paids \
  --invoice_ids '[1]'
```

---

### Raise a dispute

Calling `raise_dispute` on the invoice contract atomically calls
`raise_dispute` on the treasury contract, placing the referenced
settlement `OnHold`.

#### soroban-cli

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- raise_dispute \
  --invoice_id 1 \
  --settlement_id 3 \
  --claimant $SOURCE_ACCOUNT \
  --reason 1
```

#### API

```sh
curl -X POST http://localhost:3000/disputes \
  -H "Content-Type: application/json" \
  -d '{
    "claimant_address": "$SOURCE_ACCOUNT",
    "settlement_id": "3",
    "reason": "Goods not delivered"
  }'
```

---

### Configure treasury address (admin only)

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- set_treasury \
  --caller $SOURCE_ACCOUNT \
  --treasury $TREASURY_CONTRACT
```

---

## Treasury Contract

### Propose a settlement

#### soroban-cli

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- propose_settlement \
  --signer $SOURCE_ACCOUNT \
  --token CUSDC... \
  --amount 5000000 \
  --merchant GMERCHANT...
```

Returns the `settlement_id`.

---

### Approve a settlement

#### soroban-cli

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- approve_settlement \
  --signer $SOURCE_ACCOUNT \
  --settlement_id 1
```

#### API

```sh
curl -X POST http://localhost:3000/api/treasury/approve-settlement \
  -H "Content-Type: application/json" \
  -d '{ "settlement_id": 1 }'
```

---

### Execute a settlement

#### soroban-cli

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- execute_settlement \
  --signer $SOURCE_ACCOUNT \
  --settlement_id 1 \
  --token_contract CUSDC...
```

#### API

The execute endpoint validates the treasury USDC balance before submitting.

```sh
curl -X POST http://localhost:3000/api/treasury/execute-settlement \
  -H "Content-Type: application/json" \
  -d '{ "settlement_id": 1 }'
```

---


### Place a settlement on hold

Calls `hold_settlement` on the treasury contract, preventing execution until
explicitly released or escalated.

#### soroban-cli

```sh
soroban contract invoke \\
  --id $TREASURY_CONTRACT \\
  --source $SECRET_KEY \\
  --rpc-url $RPC_URL \\
  --network-passphrase "$NETWORK_PASSPHRASE" \\
  -- hold_settlement \\
  --signer $SOURCE_ACCOUNT \\
  --settlement_id 7 \\
  --reason "Awaiting KYC confirmation"
```

---

### Release a hold

Calls `release_hold` on the treasury contract, returning the settlement to `Pending`
so the normal approval and execution flow can resume.

#### soroban-cli

```sh
soroban contract invoke \\
  --id $TREASURY_CONTRACT \\
  --source $SECRET_KEY \\
  --rpc-url $RPC_URL \\
  --network-passphrase "$NETWORK_PASSPHRASE" \\
  -- release_hold \\
  --signer $SOURCE_ACCOUNT \\
  --settlement_id 7
```

#### API

```sh
curl -X POST http://localhost:3000/api/treasury/release-hold \\
  -H "Content-Type: application/json" \\
  -d '{ "settlement_id": 7 }'
```

---

### Raise a dispute (escalate hold)

Calls `raise_dispute` on the treasury contract, escalating the hold to the
governance dispute-resolution flow and beginning a multi-sig vote.

#### soroban-cli

```sh
soroban contract invoke \\
  --id $TREASURY_CONTRACT \\
  --source $SECRET_KEY \\
  --rpc-url $RPC_URL \\
  --network-passphrase "$NETWORK_PASSPHRASE" \\
  -- raise_dispute \\
  --signer $SOURCE_ACCOUNT \\
  --settlement_id 7 \\
  --reason "Merchant disputes the invoice amount"
```

#### API

```sh
curl -X POST http://localhost:3000/api/treasury/escalate-hold \\
  -H "Content-Type: application/json" \\
  -d '{ "settlement_id": 7, "reason": "Merchant disputes the invoice amount" }'
```

---

### Get / set approval threshold

#### soroban-cli — read

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_threshold
```

#### soroban-cli — update

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- update_threshold \
  --admin $SOURCE_ACCOUNT \
  --new_threshold 3
```

#### API — read

```sh
curl http://localhost:3000/api/treasury/threshold
```

#### API — update

```sh
curl -X POST http://localhost:3000/api/treasury/threshold \
  -H "Content-Type: application/json" \
  -d '{ "threshold": 3 }'
```

---

## Treasury Multisig Workflow

This section walks through a complete multisig approval flow: proposing a settlement, approving it from multiple signer identities, and executing it. Use this guide when acting directly on-chain during backend outages.

### Scenario: Three signers approve a settlement

Signers: `SIGNER_1`, `SIGNER_2`, `SIGNER_3` (threshold = 100 weight; each signer has 50 weight).

#### Step 1: Propose a settlement

The first signer proposes a settlement disbursing 10 USDC to a merchant.

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \  # Signer 1's key
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- propose_settlement \
  --signer SIGNER_1 \
  --token CUSDC... \
  --amount 10000000 \
  --merchant GMERCHANT...
```

**Expected output:** Settlement ID (e.g. `settlement_id: 1`). Note this ID; you'll need it for approvals.

#### Step 2: Check settlement status

Verify the settlement was created and is awaiting approvals.

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_settlement \
  --settlement_id 1
```

**Expected output:**
```
status: Pending
approval_weight: 0
threshold: 100
```

The `approval_weight` of 0 means no signers have approved yet.

#### Step 3: Signer 1 approves

Signer 1 approves the settlement (automating their 50 weight).

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SIGNER_1_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- approve_settlement \
  --signer SIGNER_1 \
  --settlement_id 1
```

**Expected output:** Transaction confirmed.

Check status again:

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_settlement \
  --settlement_id 1
```

**Expected output:**
```
status: Pending
approval_weight: 50
threshold: 100
```

Still pending — only 50 of 100 weight approvals collected.

#### Step 4: Signer 2 approves

A second signer approves. Their 50 weight brings the total to 100, meeting the threshold.

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SIGNER_2_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- approve_settlement \
  --signer SIGNER_2 \
  --settlement_id 1
```

Check status:

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_settlement \
  --settlement_id 1
```

**Expected output:**
```
status: Pending
approval_weight: 100
threshold: 100
```

Status is still `Pending`, but `approval_weight` now equals the threshold. The settlement is ready to be executed by any signer.

#### Step 5: Execute the settlement

Any signer (or the protocol admin) can now call `execute_settlement` to transfer funds.

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SIGNER_1_KEY \  # Any signer can execute
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- execute_settlement \
  --signer SIGNER_1 \
  --settlement_id 1 \
  --token_contract CUSDC...
```

**Expected output:** Transaction confirmed. Funds are transferred to the merchant's account.

Verify execution:

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_settlement \
  --settlement_id 1
```

**Expected output:**
```
status: Executed
```

#### Step 6 (optional): Update the threshold

After testing, the admin can adjust the threshold for future settlements.

```sh
soroban contract invoke \
  --id $TREASURY_CONTRACT \
  --source $ADMIN_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- update_threshold \
  --admin GADMIN... \
  --new_threshold 150
```

Now all future settlements will require 150 cumulative weight before execution.

---

## Compliance Contract

### Allow an address

#### soroban-cli

```sh
soroban contract invoke \
  --id $COMPLIANCE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- allow_address \
  --admin $SOURCE_ACCOUNT \
  --address GTARGET...
```

---

### Block an address

#### soroban-cli

```sh
soroban contract invoke \
  --id $COMPLIANCE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- block_address \
  --admin $SOURCE_ACCOUNT \
  --address GTARGET...
```

---

### Check whether an address is allowed (`is_allowed`)

`is_allowed` returns `true` only when an address has been explicitly allowed
**and** its allowance has not expired.  Three distinct scenarios produce a
`false` result, and integrators must not treat them as equivalent — the
appropriate response differs in each case.

#### Scenario 1 — Address was never allowed

The address has never been passed to `allow_address`.  `is_allowed` returns
`false` immediately.  The correct action is to route the payer through your
KYC/onboarding flow before retrying.

```sh
# The address GNEW... has never been allowed.
soroban contract invoke \
  --id $COMPLIANCE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- is_allowed \
  --address GNEWADDRESSNEVERALLOWED...
# → false
```

Expected response: `false`

The backend maps this to error code `COMPLIANCE_NOT_ALLOWED`.  Return HTTP 403
to the caller with a message indicating that the address must complete
onboarding before transacting.

#### Scenario 2 — Address was allowed but the allowance has expired

`allow_address` was called with an `expires_at` timestamp that has since
passed.  `is_allowed` returns `false` because the allowance window closed.
The address is not blocked — it simply needs to be re-allowed (e.g., after
a periodic compliance re-check).

```sh
# GEXPIRED... was allowed until ledger time 1700000000, which has passed.
soroban contract invoke \
  --id $COMPLIANCE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- is_allowed \
  --address GEXPIREDADDRESS...
# → false  (allowance window closed)
```

Expected response: `false`

The backend maps this to error code `COMPLIANCE_ALLOWANCE_EXPIRED`.  Return
HTTP 403 with a message telling the caller that their compliance approval has
lapsed and they must renew it.  Do **not** present this to the user as a block
— it is a renewal prompt.

#### Scenario 3 — Address is explicitly blocked

`block_address` was called for this address.  `is_allowed` returns `false`
regardless of any prior allowance.  A blocked address must not transact until
the block is explicitly lifted by a compliance admin.

```sh
# GBLOCKED... was explicitly blocked via block_address.
soroban contract invoke \
  --id $COMPLIANCE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- is_allowed \
  --address GBLOCKEDADDRESS...
# → false  (explicit block in effect)
```

Expected response: `false`

The backend maps this to error code `COMPLIANCE_BLOCKED`.  Return HTTP 403
with a message indicating that the address is blocked from transacting.  Do
**not** expose details about why it was blocked to the end-user; log the event
for compliance audit purposes and direct the user to your support channel.

#### Summary of `is_allowed` return values

| State | `is_allowed` result | Error code | Suggested HTTP status |
| ----- | ------------------- | ---------- | --------------------- |
| Never allowed | `false` | `COMPLIANCE_NOT_ALLOWED` | 403 |
| Allowance expired | `false` | `COMPLIANCE_ALLOWANCE_EXPIRED` | 403 |
| Explicitly blocked | `false` | `COMPLIANCE_BLOCKED` | 403 |
| Allowed and within window | `true` | — | proceed |

---

## Invoice grace window

### Read

#### soroban-cli

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_grace_window
```

#### API

```sh
curl http://localhost:3000/api/invoice/grace-window
```

### Update (admin only)

#### soroban-cli

```sh
soroban contract invoke \
  --id $INVOICE_CONTRACT \
  --source $SECRET_KEY \
  --rpc-url $RPC_URL \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- set_grace_window \
  --caller $SOURCE_ACCOUNT \
  --window 172800
```

#### API

```sh
curl -X POST http://localhost:3000/api/invoice/grace-window \
  -H "Content-Type: application/json" \
  -d '{ "grace_window_seconds": 172800 }'
```

---

## Tips

- All contract write operations require `--source` to be a funded account with sufficient XLM for fees.
- Use `--network testnet` instead of `--rpc-url` / `--network-passphrase` flags when targeting Testnet via the CLI default configuration.
- Contract IDs and addresses are exported to `artifacts/addresses.json` after running a deployment script.
