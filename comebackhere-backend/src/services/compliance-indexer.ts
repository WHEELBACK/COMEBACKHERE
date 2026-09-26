import { xdr } from "stellar-sdk"
import { buildSorobanClient, type SorobanClient } from "../lib/soroban.js"
import { connectMongo, getCursorsCollection, getComplianceAuditCollection, type ComplianceAuditRecord, type ComplianceAuditStatus } from "../db/mongo.js"

const CURSOR_ID = "compliance_audit_events"
const EVENT_LIMIT = 100
const POLL_INTERVAL_MS = 5_000
const EVENT_TYPES = new Set(["address_allowed", "address_allowed_until", "address_blocked", "address_cleared"])

function symbol(topic: xdr.ScVal[] | undefined, index: number): string {
  return topic?.[index]?.sym()?.toString() ?? ""
}

function address(value: xdr.ScVal | undefined): string {
  return value?.address()?.toString() ?? ""
}

function status(value: xdr.ScVal | undefined): string {
  try { return value?.sym()?.toString() ?? "" }
  catch { return "" }
}

function values(event: any): xdr.ScVal[] | undefined {
  try { return event.value?.vec() }
  catch { return undefined }
}

function isU64(value: xdr.ScVal | undefined): boolean {
  try { return value?.u64() !== undefined }
  catch { return false }
}

function eventAddress(event: any, eventType: string): string {
  const payload = values(event)
  return address(payload?.[0] ?? event.value)
}

function eventStatus(event: any, eventType: string): ComplianceAuditStatus {
  const payload = values(event)
  const emittedStatus = status(payload?.[1])
  if (emittedStatus === "Allowed" || emittedStatus === "AllowedUntil" || emittedStatus === "Blocked" || emittedStatus === "Cleared") {
    return emittedStatus
  }
  if (isU64(payload?.[1])) return "AllowedUntil"
  if (eventType === "address_allowed_until") return "AllowedUntil"
  if (eventType === "address_blocked") return "Blocked"
  if (eventType === "address_cleared") return "Cleared"
  return "Allowed"
}

function eventExpiry(event: any, eventType: string): number | null {
  const payload = values(event)
  const expiry = status(payload?.[1]) ? payload?.[2] : payload?.[1]
  if (eventType !== "address_allowed_until" && !isU64(expiry)) return null
  if (!isU64(expiry)) return null
  return Number(expiry?.u64().toString()) || null
}

export function complianceEventId(event: any, eventType: string, addressValue: string): string {
  return event.pagingToken ?? `${event.txHash ?? ""}:${eventType}:${addressValue}`
}

async function loadCursor(database: Awaited<ReturnType<typeof connectMongo>>) {
  return (await getCursorsCollection(database).findOne({ _id: CURSOR_ID })) ?? {
    _id: CURSOR_ID, paging_token: null, last_ledger: 0, updated_at: new Date(), processed_event_ids: [],
  }
}

export async function processComplianceIndexerBatch(
  client: SorobanClient,
  contractId: string,
  database: Awaited<ReturnType<typeof connectMongo>>,
): Promise<number> {
  const cursor = await loadCursor(database)
  const seen = new Set(cursor.processed_event_ids ?? [])
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

  for (const event of response.events ?? []) {
    const eventType = symbol(event.topic, 0)
    if (!EVENT_TYPES.has(eventType)) continue
    const addressValue = eventAddress(event, eventType)
    const id = complianceEventId(event, eventType, addressValue)
    lastToken = event.pagingToken ?? lastToken
    if (seen.has(id)) continue
    const record: ComplianceAuditRecord = {
      event_id: id,
      event_type: eventType as ComplianceAuditRecord["event_type"],
      address: addressValue,
      status: eventStatus(event, eventType),
      expires_at: eventExpiry(event, eventType),
      ledger: event.ledger ?? 0,
      ledger_closed_at: event.ledgerClosedAt ?? null,
      transaction_hash: event.txHash ?? "",
      contract_id: contractId,
      paging_token: event.pagingToken ?? null,
      created_at: new Date(),
    }
    await collection.updateOne({ event_id: id }, { $setOnInsert: record }, { upsert: true })
    seen.add(id)
    newIds.push(id)
    processed++
  }

  await getCursorsCollection(database).updateOne(
    { _id: CURSOR_ID },
    {
      $set: { paging_token: lastToken, last_ledger: response.latestLedger ?? cursor.last_ledger, updated_at: new Date() },
      ...(newIds.length ? { $push: { processed_event_ids: { $each: newIds, $slice: -1000 } } } : {}),
    } as any,
    { upsert: true },
  )
  return processed
}

let timer: ReturnType<typeof setInterval> | null = null
export function startComplianceIndexer(): void {
  if (timer) return
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const contractId = process.env.COMPLIANCE_CONTRACT_ID
  if (!rpcUrl || !contractId) return
  const client = buildSorobanClient(rpcUrl)
  const tick = async () => {
    try { await processComplianceIndexerBatch(client, contractId, await connectMongo()) }
    catch (err) { console.error("[compliance-indexer] error:", err instanceof Error ? err.message : err) }
  }
  void tick()
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
}
export function stopComplianceIndexer(): void {
  if (timer) { clearInterval(timer); timer = null }
}
