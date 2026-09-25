# Rate Limits and Throttling

Both the TypeScript backend (`comebackhere-backend`) and the Rust backend
(`backend`) enforce rate limiting on every API endpoint. Anonymous traffic is
limited per IP; requests with a valid API key use a separate per-key bucket.
This page
documents the default limits, how to configure them, and the response shape
returned when a client exceeds the budget.

---

## Default limits

| Setting | Default | Environment variable |
| --- | --- | --- |
| Max requests per window | **60** | `RATE_LIMIT_POINTS` |
| Max API-key requests per window | **600** | `RATE_LIMIT_API_KEY_POINTS` |
| Window duration | **60 seconds** | `RATE_LIMIT_DURATION` |

The same defaults apply to both backends. Operators can override them by setting
the environment variables before starting the service.

---

## Scope

The rate limiter is applied as **global middleware** — every endpoint listed in
[docs/api-reference.md](./api-reference.md) is subject to a budget. Anonymous
requests share a per-IP bucket; requests carrying a non-empty `X-API-Key`
header use a separate bucket for that key. The API-key tier has its own limit,
but both tiers share the configured window duration.

| Backend | Middleware layer |
| --- | --- |
| `comebackhere-backend` (Express) | `rateLimitMiddleware` in `src/middleware/rateLimiter.ts` |
| `backend` (Axum / Tower) | `RateLimiterLayer` in `src/rate_limiter.rs` |

---

## How the IP is determined

The client IP is resolved in the following order:

1. **`X-Forwarded-For` header** — the first comma-separated entry is used.
   Leading and trailing whitespace is trimmed.
2. **Peer socket address** — the TCP connection's remote address.
3. **`"unknown"`** — fallback when neither source is available.

> **Note:** Because the limiter is per-IP, all clients sharing the same public
> IP (e.g. behind a corporate NAT) share the same rate-limit bucket.

---

## Rate limit headers

Every API response — whether the request succeeds or is rejected — includes the
following headers so clients can proactively back off before hitting the limit:

| Header | Type | Description |
| --- | --- | --- |
| `X-RateLimit-Limit` | integer | Total requests allowed per window. |
| `X-RateLimit-Remaining` | integer | Requests remaining in the current window. |
| `X-RateLimit-Reset` | integer | Unix timestamp (seconds) when the window resets. |

Example headers on a successful response:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1720000060
```

---

## 429 response

When the limit is exceeded the backend returns **HTTP 429** with the following
shape:

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
| `error.correlationId` | string | Same as the `X-Request-Id` response header. |

The response also includes a `Retry-After` header with the same integer value,
plus `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset`.

---

## Configuration examples

### Increase the limit for a high-traffic deployment

```bash
RATE_LIMIT_POINTS=200 RATE_LIMIT_API_KEY_POINTS=2000 RATE_LIMIT_DURATION=60 node dist/app.js
```

### Tighten the limit for a staging environment

```bash
RATE_LIMIT_POINTS=10 RATE_LIMIT_DURATION=60 node dist/app.js
```

### API-key requests

Send the API key in the `X-API-Key` header. The response headers always describe
the bucket used for that request, so clients can use the same logic for either
tier:

```http
X-API-Key: merchant-key
```

`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` are
returned on successful and rejected responses. On `429`, also honor
`Retry-After` or `error.details.retryAfter` before retrying.

---

## Implementation details

### TypeScript backend (`comebackhere-backend`)

- Uses [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible).
- When `REDIS_URL` is set, rate-limit state is stored in Redis (key prefix
  `rl:invoice`) with an in-memory fallback if Redis is unreachable.
- When `REDIS_URL` is not set (local development and tests), the limiter runs
  entirely in memory. API-key and IP buckets remain independent.

### Rust backend (`backend`)

- Implements a sliding-window algorithm as a `tower::Layer`.
- Stores per-IP buckets in an in-memory `HashMap` protected by a `Mutex`.
- Retains only timestamps that fall inside the current window, so the window
  rolls forward naturally without a background cleanup.

---

## Further reading

- [docs/api-reference.md](./api-reference.md) — full endpoint catalogue.
- [docs/error-codes.md](./error-codes.md) — contract-level error codes (distinct from HTTP 429).
- [Issue #215](https://github.com/WHEELBACK/COMEBACKHERE/issues/215) — rate-limiter test suite.
