import { xdr } from "stellar-sdk"
import {
  buildSorobanClient,
  type SorobanClient,
} from "../lib/soroban.js"
import {
  connectMongo,
  getCursorsCollection,
  getSettlementsCollection,
  type SettlementRecord,
} from "../db/mongo.js"
import { dispatchWebhook } from "./webhooks.js"
import { invalidateBalanceCache } from "../lib/cache.js"
import { indexerLedgerLag } from "../lib/metrics.js"
import { logger } from "../lib/logger.js"

const CURSOR_ID = "treasury_settlement_events"
const POLL_INTERVAL_MS = 5_000
const EVENT_LIMIT = 100
// Upper bound on the number of processed event IDs kept in the cursor document.
// Bounds both the Mongo document size and the in-memory Set used for de-duplication.
const MAX_PROCESSED_EVENT_IDS = 1_000
// Maximum number of settlement writes to buffer before flushing to Mongo.
const DB_WRITE_BATCH_SIZE = 50

function topicSymbol(topic: xdr.ScVal[] | undefined, index: number): string | null {
  try {
    return topic?.[index]?.sym()?.toString() ?? null
  } catch {
    return null
  }
}

function topicU64(topic: xdr.ScVal[] | undefined, index: number): bigint {
  try {
    return BigInt(topic?.[index]?.u64()?.toString() ?? "0")
  } catch {
    return 0n
  }
}

function topicAddress(topic: xdr.ScVal[] | undefined, index: number): string {
  try {
    return topic?.[index]?.address()?.toString() ?? ""
  } catch {
    return ""
  }
}

function valueU64(value: xdr.ScVal | undefined, index: number): bigint {
  try {
    const vec = value?.vec()
    return BigInt(vec?.[index]?.u64()?.toString() ?? "0")
  } catch {
    return 0n
  }
}

function valueAddress(value: xdr.ScVal | undefined, index: number): string {
  try {
    const vec = value?.vec()
    return vec?.[index]?.address()?.toString() ?? ""
  } catch {
    return ""
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Execute an RPC call with bounded retries and exponential backoff.
 * Retries only on transient failures; the final error is re-thrown so the
 * caller can decide whether to abort the batch.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts: number = RPC_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts) break
      const backoff = RPC_BASE_BACKOFF_MS * 2 ** (attempt - 1)
      logger.warn(
        {
          label,
          attempt,
          maxAttempts,
          backoffMs: backoff,
          errorName: err instanceof Error ? err.name : "UnknownError",
        },
        "Treasury indexer RPC call failed; retrying",
      )
      await sleep(backoff)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Treasury indexer RPC call failed: ${label}`)
}

async function loadCursor(database: Awaited<ReturnType<typeof connectMongo>>) {
  const cursors = getCursorsCollection(database)
  const existing = await cursors.findOne({ _id: CURSOR_ID })
  if (!existing) {
    return { _id: CURSOR_ID, paging_token: null, last_ledger: 0, updated_at: new Date() }
  }

  // Defensive normalization: a corrupted cursor document must never crash the
  // indexer. Fall back to safe defaults for any malformed field.
  const pagingToken =
    typeof existing.paging_token === "string" && existing.paging_token.length > 0
      ? existing.paging_token
      : null
  const rawLedger = Number(existing.last_ledger)
  const lastLedger =
    Number.isFinite(rawLedger) && rawLedger > 0 ? Math.floor(rawLedger) : 0
  const processedIds = Array.isArray(existing.processed_event_ids)
    ? existing.processed_event_ids.filter(
        (id: unknown): id is string => typeof id === "string" && id.length > 0,
      )
    : []

  if (pagingToken !== existing.paging_token || lastLedger !== existing.last_ledger) {
    logger.warn(
      { cursorId: CURSOR_ID },
      "Treasury indexer cursor was malformed; using normalized values",
    )
  }

  return {
    _id: CURSOR_ID,
    paging_token: pagingToken,
    last_ledger: lastLedger,
    processed_event_ids: processedIds,
    updated_at: existing.updated_at ?? new Date(),
  }
}

/**
 * Build a bounded in-memory set of already-processed event IDs from the cursor
 * document. Only the most recent `MAX_PROCESSED_EVENT_IDS` entries are retained
 * so memory usage stays constant regardless of how long the indexer has run.
 */
function loadProcessedEventIds(cursor: { processed_event_ids?: unknown }): Set<string> {
  const raw = Array.isArray(cursor.processed_event_ids) ? cursor.processed_event_ids : []
  const bounded = raw.length > MAX_PROCESSED_EVENT_IDS
    ? raw.slice(-MAX_PROCESSED_EVENT_IDS)
    : raw
  const ids = new Set<string>()
  for (const id of bounded) {
    if (typeof id === "string") ids.add(id)
  }
  return ids
}

/**
 * Ensure the settlements collection has the indexes required for the indexer's
 * hot-path lookups. Index creation is idempotent and safe to call repeatedly.
 */
export async function ensureSettlementIndexes(
  database: Awaited<ReturnType<typeof connectMongo>>,
): Promise<void> {
  try {
    const settlements = getSettlementsCollection(database)
    await Promise.all([
      settlements.createIndex({ id: 1 }, { unique: true, background: true }),
      settlements.createIndex({ status: 1, updated_at: -1 }, { background: true }),
      settlements.createIndex({ merchant_address: 1 }, { background: true }),
    ])
  } catch (err) {
    logger.error(
      { errorName: err instanceof Error ? err.name : "UnknownError" },
      "Failed to ensure settlement indexes",
    )
  }
}

async function saveCursor(
  database: Awaited<ReturnType<typeof connectMongo>>,
  pagingToken: string | null,
  lastLedger: number,
  newEventIds: string[] = [],
) {
  const cursors = getCursorsCollection(database)
  const update: Record<string, unknown> = {
    paging_token: pagingToken,
    last_ledger: lastLedger,
    updated_at: new Date(),
  }

  if (newEventIds.length > 0) {
    // Only push the most recent IDs; the $slice keeps the array bounded so the
    // cursor document never grows without limit.
    const boundedIds = newEventIds.length > MAX_PROCESSED_EVENT_IDS
      ? newEventIds.slice(-MAX_PROCESSED_EVENT_IDS)
      : newEventIds
    await cursors.updateOne(
      { _id: CURSOR_ID },
      {
        $set: update,
        // Keep only the most recent MAX_PROCESSED_EVENT_IDS event IDs to bound document size
        $push: {
          processed_event_ids: {
            $each: boundedIds,
            $slice: -MAX_PROCESSED_EVENT_IDS,
          },
        },
      },
      { upsert: true },
    )
  } else {
    await cursors.updateOne(
      { _id: CURSOR_ID },
      { $set: update },
      { upsert: true },
    )
  }
}

async function processSettlementProposed(
  settlements: ReturnType<typeof getSettlementsCollection>,
  settlementId: number,
  token: string,
  amount: bigint,
  merchant: string,
  txHash: string,
) {
  await settlements.updateOne(
    { id: settlementId },
    {
      $setOnInsert: {
        id: settlementId,
        approvals: [],
        approval_weight: 0,
        status: "Pending" as const,
        hold_reason: null,
      },
      $set: {
        merchant_address: merchant,
        amount: amount.toString(),
        token,
        proposed_tx_hash: txHash,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  )
}

async function processSettlementApproved(
  settlements: ReturnType<typeof getSettlementsCollection>,
  settlementId: number,
  signer: string,
  newWeight: bigint,
) {
  await settlements.updateOne(
    { id: settlementId },
    {
      $addToSet: { approvals: signer },
      $set: {
        approval_weight: Number(newWeight),
        updated_at: new Date(),
      },
      $setOnInsert: {
        merchant_address: "",
        amount: "0",
        token: "",
        status: "Pending" as const,
        hold_reason: null,
      },
    },
    { upsert: true },
  )
}

async function processSettlementExecuted(
  settlements: ReturnType<typeof getSettlementsCollection>,
  settlementId: number,
  txHash: string,
) {
  await settlements.updateOne(
    { id: settlementId },
    {
      $set: {
        status: "Executed" as SettlementRecord["status"],
        executed_tx_hash: txHash,
        updated_at: new Date(),
      },
      $setOnInsert: {
        merchant_address: "",
        amount: "0",
        token: "",
        approvals: [],
        approval_weight: 0,
        hold_reason: null,
      },
    },
    { upsert: true },
  )
}

/**
 * Build a deterministic, unique identifier for an on-chain event so that
 * replaying an overlapping window (e.g. after a reorg or indexer restart)
 * never applies the same side-effect twice.
 *
 * Format: "<pagingToken>" when available (Soroban paging tokens already encode
 * ledger + tx index + event index), falling back to "<txHash>:<eventType>:<settlementId>".
 */
export function buildEventId(
  pagingToken: string | undefined,
  txHash: string,
  eventType: string,
  settlementId: number,
): string {
  if (pagingToken) return pagingToken
  return `${txHash}:${eventType}:${settlementId}`
}

type PendingWrite = () => Promise<void>

/**
 * Flush a buffer of pending settlement writes in bounded chunks so we never
 * hold an unbounded number of promises in memory and never issue one round-trip
 * per event. Writes within a chunk run concurrently; chunks run sequentially.
 */
async function flushWrites(writes: PendingWrite[]): Promise<void> {
  for (let i = 0; i < writes.length; i += DB_WRITE_BATCH_SIZE) {
    const chunk = writes.slice(i, i + DB_WRITE_BATCH_SIZE)
    await Promise.all(chunk.map((write) => write()))
  }
}

export async function processIndexerBatch(
  client: SorobanClient,
  treasuryContractId: string,
  database: Awaited<ReturnType<typeof connectMongo>>,
): Promise<number> {
  const settlements = getSettlementsCollection(database)
  const cursor = await loadCursor(database)

  let startLedger = cursor.last_ledger > 0 ? cursor.last_ledger : undefined
  if (!startLedger) {
    const latest = await withRetry("getLatestLedger", () => client.getLatestLedger())
    const latestSequence = Number(latest?.sequence)
    startLedger = Number.isFinite(latestSequence) && latestSequence > 0
      ? Math.max(1, Math.floor(latestSequence) - 100)
      : 1
  }

  const response = await withRetry("getEvents", () =>
    client.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [treasuryContractId] }],
      limit: EVENT_LIMIT,
      ...(cursor.paging_token ? { cursor: cursor.paging_token } : {}),
    }),
  )

  const events = Array.isArray(response?.events) ? response.events : []
  if (events.length === 0) {
    // Nothing to do; still advance the ledger cursor if the RPC reported one.
    const emptyLedger = Number(response?.latestLedger)
    if (Number.isFinite(emptyLedger) && emptyLedger > cursor.last_ledger) {
      await saveCursor(database, cursor.paging_token, Math.floor(emptyLedger))
    }
    indexerLedgerLag.set({ indexer: "treasury" }, 0)
    return 0
  }

  // Collect the set of already-processed event IDs stored in the cursor document
  // so we can skip duplicates that appear when replaying an overlapping window
  // after a reorg or an indexer restart that resumed from an earlier ledger.
  // The set is bounded to keep memory usage constant.
  const processedIds: Set<string> = loadProcessedEventIds(cursor)

  let processed = 0
  let lastPagingToken = cursor.paging_token
  const newEventIds: string[] = []
  const pendingWrites: PendingWrite[] = []

    const eventType = topicSymbol(event.topic, 0)
    const txHash = typeof event.txHash === "string" ? event.txHash : ""
    const pagingToken =
      typeof event.pagingToken === "string" && event.pagingToken.length > 0
        ? event.pagingToken
        : undefined

    if (pagingToken) {
      if (seenPagingTokens.has(pagingToken)) {
        logger.debug({ pagingToken }, "Skipping duplicate paging token in batch")
        continue
      }
      seenPagingTokens.add(pagingToken)
      lastPagingToken = pagingToken
    }

    if (
      eventType !== "settlement_proposed" &&
      eventType !== "settlement_approved" &&
      eventType !== "settlement_executed"
    ) {
      continue
    }

    const rawSettlementId = valueU64(event.value, 0)
    const settlementId = Number(rawSettlementId)
    if (!Number.isFinite(settlementId) || settlementId < 0) {
      logger.warn(
        { eventType, txHash, pagingToken },
        "Skipping treasury event with invalid settlement id",
      )
      continue
    }

    const eventId = buildEventId(pagingToken, txHash, eventType, settlementId)

    // De-duplicate: skip events we have already applied (reorg / replay protection)
    if (processedIds.has(eventId)) {
      logger.debug({ eventId }, "Skipping duplicate treasury event")
      continue
    }

    if (eventType === "settlement_proposed") {
      const token = valueAddress(event.value, 1)
      const amount = valueU64(event.value, 2)
      const merchant = valueAddress(event.value, 3)
      pendingWrites.push(() =>
        processSettlementProposed(settlements, settlementId, token, amount, merchant, txHash),
      )

      // Dispatch signed webhook for settlement_proposed
      const webhookUrl = process.env.WEBHOOK_URL
      if (webhookUrl) {
        dispatchWebhook(webhookUrl, {
          event: "settlement_proposed",
          settlement_id: settlementId,
          merchant_address: merchant,
          amount: amount.toString(),
          token,
          tx_hash: txHash,
        }, undefined, fetch, { eventId }).catch((err: unknown) => {
          logger.error({ errorName: err instanceof Error ? err.name : "UnknownError", eventType: "settlement_proposed" }, "Treasury webhook dispatch failed")
        })
      }
    } else if (eventType === "settlement_approved") {
      const signer = valueAddress(event.value, 1)
      const newWeight = valueU64(event.value, 3)
      pendingWrites.push(() =>
        processSettlementApproved(settlements, settlementId, signer, newWeight),
      )

      // Dispatch signed webhook for settlement_approved
      const webhookUrl = process.env.WEBHOOK_URL
      if (webhookUrl) {
        dispatchWebhook(webhookUrl, {
          event: "settlement_approved",
          settlement_id: settlementId,
          signer,
          approval_weight: newWeight.toString(),
          tx_hash: txHash,
        }, undefined, fetch, { eventId }).catch((err: unknown) => {
          logger.error({ errorName: err instanceof Error ? err.name : "UnknownError", eventType: "settlement_approved" }, "Treasury webhook dispatch failed")
        })
      }
    } else if (eventType === "settlement_executed") {
      pendingWrites.push(() =>
        processSettlementExecuted(settlements, settlementId, txHash),
      )

      // Treasury balances changed on-chain; drop the cached copy so the next
      // GET /api/treasury/balances reads fresh data instead of waiting for TTL.
      invalidateBalanceCache(`settlement_executed id=${settlementId} tx=${txHash}`)

      // Dispatch signed webhook for settlement_executed.
      // IMPORTANT: read the status from the DB record we just wrote so the
      // webhook always reflects the current, authoritative status ("Executed")
      // and never carries a stale in-memory value from before the DB update.
      const webhookUrl = process.env.WEBHOOK_URL
      if (webhookUrl) {
        // Defer the read until after the write is flushed so the webhook always
        // reflects the authoritative post-write state.
        pendingWrites.push(async () => {
          const updatedRecord = await settlements.findOne({ id: settlementId })
          dispatchWebhook(webhookUrl, {
            event: "settlement_executed",
            settlement_id: settlementId,
            status: updatedRecord?.status ?? "Executed",
            merchant_address: updatedRecord?.merchant_address ?? "",
            amount: updatedRecord?.amount ?? "0",
            token: updatedRecord?.token ?? "",
            tx_hash: txHash,
          }, undefined, fetch, { eventId }).catch((err: unknown) => {
            logger.error({ errorName: err instanceof Error ? err.name : "UnknownError", eventType: "settlement_executed" }, "Treasury webhook dispatch failed")
          })
        })
      }
    } catch (err) {
      // A single malformed event must not abort the whole batch. Log and move
      // on; the cursor is not advanced past this event's paging token so it
      // will be retried on the next tick.
      logger.error(
        {
          errorName: err instanceof Error ? err.name : "UnknownError",
          eventType,
          settlementId,
          eventId,
        },
        "Treasury indexer failed to process event",
      )
      continue
    }

    processedIds.add(eventId)
    newEventIds.push(eventId)
    processed++
  }

  // Flush all buffered writes in bounded chunks before advancing the cursor so
  // a crash mid-batch never leaves the cursor ahead of the persisted state.
  if (pendingWrites.length > 0) {
    await flushWrites(pendingWrites)
  }

  const lastLedger = response.latestLedger ?? cursor.last_ledger
  await saveCursor(database, lastPagingToken, lastLedger, newEventIds)
  indexerLedgerLag.set(
    { indexer: "treasury" },
    Math.max(0, lastLedger - cursor.last_ledger),
  )

  if (processed > 0) {
    logger.info({ processed, cursorLedger: lastLedger }, "Treasury indexer batch processed")
  }

  return processed
}

let indexerTimer: ReturnType<typeof setInterval> | null = null

export function startTreasuryIndexer(): void {
  if (indexerTimer) return

  const rpcUrl = process.env.SOROBAN_RPC_URL
  const treasuryContractId = process.env.TREASURY_CONTRACT_ID

  if (!rpcUrl || !treasuryContractId) {
    logger.warn("Treasury indexer skipped; RPC URL and contract ID are required")
    return
  }

  const client = buildSorobanClient(rpcUrl)
  let indexesEnsured = false

  // Prevent overlapping ticks under high load: if a batch is still running,
  // skip the next interval rather than stacking concurrent batches that race
  // on the cursor document.
  let inFlight = false

  const tick = async () => {
    const startedAt = Date.now()
    try {
      const database = await connectMongo()
      if (!indexesEnsured) {
        await ensureSettlementIndexes(database)
        indexesEnsured = true
      }
      await processIndexerBatch(client, treasuryContractId, database)
    } catch (err) {
      logger.error({ errorName: err instanceof Error ? err.name : "UnknownError" }, "Treasury indexer failed")
    } finally {
      indexerLedgerLag.set({ indexer: "treasury" }, indexerLedgerLag.get({ indexer: "treasury" }) ?? 0)
      logger.debug({ durationMs: Date.now() - startedAt }, "Treasury indexer tick completed")
    }
  }

  void tick()
  indexerTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  logger.info("Treasury indexer started")
}

export function stopTreasuryIndexer(): void {
  if (indexerTimer) {
    clearInterval(indexerTimer)
    indexerTimer = null
  }
}
