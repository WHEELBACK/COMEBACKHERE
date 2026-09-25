import { createHash } from "node:crypto"
import { type Request, type Response, type NextFunction } from "express"
import { cacheGet, cacheReleaseLock, cacheSet, cacheTryLock } from "../lib/cache.js"
import { ConflictError } from "../lib/errors.js"

const TTL_SECONDS = 24 * 60 * 60
const memory = new Map<string, { fingerprint: string; response: StoredResponse; expiresAt: number }>()
const inFlight = new Map<string, Promise<void>>()

type StoredResponse = { status: number; body: unknown }

function fingerprint(req: Request): string {
  return createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex")
}

export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST" || req.path !== "/") {
    next()
    return
  }
  const idempotencyKey = req.header("Idempotency-Key")?.trim()
  if (!idempotencyKey) {
    next()
    return
  }

  const key = `idempotency:invoice:${idempotencyKey}`
  const requestFingerprint = fingerprint(req)
  const cached = memory.get(key)
  const load = cached && cached.expiresAt > Date.now()
    ? Promise.resolve({ fingerprint: cached.fingerprint, response: cached.response })
    : cacheGet<{ fingerprint: string; response: StoredResponse }>(key)

  load.then(async (entry) => {
    if (entry) {
      if (entry.fingerprint !== requestFingerprint) {
        throw new ConflictError("Idempotency-Key was already used with a different request body")
      }
      res.status(entry.response.status).json(entry.response.body)
      return
    }

    const previous = inFlight.get(key)
    if (previous) {
      await previous
      const completed = memory.get(key)
      if (completed && completed.fingerprint === requestFingerprint) {
        res.status(completed.response.status).json(completed.response.body)
        return
      }
      if (completed) {
        throw new ConflictError("Idempotency-Key was already used with a different request body")
      }
    }

    const lockKey = `${key}:lock`
    if (!(await cacheTryLock(lockKey, 5_000))) {
      const waitForOwner = inFlight.get(key)
      if (waitForOwner) await waitForOwner
      const completed = memory.get(key)
      if (completed?.fingerprint === requestFingerprint) {
        res.status(completed.response.status).json(completed.response.body)
        return
      }
      if (completed) throw new ConflictError("Idempotency-Key was already used with a different request body")
      throw new ConflictError("A request with this Idempotency-Key is already in progress")
    }

    let resolveFlight!: () => void
    const flight = new Promise<void>((resolve) => { resolveFlight = resolve })
    inFlight.set(key, flight)
    const json = res.json.bind(res)
    res.json = ((body: unknown) => {
      const response = { status: res.statusCode, body }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        memory.set(key, { fingerprint: requestFingerprint, response, expiresAt: Date.now() + TTL_SECONDS * 1000 })
        void cacheSet(key, { fingerprint: requestFingerprint, response }, TTL_SECONDS)
      }
      resolveFlight()
      inFlight.delete(key)
      void cacheReleaseLock(lockKey)
      return json(body)
    }) as Response["json"]
    next()
  }).catch(next)
}