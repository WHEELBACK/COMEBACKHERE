# API Reference

Base URL: `http://localhost:3000` (local) or your deployed backend.

All request bodies are JSON (`Content-Type: application/json`) and are limited
to **100 kB**; larger bodies are rejected with `413 PAYLOAD_TOO_LARGE`.
All responses are JSON.

**CORS:** browsers may call the API only from origins listed in
`CORS_ORIGINS`. Requests from any other origin, including preflights, get
`403 CORS_ORIGIN_NOT_ALLOWED`. Preflight allows the `Content-Type`,
`Authorization`, `Idempotency-Key`, `X-Request-Id` and `X-Admin-Key` request
headers, and exposes `X-Request-Id`, `Retry-After` and the `X-RateLimit-*`
response headers. Requests with no `Origin` header (server-to-server, curl)
are unaffected.

Every response carries a baseline of security headers (via
[helmet](https://helmetjs.github.io/)), including `Strict-Transport-Security`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a strict
`Content-Security-Policy: default-src 'none'`. Swagger UI under `/api-docs`
gets a relaxed CSP that allows its same-origin scripts, inline styles and
`data:` images.

> **Machine-readable spec:** A Swagger/OpenAPI 3.0 spec is served at
> [`GET /api-docs/swagger.json`](http://localhost:3000/api-docs/swagger.json) (raw JSON)
> and [`GET /api-docs`](http://localhost:3000/api-docs) (interactive Swagger UI).
>
> **Rate limits:** All endpoints are subject to per-IP rate limiting. See
> [docs/rate-limits.md](./rate-limits.md) for default limits, configuration,
> and the 429 response shape.
>
> **Errors:** Every error uses one envelope,
> `{ "error": { "code", "message", "details", "correlationId" } }`. See
> [Error response shape](#error-response-shape).

## Deprecation Policy

Some endpoints are marked as **deprecated** and will be removed in a future version. Deprecated endpoints receive standard HTTP deprecation headers:

- `Deprecation: true` — indicates the endpoint is deprecated
- `Sunset: <HTTP-date>` — the date when the endpoint will be permanently removed
- `Link: <new-url>; rel="successor-version"` — the replacement endpoint to migrate to

**Legacy routes** in `backend/src/legacy_routes.rs` and `backend/src/routes_auth_legacy.rs` carry these headers. Plan to migrate to the canonical routes before the sunset date.

Current legacy routes (to be removed):
- Old merchant endpoints under `/api/v1/merchant/*` — migrate to `/api/v2/merchant/*`
- Old settlement endpoints under `/api/v1/settlement/*` — migrate to `/api/v2/settlement/*`
- Old dispute endpoints under `/api/v1/dispute/*` — migrate to `/api/v2/dispute/*`
- Old signer endpoints under `/api/v1/signer/*` — migrate to `/api/v2/signer/*`
- Old admin endpoints under `/api/v1/admin/*` — migrate to `/api/v2/admin/*`

Usage of deprecated endpoints is logged server-side; if you hit one, update your client to use the replacement endpoint.

---

## Health

### `GET /health`

Returns service health status.

**Response `200`**

```json
{ "status": "ok" }
```

---

### `GET /health/rpc`

Checks Soroban RPC reachability and current ledger.

**Response `200`**

```json
{
  "rpc": "reachable",
  "network": "mainnet",
  "ledger": 54321678
}
```

#### Errors

| Status | Description                             |
| ------ | --------------------------------------- |
| `503`  | Soroban RPC unreachable                 |
| `500`  | Unexpected server error                 |

---


## Invoices

### `GET /invoices/:id`

Fetch the on-chain status of an invoice by its numeric ID.

#### Path parameters

| Parameter | Type   | Description             |
| --------- | ------ | ----------------------- |
| `id`      | string | Positive integer string |

**Response `200`**

```json
{
  "invoice_id": "42",
  "status": "Pending"
}
```

#### Errors

| Status | Description                              |
| ------ | ---------------------------------------- |
| `400`  | `id` is not a positive integer           |
| `404`  | Invoice not found on-chain               |
| `503`  | Missing required environment variables   |
| `500`  | Unexpected server error                  |

---

### `POST /invoices`

Create a new invoice by submitting `create_invoice` to the Soroban RPC.

#### Request body

```json
{
  "merchant_address": "G...",
  "token": "USDC",
  "amount": 1000000,
  "due_date": 1720000000
}
```

| Field              | Type   | Description                                       |
| ------------------ | ------ | ------------------------------------------------- |
| `merchant_address` | string | Valid Stellar public key (G…)                    |
| `token`            | string | Token identifier                                  |
| `amount`           | number | Positive number (in stroops / smallest unit)      |
| `due_date`         | number | Future Unix timestamp (seconds) for the due date  |

**Response `201`**

```json
{
  "invoice_id": "1",
  "status": "Pending"
}
```

#### Errors

| Status | Description                                                    |
| ------ | -------------------------------------------------------------- |
| `400`  | Validation error — see `error.details` for field-level detail  |
| `422`  | Soroban simulation or transaction failure                      |
| `503`  | Missing required environment variables                         |
| `504`  | Transaction confirmation timeout                               |
| `500`  | Unexpected server error                                        |

---

### `GET /invoices/export.csv`

Downloads invoices as a CSV file for accounting tools. Accepts the same filters
as `GET /invoices` (without pagination) and the same authentication; every
matching invoice is exported, newest first. Rows are streamed from the database
cursor, so large exports do not load into memory.

#### Query parameters

| Parameter  | Type   | Description                                                                 |
| ---------- | ------ | --------------------------------------------------------------------------- |
| `status`   | string | Optional. `Pending`, `Paid`, `Expired`, `Cancelled`, `RefundRequested`, `Released` |
| `merchant` | string | Optional. Merchant Stellar address                                          |

**Response `200`** — `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="invoices-2026-09-25.csv"`
(`invoices-<status>-<date>.csv` when filtered by status).

```csv
invoice_id,merchant_address,token,amount_raw,amount,status,reference,due_date,created_at,updated_at
1,GDR7...T5XT,USDC,12500000,1.25 USDC,Paid,"Order ""A"", batch 2",2026-01-01T00:00:00.000Z,2025-12-01T10:00:00.000Z,2025-12-02T10:00:00.000Z
```

- Fields follow RFC 4180: values containing commas, quotes or line breaks are
  quoted, and quotes are doubled. Rows end with CRLF.
- Text beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` so
  spreadsheets do not evaluate it as a formula.
- `amount_raw` is in the token's smallest unit; `amount` is the human-readable
  value with the token symbol. Tokens default to 7 decimals with the stored
  token value as symbol; override per token with the `TOKEN_METADATA`
  environment variable, e.g.
  `{"C...USDC_CONTRACT":{"symbol":"USDC","decimals":7}}`.
- Dates are ISO 8601 in UTC.

#### Errors

| Status | Description                                                                 |
| ------ | --------------------------------------------------------------------------- |
| `500`  | Database error before streaming started (JSON body). Errors after streaming started abort the download |

---

## Disputes

### `POST /disputes`

Raise a dispute linked to a settlement, transitioning it to `OnHold`.

#### Request body

```json
{
  "claimant_address": "G...",
  "settlement_id": "5",
  "reason": "Goods not delivered"
}
```

| Field               | Type   | Required | Description                                      |
| ------------------- | ------ | -------- | ------------------------------------------------ |
| `claimant_address`  | string | Yes      | Valid Stellar public key of the disputing party  |
| `settlement_id`     | string | Yes      | Positive integer string identifying settlement   |
| `reason`            | string | No       | Human-readable reason for the dispute            |

**Response `201`**

```json
{
  "dispute_id": "5-1720000000000",
  "settlement_id": "5",
  "claimant_address": "G...",
  "status": "Raised",
  "settlement_status": "OnHold"
}
```

#### Errors

| Status | Description                                                    |
| ------ | -------------------------------------------------------------- |
| `400`  | Validation error — see `error.details` for field-level detail  |
| `503`  | Missing required environment variables                         |
| `500`  | Unexpected server error                                        |

### `GET /disputes`

List disputes with their current vote tallies, newest first.

#### Query parameters

| Parameter       | Type    | Default | Description                                   |
| --------------- | ------- | ------- | --------------------------------------------- |
| `status`        | string  | —       | `Raised` (open) or `Resolved`                 |
| `settlement_id` | string  | —       | Only disputes for this settlement             |
| `page`          | integer | `1`     | 1-based page number                           |
| `limit`         | integer | `20`    | Page size, 1–100                              |

Send `x-admin-key` to include voter identities (see
[Voter visibility](#voter-visibility)).

**Response `200`**

```json
{
  "data": [
    {
      "dispute_id": "5-1720000000000",
      "settlement_id": "5",
      "claimant_address": "G...",
      "reason": "Goods not delivered",
      "status": "Raised",
      "outcome": null,
      "claimant_weight": 1,
      "counterparty_weight": 0,
      "resolution_weight": 1,
      "threshold": 2,
      "vote_count": 1,
      "created_at": "2026-09-25T10:00:00.000Z",
      "resolved_at": null
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

#### Errors

| Status | Description                                                   |
| ------ | ------------------------------------------------------------- |
| `400`  | Invalid query parameter — see `error.details`                 |
| `401`  | `x-admin-key` supplied but invalid                            |

### `GET /disputes/:id`

Full details for one dispute: the same fields as a list item. For admins it
also includes `votes`:

```json
{
  "dispute_id": "5-1720000000000",
  "status": "Resolved",
  "outcome": "ResolvedClaimant",
  "claimant_weight": 2,
  "counterparty_weight": 1,
  "resolution_weight": 3,
  "threshold": 2,
  "vote_count": 3,
  "resolved_at": "2026-09-25T10:05:00.000Z",
  "votes": [
    { "signer": "G...", "vote": "ResolvedClaimant", "weight": 1, "voted_at": "2026-09-25T10:01:00.000Z" }
  ]
}
```

#### Errors

| Status | Description                                   |
| ------ | --------------------------------------------- |
| `401`  | `x-admin-key` supplied but invalid            |
| `404`  | No dispute with this ID                       |

### `POST /disputes/:id/vote`

Cast a weighted vote (`ResolvedClaimant` or `ResolvedCounterparty`). The
dispute resolves as soon as either side's weight reaches the threshold
(`DISPUTE_VOTE_THRESHOLD`, default `2`).

| Status | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `400`  | Validation error                                                       |
| `404`  | No dispute with this ID                                                |
| `409`  | Signer already voted, or dispute already resolved (`details.outcome`)  |

### Voter visibility

Tallies (`claimant_weight`, `counterparty_weight`, `resolution_weight`,
`vote_count`, `outcome`) are public. **Who voted which way is visible only to
admins** (a valid `x-admin-key` header), via the `votes` array.

Signers are the treasury's multi-sig keys. Publishing each key's vote in a
public API makes it easy to single out and pressure individual signers, and
clients showing dispute progress only need the tallies. The API hides voter
identities as a precaution: on-chain votes are still public on the ledger,
so this is not a confidentiality guarantee.

---

## Treasury

### `GET /api/treasury/pending-settlements`

Returns all settlements with `Pending` status from the indexed database.

**Response `200`**

```json
[
  {
    "id": 1,
    "merchant_address": "G...",
    "amount": "5000000",
    "approvals": ["G..."],
    "approval_weight": 1,
    "status": "Pending",
    "hold_reason": null
  }
]
```

#### Errors

| Status | Description             |
| ------ | ----------------------- |
| `500`  | Database error          |

---

### `POST /api/treasury/approve-settlement`

Approve a pending settlement by submitting `approve_settlement` to the treasury contract.

#### Request body

```json
{ "settlement_id": 1 }
```

| Field           | Type   | Description                    |
| --------------- | ------ | ------------------------------ |
| `settlement_id` | number | Positive integer settlement ID |

**Response `200`**

```json
{
  "id": 1,
  "merchant_address": "G...",
  "amount": "5000000",
  "approvals": ["G..."],
  "approval_weight": 2,
  "status": "Pending",
  "hold_reason": null,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                     |
| ------ | ----------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer        |
| `503`  | Missing required environment variables           |
| `500`  | Unexpected server error                          |

---

### `POST /api/treasury/execute-settlement`

Execute a fully-approved settlement after verifying the treasury USDC balance.

#### Request body

```json
{
  "settlement_id": 1,
  "token_contract": "C..."
}
```

| Field            | Type   | Required | Description                                                      |
| ---------------- | ------ | -------- | ---------------------------------------------------------------- |
| `settlement_id`  | number | Yes      | Positive integer settlement ID                                   |
| `token_contract` | string | No       | Token contract address — defaults to `USDC_CONTRACT_ID` env var |

**Response `200`**

```json
{
  "tx_hash": "abc123...",
  "settlement_id": 1,
  "balance_checked": "10000000",
  "amount_required": "5000000"
}
```

#### Errors

| Status | Description                                        |
| ------ | -------------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer           |
| `409`  | Settlement is not in `Pending` status               |
| `422`  | Insufficient treasury balance or simulation failure |
| `503`  | Missing required environment variables              |
| `500`  | Unexpected server error                             |

---

### `GET /api/treasury/threshold`

Returns the current approval threshold from the treasury contract.

**Response `200`**

```json
{ "threshold": 2 }
```

#### Errors

| Status | Description                             |
| ------ | --------------------------------------- |
| `422`  | Soroban simulation failure              |
| `503`  | Missing required environment variables  |
| `500`  | Unexpected server error                 |

---

### `POST /api/treasury/threshold`

Update the treasury approval threshold.

#### Request body

```json
{ "threshold": 3 }
```

| Field       | Type   | Description                    |
| ----------- | ------ | ------------------------------ |
| `threshold` | number | Positive integer ≥ 1           |

**Response `200`**

```json
{
  "threshold": 3,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                     |
| ------ | ----------------------------------------------- |
| `400`  | `threshold` is not a positive integer            |
| `422`  | Soroban simulation or transaction failure        |
| `503`  | Missing required environment variables           |
| `500`  | Unexpected server error                          |

---

### `GET /api/treasury/on-hold-settlements`

Returns all settlements that are currently on hold.
A hold is placed when a signer flags a settlement as requiring manual review before
execution can proceed.

**Query parameters:**

| Parameter | Type   | Required | Description                                   |
|-----------|--------|----------|-----------------------------------------------|
| `page`    | number | No       | Page number (1-based, default: `1`)           |
| `limit`   | number | No       | Results per page (default: `20`, max: `100`)  |

**Response `200`**

```json
{
  "settlements": [
    {
      "id": 7,
      "merchant_address": "G...",
      "amount": "5000000",
      "approvals": [],
      "approval_weight": 0,
      "status": "OnHold",
      "hold_reason": "Merchant KYC under review"
    }
  ]
}
```

#### Errors

| Status | Description             |
| ------ | ----------------------- |
| `500`  | Database error          |

---

### `POST /api/treasury/release-hold`

Releases a held settlement, restoring it to `Pending` so the normal approval and
execution flow can resume. Calls `release_hold` on the treasury contract.

See also: [`release_hold` in the Contract Interaction Guide](./contract-interaction-guide.md#release-a-hold).

#### Request body

```json
{ "settlement_id": 7 }
```

| Field           | Type   | Description                    |
| --------------- | ------ | ------------------------------ |
| `settlement_id` | number | Positive integer settlement ID |

**Response `200`**

```json
{
  "id": 7,
  "merchant_address": "G...",
  "amount": "5000000",
  "approvals": [],
  "approval_weight": 0,
  "status": "Pending",
  "hold_reason": null,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                       |
| ------ | ------------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer         |
| `409`  | Settlement is not currently on hold               |
| `422`  | Soroban simulation or transaction failure         |
| `503`  | Missing required environment variables            |
| `500`  | Unexpected server error                           |

---

### `POST /api/treasury/escalate-hold`

Escalates a held settlement to the on-chain dispute-resolution flow.
Calls `raise_dispute` on the treasury contract and begins a multi-sig governance
vote among the configured signers.

See also: [`raise_dispute` in the Contract Interaction Guide](./contract-interaction-guide.md#raise-a-dispute).

#### Request body

```json
{
  "settlement_id": 7,
  "reason": "Merchant disputes the invoice amount"
}
```

| Field           | Type   | Required | Description                                              |
| --------------- | ------ | -------- | -------------------------------------------------------- |
| `settlement_id` | number | Yes      | Positive integer settlement ID                           |
| `reason`        | string | No       | Human-readable reason for escalation (max 512 chars)     |

**Response `200`**

```json
{
  "dispute_id": "7-1720000001000",
  "settlement_id": "7",
  "status": "Raised",
  "settlement_status": "OnHold",
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                       |
| ------ | ------------------------------------------------- |
| `400`  | `settlement_id` is not a positive integer         |
| `422`  | Soroban simulation or transaction failure         |
| `503`  | Missing required environment variables            |
| `500`  | Unexpected server error                           |

---


## Invoice Settings

### `GET /api/invoice/grace-window`

Returns the current invoice grace window in seconds.

**Response `200`**

```json
{ "grace_window_seconds": 86400 }
```

#### Errors

| Status | Description                             |
| ------ | --------------------------------------- |
| `422`  | Soroban simulation failure              |
| `503`  | Missing required environment variables  |
| `500`  | Unexpected server error                 |

---

### `POST /api/invoice/grace-window`

Update the invoice grace window.

#### Request body

```json
{ "grace_window_seconds": 172800 }
```

| Field                  | Type   | Description                           |
| ---------------------- | ------ | ------------------------------------- |
| `grace_window_seconds` | number | Positive integer number of seconds    |

**Response `200`**

```json
{
  "grace_window_seconds": 172800,
  "tx_hash": "abc123..."
}
```

#### Errors

| Status | Description                                     |
| ------ | ----------------------------------------------- |
| `400`  | `grace_window_seconds` is not a positive integer |
| `422`  | Soroban simulation or transaction failure        |
| `503`  | Missing required environment variables           |
| `500`  | Unexpected server error                          |

---

## Compliance

### `GET /compliance/audit`

Returns the paginated, consolidated audit trail emitted by the compliance contract.
The service indexes `address_allowed`, `address_allowed_until`, `address_blocked`, and
`address_cleared` events in MongoDB.

#### Query parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `address` | string | No | Stellar public key filter |
| `event_type` | string | No | One of the four compliance event types |
| `from_ledger` | integer | No | Inclusive lower ledger bound |
| `to_ledger` | integer | No | Inclusive upper ledger bound |
| `page` | integer | No | 1-based page, default `1` |
| `limit` | integer | No | Page size, default `20`, maximum `100` |

**Response `200`**

```json
{
  "events": [
    {
      "event_id": "paging-token",
      "event_type": "address_cleared",
      "address": "G...",
      "expires_at": null,
      "ledger": 123,
      "ledger_closed_at": "2026-08-27T12:00:00.000Z",
      "transaction_hash": "abc123...",
      "contract_id": "C...",
      "paging_token": "paging-token",
      "created_at": "2026-08-27T12:00:01.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "has_more": false
}
```

#### Errors

| Status | Description |
| --- | --- |
| `400` | Invalid query parameter |
| `503` | MongoDB unavailable |
| `500` | Unexpected server error |

---

## Analytics

### `GET /api/analytics/metrics`

Returns protocol totals for the admin dashboard. With `bucket`, returns a time
series instead, for charts such as invoices per day or settlement volume per
week.

#### Query parameters

| Parameter    | Type   | Description                                                              |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `start_date` | number | Optional. Unix timestamp (seconds), inclusive                            |
| `end_date`   | number | Optional. Unix timestamp (seconds), inclusive. Defaults to now           |
| `bucket`     | string | Optional. `day`, `week` or `month`                                       |
| `merchant`   | string | Optional. Only count invoices of this merchant (series only)             |
| `token`      | string | Optional. Only count invoices in this token (series only)                |

**Time zone:** buckets are always computed in **UTC**. Weeks start on Monday
(ISO 8601) and months on the 1st. `period` is the first day of the bucket in
`YYYY-MM-DD` form. Without `start_date` the series covers the last 30 days,
12 weeks or 12 months, depending on `bucket`. A request may span at most 1000
buckets.

Every bucket in the range is returned, with zeros for periods without
activity, so charts do not skip dates. `count` is the number of invoices
created in the bucket; `volume` is the sum of raw amounts (smallest token
unit) of those invoices that are settled (`Paid` or `Released`).

**Response `200` (with `bucket=day`)**

```json
{
  "bucket": "day",
  "timezone": "UTC",
  "start_date": 1767225600,
  "end_date": 1767398400,
  "series": [
    { "period": "2026-01-01", "count": 4, "volume": 3000000 },
    { "period": "2026-01-02", "count": 0, "volume": 0 },
    { "period": "2026-01-03", "count": 1, "volume": 0 }
  ]
}
```

#### Errors

| Status | Description                                                          |
| ------ | -------------------------------------------------------------------- |
| `400`  | Invalid `bucket`, timestamps, `merchant`, or a range over 1000 buckets |
| `500`  | Unexpected server error                                              |

---

## Webhooks

COMEBACKHERE signs every outbound webhook POST with HMAC-SHA256 so your endpoint
can verify payload authenticity before processing it.

> For the full payload reference, retry schedule, idempotency guidance, and
> language-specific verification examples, see
> [Webhook Payload Reference](./webhooks.md).
> **Security note**: this is a security-sensitive feature. Treat your signing
> secret with the same care as a private key. Rotate it immediately if it is ever
> exposed.

### Signature header

| Header                      | Value                                    |
| --------------------------- | ---------------------------------------- |
| `X-COMEBACKHERE-Signature`  | Lowercase hex-encoded HMAC-SHA256 digest |

The digest is computed over the **raw JSON request body** (exactly as sent over
the wire) using the `WEBHOOK_SIGNING_SECRET` environment variable as the key.

### Verification (Node.js example)

```typescript
import { createHmac, timingSafeEqual } from "crypto"

function verifyWebhook(
  rawBody: string,     // The unparsed request body string
  signature: string,   // Value of X-COMEBACKHERE-Signature header
  secret: string,      // Your WEBHOOK_SIGNING_SECRET
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  const expectedBuf = Buffer.from(expected, "hex")
  const actualBuf   = Buffer.from(signature, "hex")
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}
```

Always use a **constant-time comparison** (e.g. `crypto.timingSafeEqual`) when
comparing signatures to prevent timing side-channel attacks.

### Webhook event payload shape

All events share a common `event` field plus event-specific fields:

```json
{
  "event": "settlement_executed",
  "settlement_id": 1,
  "tx_hash": "abc123..."
}
```

| Event                   | Extra fields                                               |
| ----------------------- | ---------------------------------------------------------- |
| `settlement_proposed`   | `settlement_id`, `merchant_address`, `amount`, `token`, `tx_hash` |
| `settlement_approved`   | `settlement_id`, `signer`, `approval_weight`, `tx_hash`    |
| `settlement_executed`   | `settlement_id`, `tx_hash`                                 |

### Configuration

| Variable                | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `WEBHOOK_URL`           | Merchant endpoint that receives webhook POSTs                      |
| `WEBHOOK_SIGNING_SECRET`| HMAC-SHA256 signing secret (minimum 32 characters recommended)     |

Set both variables in your deployment environment. If `WEBHOOK_URL` is not set,
webhook delivery is skipped silently (no error).

---

## Error response shape

Every non-2xx response, from every endpoint, uses the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "settlement_id: Must be a positive integer",
    "details": [{ "field": "settlement_id", "message": "Must be a positive integer" }],
    "correlationId": "5f1c9a8e-2b7d-4c1e-9a3f-0d2e6b7c8a91"
  }
}
```

| Field           | Type           | Description                                                                                   |
| --------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `code`          | string         | Stable, machine-readable error code (see below). Branch on this, not on `message`.            |
| `message`       | string         | Human-readable description. May change between releases.                                      |
| `details`       | any \| null    | Extra structured context; shape depends on `code`. `null` when there is nothing to add.        |
| `correlationId` | string \| null | Same value as the `X-Request-Id` response header. Quote it when contacting support.           |

Clients may send their own `X-Request-Id` header; it is echoed back as both the
header and `correlationId`. Otherwise the server generates a UUID v4.

### Error codes

| HTTP | `code`                  | When                                                             | `details`                              |
| ---- | ----------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| 400  | `VALIDATION_ERROR`      | Body, path or query parameters failed schema validation          | `[{ field, message }]`, one per issue  |
| 400  | `INVALID_JSON`          | Request body is not valid JSON                                   | `null`                                 |
| 401  | `UNAUTHORIZED`          | Missing or invalid `x-admin-key`                                 | `null`                                 |
| 403  | `FORBIDDEN`             | Caller lacks permission                                          | `null`                                 |
| 403  | `CORS_ORIGIN_NOT_ALLOWED` | Browser `Origin` is not in `CORS_ORIGINS`                      | `{ origin }`                           |
| 404  | `NOT_FOUND`             | Resource or route does not exist                                 | `null`                                 |
| 409  | `CONFLICT`              | Request conflicts with current state (e.g. dispute already resolved) | Endpoint-specific, e.g. `{ outcome }` |
| 413  | `PAYLOAD_TOO_LARGE`     | JSON body exceeds 100 kB                                         | `{ limitBytes }`                       |
| 4xx/5xx | `CONTRACT_ERROR`     | A Soroban contract returned `Error(Contract, #N)`                | `{ contractCode: N }` — see [error-codes.md](./error-codes.md) |
| 422  | `UNPROCESSABLE_ENTITY`  | Soroban simulation / submission failed without a contract code   | `null`                                 |
| 429  | `RATE_LIMITED`          | Per-IP rate limit exceeded                                       | `{ retryAfter }` (seconds)             |
| 500  | `INTERNAL_ERROR`        | Unexpected server error                                          | `null`                                 |
| 503  | `SERVICE_MISCONFIGURED` | Required environment variables are missing                       | `null`                                 |
| 503  | `SERVICE_UNAVAILABLE`   | A dependency (e.g. MongoDB) is unreachable                       | `null`                                 |
| 504  | `GATEWAY_TIMEOUT`       | Timed out waiting for Soroban transaction confirmation           | `null`                                 |

### Server implementation

Routes do not build error responses by hand. They throw a typed error from
`comebackhere-backend/src/lib/errors.ts` (`ValidationError`, `NotFoundError`,
`ConflictError`, `UnauthorizedError`, `ContractError`, …) and the central
handler in `src/middleware/errorHandler.ts` renders the envelope. Async
handlers are wrapped in `asyncHandler` so rejected promises reach it.

## Environment variables

| Variable               | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `SOROBAN_RPC_URL`      | Soroban RPC endpoint (e.g. `http://localhost:8000/soroban/rpc`) |
| `INVOICE_CONTRACT_ID`  | Deployed invoice contract address                         |
| `TREASURY_CONTRACT_ID` | Deployed treasury contract address                        |
| `USDC_CONTRACT_ID`     | USDC token contract address                               |
| `SETTLEMENT_CONTRACT_ID` | Settlement contract address (disputes)                  |
| `SIGNER_SECRET_KEY`    | Stellar secret key for signing transactions               |
| `NETWORK_PASSPHRASE`   | Stellar network passphrase                                |
| `WEBHOOK_URL`          | Merchant webhook endpoint URL                             |
| `WEBHOOK_SIGNING_SECRET` | HMAC-SHA256 signing secret for outbound webhooks        |
| `PORT`                 | HTTP server port (default `3000`)                         |
| `CORS_ORIGINS`         | Comma-separated allowlist of browser origins, e.g. `http://localhost:5173,https://app.example.com`. Bare origins only (no path, trailing slash or `*`); invalid entries fail startup. Unset = no cross-origin access. |
