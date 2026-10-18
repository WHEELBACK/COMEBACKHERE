# Webhook Payload Reference

COMEBACKHERE can send signed HTTP POST requests to your configured endpoint when
settlement events occur on-chain. This page documents the events, their exact
payload shapes, and how to verify the HMAC-SHA256 signature.

> **Security note:** Treat your `WEBHOOK_SIGNING_SECRET` with the same care as a
> private key. Anyone who holds it can forge valid webhook signatures. Rotate it
> immediately if it is ever exposed.

> **There is no `WEBHOOK_SECRET`.** The backend reads `WEBHOOK_SIGNING_SECRET`
> and nothing else — see [Configuration](#configuration).

See also: [`## Webhooks` in the API Reference](./api-reference.md#webhooks) for
the configuration environment variables.

---

## The two delivery paths

Everything below depends on which code path sends the request, and the two paths
are **not** equivalent. Read this section before writing a receiver.

| | Live dispatch (current) | Retry queue (dormant) |
| --- | --- | --- |
| Implementation | `dispatchWebhook` in `src/services/webhooks.ts` | `postWebhook` in `src/services/webhook-delivery.ts` |
| Signed | **Yes** — `X-COMEBACKHERE-Signature` | **No** |
| `X-Idempotency-Key` | Not sent | Sent |
| `X-Request-Id` | Not sent | Sent when a correlation id is supplied |
| Retries / dead letters | None — single attempt, failures are logged | Yes, with backoff and dead-letter persistence |
| Used by | `treasury-indexer` for `settlement_proposed`, `settlement_approved`, `settlement_executed` | Nothing in production code; the queue is never enqueued to |

**Only the live dispatch path is exercised today.** The retry queue is
implemented and unit-tested but not wired to an event source, so in a running
deployment every outbound webhook is a single, signed attempt.

Because the live path does not send an idempotency key, **your receiver is
responsible for deduplication** — see [Deduplicating deliveries](#deduplicating-deliveries).

---

## Configuration

| Variable                 | Description                                                            |
| ------------------------ | ---------------------------------------------------------------------- |
| `WEBHOOK_URL`            | Your endpoint that receives `POST` requests from the backend. If unset, no webhooks are sent. |
| `WEBHOOK_SIGNING_SECRET` | HMAC-SHA256 signing secret (minimum 32 characters recommended). **Required at startup** — the backend refuses to boot without it. |
| `WEBHOOK_MAX_ATTEMPTS`   | Maximum delivery attempts (default `5`) — retry queue only            |
| `WEBHOOK_BASE_DELAY_MS`  | Initial retry delay in milliseconds (default `1000`) — retry queue only |
| `WEBHOOK_MAX_DELAY_MS`   | Maximum exponential backoff delay in milliseconds (default `60000`) — retry queue only |
| `WEBHOOK_JITTER_RATIO`   | Randomized delay variation from `0` to `1` (default `0.2`) — retry queue only |

If `WEBHOOK_URL` is not set, webhook delivery is skipped silently — no error is
logged and no request is made.

If `WEBHOOK_SIGNING_SECRET` is missing, `validateEnv()` in `src/lib/env.ts`
fails the process at startup with a message naming the variable. It is never a
runtime warning.

---

## Signature verification

Every webhook sent by the live dispatch path includes an
`X-COMEBACKHERE-Signature` header containing a lowercase hex-encoded
HMAC-SHA256 digest of the **raw request body** (the exact bytes sent over the
wire), keyed by your `WEBHOOK_SIGNING_SECRET`.

### Signature format

| Property | Value |
| --- | --- |
| Header name | `X-COMEBACKHERE-Signature` |
| Algorithm | HMAC-SHA256 |
| Encoding | lowercase hex, 64 characters |
| Signed input | the exact request body bytes, UTF-8 |
| Envelope | **none** — a bare digest, not a `t=…,v1=…` string |

There is no `t=` timestamp prefix and no version field. Consequently **there is
no signature timestamp and no replay window**: a captured request body and its
signature stay valid forever. Replay defence has to come from your own
deduplication (see
[Deduplicating deliveries](#deduplicating-deliveries)), not from the signature.

### Algorithm summary

1. Read the raw request body **before** calling `JSON.parse()`.
2. Read the Unix timestamp from `X-COMEBACKHERE-Timestamp` and reject values
  outside a five-minute tolerance.
3. Compute `HMAC-SHA256(secret, timestamp + "." + rawBody)` and hex-encode it.
4. Compare the result to the `X-COMEBACKHERE-Signature` header using a
   **constant-time comparison** to prevent timing side-channel attacks.
4. Compare lengths first — `timingSafeEqual` throws on a length mismatch, so a
   short or malformed header must be rejected before the comparison.

### Header reference

Headers sent on a **live dispatch** request:

| Header                     | Value                                    |
| -------------------------- | ---------------------------------------- |
| `X-COMEBACKHERE-Signature` | Lowercase hex-encoded HMAC-SHA256 digest |
| `Content-Type`             | `application/json`                       |

Additional headers sent by the **retry queue** path (not used today):

| Header                 | Value                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `X-Idempotency-Key`    | Stable per-event key (see [Deduplicating deliveries](#deduplicating-deliveries)) |
| `X-Request-Id`         | Correlation ID forwarded from the originating request, when available |

If you need a `X-COMEBACKHERE-Signature` on every delivery, verify it
unconditionally and treat a missing signature as a rejection.


### Verification — Node.js / TypeScript

```typescript
import { createHmac, timingSafeEqual } from "crypto"

/**
 * Returns true if the signature header is a valid HMAC-SHA256 of the raw body
 * under the given secret.
 *
 * @param rawBody   The unparsed request body string (read before JSON.parse).
 * @param signature The value of the X-COMEBACKHERE-Signature header.
 * @param timestamp The value of the X-COMEBACKHERE-Timestamp header.
 * @param secret    Your WEBHOOK_SIGNING_SECRET environment variable.
 */
function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string,
): boolean {
  try {
    const seconds = Number(timestamp)
    if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`, "utf8")
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
import time

def verify_webhook_signature(raw_body: bytes, signature: str, timestamp: str, secret: str) -> bool: return (
    timestamp.isdigit()
    and abs(time.time() - int(timestamp)) <= 300
    and hmac.compare_digest(
        hmac.new(
            secret.encode("utf-8"),
            timestamp.encode("utf-8") + b"." + raw_body,
            hashlib.sha256,
        ).hexdigest(),
        signature,
    )
)
```

### Verification — Go

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
)

// VerifyWebhookSignature returns true if the signature header is a valid
// HMAC-SHA256 of the raw request body under the given secret.
func VerifyWebhookSignature(rawBody []byte, signature, secret string) bool {
	expected := hmac.New(sha256.New, []byte(secret))
	expected.Write(rawBody)
	expectedHex := hex.EncodeToString(expected.Sum(nil))

	// Use constant-time comparison to prevent timing attacks
	return hmac.Equal([]byte(expectedHex), []byte(signature))
}

// Example: verify webhook in an HTTP handler
func HandleWebhook(w http.ResponseWriter, r *http.Request) {
	// Read raw body before parsing JSON
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	signature := r.Header.Get("X-COMEBACKHERE-Signature")
	secret := os.Getenv("WEBHOOK_SIGNING_SECRET")

	if !VerifyWebhookSignature(rawBody, signature, secret) {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	// Signature verified; parse and process the webhook
	var event WebhookEvent
	if err := json.Unmarshal(rawBody, &event); err != nil {
		http.Error(w, "failed to parse webhook", http.StatusBadRequest)
		return
	}

	// Process event...
	w.WriteHeader(http.StatusOK)
}
```

> **Always use a constant-time comparison.** Standard string equality (`===`,
> `==`, `==` in Go) leaks information about how many bytes match, which can be
> exploited by a timing attack. Use `hmac.Equal()` (Go), `timingSafeEqual()`
> (Node.js), or `hmac.compare_digest()` (Python).

---

## Deduplicating deliveries

The live dispatch path sends **no** `X-Idempotency-Key` header and includes no
`idempotency_key` field in the body. There is no stable per-event key to dedupe
on out of the box.

Deduplicate on a tuple you build yourself from the body. For settlement events
`(event, settlement_id, tx_hash)` is stable across redeliveries of the same
chain event, and `settlement_approved` can legitimately repeat with different
signers, so include the signer when you need to distinguish approvals:

```
dedupe_key = "<event>:<settlement_id>:<tx_hash>"
            # settlement_approved: "<event>:<settlement_id>:<signer>:<tx_hash>"

Examples:
  settlement_proposed:15:9f2c...
  settlement_executed:15:41ab...
  settlement_approved:15:GDR7...:41ab...
```

Store the key and reject duplicates before applying side effects. This is the
only replay protection available, because the signature carries no timestamp.

The retry queue path, when it is wired up, additionally sends an
`X-Idempotency-Key` header and an `idempotency_key` body field derived as
`<event_type>:<resource_id>`. Do not build a receiver that depends on that
header today.

---

## Event payload shapes

Every event is a **flat JSON object** with an `event` discriminator and
event-specific fields at the top level. There is no `event_type` /
`timestamp` / `data` envelope — fields are not nested under `data`, and
`event_type` is spelled `event`.

`settlement_id` is a JSON **number**. Token amounts (`amount`,
`approval_weight`) are converted with `String(...)` before sending, so they
arrive as **strings** and never lose precision. Account addresses and
`tx_hash` are strings.

| Field           | Type   | Present on                    | Description                          |
| --------------- | ------ | ----------------------------- | ------------------------------------ |
| `event`         | string | all                           | One of the event names below         |
| `settlement_id` | number | all                           | Numeric settlement ID               |
| `tx_hash`       | string | all                           | Stellar transaction hash             |
| `merchant_address` | string | `settlement_proposed`      | Stellar public key of the merchant   |
| `amount`        | string | `settlement_proposed`         | Settlement amount in stroops         |
| `token`         | string | `settlement_proposed`         | Token identifier, e.g. `"USDC"`      |
| `signer`        | string | `settlement_approved`         | Public key of the approving signer   |
| `approval_weight` | string | `settlement_approved`       | Accumulated weight after this approval |

`approval_weight` is a string, not a number.

There is no `invoice_paid` event: the backend does not emit one today. Paying an
invoice on-chain does not produce an outbound webhook.

---

### `settlement_proposed`

Emitted when a new settlement is created in the treasury contract.

```json
{
  "event": "settlement_proposed",
  "settlement_id": 15,
  "merchant_address": "G...",
  "amount": "5000000",
  "token": "USDC",
  "tx_hash": "def456..."
}
```

| Field              | Type   | Description                                   |
| ------------------ | ------ | --------------------------------------------- |
| `settlement_id`    | number | Numeric settlement ID                        |
| `merchant_address` | string | Stellar public key of the merchant            |
| `amount`           | string | Settlement amount in stroops                  |
| `token`            | string | Token identifier (e.g. `"USDC"`)              |
| `tx_hash`          | string | Stellar transaction hash                      |

---

### `settlement_approved`

Emitted each time a registered signer approves a pending settlement. This event
fires **once per approval**, so a settlement reaching quorum produces several
`settlement_approved` deliveries before `settlement_executed`.

```json
{
  "event": "settlement_approved",
  "settlement_id": 15,
  "signer": "G...",
  "approval_weight": "2",
  "tx_hash": "ghi789..."
}
```

| Field             | Type   | Description                                    |
| ----------------- | ------ | ---------------------------------------------- |
| `settlement_id`   | number | Numeric settlement ID                         |
| `signer`          | string | Stellar public key of the approving signer     |
| `approval_weight` | string | Total accumulated approval weight after approval |
| `tx_hash`         | string | Stellar transaction hash                       |

---

### `settlement_executed`

Emitted when a settlement reaches quorum and is executed on-chain, transferring
funds to the merchant.

```json
{
  "event": "settlement_executed",
  "settlement_id": 15,
  "tx_hash": "jkl012..."
}
```

| Field           | Type   | Description               |
| --------------- | ------ | ------------------------- |
| `settlement_id` | number | Numeric settlement ID    |
| `tx_hash`       | string | Stellar transaction hash  |

---

## Delivery guarantees and retry schedule

The live dispatch path makes **one attempt** per event. There is no retry, no
backoff, and no dead-letter record. A failure is logged and dropped:

```
[treasury-indexer] webhook dispatch failed (settlement_proposed): <message>
```

Treat every delivery as at-most-once, and expect to miss some. If the retry queue
is wired up in a future release, the policy below applies to it.

### Retry parameters (retry queue, dormant)

| Parameter          | Value                                              |
| ------------------ | -------------------------------------------------- |
| Maximum attempts   | **5** by default; configurable with `WEBHOOK_MAX_ATTEMPTS` |
| Base delay         | **1 000 ms** by default; configurable with `WEBHOOK_BASE_DELAY_MS` |
| Maximum delay      | **60 000 ms** by default; configurable with `WEBHOOK_MAX_DELAY_MS` |
| Jitter             | **±20%** by default; configurable with `WEBHOOK_JITTER_RATIO` |
| Backoff formula    | `min(max_delay, base_delay × 2^attempt)`, with jitter |
| Request timeout    | **10 000 ms** (10 seconds) per attempt             |

### Retry schedule (default)

| Attempt | Nominal delay before attempt | Cumulative wait |
| ------- | ---------------------------- | --------------- |
| 1       | 0 ms (immediate)             | 0 s             |
| 2       | 1 000 ms (±20%)              | about 1 s        |
| 3       | 2 000 ms (±20%)              | about 3 s        |
| 4       | 4 000 ms (±20%)              | about 7 s        |
| 5       | 8 000 ms (±20%)              | about 15 s       |

After all configured attempts are exhausted the delivery record is marked `failed` and
the full record is saved in MongoDB's `webhook_dead_letters` collection. It
includes the payload, endpoint, final error, and timestamped attempt history.
Administrators can inspect dead letters with `GET /webhooks/dead-letters` and
replay one with `POST /webhooks/dead-letters/:id/replay`; both require the
`x-admin-key` header. A letter is removed only after replay succeeds.

> These two routes are live today, but nothing populates the collection while the
> retry queue is dormant.

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
| `attempt_history`   | array            | Timestamp, status code, and error for every attempt |

---

## Responding to webhook deliveries

Your endpoint should:

1. Verify `X-COMEBACKHERE-Signature` against the raw body before parsing JSON,
   and reject the request with `401` if it does not match.
2. Immediately respond with a `2xx` status code once the signature is verified
   and the payload is accepted.
3. Perform all heavy work (database writes, downstream calls) asynchronously
   after returning `200 OK` to avoid triggering a delivery timeout.
4. Deduplicate on your own key before applying side effects — see
   [Deduplicating deliveries](#deduplicating-deliveries).

---

## Troubleshooting

| Symptom                                | Likely cause                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Signature verification fails           | Body was parsed before reading the raw bytes, or wrong `WEBHOOK_SIGNING_SECRET` |
| `timingSafeEqual` throws               | The signature header was not 64 hex characters; compare lengths first          |
| Duplicate events processed             | Dedupe key not checked; no idempotency key is sent on the live path           |
| Deliveries time out                    | Endpoint performs synchronous work before responding; move work off the request path |
| No webhooks received                   | `WEBHOOK_URL` not set, or set to an unreachable address                      |
| Occasional missing events             | Expected: the live path is single-attempt with no retry                        |
| A replayed body still verifies         | Expected: the signature has no timestamp; dedupe on your own key              |
| Backend refuses to start               | `WEBHOOK_SIGNING_SECRET` is unset — `validateEnv()` fails fast                 |

---

## Verifying these claims

`scripts/check_webhook_docs_sync.sh` parses the signing implementation and fails
if this page, `docs/api-reference.md` or the `.env.*.example` files drift from
it — including the header name, the algorithm, the required
`WEBHOOK_SIGNING_SECRET` variable, and any claim that the live path sends
`X-Idempotency-Key`.

The behavioural half — the digest itself, the constant-time comparison, and the
absence of an envelope — is covered by
`comebackhere-backend/src/tests/webhooks.test.ts`, run in CI by
`.github/workflows/backend-tests.yml`.
