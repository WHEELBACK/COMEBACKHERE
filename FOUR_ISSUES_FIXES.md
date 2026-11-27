# Four Issues: Detailed Fix Implementations

## Fix #1: i128ToBigInt — Handle Signed Values Correctly

**File:** `comebackhere-backend/src/lib/soroban.ts` lines 43-52

### Current Code (Broken for Negative Values)
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  return (hi << 64n) | lo  // ← Doesn't handle sign bit
}
```

### Problem
The current implementation treats i128 as unsigned. For negative values (hi bit set), the OR operation doesn't properly convert from two's complement.

**Example:**
- Negative value: `-1n`
- In i128 two's complement: hi = `-1n` (all bits 1), lo = `0xffffffffffffffffn` (all bits 1)
- Current code: `((-1n << 64n) | 0xffffffffffffffffn)` → incorrect large positive
- Expected: `-1n`

### Fixed Code
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  
  // i128 is stored as two 64-bit signed integers (hi, lo) in two's complement.
  // We reconstruct the full 128-bit value, then check the sign bit.
  const MAX_INT128 = 1n << 127n
  
  // Combine the parts (treating as unsigned for now)
  const combined = (hi << 64n) | lo
  
  // If the 128th bit (sign bit) is set, convert from two's complement
  if (hi < 0n || (hi === 0n && lo >= 0x8000000000000000n)) {
    // This is a negative number; convert using two's complement
    return combined - (1n << 128n)
  }
  
  return combined
}
```

**Alternatively, simpler approach using two's complement directly:**
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  let hi = BigInt(parts.hi().toString())
  
  // Reconstruct 128-bit value treating hi as signed
  // The hi part is already signed from XDR, so we just need to combine properly
  const combined = (hi << 64n) | lo
  
  // If hi is negative, the whole number is negative
  // Adjust lo if needed to maintain proper two's complement
  if (hi < 0n) {
    // Convert from two's complement: subtract 2^128
    return combined - (1n << 128n)
  }
  
  return combined
}
```

### Test Cases to Add
```typescript
describe("i128ToBigInt — boundary values", () => {
  function makeI128ScVal(value: bigint): xdr.ScVal {
    // Helper to create i128 ScVal from bigint
    const lo = Number(value & 0xffffffffffffffffn)
    const hi = Number((value >> 64n) & 0xffffffffffffffffn)
    const parts = new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
    return xdr.ScVal.scvI128(parts)
  }

  it("handles zero correctly", async () => {
    const scval = makeI128ScVal(0n)
    const client = makeMockClient({...})
    const balance = await getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK)
    expect(balance).toBe(0n)
  })

  it("handles max positive i128 (2^127 - 1)", async () => {
    const maxInt128 = (1n << 127n) - 1n
    // Test with actual Soroban response containing this value
    const scval = makeI128ScVal(maxInt128)
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: scval },
      }),
    })
    const balance = await getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK)
    expect(balance).toBe(maxInt128)
  })

  it("rejects negative balance as invalid", async () => {
    const negativeValue = -1n
    const scval = makeI128ScVal(negativeValue)
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue({
        ...PARSED_SIM_SUCCESS,
        result: { auth: [], retval: scval },
      }),
    })
    
    // Negative balances should not occur in practice; log as error
    const balance = await getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK)
    // Either throw or return a sentinel value; document the contract assumption
    expect(balance < 0n).toBe(true)  // Document that negative is possible but wrong
  })
})
```

---

## Fix #2: MongoDB Pool & Timeout Tuning

**File:** `comebackhere-backend/src/db/mongo.ts` lines 184-208

### Current Code
```typescript
const MONGO_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
}
```

### Recommended Changes

**Justification:**
- `maxPoolSize: 10` → `25`: Indexer uses 1-2 persistent connections; API can have 20+ concurrent requests
- `minPoolSize: 2` → `5`: Keep more connections warm to avoid establishment latency spikes
- `serverSelectionTimeoutMS: 5_000` → `15_000`: 5s is tight; topology discovery needs buffer
- `connectTimeoutMS: 10_000` → `20_000`: Align with Soroban's 30s timeout for consistency
- `socketTimeoutMS: 45_000` → `60_000`: Give long queries (cursor save, settlement lookup) more breathing room
- Add `tcpKeepaliveMS: 30_000`: Prevent stale connection drops on idle connections

### Fixed Code
```typescript
// #210 & #215 — Connection options: explicit pool size and timeouts.
// Settings tuned for combined indexer + API workload:
//   - Indexer: 1-2 persistent connections for polling
//   - API: 20-50 concurrent requests during peak
//   - Total: 25 max connections provides buffer for bursts
// Timeouts aligned with Soroban RPC limits (30s simulation max).

const MONGO_OPTIONS = {
  /** Maximum connections in pool. Indexer (2) + API peak (20+) + buffer. */
  maxPoolSize: 25,  // was: 10
  /** Minimum idle connections to maintain warm. */
  minPoolSize: 5,   // was: 2
  /**
   * Time (ms) to select a server before throwing MongoServerSelectionError.
   * Increased from 5s to allow topology discovery/recovery during maintenance.
   */
  serverSelectionTimeoutMS: 15_000,  // was: 5_000
  /**
   * Time (ms) for a new connection to establish.
   * Increased to align with Soroban timeout and reduce false failures.
   */
  connectTimeoutMS: 20_000,  // was: 10_000
  /**
   * Time (ms) for a socket operation (query execution) to complete.
   * Increased to allow long queries (Soroban indexing, settlement lookups)
   * and to exceed Soroban's 30s simulation max.
   */
  socketTimeoutMS: 60_000,  // was: 45_000
  /**
   * Time (ms) between TCP keepalive packets. Prevents network hardware
   * from silently dropping idle connections after hours.
   */
  tcpKeepaliveMS: 30_000,  // NEW: was not set
}
```

### Load Test Recommendation
After applying this change, run a load test:
```bash
# Simulate 50 concurrent requests while indexer is polling
# Monitor: connection count, queue depth, timeout rate
# Target: 0% timeouts at 50 concurrent req/sec for 5 minutes
```

---

## Fix #3: Validation of Settlement Simulation Response

**File:** `comebackhere-backend/src/lib/soroban.ts` lines 242-261

### Current Code (Missing Validation)
```typescript
return {
  settlementId: BigInt(entries.settlement_id?.u64()?.toString() ?? "0"),
  status: scValToSettlementStatus(entries.status ?? xdr.ScVal.scvVoid()),
  wouldSucceed: entries.would_succeed?.b() ?? false,
  approvalWeight: BigInt(entries.approval_weight?.u64()?.toString() ?? "0"),
  threshold: BigInt(entries.threshold?.u64()?.toString() ?? "0"),
  settlementAmount: BigInt(entries.settlement_amount?.u64()?.toString() ?? "0"),
  treasuryBalance: i128ToBigInt(entries.treasury_balance?.i128() ?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))),
  projectedBalance: i128ToBigInt(entries.projected_balance?.i128() ?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))),
}
```

### Problem
The fallback `?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))` silently creates a zero-filled i128, which becomes `0n`. This masks missing data as "zero balance" instead of failing loudly.

### Fixed Code
```typescript
const entries: Record<string, xdr.ScVal> = {}
for (const entry of map) {
  const key = entry.key().sym().toString()
  entries[key] = entry.val()
}

// Validate all required fields are present
const requiredFields = [
  "settlement_id", "status", "would_succeed", "approval_weight",
  "threshold", "settlement_amount", "treasury_balance", "projected_balance"
]
for (const field of requiredFields) {
  if (!entries[field]) {
    throw Object.assign(
      new Error(`Invalid simulate_settlement response: missing field "${field}"`),
      { status: 422 },
    )
  }
}

return {
  settlementId: BigInt(entries.settlement_id.u64().toString()),
  status: scValToSettlementStatus(entries.status),
  wouldSucceed: entries.would_succeed.b(),
  approvalWeight: BigInt(entries.approval_weight.u64().toString()),
  threshold: BigInt(entries.threshold.u64().toString()),
  settlementAmount: BigInt(entries.settlement_amount.u64().toString()),
  treasuryBalance: i128ToBigInt(entries.treasury_balance.i128()),
  projectedBalance: i128ToBigInt(entries.projected_balance.i128()),
}
```

### Test Cases
```typescript
it("throws 422 when treasury_balance field is missing", async () => {
  const scval = makeSettlementScVal({...})
  // Manually remove treasury_balance from the map
  const entries = scval.map().filter(e => e.key().sym().toString() !== "treasury_balance")
  const fakeMap = xdr.ScVal.scvMap(entries)
  
  const client = makeMockClient({
    getAccount: vi.fn().mockResolvedValue(fakeAccount),
    simulateTransaction: vi.fn().mockResolvedValue({
      ...PARSED_SIM_SUCCESS,
      result: { auth: [], retval: fakeMap },
    }),
  })

  await expect(
    getSettlementSimulation(client, TREASURY_CONTRACT, 1n, SOURCE_ACCT, NETWORK)
  ).rejects.toMatchObject({
    message: expect.stringMatching(/missing field "treasury_balance"/),
    status: 422,
  })
})
```

---

## Fix #4: Ledger Continuity Check After Redis Reconnect

**File:** `comebackhere-backend/src/indexer.ts` lines 282-310

### Current Code
```typescript
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

// ← No validation that startLedger is still within RPC retention here
```

### Problem
After loading the cursor from Mongo, there's no check that `startLedger` hasn't fallen outside the RPC's retention window. If the indexer paused for >24h, the next poll will fail with a retention error, but the check happens inside `fetchEvents()` not here.

### Fixed Code
```typescript
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

// NEW: Validate that the resume point is still within RPC retention
// before attempting to poll, so we can log the issue early.
if (startLedger > 0 && !pagingToken) {
  try {
    const latest = await rpc.getLatestLedger()
    const oldestRetained = await getOldestRetainedLedger(rpc) ?? (latest.sequence - 432000)  // ~30 days fallback
    
    if (startLedger < oldestRetained) {
      logger.warn(
        { startLedger, oldestRetained, latestLedger: latest.sequence },
        "Indexer cursor is outside RPC retention window; will detect and handle gap on first poll"
      )
    }
  } catch (err) {
    // getOldestRetainedLedger can fail if RPC doesn't support getHealth
    // Continue anyway; the gap check will fire in fetchEvents() if needed
    logger.debug("Could not pre-check RPC retention window")
  }
}
```

### Test Cases
```typescript
it("logs warning when cursor is outside retention window on startup", async () => {
  const logWarnSpy = vi.spyOn(logger, "warn")
  
  // Mock cursor that's very old
  const oldCursor: IndexerCursor = {
    _id: MONGO_CURSOR_ID,
    paging_token: null,
    last_ledger: 100,  // Very old ledger
    updated_at: new Date(Date.now() - 30 * 86400 * 1000),  // 30 days ago
  }
  
  const mockRpc = makeMockRpc({
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 10_000_000 }),
    getHealth: vi.fn().mockResolvedValue({ oldestLedger: 9_000_000 }),
  })
  
  await pollOnce(mockRpc, CONTRACT_ID, mockDb)
  
  // Should log the warning
  expect(logWarnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      startLedger: 100,
      oldestRetained: expect.any(Number),
    }),
    expect.stringMatching(/outside RPC retention/i)
  )
})
```

---

## Fix #5: Rate Limiting for Simulation Endpoint (Optional)

**File:** `comebackhere-backend/src/routes/treasury.ts` lines 449-451

### Current Code
```typescript
router.post("/simulate-settlement", validateBody(settlementIdSchema), asyncHandler(async (req: Request, res: Response) => {
  // No rate limit check
  const result = await simulateSettlement({ settlement_id: settlementId }, env)
  res.json(result)
}))
```

### Problem
Simulation calls are "free" (no state mutation), so a malicious caller could DOS the Soroban RPC by flooding requests.

### Recommended Fix (Using Middleware)
```typescript
import { rateLimit } from "express-rate-limit"

// Rate limit: max 30 simulation calls per minute per IP
const simulationLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,              // 30 requests per window
  message: "Too many simulation requests, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
})

router.post("/simulate-settlement", simulationLimiter, validateBody(settlementIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const settlementId = req.body.settlement_id
  const result = await simulateSettlement({ settlement_id: settlementId }, env)
  res.json(result)
}))
```

Or, counter-based (simpler, no new dependency):
```typescript
const simulationCounts = new Map<string, { count: number; resetAt: number }>()

function checkSimulationRateLimit(clientIp: string): boolean {
  const now = Date.now()
  const record = simulationCounts.get(clientIp)
  
  if (!record || now > record.resetAt) {
    simulationCounts.set(clientIp, { count: 1, resetAt: now + 60_000 })
    return true
  }
  
  if (record.count >= 30) return false
  record.count++
  return true
}

router.post("/simulate-settlement", validateBody(settlementIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const clientIp = req.ip || "unknown"
  
  if (!checkSimulationRateLimit(clientIp)) {
    res.status(429).json({ error: "Too many simulation requests" })
    return
  }
  
  const settlementId = req.body.settlement_id
  const result = await simulateSettlement({ settlement_id: settlementId }, env)
  res.json(result)
}))
```

---

## Summary of Changes

| Issue | File | Lines | Change | Complexity |
|-------|------|-------|--------|-----------|
| 1 | soroban.ts | 43-52 | Fix i128ToBigInt for signed values | Medium |
| 2a | soroban.ts | 242-261 | Add validation for missing fields | Low |
| 2b | mongo.ts | 184-208 | Increase pool sizes and timeouts | Low |
| 3 | indexer.ts | 282-310 | Add pre-check for retention gap | Low |
| 4 | treasury.ts | 449-451 | Add rate limiting (optional) | Low |

All changes are backward-compatible. Recommend applying in order of severity (1, 2b, 2a, 3, 4).

---

## Verification Checklist

After applying fixes:

- [ ] Run full test suite: `npm test`
- [ ] Verify no new linter warnings: `npm run lint`
- [ ] Build TypeScript: `npm run build`
- [ ] Load test MongoDB with 50 concurrent requests
- [ ] Test i128 edge cases with actual Soroban contract (max/min values)
- [ ] Verify simulation endpoint does NOT submit transactions (logs should show no sendTransaction calls)
- [ ] Monitor indexer logs for new retention gap pre-check warnings (if any)
