# Webhook Payload Reference

COMEBACKHERE sends signed HTTP POST requests to your configured endpoint whenever
key protocol events occur. This page documents every event type, its payload
shape, how to verify the HMAC-SHA256 signature, and the delivery retry schedule.

> **Security note:** Treat your `WEBHOOK_SIGNING_SECRET` with the same care as a
> private key. Anyone who holds it can forge valid webhook signatures. Rotate it
> immediately if it is ever exposed.

See also: [`## Webhooks` in the API Reference](./api-reference.md#webhooks) for
the configuration environment variables.

---

## Configuration

| Variable                 | Description                                                            |
| ------------------------ | ---------------------------------------------------------------------- |
| `WEBHOOK_URL`            | Your endpoint that receives `POST` requests from the backend           |
| `WEBHOOK_SIGNING_SECRET` | HMAC-SHA256 signing secret (minimum 32 characters recommended)         |

If `WEBHOOK_URL` is not set, webhook delivery is skipped silently — no error is
logged and no retries are attempted.

---

## Signature verification

Every outbound webhook `POST` includes an `X-COMEBACKHERE-Signature` header
containing a lowercase hex-encoded HMAC-SHA256 digest of the **raw request
body** (the exact bytes sent over the wire), keyed by your
`WEBHOOK_SIGNING_SECRET`.

### Algorithm summary

1. Read the raw request body **before** calling `JSON.parse()`.
2. Compute `HMAC-SHA256(secret, rawBody)` and hex-encode it.
3. Compare the result to the `X-COMEBACKHERE-Signature` header using a
   **constant-time comparison** to prevent timing side-channel attacks.

### Header reference

| Header                      | Value                                        |
| --------------------------- | -------------------------------------------- |
| `X-COMEBACKHERE-Signature`  | Lowercase hex-encoded HMAC-SHA256 digest     |
| `Content-Type`              | `application/json`                           |
| `X-Idempotency-Key`         | Stable per-event key (see [Idempotency](#idempotency)) |
| `X-Request-Id`              | Correlation ID forwarded from the originating request (when available) |

### Verification — Node.js / TypeScript

```typescript
import { createHmac, timingSafeEqual } from "crypto"

/**
 * Returns true if the signature header is a valid HMAC-SHA256 of the raw body
 * under the given secret.
 *
 * @param rawBody   The unparsed request body string (read before JSON.parse).
 * @param signature The value of the X-COMEBACKHERE-Signature header.
 * @param secret    Your WEBHOOK_SIGNING_SECRET environment variable.
 */
function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  try {
    const expected = createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("hex")

    const expectedBuf = Buffer.from(expected, "hex")
    const actualBuf   = Buffer.from(signature, "hex")

    // Buffers must be the same length for timingSafeEqual
    if (expectedBuf.length !== actualBuf.length) return false

    return timingSafeEqual(expectedBuf, actualBuf)
  } catch {
    return false
  }
}
```

### Verification — Python

```python
import hashlib
import hmac

def verify_webhook_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    """Return True if the signature is a valid HMAC-SHA256 of raw_body."""
    expected = hmac.new(
        secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

> **Always use a constant-time comparison.** Standard string equality (`===`,
> `==`) leaks information about how many bytes match, which can be exploited
> by a timing attack.

---

## Idempotency

Every webhook `POST` includes an `X-Idempotency-Key` header (and the same value
in the payload body as `idempotency_key`). The key is derived deterministically
from the event type and the resource ID:

```
idempotency_key = "<event_type>:<resource_id>"

Examples:
  invoice_paid:42
  settlement_executed:7
  settlement_proposed:15
```

Because the key is stable, retries of the same delivery attempt carry the
**same idempotency key**. Your endpoint should use this key to detect and safely
ignore duplicate deliveries.

---

## Event payload shapes

All events share a common envelope. Event-specific fields are listed in each
section below.

### Common envelope

```json
{
  "event_type": "string",
  "idempotency_key": "string",
  "timestamp": "ISO-8601 string",
  "invoice_id": "string | undefined",
  "settlement_id": "string | undefined",
  "data": { }
}
```

| Field             | Type              | Description                                                       |
| ----------------- | ----------------- | ----------------------------------------------------------------- |
| `event_type`      | string            | One of the event type names listed below                          |
| `idempotency_key` | string            | Stable per-event key in the format `<event_type>:<id>`           |
| `timestamp`       | ISO-8601 string   | When the event was emitted by the backend                         |
| `invoice_id`      | string (optional) | Numeric invoice ID as a string; set for invoice events            |
| `settlement_id`   | string (optional) | Numeric settlement ID as a string; set for settlement events      |
| `data`            | object            | Event-specific payload fields (see each event type below)         |

---

### `invoice_paid`

Emitted when a payer successfully pays an invoice on-chain.

```json
{
  "event_type": "invoice_paid",
  "idempotency_key": "invoice_paid:42",
  "timestamp": "2026-08-29T14:23:00.000Z",
  "invoice_id": "42",
  "settlement_id": null,
  "data": {
    "invoice_id": "42",
    "payer_address": "G...",
    "amount_usdc": "1000000",
    "tx_hash": "abc123..."
  }
}
```

| `data` field      | Type   | Description                                     |
| ----------------- | ------ | ----------------------------------------------- |
| `invoice_id`      | string | Numeric invoice ID                              |
| `payer_address`   | string | Stellar public key of the payer                 |
| `amount_usdc`     | string | Amount paid in stroops (1 USDC = 10 000 000)    |
| `tx_hash`         | string | Stellar transaction hash                        |

---

### `settlement_proposed`

Emitted when a new settlement is created in the treasury contract.

```json
{
  "event_type": "settlement_proposed",
  "idempotency_key": "settlement_proposed:15",
  "timestamp": "2026-08-29T14:30:00.000Z",
  "invoice_id": null,
  "settlement_id": "15",
  "data": {
    "settlement_id": "15",
    "merchant_address": "G...",
    "amount": "5000000",
    "token": "USDC",
    "tx_hash": "def456..."
  }
}
```

| `data` field        | Type   | Description                                   |
| ------------------- | ------ | --------------------------------------------- |
| `settlement_id`     | string | Numeric settlement ID                         |
| `merchant_address`  | string | Stellar public key of the merchant            |
| `amount`            | string | Settlement amount in stroops                  |
| `token`             | string | Token identifier (e.g. `"USDC"`)              |
| `tx_hash`           | string | Stellar transaction hash                      |

---

### `settlement_approved`

Emitted each time a registered signer approves a pending settlement.

```json
{
  "event_type": "settlement_approved",
  "idempotency_key": "settlement_approved:15",
  "timestamp": "2026-08-29T14:35:00.000Z",
  "invoice_id": null,
  "settlement_id": "15",
  "data": {
    "settlement_id": "15",
    "signer": "G...",
    "approval_weight": 2,
    "tx_hash": "ghi789..."
  }
}
```

| `data` field       | Type   | Description                                           |
| ------------------ | ------ | ----------------------------------------------------- |
| `settlement_id`    | string | Numeric settlement ID                                 |
| `signer`           | string | Stellar public key of the approving signer            |
| `approval_weight`  | number | Total accumulated approval weight after this approval |
| `tx_hash`          | string | Stellar transaction hash                              |

---

### `settlement_executed`

Emitted when a settlement reaches quorum and is executed on-chain, transferring
funds to the merchant.

```json
{
  "event_type": "settlement_executed",
  "idempotency_key": "settlement_executed:15",
  "timestamp": "2026-08-29T14:40:00.000Z",
  "invoice_id": null,
  "settlement_id": "15",
  "data": {
    "settlement_id": "15",
    "tx_hash": "jkl012..."
  }
}
```

| `data` field    | Type   | Description               |
| --------------- | ------ | ------------------------- |
| `settlement_id` | string | Numeric settlement ID     |
| `tx_hash`       | string | Stellar transaction hash  |

---

## Delivery guarantees and retry schedule

The backend retries failed deliveries with **exponential backoff**. A delivery
is considered failed when the merchant endpoint returns a non-`2xx` status code
or a network error occurs (connection refused, timeout, etc.).

### Retry parameters

| Parameter          | Value                                              |
| ------------------ | -------------------------------------------------- |
| Maximum attempts   | **5**                                              |
| Base delay         | **1 000 ms** (1 second)                            |
| Backoff formula    | `delay = base_delay × 2^attempt` (zero-indexed)    |
| Request timeout    | **10 000 ms** (10 seconds) per attempt             |

### Retry schedule (default)

| Attempt | Delay before attempt | Cumulative wait |
| ------- | -------------------- | --------------- |
| 1       | 0 ms (immediate)     | 0 s             |
| 2       | 1 000 ms             | 1 s             |
| 3       | 2 000 ms             | 3 s             |
| 4       | 4 000 ms             | 7 s             |
| 5       | 8 000 ms             | 15 s            |

After all 5 attempts are exhausted the delivery record is marked `failed` and
no further retries occur. A delivery error is logged with the idempotency key,
endpoint URL, and last error message.

### Delivery record fields

The backend maintains an internal delivery record for every webhook event:

| Field               | Type             | Description                                       |
| ------------------- | ---------------- | ------------------------------------------------- |
| `idempotency_key`   | string           | Stable key identifying this event                 |
| `endpoint`          | string           | Merchant URL the POST was sent to                 |
| `status`            | `delivered` \| `failed` \| `pending` | Final delivery outcome      |
| `attempts`          | number           | Total number of delivery attempts made            |
| `last_attempt_at`   | ISO-8601 string  | When the most recent attempt was made             |
| `last_status_code`  | number \| null   | HTTP status returned by the last attempt          |
| `last_error`        | string \| null   | Error message from the last failed attempt        |
| `request_id`        | string \| null   | Correlation ID forwarded as `X-Request-Id`        |

---

## Responding to webhook deliveries

Your endpoint should:

1. Immediately respond with a `2xx` status code once the signature is verified
   and the payload is accepted. The backend considers any `2xx` response a
   successful delivery and will not retry.
2. Perform all heavy work (database writes, downstream calls) asynchronously
   after returning `200 OK` to avoid triggering a delivery timeout.
3. Store the `idempotency_key` and check it before processing to safely handle
   retried deliveries without duplicating side effects.
4. Return `4xx` or `5xx` to signal a transient failure and trigger a retry.
   Note that a `4xx` is treated the same as `5xx` — the backend will retry up
   to the maximum attempt cap regardless.

---

## Troubleshooting

| Symptom                                | Likely cause                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Signature verification fails           | Body was parsed before reading the raw bytes, or wrong `WEBHOOK_SIGNING_SECRET` |
| Duplicate events processed             | Idempotency key not checked; same event delivered on retry                   |
| Deliveries time out                    | Endpoint performs synchronous work before responding; move work off the request path |
| No webhooks received                   | `WEBHOOK_URL` not set, or set to an unreachable address                      |
| All 5 attempts fail silently           | Check backend logs for `[webhook] delivery failed` entries                   |
