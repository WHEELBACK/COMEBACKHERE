/**
 * Minimal in-memory stand-in for the Mongo collections used by the indexer.
 * Supports the operations the indexer performs (findOne, updateOne and
 * findOneAndUpdate with $set / $setOnInsert / upsert) and a unique key per
 * collection, which is enough to exercise cursor and idempotency logic.
 */

type Doc = Record<string, any>

const UNIQUE_KEYS: Record<string, string> = {
  indexer_cursors: "_id",
  invoice_events: "event_id",
  invoices: "invoice_id",
  indexer_gaps: "_id",
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v)
}

export class FakeCollection {
  docs: Doc[] = []
  /** Set to make the next matching write throw, simulating a crash. */
  failOn: ((op: string, filter: Doc) => boolean) | null = null

  constructor(readonly name: string) {}

  private maybeFail(op: string, filter: Doc) {
    if (this.failOn?.(op, filter)) throw new Error(`simulated crash during ${this.name}.${op}`)
  }

  async findOne(filter: Doc) {
    return this.docs.find((d) => matches(d, filter)) ?? null
  }

  async find(filter: Doc = {}) {
    return this.docs.filter((d) => matches(d, filter))
  }

  /**
   * Returns a cursor-like object supporting the chainable methods used by the
   * reporting engine (sort / skip / limit / toArray). Sorting is stable and
   * supports the `{ field: 1 | -1 }` form.
   */
  findCursor(filter: Doc = {}) {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)))
  }

  /**
   * Minimal aggregation pipeline support. Handles the stages the reporting
   * engine relies on: $match, $sort, $skip, $limit, $group (with $sum / $count
   * accumulators) and $project (inclusion only).
   */
  async aggregate(pipeline: Doc[] = []) {
    let rows: Doc[] = this.docs.map((d) => ({ ...d }))
    for (const stage of pipeline) {
      const [op, arg] = Object.entries(stage)[0] ?? []
      switch (op) {
        case "$match":
          rows = rows.filter((d) => matches(d, arg))
          break
        case "$sort":
          rows = sortDocs(rows, arg)
          break
        case "$skip":
          rows = rows.slice(arg)
          break
        case "$limit":
          rows = rows.slice(0, arg)
          break
        case "$group":
          rows = groupDocs(rows, arg)
          break
        case "$project":
          rows = rows.map((d) => projectDoc(d, arg))
          break
        default:
          throw new Error(`FakeCollection.aggregate: unsupported stage ${op}`)
      }
    }
    return rows
  }

  async countDocuments(filter: Doc = {}) {
    return this.docs.filter((d) => matches(d, filter)).length
  }

  async insertOne(doc: Doc) {
    const key = UNIQUE_KEYS[this.name]
    if (key && this.docs.some((d) => d[key] === doc[key])) {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
    }
    this.docs.push({ ...doc })
    return { insertedId: doc._id }
  }

  async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    this.maybeFail("updateOne", filter)
    const existing = this.docs.find((d) => matches(d, filter))
    if (existing) {
      Object.assign(existing, update.$set ?? {})
      return { matchedCount: 1, upsertedCount: 0 }
    }
    if (!options.upsert) return { matchedCount: 0, upsertedCount: 0 }
    this.docs.push({ ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) })
    return { matchedCount: 0, upsertedCount: 1 }
  }

  async findOneAndUpdate(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    this.maybeFail("findOneAndUpdate", filter)
    const existing = this.docs.find((d) => matches(d, filter))
    if (existing) {
      const before = { ...existing }
      Object.assign(existing, update.$set ?? {})
      return before
    }
    if (options.upsert) {
      this.docs.push({ ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) })
    }
    return null
  }
}

function sortDocs(rows: Doc[], spec: Doc): Doc[] {
  const entries = Object.entries(spec)
  return [...rows].sort((a, b) => {
    for (const [field, dir] of entries) {
      const av = a[field]
      const bv = b[field]
      if (av === bv) continue
      const cmp = av < bv ? -1 : 1
      return dir === -1 ? -cmp : cmp
    }
    return 0
  })
}

function groupDocs(rows: Doc[], spec: Doc): Doc[] {
  const { _id, ...accumulators } = spec
  const groups = new Map<string, Doc>()
  for (const row of rows) {
    const key = typeof _id === "string" && _id.startsWith("$") ? row[_id.slice(1)] : _id
    const mapKey = JSON.stringify(key ?? null)
    let group = groups.get(mapKey)
    if (!group) {
      group = { _id: key ?? null }
      for (const [field, acc] of Object.entries(accumulators)) {
        if (acc && typeof acc === "object" && "$sum" in acc) group[field] = 0
        else if (acc && typeof acc === "object" && "$count" in acc) group[field] = 0
      }
      groups.set(mapKey, group)
    }
    for (const [field, acc] of Object.entries(accumulators)) {
      if (acc && typeof acc === "object" && "$sum" in acc) {
        const expr = acc.$sum
        const value = typeof expr === "string" && expr.startsWith("$") ? row[expr.slice(1)] : expr
        group[field] = (group[field] ?? 0) + (typeof value === "number" ? value : 0)
      } else if (acc && typeof acc === "object" && "$count" in acc) {
        group[field] = (group[field] ?? 0) + 1
      }
    }
  }
  return [...groups.values()]
}

function projectDoc(doc: Doc, spec: Doc): Doc {
  const out: Doc = {}
  for (const [field, include] of Object.entries(spec)) {
    if (include) out[field] = doc[field]
  }
  return out
}

/** Chainable cursor stand-in mirroring the subset of the Mongo cursor API we use. */
export class FakeCursor {
  private rows: Doc[]
  private skipCount = 0
  private limitCount: number | null = null

  constructor(rows: Doc[]) {
    this.rows = rows
  }

  sort(spec: Doc) {
    this.rows = sortDocs(this.rows, spec)
    return this
  }

  skip(n: number) {
    this.skipCount = n
    return this
  }

  limit(n: number) {
    this.limitCount = n
    return this
  }

  async toArray() {
    let rows = this.rows.slice(this.skipCount)
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount)
    return rows
  }
}

export class FakeDb {
  collections = new Map<string, FakeCollection>()

  collection(name: string): FakeCollection {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(name))
    return this.collections.get(name)!
  }
}
