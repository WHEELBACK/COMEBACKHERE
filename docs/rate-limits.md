# Rate Limits and Throttling

The TypeScript backend (`comebackhere-backend`, the live service) rate limits
**every** route as global middleware. Traffic is bucketed per IP, or per
`X-API-Key` when that header is present.

The legacy Rust backend (`backend`) also rate limits, but per IP only and with a
different 429 body shape — see
[Differences between the two backends](#differences-between-the-two-backends).

This page documents the effective limits, the response headers, and the 429
shape, so an integrator reading it does not have to read the source to find out
what the server actually does.

> **These claims are enforced by a repeatable check**, not just by prose.
> `scripts/check_ratelimit_docs_sync.sh` parses the implementation and fails if
> this page, `docs/api-reference.md` or the `.env.*.example` files drift from it.
> See [Verifying these claims](#verifying-these-claims).

---

## Default limits

| Setting | Default | Environment variable |
| --- | --- | --- |
| Max requests per window, per IP | **60** | `RATE_LIMIT_POINTS` |
| Max requests per window, per `X-API-Key` | **600** | `RATE_LIMIT_API_KEY_POINTS` |
| Window duration | **60** seconds | `RATE_LIMIT_DURATION` |

Each tier is enforced by its own limiter instance with its own `points` value,
so the effective per-IP allowance really is 60 and the effective per-key
allowance really is 600.

A value that is not a positive integer falls back to the default rather than
disabling the limiter — `RATE_LIMIT_POINTS=abc` yields 60, not "no limit".

The Rust backend shares the `RATE_LIMIT_POINTS` and `RATE_LIMIT_DURATION`
defaults but has no `RATE_LIMIT_API_KEY_POINTS` tier.

---

## Scope

The rate limiter is registered before every router, so it covers **all** routes
— including `/health`, `/metrics` and `/api-docs`, and including admin routes
such as `/webhooks/dead-letters`. No route is exempt.

| Backend | Middleware layer |
| --- | --- |
| `comebackhere-backend` (Express) | `rateLimitMiddleware` in `src/middleware/rateLimiter.ts` |
| `backend` (Axum / Tower) | `RateLimiterLayer` in `src/rate_limiter.rs` |

---

## Which bucket a request lands in

The bucket is selected in this order:

1. **`X-API-Key` header** — if present and non-empty after trimming, the bucket
   key is `api-key:<value>` and the budget is `RATE_LIMIT_API_KEY_POINTS`.
2. **Otherwise, the client IP** — bucket key `ip:<addr>`, budget
   `RATE_LIMIT_POINTS`.

A request is never counted against both. Whitespace-only `X-API-Key` values are
treated as absent.

> **`X-API-Key` is a bucket selector, not a credential.** The backend does not
> authenticate it, does not compare it to a stored value, and derives no
> identity from it. Anyone can send an arbitrary, unique `X-API-Key` on every
> request and draw the larger per-key budget. Put a real rate limit in front of
> the service for untrusted traffic, or set `RATE_LIMIT_API_KEY_POINTS` equal to
> `RATE_LIMIT_POINTS` to collapse the two tiers.

`X-API-Key` is in `CORS_ALLOWED_HEADERS`, so browser clients may send it
cross-origin.

---

## How the IP is determined

The client IP is resolved in the following order:

1. **`X-Forwarded-For` header** — the first comma-separated entry is used.
   Leading and trailing whitespace is trimmed.
2. **Peer socket address** — the TCP connection's remote address.
3. **`"unknown"`** — fallback when neither source is available.

> **Note:** Because the limiter is per-IP, all clients sharing the same public
> IP (e.g. behind a corporate NAT) share the same rate-limit bucket. When the
> backend runs behind a proxy, `X-Forwarded-For` is trusted verbatim — make sure
> the proxy overwrites it rather than appending to client-supplied values.

---

## Rate limit headers

Exactly three headers are attached to **every** API response, successful or
rejected, so clients can back off before hitting the limit:

| Header | Type | Description |
| --- | --- | --- |
| `X-RateLimit-Limit` | integer | Budget for the bucket this request used. |
| `X-RateLimit-Remaining` | integer | Requests left in the current window, clamped at 0. |
| `X-RateLimit-Reset` | integer | Unix timestamp (seconds) at which the window resets. |

Example headers on a successful anonymous request:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1720000060
```

And on a successful `X-API-Key` request:

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 599
X-RateLimit-Reset: 1720000060
```

A fourth header, `Retry-After`, is sent **only on 429 responses**. It is absent
on every other status code.

> The backend uses the `X-RateLimit-*` names. It does **not** emit the IETF
> draft `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` form. Do
> not write client code that reads the unprefixed names.

These headers are listed in `CORS_EXPOSED_HEADERS`, so browser JavaScript can
read them on cross-origin responses.

---

## 429 response

When the limit is exceeded the TypeScript backend returns **HTTP 429** with the
standard error envelope:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please retry after the indicated number of seconds.",
    "details": { "retryAfter": 12 },
    "correlationId": "5f1c9a8e-2b7d-4c1e-9a3f-0d2e6b7c8a91"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `error.code` | string | Always `RATE_LIMITED`. |
| `error.message` | string | Human-readable message. |
| `error.details.retryAfter` | number | Seconds to wait before retrying. |
| `error.correlationId` | string \| null | Same as the `X-Request-Id` response header; `null` when no request id was assigned. |

The 429 response also carries `Retry-After` with the same integer value as
`error.details.retryAfter`, plus `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`
and `X-RateLimit-Reset`.

Read the value from `Retry-After` or `error.details.retryAfter` — they are
always equal.

---

## Configuration examples

### Increase the limit for a high-traffic deployment

```bash
RATE_LIMIT_POINTS=200 RATE_LIMIT_API_KEY_POINTS=2000 RATE_LIMIT_DURATION=60 npm start
```

### Tighten the limit for a staging environment

```bash
RATE_LIMIT_POINTS=10 RATE_LIMIT_DURATION=60 npm start
```

### Collapse the two tiers

To remove the advantage of an unauthenticated `X-API-Key`:

```bash
RATE_LIMIT_POINTS=60 RATE_LIMIT_API_KEY_POINTS=60 npm start
```

`npm start` runs `node dist/index.js` from `comebackhere-backend/`. There is no
`dist/app.js` build output — `createApp()` is imported by the entrypoint rather
than executed on its own.

---

## Verifying these claims

The table above is generated from, and checked against, the implementation:

```sh
scripts/check_ratelimit_docs_sync.sh
```

The check fails, with the offending file and the expected value, if:

- the header names emitted by `src/middleware/rateLimiter.ts` are not exactly
  the set documented above;
- `Retry-After` is documented as present on non-429 responses;
- a default documented here no longer matches the code;
- a `.env.*.example` file documents a different `RATE_LIMIT_*` default;
- the Rust backend is described as having an API-key tier.

The behavioural half of the claim — that the two tiers really are enforced
independently — is covered by unit tests in
`comebackhere-backend/src/tests/rateLimiter.test.ts`, which run in CI via
`.github/workflows/backend-tests.yml`.

---

## Implementation details

### TypeScript backend (`comebackhere-backend`)

- Uses [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible).
- One limiter instance per tier (IP and API key), each configured with its own
  `points` and the shared `duration`.
- When `REDIS_URL` is set, rate-limit state is stored in Redis (key prefix
  `rl:invoice`) with an in-memory fallback if Redis is unreachable. Both tiers
  share a single Redis client.
- When `REDIS_URL` is not set (local development and tests), the limiters run
  entirely in memory. The two tiers remain independent.

### Rust backend (`backend`, legacy)

- Implements a sliding-window algorithm as a `tower::Layer`.
- Stores per-IP buckets in an in-memory `HashMap` protected by a `Mutex`.
- Retains only timestamps that fall inside the current window, so the window
  rolls forward naturally without a background cleanup.
- Per IP only — there is no `X-API-Key` tier and no Redis-backed store.

---

## Differences between the two backends

| Behaviour | `comebackhere-backend` (live) | `backend` (legacy) |
| --- | --- | --- |
| Bucket key | `X-API-Key` if present, else IP | IP only |
| API-key tier | Yes (`RATE_LIMIT_API_KEY_POINTS`, default 600) | No |
| Store | Redis when `REDIS_URL` is set, else in-memory | In-memory only |
| Window | Fixed, per-bucket expiry | Sliding |
| 429 headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` | Same four |
| 429 body | `{ "error": { "code", "message", "details": { "retryAfter" }, "correlationId" } }` | `{ "error": "<string>", "retryAfter": <number> }` |
| `X-RateLimit-Reset` meaning | When this caller's window expires (`now + msBeforeNext`) | Fixed end of the configured window (`now + duration`) |

If you write a client against the TypeScript backend, note the 429 body differs
between the two trees: the legacy Rust backend does not use the error envelope.

---

## Further reading

- [docs/api-reference.md](./api-reference.md) — full endpoint catalogue.
- [docs/error-codes.md](./error-codes.md) — contract-level error codes (distinct from HTTP 429).
- [docs/webhooks.md](./webhooks.md) — outbound webhook signing and verification.
- [Issue #215](https://github.com/WHEELBACK/COMEBACKHERE/issues/215) — rate-limiter test suite.
