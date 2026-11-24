import { SorobanRpc, xdr } from "stellar-sdk"
import { buildSorobanClient, type SorobanClient } from "../lib/soroban.js"
import { connectMongo, getCursorsCollection, getComplianceAuditCollection, type ComplianceAuditRecord, type ComplianceAuditStatus } from "../db/mongo.js"
import { indexerLedgerLag, indexerBatchLatency } from "../lib/metrics.js"
import { logger } from "../lib/logger.js"
import { complianceStatusForEvent, tryParseEvent } from "../lib/compliance-guards.js"

const CURSOR_ID = "compliance_audit_events"
const EVENT_LIMIT = 100
const POLL_INTERVAL_MS = 5_000
const EVENT_TYPES = new Set(["address_allowed", "address_allowed_until", "address_blocked", "address_cleared"])
// Bound the in-memory dedupe set so long-running indexers do not grow unbounded.
const MAX_SEEN_EVENT_IDS = 1_000
// Flush pending writes in chunks to bound memory and DB round-trips per batch.
const WRITE_BATCH_SIZE = 50
type ComplianceRpcEvent = Awaited<ReturnType<SorobanRpc.Server["getEvents"]>>["events"][number]

/**
 * Bounded insertion-ordered set: keeps at most `max` entries, evicting the
 * oldest inserted IDs first. Prevents unbounded memory growth of the dedupe set.
 */
class BoundedIdSet {
  private readonly ids = new Set<string>()
  constructor(private readonly max: number) {}

  has(id: string): boolean {
    return this.ids.has(id)
  }

  add(id: string): void {
    if (this.ids.has(id)) return
    this.ids.add(id)
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
  }

  toArray(): string[] {
    return [...this.ids]
  }
}

function symbol(topic: xdr.ScVal[] | undefined, index: number): string {
  try {
    return topic?.[index]?.sym()?.toString() ?? ""
  } catch {
    return ""
  }
}

function address(value: xdr.ScVal | undefined): string {
  try {
    return value?.address()?.toString() ?? ""
  } catch {
    return ""
  }
}

function eventAddress(event: ComplianceRpcEvent, eventType: string): string {
  try {
    return address(eventType === "address_cleared" || eventType === "address_allowed_until"
      ? event.value?.vec()?.[0]
      : event.value)
  } catch {
    return ""
  }
}

function eventExpiry(event: ComplianceRpcEvent, eventType: string): number | null {
  if (eventType !== "address_allowed_until") return null
  try {
    const raw = event.value?.vec()?.[1]?.u64()?.toString()
    if (raw === undefined) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export function complianceEventId(event: ComplianceRpcEvent, eventType: string, addressValue: string): string {
  return event.pagingToken ?? `${event.txHash ?? ""}:${eventType}:${addressValue}`
}

async function loadCursor(database: Awaited<ReturnType<typeof connectMongo>>) {
  try {
    return (await getCursorsCollection(database).findOne({ _id: CURSOR_ID })) ?? {
      _id: CURSOR_ID, paging_token: null, last_ledger: 0, updated_at: new Date(), processed_event_ids: [],
    }
  } catch (err) {
    logger.error({ errorName: err instanceof Error ? err.name : "UnknownError" }, "Failed to load compliance cursor")
    throw err
  }
}

let indexesEnsured = false
async function ensureIndexes(database: Awaited<ReturnType<typeof connectMongo>>): Promise<void> {
  if (indexesEnsured) return
  try {
    await getComplianceAuditCollection(database).createIndexes([
      { key: { event_id: 1 }, name: "event_id_unique", unique: true },
      { key: { address: 1, created_at: -1 }, name: "address_created_at" },
      { key: { ledger: 1 }, name: "ledger" },
    ])
    indexesEnsured = true
  } catch (err) {
    // Index creation is best-effort; log and continue so indexing is not blocked.
    logger.warn({ errorName: err instanceof Error ? err.name : "UnknownError" }, "Failed to ensure compliance audit indexes")
  }
}

export async function processComplianceIndexerBatch(
  client: SorobanClient,
  contractId: string,
  database: Awaited<ReturnType<typeof connectMongo>>,
): Promise<number> {
  const startedAt = Date.now()
  await ensureIndexes(database)
  const cursor = await loadCursor(database)
  const seen = new BoundedIdSet(MAX_SEEN_EVENT_IDS)
  for (const id of cursor.processed_event_ids ?? []) seen.add(id)
  const startLedger = cursor.last_ledger > 0 ? cursor.last_ledger : undefined
  const response = await client.getEvents({
    startLedger,
    ...(cursor.paging_token ? { cursor: cursor.paging_token } : {}),
    filters: [{ type: "contract", contractIds: [contractId] }],
    limit: EVENT_LIMIT,
  })
  const collection = getComplianceAuditCollection(database)
  const newIds: string[] = []
  let processed = 0
  let lastToken = cursor.paging_token
  let pending: ComplianceAuditRecord[] = []

  const flush = async () => {
    if (!pending.length) return
    const batch = pending
    pending = []
    try {
      const ops = batch.map((record) => ({
        updateOne: { filter: { event_id: record.event_id }, update: { $setOnInsert: record }, upsert: true },
      }))
      await collection.bulkWrite(ops, { ordered: false })
    } catch (err) {
      // Bulk write failures (e.g. duplicate key races) must not abort the whole batch.
      logger.warn({ errorName: err instanceof Error ? err.name : "UnknownError", count: batch.length }, "Compliance audit bulk write partially failed")
    }
  }

  for (const event of response.events ?? []) {
    // Advance the cursor for every event we observe, even ones we skip, so a
    // malformed or unknown event can never wedge the indexer in a retry loop.
    lastToken = event.pagingToken ?? lastToken
    const eventType = symbol(event.topic, 0)
    if (!EVENT_TYPES.has(eventType)) continue
    const parsed = tryParseEvent(event, (e) => ({
      addressValue: eventAddress(e, eventType), status: complianceStatusForEvent(eventType), expiresAt: eventExpiry(e, eventType),
    }))
    if (!parsed || !parsed.addressValue) {
      logger.warn({ eventType, pagingToken: event.pagingToken }, "Skipping malformed compliance event")
      continue
    }
    const { addressValue } = parsed
    const id = complianceEventId(event, eventType, addressValue)
    if (seen.has(id)) continue
    const record: ComplianceAuditRecord = {
      event_id: id,
      event_type: eventType as ComplianceAuditRecord["event_type"],
      address: addressValue,
      status: parsed.status,
      expires_at: parsed.expiresAt,
      ledger: event.ledger ?? 0,
      ledger_closed_at: event.ledgerClosedAt ?? null,
      transaction_hash: event.txHash ?? "",
      contract_id: contractId,
      paging_token: event.pagingToken ?? null,
      created_at: new Date(),
    }
    pending.push(record)
    seen.add(id)
    newIds.push(id)
    processed++
    if (pending.length >= WRITE_BATCH_SIZE) await flush()
  }
  await flush()

  const latestLedger = Number.isFinite(response.latestLedger) && (response.latestLedger ?? 0) > 0
    ? (response.latestLedger as number)
    : cursor.last_ledger
  await getCursorsCollection(database).updateOne(
    { _id: CURSOR_ID },
    {
      $set: { paging_token: lastToken, last_ledger: response.latestLedger ?? cursor.last_ledger, updated_at: new Date() },
      ...(newIds.length ? { $push: { processed_event_ids: { $each: newIds, $slice: -MAX_SEEN_EVENT_IDS } } } : {}),
    },
    { upsert: true },
  )
  indexerLedgerLag.set(
    { indexer: "compliance" },
    Math.max(0, latestLedger - (response.events?.at(-1)?.ledger ?? latestLedger)),
  )
  indexerBatchLatency.observe({ indexer: "compliance" }, Date.now() - startedAt)
  return processed
}

let timer: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
export function startComplianceIndexer(): void {
  if (timer) return
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const contractId = process.env.COMPLIANCE_CONTRACT_ID
  if (!rpcUrl || !contractId) return
  const client = buildSorobanClient(rpcUrl)
  const tick = async () => {
    // Skip overlapping polls: a slow batch must not stack concurrent DB work.
    if (tickInFlight) return
    tickInFlight = true
    try {
      const database = await connectMongo()
      await processComplianceIndexerBatch(client, contractId, database)
    } catch (err) {
      logger.error(
        { errorName: err instanceof Error ? err.name : "UnknownError", errorMessage: err instanceof Error ? err.message : String(err) },
        "Compliance indexer failed",
      )
    } finally { tickInFlight = false }
  }
  void tick()
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
}
export function stopComplianceIndexer(): void {
  if (timer) { clearInterval(timer); timer = null }
}
