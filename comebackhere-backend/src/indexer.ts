/**
 * Invoice event indexer — #69 / #209
 *
 * Polls Soroban for invoice contract events (invoice_created, invoice_paid,
 * invoice_expired, invoice_cancelled, escrow_released) using cursor-based
 * pagination so missed events and re-org recovery are handled automatically.
 *
 * Cursor persistence:
 *   After each batch the last processed paging token and ledger are stored in
 *   Mongo (indexer_cursors, _id "invoice_events").  On startup the indexer
 *   resumes from that cursor.  The token is also mirrored to Redis (#209),
 *   which is used only when the indexer runs without Mongo.
 *
 * Retention gaps:
 *   If the cursor is older than the RPC node's event retention window the
 *   missing ledger range is logged, counted in Prometheus metrics and stored
 *   in indexer_gaps before the indexer continues from the oldest retained
 *   ledger.  See docs/troubleshooting.md for the recovery procedure.
 *
 * Idempotency:
 *   Every event is stored in invoice_events under its unique Soroban event
 *   id.  A crash between processing a batch and saving the cursor replays
 *   the batch on restart; events already applied are skipped, so nothing is
 *   duplicated and nothing is lost.
 *
 * Redis reconnection (#209):
 *   If the Redis connection drops the indexer reconnects with exponential
 *   back-off (base 250 ms, cap 30 s, jitter ±10 %).  It continues to poll
 *   Soroban during the reconnect window — cursor saves are queued / retried
 *   automatically by ioredis — so no events are lost.
 *
 * Usage (standalone):
 *   SOROBAN_RPC_URL=... INVOICE_CONTRACT_ID=... node dist/indexer.js
 *
 * Usage (embedded): call startIndexer() from index.ts or a worker.
 */

import { SorobanRpc, xdr } from "stellar-sdk"
import Redis from "ioredis"
import type { Db } from "mongodb"
import {
  connectMongo,
  getCursorsCollection,
  getInvoiceEventsCollection,
  getIndexerGapsCollection,
  getInvoicesCollection,
  type IndexerCursor,
  type InvoiceEventRecord,
  type InvoiceStatus,
} from "./db/mongo.js"
import { getOldestRetainedLedger, ledgerFromPagingToken, parseRetentionError } from "./lib/soroban.js"
import { counter, gauge } from "./lib/metrics.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvoiceEventType =
  | "invoice_created"
  | "invoice_paid"
  | "invoice_expired"
  | "invoice_cancelled"
  | "escrow_released"

export interface InvoiceStateTransition {
  event_type: InvoiceEventType
  invoice_id: string
  ledger: number
  ledger_closed_at: string
  transaction_hash: string
  contract_id: string
  raw_topics: string[]
  raw_value: string
}

const TRACKED_EVENTS = new Set<string>([
  "invoice_created",
  "invoice_paid",
  "invoice_expired",
  "invoice_cancelled",
  "escrow_released",
])

// ---------------------------------------------------------------------------
// Redis cursor persistence (#209)
// ---------------------------------------------------------------------------

const INDEXER_CURSOR_KEY = "invoice_indexer_cursor"

/**
 * In-memory fallback cursor — used when Redis is unavailable at startup
 * or when a cursor write fails.  Soroban polling continues uninterrupted.
 */
let memCursor: string = process.env.INDEXER_START_CURSOR ?? "0"

/** The active ioredis client.  Replaced on each reconnect attempt. */
let redisClient: Redis | null = null

// ---------------------------------------------------------------------------
// Exponential back-off helper (#209)
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 30_000
const BACKOFF_JITTER = 0.1 // ±10 %

/**
 * Returns the delay in milliseconds for the n-th retry attempt
 * (0-indexed) using capped exponential back-off with jitter.
 */
export function backoffDelayMs(attempt: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
  const jitter = exp * BACKOFF_JITTER * (Math.random() * 2 - 1)
  return Math.round(exp + jitter)
}

// ---------------------------------------------------------------------------
// Redis connection with reconnect/back-off loop (#209)
// ---------------------------------------------------------------------------

/**
 * Creates an ioredis client configured with automatic reconnect back-off.
 * ioredis natively retries connections; we customise the strategy so each
 * attempt follows our capped exponential schedule.
 *
 * The returned client emits 'connect', 'reconnecting', and 'error' events
 * which are logged for observability.
 */
export function createRedisClient(redisUrl?: string): Redis {
  const url = redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379"

  let attempt = 0
  const client = new Redis(url, {
    // ioredis calls this after each failed connection attempt.
    // Return the number of milliseconds to wait before the next attempt,
    // or false / null to stop retrying entirely.
    retryStrategy(times: number): number | null {
      attempt = times
      if (times > 50) {
        // After 50 retries (~30 min with cap) give up so operators notice.
        console.error(
          `[indexer] Redis retry limit reached after ${times} attempts — stopping reconnect`
        )
        return null
      }
      const delay = backoffDelayMs(times - 1)
      console.warn(
        `[indexer] Redis reconnect attempt ${times} — waiting ${delay} ms`
      )
      return delay
    },
    // Do not flood logs when commands queue during a disconnect.
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  })

  client.on("connect", () => {
    console.log("[indexer] Redis connected")
    attempt = 0
  })

  client.on("reconnecting", (ms: number) => {
    console.warn(`[indexer] Redis reconnecting in ${ms} ms (attempt ${attempt})`)
  })

  client.on("error", (err: Error) => {
    // Log but do not crash — the indexer continues polling Soroban.
    console.error(`[indexer] Redis error: ${err.message}`)
  })

  return client
}

// ---------------------------------------------------------------------------
// Cursor read / write (with Redis fallback to in-memory)
// ---------------------------------------------------------------------------

/** Reads the last cursor from Redis, falling back to the in-memory value. */
export async function loadCursor(): Promise<string> {
  if (redisClient) {
    try {
      const stored = await redisClient.get(INDEXER_CURSOR_KEY)
      if (stored) {
        memCursor = stored
        return stored
      }
    } catch (err) {
      console.warn("[indexer] could not read cursor from Redis — using in-memory cursor", err)
    }
  }
  return memCursor
}

/** Persists the cursor to Redis and in-memory for durability. */
export async function saveCursor(next: string): Promise<void> {
  memCursor = next
  if (redisClient) {
    try {
      await redisClient.set(INDEXER_CURSOR_KEY, next)
    } catch (err) {
      // Non-fatal: in-memory cursor is still updated, so polling continues.
      console.warn("[indexer] could not save cursor to Redis — using in-memory fallback", err)
    }
  }
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

/** stellar-sdk returns parsed ScVals; raw RPC responses carry base64 XDR. */
function toScVal(value: xdr.ScVal | string): xdr.ScVal {
  return typeof value === "string" ? xdr.ScVal.fromXDR(value, "base64") : value
}

function toBase64(value: xdr.ScVal | string | undefined): string {
  if (!value) return ""
  return typeof value === "string" ? value : value.toXDR("base64")
}

function parseEventType(topics: xdr.ScVal[]): InvoiceEventType | null {
  let name: string | undefined
  try {
    name = topics[0]?.sym()?.toString()
  } catch {
    return null
  }
  if (!name || !TRACKED_EVENTS.has(name)) return null
  return name as InvoiceEventType
}

function parseInvoiceId(topics: xdr.ScVal[]): string {
  const topic = topics[1]
  if (!topic) return "unknown"
  try {
    return topic.u64().toString()
  } catch {
    try {
      return topic.u32().toString()
    } catch {
      return "unknown"
    }
  }
}

/**
 * Unique id for an event. Soroban event ids ("<toid>-<index>") are globally
 * unique; the paging token is equivalent and used as a fallback.
 */
export function eventIdOf(event: { id?: string; pagingToken?: string }): string | null {
  return event.id ?? event.pagingToken ?? null
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Side-effect hook for a newly indexed state transition (logging today,
 * webhooks later). Runs at most once per event id, except when the process
 * crashed after the event was stored but before it was marked applied.
 */
export function persistTransition(transition: InvoiceStateTransition): void {
  console.log(
    `[indexer] ${transition.event_type} invoice_id=${transition.invoice_id}` +
    ` ledger=${transition.ledger} tx=${transition.transaction_hash}`
  )
}

const STATUS_BY_EVENT: Partial<Record<InvoiceEventType, InvoiceStatus>> = {
  invoice_paid: "Paid",
  invoice_expired: "Expired",
  invoice_cancelled: "Cancelled",
  escrow_released: "Released",
}

/**
 * Stores the event keyed by its unique id and applies it to the invoice.
 * Returns false when the event was already fully applied (duplicate), so
 * replaying a batch after a crash neither duplicates rows nor re-fires hooks.
 */
export async function recordTransition(
  database: Db,
  eventId: string,
  pagingToken: string | null,
  transition: InvoiceStateTransition,
): Promise<boolean> {
  const events = getInvoiceEventsCollection(database)

  let before: InvoiceEventRecord | null
  try {
    before = await events.findOneAndUpdate(
      { event_id: eventId },
      {
        $setOnInsert: {
          event_id: eventId,
          paging_token: pagingToken,
          ...transition,
          applied: false,
          created_at: new Date(),
        },
      },
      { upsert: true, returnDocument: "before" },
    )
  } catch (err) {
    // A concurrent upsert of the same id lost the race on the unique index.
    if ((err as { code?: number })?.code === 11000) return false
    throw err
  }

  if (before?.applied) return false

  const status = STATUS_BY_EVENT[transition.event_type]
  if (status) {
    await getInvoicesCollection(database).updateOne(
      { invoice_id: transition.invoice_id },
      { $set: { status, updated_at: new Date() } },
    )
  }
  persistTransition(transition)

  await events.updateOne(
    { event_id: eventId },
    { $set: { applied: true, applied_at: new Date() } },
  )
  return true
}

// ---------------------------------------------------------------------------
// Mongo cursor persistence
// ---------------------------------------------------------------------------

export const MONGO_CURSOR_ID = "invoice_events"
const EVENT_LIMIT = 100

/** Reads the durable cursor ({ paging_token, last_ledger }) from Mongo. */
export async function loadMongoCursor(database: Db): Promise<IndexerCursor | null> {
  return getCursorsCollection(database).findOne({ _id: MONGO_CURSOR_ID })
}

/**
 * Saves the resume point after a batch has been fully processed.
 * `last_ledger` is the last ledger whose events were all handled; when the
 * paging token is missing the indexer rescans from that ledger, relying on
 * per-event idempotency to skip what it has already seen.
 */
export async function saveMongoCursor(
  database: Db,
  pagingToken: string | null,
  lastLedger: number,
): Promise<void> {
  await getCursorsCollection(database).updateOne(
    { _id: MONGO_CURSOR_ID },
    { $set: { paging_token: pagingToken, last_ledger: lastLedger, updated_at: new Date() } },
    { upsert: true },
  )
}

// ---------------------------------------------------------------------------
// RPC retention gaps
// ---------------------------------------------------------------------------

export const retentionGapsTotal = counter(
  "indexer_retention_gaps_total",
  "Times the indexer's resume ledger was older than the RPC node's retention window",
)
export const retentionGapLedgersTotal = counter(
  "indexer_retention_gap_ledgers_total",
  "Ledgers skipped because they had fallen out of the RPC node's retention window",
)
export const retentionGapLastMissing = gauge(
  "indexer_retention_gap_last_missing_ledgers",
  "Number of ledgers missing in the most recently detected retention gap",
)

/**
 * Logs, counts and stores a range of ledgers the indexer could not read.
 * Stored gaps (indexer_gaps, status "open") drive the recovery procedure in
 * docs/troubleshooting.md. Keyed by range, so re-detecting is a no-op.
 */
export async function recordRetentionGap(
  database: Db | null,
  contractId: string,
  fromLedger: number,
  toLedger: number,
): Promise<void> {
  const missing = Math.max(0, toLedger - fromLedger + 1)
  console.error(
    `[indexer] RETENTION GAP: ledgers ${fromLedger}-${toLedger} (${missing} ledgers) are no longer ` +
    `retained by the RPC node; events in this range were NOT indexed. Resuming from ledger ` +
    `${toLedger + 1}. See docs/troubleshooting.md#indexer-retention-gaps to backfill.`
  )

  const labels = { indexer: "invoice" }
  retentionGapsTotal.inc(labels)
  retentionGapLedgersTotal.inc(labels, missing)
  retentionGapLastMissing.set(missing, labels)

  if (!database) return
  await getIndexerGapsCollection(database).updateOne(
    { _id: `invoice:${fromLedger}-${toLedger}` },
    {
      $setOnInsert: {
        indexer: "invoice",
        contract_id: contractId,
        from_ledger: fromLedger,
        to_ledger: toLedger,
        missing_ledgers: missing,
        status: "open",
        detected_at: new Date(),
      },
    },
    { upsert: true },
  )
}

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

/** The subset of the Soroban RPC client the indexer needs (mockable in tests). */
export interface IndexerRpc {
  getEvents: (params: Parameters<SorobanRpc.Server["getEvents"]>[0]) => ReturnType<SorobanRpc.Server["getEvents"]>
  getLatestLedger: () => Promise<{ sequence: number }>
  getHealth?: () => Promise<unknown>
}

/** Ledger to start from when no cursor has ever been saved. */
async function initialStartLedger(rpc: IndexerRpc): Promise<number> {
  const configured = Number(process.env.INDEXER_START_LEDGER)
  if (Number.isInteger(configured) && configured > 0) return configured
  const latest = await rpc.getLatestLedger()
  return latest.sequence
}

/**
 * Fetches and processes one batch of events, then saves the cursor.
 *
 * `database` defaults to the shared Mongo connection; pass null to run
 * without Mongo (cursor kept in Redis / memory only, no idempotency).
 * Returns the number of newly applied events.
 */
export async function pollOnce(
  rpc: IndexerRpc,
  contractId: string,
  database?: Db | null,
): Promise<number> {
  const db = database === undefined ? await connectMongo() : database

  let pagingToken: string | undefined
  let startLedger: number | undefined
  let lastLedger = 0

  if (db) {
    const saved = await loadMongoCursor(db)
    lastLedger = saved?.last_ledger ?? 0
    if (saved?.paging_token) pagingToken = saved.paging_token
    else if (lastLedger > 0) startLedger = lastLedger
  } else {
    const mem = await loadCursor()
    if (mem !== "0") pagingToken = mem
  }
  if (!pagingToken && !startLedger) startLedger = await initialStartLedger(rpc)

  const fetchEvents = () =>
    rpc.getEvents({
      ...(pagingToken ? { cursor: pagingToken } : { startLedger }),
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: EVENT_LIMIT,
    })

  let response: Awaited<ReturnType<SorobanRpc.Server["getEvents"]>>
  try {
    response = await fetchEvents()
  } catch (err) {
    const retention = parseRetentionError(err)
    if (!retention) throw err

    // The resume point has fallen out of the node's retention window. Record
    // the missing range before skipping ahead so the gap is never silent.
    const oldest = Number.isFinite(retention.oldestLedger)
      ? retention.oldestLedger
      : await getOldestRetainedLedger(rpc)
    if (oldest === null) throw err

    const fromLedger =
      startLedger ?? (pagingToken ? ledgerFromPagingToken(pagingToken) : null) ?? lastLedger
    await recordRetentionGap(db, contractId, fromLedger, oldest - 1)

    pagingToken = undefined
    startLedger = oldest
    lastLedger = oldest
    if (db) await saveMongoCursor(db, null, oldest)
    response = await fetchEvents()
  }

  const events = response.events ?? []
  let applied = 0

  for (const event of events) {
    const topics = ((event.topic ?? []) as Array<xdr.ScVal | string>).map(toScVal)
    const eventType = parseEventType(topics)
    if (!eventType) continue

    const transition: InvoiceStateTransition = {
      event_type: eventType,
      invoice_id: parseInvoiceId(topics),
      ledger: event.ledger,
      ledger_closed_at: event.ledgerClosedAt ?? new Date().toISOString(),
      transaction_hash: event.txHash ?? "",
      contract_id: contractId,
      raw_topics: (event.topic ?? []).map(toBase64),
      raw_value: toBase64(event.value?.xdr ?? event.value),
    }

    const eventId = eventIdOf(event)
    if (db && eventId) {
      if (await recordTransition(db, eventId, event.pagingToken ?? null, transition)) applied++
    } else {
      persistTransition(transition)
      applied++
    }
  }

  // Advance the cursor only after every event in the batch has been handled.
  let nextToken: string | null
  if (events.length > 0) {
    const last = events[events.length - 1]
    nextToken = last.pagingToken ?? null
    lastLedger = last.ledger ?? lastLedger
  } else {
    // Nothing new: the RPC scanned up to latestLedger. Newer RPC versions
    // return a resume cursor; otherwise restart the scan at latestLedger.
    nextToken = response?.cursor ?? null
    lastLedger = Math.max(lastLedger, response?.latestLedger ?? 0)
  }

  if (db) await saveMongoCursor(db, nextToken, lastLedger)
  if (nextToken) await saveCursor(nextToken)

  return applied
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

let stopped = false
let activeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Stops the indexer poll loop.  Safe to call multiple times.
 * Does not interrupt an in-flight pollOnce() call; it prevents scheduling
 * the next one so any active poll completes cleanly before the process exits.
 */
export function stopIndexer(): void {
  stopped = true
  if (activeTimer !== null) {
    clearTimeout(activeTimer)
    activeTimer = null
  }
  // Gracefully close the Redis connection on shutdown.
  if (redisClient) {
    redisClient.quit().catch(() => {/* ignore quit errors during shutdown */})
    redisClient = null
  }
}

export async function startIndexer(options?: {
  rpcUrl?: string
  contractId?: string
  pollIntervalMs?: number
  redisUrl?: string
  onError?: (err: unknown) => void
  /** Injected Redis client for tests — skips real Redis connection. */
  _redisClient?: Redis | null
  /** Injected Mongo database for tests; null disables Mongo persistence. */
  _db?: Db | null
  /** Injected RPC client for tests. */
  _rpc?: IndexerRpc
}): Promise<void> {
  const rpcUrl = options?.rpcUrl ?? process.env.SOROBAN_RPC_URL
  const contractId = options?.contractId ?? process.env.INVOICE_CONTRACT_ID
  const pollIntervalMs = options?.pollIntervalMs ?? 5_000

  if (!rpcUrl || !contractId) {
    throw new Error("startIndexer: SOROBAN_RPC_URL and INVOICE_CONTRACT_ID are required")
  }

  // #209 — create (or inject) a Redis client with reconnect back-off.
  if (options?._redisClient !== undefined) {
    // Allow tests to inject a mock/null client.
    redisClient = options._redisClient
  } else {
    redisClient = createRedisClient(options?.redisUrl)
  }

  const rpc: IndexerRpc =
    options?._rpc ?? new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") })

  // The Mongo cursor is authoritative; Redis / memory is only a fallback
  // when the indexer runs without Mongo.
  const database = options?._db !== undefined ? options._db : await connectMongo()
  const saved = database ? await loadMongoCursor(database) : null
  const initialCursor = saved
    ? `ledger=${saved.last_ledger} token=${saved.paging_token ?? "none"}`
    : await loadCursor()
  console.log(
    `[indexer] starting — contract=${contractId} cursor=${initialCursor} interval=${pollIntervalMs}ms`
  )

  const loop = async () => {
    if (stopped) return
    try {
      await pollOnce(rpc, contractId!, database)
    } catch (err) {
      const handler = options?.onError ?? ((e) => console.error("[indexer] poll error", e))
      handler(err)
    }
    if (!stopped) {
      activeTimer = setTimeout(loop, pollIntervalMs)
    }
  }

  // Reset stopped flag in case startIndexer is called again after stopIndexer
  stopped = false
  loop()
}

// Run as standalone entry point
if (import.meta.url === new URL(process.argv[1], import.meta.url).href) {
  startIndexer().catch((err) => {
    console.error("[indexer] fatal", err)
    process.exit(1)
  })
}
