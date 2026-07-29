import { MongoClient, type Db, type Collection } from "mongodb"

export interface SettlementRecord {
  id: number
  merchant_address: string
  amount: string
  token: string
  approvals: string[]
  approval_weight: number
  status: "Pending" | "Executed" | "PartiallyExecuted" | "OnHold" | "Cancelled"
  hold_reason: string | null
  updated_at: Date
  proposed_tx_hash?: string
  executed_tx_hash?: string
}

export interface IndexerCursor {
  _id: string
  paging_token: string | null
  last_ledger: number
  updated_at: Date
}

export interface ThresholdRecord {
  _id?: string
  threshold: number
  previous_threshold?: number
  caller?: string
  tx_hash?: string
  updated_at: Date
}

export interface AuditLogRecord {
  _id?: string
  action: string
  resource: string
  caller?: string
  previous_value?: unknown
  new_value?: unknown
  tx_hash?: string
  created_at: Date
}

let client: MongoClient | null = null
let db: Db | null = null

export async function connectMongo(): Promise<Db> {
  if (db) return db

  const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017"
  const dbName = process.env.MONGODB_DB ?? "comebackhere"

  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)

  const settlements = db.collection<SettlementRecord>("settlements")
  await settlements.createIndex({ id: 1 }, { unique: true })
  await settlements.createIndex({ status: 1 })

  const cursors = db.collection<IndexerCursor>("indexer_cursors")
  await cursors.createIndex({ _id: 1 }, { unique: true })

  const thresholds = db.collection<ThresholdRecord>("thresholds")
  await thresholds.createIndex({ updated_at: -1 })

  const auditLogs = db.collection<AuditLogRecord>("audit_logs")
  await auditLogs.createIndex({ created_at: -1 })
  await auditLogs.createIndex({ action: 1, resource: 1 })

  return db
}

export function getSettlementsCollection(database: Db): Collection<SettlementRecord> {
  return database.collection<SettlementRecord>("settlements")
}

export function getCursorsCollection(database: Db): Collection<IndexerCursor> {
  return database.collection<IndexerCursor>("indexer_cursors")
}

export function getThresholdsCollection(database: Db): Collection<ThresholdRecord> {
  return database.collection<ThresholdRecord>("thresholds")
}

export function getAuditLogsCollection(database: Db): Collection<AuditLogRecord> {
  return database.collection<AuditLogRecord>("audit_logs")
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close()
    client = null
    db = null
  }
}
