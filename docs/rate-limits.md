# Rate Limits and Throttling

Both the TypeScript backend (`comebackhere-backend`) and the Rust backend
(`backend`) enforce **per-IP rate limiting** on every API endpoint. This page
documents the default limits, how to configure them, and the response shape
returned when a client exceeds the budget.

---

## Default limits

| Setting | Default | Environment variable |
| --- | --- | --- |
| Max requests per window | **60** | `RATE_LIMIT_POINTS` |
| Window duration | **60 seconds** | `RATE_LIMIT_DURATION` |

The same defaults apply to both backends. Operators can override them by setting
the environment variables before starting the service.

---

## Scope

The rate limiter is applied as **global middleware** — every endpoint listed in
[docs/api-reference.md](./api-reference.md) is subject to the same per-IP
budget. There is currently no per-route or per-user differentiation.

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

## 429 response

When the limit is exceeded the backend returns **HTTP 429** with the following
shape:

```json
{
  "error": "Too many requests. Please retry after the indicated number of seconds.",
  "retryAfter": 12
}
```

| Field | Type | Description |
| --- | --- | --- |
| `error` | string | Human-readable message. |
| `retryAfter` | number | Seconds to wait before retrying. |

The response also includes a `Retry-After` header with the same integer value.

---

## Configuration examples

### Increase the limit for a high-traffic deployment

```bash
RATE_LIMIT_POINTS=200 RATE_LIMIT_DURATION=60 node dist/app.js
```

### Tighten the limit for a staging environment

```bash
RATE_LIMIT_POINTS=10 RATE_LIMIT_DURATION=60 node dist/app.js
```

---

## Implementation details

### TypeScript backend (`comebackhere-backend`)

- Uses [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible).
- When `REDIS_URL` is set, rate-limit state is stored in Redis (key prefix
  `rl:invoice`) with an in-memory fallback if Redis is unreachable.
- When `REDIS_URL` is not set (local development and tests), the limiter runs
  entirely in memory.

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
