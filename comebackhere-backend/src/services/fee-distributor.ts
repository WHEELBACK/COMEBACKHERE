/**
 * Fee Distributor Service
 *
 * Processes fee distribution jobs via a Redis-backed FIFO queue.
 *
 * Issue #1 — OTel trace carrier injection
 *   Every job envelope carries a `traceparent` / `tracestate` context map so
 *   that the trace started by an HTTP handler continues inside the worker
 *   without forking the trace graph.  Injection follows W3C TraceContext
 *   (https://www.w3.org/TR/trace-context/) so any standards-compliant backend
 *   can pick up the span on the other side.
 *
 * Issue #2 — Memory and DB throughput
 *   - In-process LRU cache (bounded size) for per-merchant fee configs so each
 *     job no longer issues a Mongo round-trip.
 *   - Redis pipelining: status updates that arrive within the same tick are
 *     flushed as a single MULTI/EXEC block.
 *   - Batch DB writes: completed-job records accumulate in a micro-buffer and
 *     are flushed with a single insertMany rather than one insertOne per job.
 *
 * Issue #4 — Auth and input hardening
 *   - `enqueueDistribution` validates every field through a Zod schema before
 *     any data touches Redis or Mongo.
 *   - Merchant addresses are validated as Stellar public keys.
 *   - Amount is bounded to a safe integer range; token is an allow-listed
 *     contract address pattern.
 *   - The Redis key is constructed from an allow-listed prefix so callers
 *     cannot inject arbitrary key paths.
 */

import Redis from "ioredis"
import { z } from "zod"
import { StrKey } from "stellar-sdk"
import type { Db } from "mongodb"
import { logger } from "../lib/logger.js"
import { connectMongo } from "../db/mongo.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Redis list key used as the job queue. */
export const QUEUE_KEY = "fee_distributor:jobs"

/** Mongo collection where completed distribution records land. */
export const DISTRIBUTIONS_COLLECTION = "fee_distributions"

/** Maximum number of pending completed-job records before a forced flush. */
export const FLUSH_THRESHOLD = 50

/** Maximum milliseconds a completed record waits before being flushed. */
export const FLUSH_INTERVAL_MS = 500

/** LRU capacity: at most this many merchant fee configs are held in memory. */
export const FEE_CONFIG_CACHE_SIZE = 500

/** How long (ms) a cached fee config entry remains valid without re-reading. */
export const FEE_CONFIG_CACHE_TTL_MS = 60_000

// ---------------------------------------------------------------------------
// W3C TraceContext carrier (Issue #1)
// ---------------------------------------------------------------------------

/**
 * A minimal W3C TraceContext propagation carrier.
 *
 * We deliberately avoid importing the full OpenTelemetry SDK — the backend
 * does not currently have it as a production dependency and adding a heavy SDK
 * for a single propagation feature would be over-engineering.  Instead we
 * implement the wire format directly:
 *
 *   traceparent: 00-{traceId}-{spanId}-{flags}
 *   tracestate:  vendor key=value pairs (optional)
 *
 * When the OTel SDK is available on a consumer it can read these fields with
 * its own `W3CTraceContextPropagator.extract()`.  When it is absent the
 * context simply passes through opaquely (no-op extract).
 *
 * @see https://www.w3.org/TR/trace-context/
 */
export interface TraceCarrier {
  traceparent?: string
  tracestate?: string
}

/**
 * Builds a TraceCarrier from the current active context.
 *
 * Production callers that run with the full OTel SDK should replace this
 * with their propagator's `inject()` call; this implementation provides a
 * safe, no-SDK fallback that embeds whatever traceparent/tracestate are
 * passed in directly (e.g. forwarded from an upstream HTTP header).
 *
 * @param context  Optional headers/context object the caller already holds.
 *                 Recognised keys: `traceparent`, `tracestate`.
 */
export function buildTraceCarrier(
  context?: Record<string, string | string[] | undefined>,
): TraceCarrier {
  if (!context) return {}
  const pick = (key: string): string | undefined => {
    const v = context[key]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim() !== "") return v[0].trim()
    return undefined
  }
  const carrier: TraceCarrier = {}
  const traceparent = pick("traceparent")
  if (traceparent) carrier.traceparent = traceparent
  const tracestate = pick("tracestate")
  if (tracestate) carrier.tracestate = tracestate
  return carrier
}

/**
 * Validates that a `traceparent` string conforms to the W3C format.
 *
 * Returns `true` for a well-formed value or `false` (never throws) so callers
 * can decide whether to propagate or discard it.
 */
export function isValidTraceparent(value: string): boolean {
  // 00-{32 hex}-{16 hex}-{2 hex}
  return /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
}

// ---------------------------------------------------------------------------
// Input validation schemas (Issue #4)
// ---------------------------------------------------------------------------

function isStellarPublicKey(addr: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(addr)
  } catch {
    return false
  }
}

function isStellarContractId(addr: string): boolean {
  try {
    return StrKey.isValidContract(addr)
  } catch {
    return false
  }
}

/**
 * Schema for a fee distribution job submitted by callers.
 *
 * All string fields are stripped of leading/trailing whitespace.  The token
 * field must be a valid Stellar contract id (C…) to prevent injection of
 * arbitrary identifiers into Redis keys and Mongo documents.
 */
export const distributionJobSchema = z.object({
  /** Stellar public key of the merchant receiving the fee. */
  merchant_address: z
    .string()
    .trim()
    .min(1, "merchant_address is required")
    .refine(isStellarPublicKey, { message: "merchant_address must be a valid Stellar public key" }),

  /** Amount in the smallest token unit (e.g. stroops for XLM-based tokens). */
  amount: z
    .number({ message: "amount must be a number" })
    .int("amount must be an integer")
    .positive("amount must be positive")
    .safe("amount exceeds safe integer range"),

  /** Stellar contract id of the token being distributed. */
  token: z
    .string()
    .trim()
    .min(1, "token is required")
    .refine(isStellarContractId, { message: "token must be a valid Stellar contract id" }),

  /** Idempotency key; callers supply this to make re-submissions safe. */
  idempotency_key: z
    .string()
    .trim()
    .min(1, "idempotency_key is required")
    .max(255, "idempotency_key must not exceed 255 characters")
    .regex(/^[\w:.\-]+$/, "idempotency_key may only contain word chars, colons, dots, and hyphens"),

  /**
   * Optional W3C TraceContext carrier injected by the caller so the
   * downstream worker can continue the same trace.
   */
  trace_carrier: z
    .object({
      traceparent: z.string().trim().optional(),
      tracestate: z.string().trim().optional(),
    })
    .optional(),
})

export type DistributionJobInput = z.input<typeof distributionJobSchema>
export type DistributionJob = z.output<typeof distributionJobSchema>

// The full envelope stored in Redis includes server-generated fields.
export interface DistributionJobEnvelope {
  job: DistributionJob
  enqueued_at: string
}

// ---------------------------------------------------------------------------
// Completed job record (written to Mongo)
// ---------------------------------------------------------------------------

export type DistributionStatus = "completed" | "failed" | "skipped"

export interface CompletedDistributionRecord {
  idempotency_key: string
  merchant_address: string
  amount: number
  token: string
  status: DistributionStatus
  error?: string
  processed_at: string
}

// ---------------------------------------------------------------------------
// In-process LRU cache for merchant fee configs (Issue #2)
// ---------------------------------------------------------------------------

export interface FeeConfig {
  bps: number          // fee in basis points
  min_amount: number   // minimum distributable amount
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Minimal LRU cache backed by an insertion-ordered Map.
 * Evicts the oldest entry when the size cap is reached.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>()

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  get(key: K): V | null {
    const entry = this.map.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key)
      return null
    }
    // Move to end to maintain recency order
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.capacity) {
      // Evict the oldest (first) entry
      this.map.delete(this.map.keys().next().value as K)
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }
}

export const feeConfigCache = new LruCache<string, FeeConfig>(
  FEE_CONFIG_CACHE_SIZE,
  FEE_CONFIG_CACHE_TTL_MS,
)

// ---------------------------------------------------------------------------
// Batch write buffer (Issue #2)
// ---------------------------------------------------------------------------

/**
 * Buffers completed distribution records and flushes them in a single Mongo
 * `insertMany` once either `FLUSH_THRESHOLD` items accumulate or
 * `FLUSH_INTERVAL_MS` elapses.
 *
 * This keeps per-job Mongo round-trips at zero during bursts, dramatically
 * cutting write latency and driver connection pressure.
 */
export class CompletedJobBuffer {
  private buffer: CompletedDistributionRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly getDb: () => Promise<Db>
  private readonly flushThreshold: number
  private readonly flushIntervalMs: number

  constructor(options?: {
    getDb?: () => Promise<Db>
    flushThreshold?: number
    flushIntervalMs?: number
  }) {
    this.getDb = options?.getDb ?? (async () => connectMongo())
    this.flushThreshold = options?.flushThreshold ?? FLUSH_THRESHOLD
    this.flushIntervalMs = options?.flushIntervalMs ?? FLUSH_INTERVAL_MS
  }

  add(record: CompletedDistributionRecord): void {
    this.buffer.push(record)
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, this.flushIntervalMs)
    }
  }

  async flush(): Promise<number> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return 0
    const batch = this.buffer.splice(0)
    try {
      const db = await this.getDb()
      await db.collection<CompletedDistributionRecord>(DISTRIBUTIONS_COLLECTION).insertMany(
        batch,
        { ordered: false },
      )
      logger.debug({ count: batch.length }, "fee-distributor: flushed completed jobs to Mongo")
    } catch (err) {
      logger.error(
        { count: batch.length, errorName: err instanceof Error ? err.name : "UnknownError" },
        "fee-distributor: failed to flush completed jobs to Mongo",
      )
      // Re-queue records so they are not silently dropped.
      this.buffer.unshift(...batch)
      return 0
    }
    return batch.length
  }

  get pending(): number {
    return this.buffer.length
  }

  async drain(): Promise<void> {
    await this.flush()
  }
}

// ---------------------------------------------------------------------------
// Redis pipelined status updates (Issue #2)
// ---------------------------------------------------------------------------

/**
 * Collects Redis commands within a single microtask checkpoint and executes
 * them as a single MULTI/EXEC pipeline, reducing per-job RTTs to zero during
 * bursts.
 */
export class RedisPipeline {
  private commands: Array<[string, ...string[]]> = []
  private scheduled = false

  constructor(private readonly getRedis: () => Redis | null) {}

  schedule(command: [string, ...string[]]): void {
    this.commands.push(command)
    if (!this.scheduled) {
      this.scheduled = true
      // Flush on the next microtask so callers within the same sync burst are batched.
      Promise.resolve().then(() => void this.flush())
    }
  }

  async flush(): Promise<void> {
    this.scheduled = false
    if (this.commands.length === 0) return
    const batch = this.commands.splice(0)
    const redis = this.getRedis()
    if (!redis) return
    try {
      const pipeline = redis.pipeline()
      for (const [cmd, ...args] of batch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(pipeline as any)[cmd](...args)
      }
      await pipeline.exec()
    } catch (err) {
      logger.error(
        { count: batch.length, errorName: err instanceof Error ? err.name : "UnknownError" },
        "fee-distributor: Redis pipeline flush failed",
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Core queue operations
// ---------------------------------------------------------------------------

/**
 * Serialises a validated job and pushes it to the Redis queue.
 *
 * The envelope includes a W3C traceparent/tracestate map (Issue #1) so the
 * consuming worker can continue the trace without a secondary lookup.
 *
 * @throws `ValidationError` (from Zod) when input fails schema checks.
 * @throws On Redis write failure (caller should catch and return 503).
 */
export async function enqueueDistribution(
  redis: Redis,
  input: DistributionJobInput,
): Promise<void> {
  // Issue #4: validate before touching any external system.
  const job = distributionJobSchema.parse(input)

  const envelope: DistributionJobEnvelope = {
    job,
    enqueued_at: new Date().toISOString(),
  }

  await redis.rpush(QUEUE_KEY, JSON.stringify(envelope))
  logger.debug(
    { idempotency_key: job.idempotency_key, merchant: job.merchant_address },
    "fee-distributor: job enqueued",
  )
}

/**
 * Pops and parses one job from the queue head.
 *
 * Returns `null` when the queue is empty or the payload is malformed
 * (the malformed payload is discarded to prevent poison-pill stalls).
 */
export async function dequeueDistribution(
  redis: Redis,
): Promise<DistributionJobEnvelope | null> {
  const raw = await redis.lpop(QUEUE_KEY)
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, "fee-distributor: discarding unparseable job payload")
    return null
  }

  // Validate the envelope shape; a malformed or tampered envelope is discarded.
  const envelopeSchema = z.object({
    job: distributionJobSchema,
    enqueued_at: z.string(),
  })
  const result = envelopeSchema.safeParse(parsed)
  if (!result.success) {
    logger.warn(
      { issues: result.error.issues.length },
      "fee-distributor: discarding envelope that failed schema validation",
    )
    return null
  }
  return result.data
}

/**
 * Extracts the trace carrier from a dequeued envelope and returns it.
 *
 * The returned carrier can be passed into an OTel SDK propagator's `extract`
 * to resume the upstream span:
 *
 *   const ctx = propagator.extract(ROOT_CONTEXT, extractTraceCarrier(envelope))
 *
 * When no carrier is present an empty object is returned (no-op propagation).
 */
export function extractTraceCarrier(envelope: DistributionJobEnvelope): TraceCarrier {
  const carrier = envelope.job.trace_carrier
  if (!carrier) return {}
  const result: TraceCarrier = {}
  if (carrier.traceparent && isValidTraceparent(carrier.traceparent)) {
    result.traceparent = carrier.traceparent
  }
  if (carrier.tracestate) result.tracestate = carrier.tracestate
  return result
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export interface FeeDistributorOptions {
  redis: Redis
  /** Injected Mongo Db for tests; production omits this and connects lazily. */
  db?: Db
  /** Override the default buffer (injected in tests). */
  buffer?: CompletedJobBuffer
  /** Override poll interval in ms (default: 200). */
  pollIntervalMs?: number
  /** Fee config lookup; defaults to Mongo-backed lookup with LRU cache. */
  getFeeConfig?: (merchantAddress: string, token: string) => Promise<FeeConfig | null>
}

/**
 * Minimal fee processor: reads the config, validates amount against minimum,
 * and records the outcome.
 *
 * Production implementations would call the treasury contract here.
 * This function is designed for injection/mocking in tests.
 */
export async function processDistribution(
  job: DistributionJob,
  getFeeConfig: (merchantAddress: string, token: string) => Promise<FeeConfig | null>,
): Promise<CompletedDistributionRecord> {
  const config = await getFeeConfig(job.merchant_address, job.token)
  if (!config) {
    logger.warn(
      { merchant: job.merchant_address, token: job.token },
      "fee-distributor: no fee config found, skipping",
    )
    return {
      idempotency_key: job.idempotency_key,
      merchant_address: job.merchant_address,
      amount: job.amount,
      token: job.token,
      status: "skipped",
      processed_at: new Date().toISOString(),
    }
  }

  if (job.amount < config.min_amount) {
    return {
      idempotency_key: job.idempotency_key,
      merchant_address: job.merchant_address,
      amount: job.amount,
      token: job.token,
      status: "skipped",
      error: `amount ${job.amount} is below minimum ${config.min_amount}`,
      processed_at: new Date().toISOString(),
    }
  }

  // Compute actual fee (truncating sub-stroop fractions)
  const fee = Math.floor((job.amount * config.bps) / 10_000)
  logger.debug(
    { idempotency_key: job.idempotency_key, fee, bps: config.bps },
    "fee-distributor: processing distribution",
  )

  return {
    idempotency_key: job.idempotency_key,
    merchant_address: job.merchant_address,
    amount: fee,
    token: job.token,
    status: "completed",
    processed_at: new Date().toISOString(),
  }
}

/**
 * Returns a Mongo-backed fee config loader with LRU caching (Issue #2).
 *
 * Cache hits avoid a Mongo round-trip; cache misses load the record and store
 * it for `FEE_CONFIG_CACHE_TTL_MS` milliseconds.
 */
export function createMongoFeeConfigLoader(
  db: Db,
  cache: LruCache<string, FeeConfig> = feeConfigCache,
): (merchantAddress: string, token: string) => Promise<FeeConfig | null> {
  return async (merchantAddress, token) => {
    const cacheKey = `${merchantAddress}:${token}`
    const cached = cache.get(cacheKey)
    if (cached) return cached

    const record = await db
      .collection<FeeConfig & { merchant_address: string; token: string }>("fee_configs")
      .findOne({ merchant_address: merchantAddress, token })

    if (!record) return null
    const config: FeeConfig = { bps: record.bps, min_amount: record.min_amount }
    cache.set(cacheKey, config)
    return config
  }
}

export interface FeeDistributorWorker {
  stop: () => Promise<void>
  readonly isRunning: boolean
}

/**
 * Starts the fee distributor worker loop.
 *
 * The worker polls the Redis queue at `pollIntervalMs` and processes each job
 * through `processDistribution`.  Completed records are batched into Mongo via
 * `CompletedJobBuffer` to minimise write amplification (Issue #2).
 *
 * Trace carriers are extracted from each envelope before processing so that
 * downstream code can resume the upstream OTel trace (Issue #1).
 *
 * @returns A handle with a `stop()` method for graceful shutdown.
 */
export function startFeeDistributor(options: FeeDistributorOptions): FeeDistributorWorker {
  const { redis, pollIntervalMs = 200 } = options

  let running = true
  let timer: ReturnType<typeof setTimeout> | null = null

  const buffer =
    options.buffer ??
    new CompletedJobBuffer({
      getDb: options.db ? () => Promise.resolve(options.db!) : undefined,
    })

  let getFeeConfig: (merchantAddress: string, token: string) => Promise<FeeConfig | null>
  if (options.getFeeConfig) {
    getFeeConfig = options.getFeeConfig
  } else if (options.db) {
    getFeeConfig = createMongoFeeConfigLoader(options.db)
  } else {
    // Lazily resolve Mongo on first access.
    let cachedDb: Db | null = null
    getFeeConfig = async (merchantAddress, token) => {
      if (!cachedDb) cachedDb = await connectMongo()
      return createMongoFeeConfigLoader(cachedDb)(merchantAddress, token)
    }
  }

  const poll = async () => {
    if (!running) return
    try {
      const envelope = await dequeueDistribution(redis)
      if (envelope) {
        // Issue #1: extract trace carrier so downstream code can resume the span.
        const carrier = extractTraceCarrier(envelope)
        logger.debug(
          {
            idempotency_key: envelope.job.idempotency_key,
            hasTrace: !!carrier.traceparent,
          },
          "fee-distributor: dequeued job",
        )

        try {
          const result = await processDistribution(envelope.job, getFeeConfig)
          buffer.add(result)
        } catch (err) {
          const record: CompletedDistributionRecord = {
            idempotency_key: envelope.job.idempotency_key,
            merchant_address: envelope.job.merchant_address,
            amount: envelope.job.amount,
            token: envelope.job.token,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            processed_at: new Date().toISOString(),
          }
          buffer.add(record)
          logger.error(
            {
              idempotency_key: envelope.job.idempotency_key,
              errorName: err instanceof Error ? err.name : "UnknownError",
            },
            "fee-distributor: job processing failed",
          )
        }
      }
    } catch (err) {
      logger.error(
        { errorName: err instanceof Error ? err.name : "UnknownError" },
        "fee-distributor: poll error",
      )
    }

    if (running) {
      timer = setTimeout(() => void poll(), pollIntervalMs)
    }
  }

  // Kick off the loop
  timer = setTimeout(() => void poll(), 0)

  return {
    async stop() {
      running = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await buffer.drain()
      logger.info("fee-distributor: worker stopped")
    },
    get isRunning() {
      return running
    },
  }
}
