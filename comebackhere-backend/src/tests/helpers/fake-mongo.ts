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

export class FakeDb {
  collections = new Map<string, FakeCollection>()

  collection(name: string): FakeCollection {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(name))
    return this.collections.get(name)!
  }
}
