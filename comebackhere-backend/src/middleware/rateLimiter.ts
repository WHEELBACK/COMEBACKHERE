import { type Request, type Response, type NextFunction } from "express"
import { RateLimiterRedis, RateLimiterMemory, type RateLimiterAbstract } from "rate-limiter-flexible"
import Redis from "ioredis"
import { RateLimitError } from "../lib/errors.js"

/**
 * Reads rate limit config from environment variables with sensible defaults.
 *
 * RATE_LIMIT_POINTS          – max requests per window per IP          (default: 60)
 * RATE_LIMIT_API_KEY_POINTS  – max requests per window per X-API-Key  (default: 600)
 * RATE_LIMIT_DURATION        – window size in seconds                  (default: 60)
 *
 * A malformed value falls back to its default rather than producing NaN, so a
 * typo in the environment can never silently disable the limiter.
 */
function getConfig() {
  const positiveInt = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return fallback
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
  }

  return {
    ipPoints: positiveInt("RATE_LIMIT_POINTS", 60),
    apiKeyPoints: positiveInt("RATE_LIMIT_API_KEY_POINTS", 600),
    duration: positiveInt("RATE_LIMIT_DURATION", 60),
  }
}

// Lazily created singletons — avoid connecting to Redis at import time (important for tests).
// One limiter per tier so each tier enforces its own documented budget; a single
// shared limiter cannot, because `rate-limiter-flexible` takes one `points`
// value per instance.
let _ipLimiter: RateLimiterAbstract | null = null
let _apiKeyLimiter: RateLimiterAbstract | null = null
let _redisClient: Redis | null = null
let _redisUrl: string | null = null

/**
 * Returns (and memoises) the Redis client shared by both tiers, or `null` when
 * `REDIS_URL` is unset. The memo is keyed on the URL so a test that unsets
 * `REDIS_URL` and calls {@link resetLimiter} really does get the in-memory
 * path.
 */
function getRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null
  if (_redisClient && _redisUrl === redisUrl) return _redisClient

  const client = new Redis(redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
  })

  // If Redis becomes unavailable, fall through without blocking requests
  client.on("error", () => {
    // intentionally silent — rate-limiter-flexible handles this via insuranceLimiter
  })

  _redisClient = client
  _redisUrl = redisUrl
  return client
}

/** Builds a limiter for one tier, backed by Redis when configured. */
function createLimiter(points: number, duration: number): RateLimiterAbstract {
  const redisClient = getRedisClient()

  if (redisClient) {
    return new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: "rl:invoice",
      points,
      duration,
      // In-memory fallback when Redis is unreachable
      insuranceLimiter: new RateLimiterMemory({ points, duration }),
    })
  }

  // No Redis configured (local dev / tests) — use memory limiter
  return new RateLimiterMemory({ points, duration })
}

/** Returns (and memoises) the rate limiter for the requested tier. */
function getLimiterForTier(tier: "ip" | "apiKey"): RateLimiterAbstract {
  if (tier === "ip" && _ipLimiter) return _ipLimiter
  if (tier === "apiKey" && _apiKeyLimiter) return _apiKeyLimiter

  const { ipPoints, apiKeyPoints, duration } = getConfig()
  const limiter = createLimiter(tier === "ip" ? ipPoints : apiKeyPoints, duration)

  if (tier === "ip") _ipLimiter = limiter
  else _apiKeyLimiter = limiter

  return limiter
}

/** Clears the cached limiters — used in tests to get fresh instances per suite. */
export function resetLimiter(): void {
  _ipLimiter = null
  _apiKeyLimiter = null
}

/**
 * Attaches standard rate-limit headers to the response.
 *
 * X-RateLimit-Limit     – total requests allowed per window
 * X-RateLimit-Remaining – requests remaining in the current window
 * X-RateLimit-Reset     – Unix timestamp (seconds) when the window resets
 */
function setRateLimitHeaders(
  res: Response,
  points: number,
  remainingPoints: number,
  msBeforeNext: number
): void {
  const resetTimestamp = Math.ceil((Date.now() + msBeforeNext) / 1000)
  res.set("X-RateLimit-Limit", String(points))
  res.set("X-RateLimit-Remaining", String(Math.max(0, remainingPoints)))
  res.set("X-RateLimit-Reset", String(resetTimestamp))
}

/**
 * Express middleware: enforces per-IP or per-API-key rate limiting.
 *
 * The bucket is selected by the `X-API-Key` request header when present and
 * non-empty (`api-key:<value>`, budget `RATE_LIMIT_API_KEY_POINTS`), otherwise
 * by the caller's IP (`ip:<addr>`, budget `RATE_LIMIT_POINTS`).
 *
 * `X-API-Key` is a bucket selector, not a credential — it is not authenticated.
 * See docs/rate-limits.md.
 *
 * Returns 429 (standard error envelope, `details.retryAfter`) with a
 * Retry-After header when the limit is exceeded.
 * On every response (success or 429) attaches:
 *   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 */
export function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // x-forwarded-for may be a comma-separated list; take the first entry
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  const apiKey = req.header("X-API-Key")?.trim()
  const key = apiKey ? `api-key:${apiKey}` : `ip:${ip}`

  const { ipPoints, apiKeyPoints } = getConfig()
  const points = apiKey ? apiKeyPoints : ipPoints
  const limiter = getLimiterForTier(apiKey ? "apiKey" : "ip")

  limiter
    .consume(key)
    .then((rateLimiterRes) => {
      setRateLimitHeaders(res, points, rateLimiterRes.remainingPoints, rateLimiterRes.msBeforeNext)
      next()
    })
    .catch((rateLimiterRes) => {
      const retrySecs = Math.ceil((rateLimiterRes?.msBeforeNext ?? 1000) / 1000)
      setRateLimitHeaders(res, points, 0, rateLimiterRes?.msBeforeNext ?? 1000)
      res.set("Retry-After", String(retrySecs))
      next(new RateLimitError(retrySecs))
    })
}
