import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { idempotencyMiddleware } from "../middleware/idempotency.js"

function mkRes() {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; json: (b: unknown) => unknown; status: (n: number) => unknown }
  res.statusCode = 201
  res.json = (b) => b
  res.status = () => res
  return res
}
function mkReq(key: string) {
  return { method: "POST", path: "/", body: { a: 1 }, header: () => key } as never
}

describe("idempotency in-flight release", () => {
  it("lets a second request proceed after the first connection closes without res.json", async () => {
    const res1 = mkRes()
    await new Promise<void>((resolve) => idempotencyMiddleware(mkReq("k-release"), res1 as never, () => resolve()))
    res1.emit("close")
    const res2 = mkRes()
    let reached = false
    await new Promise<void>((resolve) => idempotencyMiddleware(mkReq("k-release"), res2 as never, () => { reached = true; resolve() }))
    expect(reached).toBe(true)
  })
})
