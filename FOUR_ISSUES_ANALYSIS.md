# Four Issues Analysis: Implementation Status & Gaps

## Issue 1: WebSocket Reconnect Backoff & Ledger Sync (indexer.ts)

### Current Implementation Status
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/indexer.ts`

The indexer implements exponential backoff with jitter for Redis reconnection (#209):

#### Backoff Implementation (Lines 119-128)
```typescript
const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 30_000
const BACKOFF_JITTER = 0.1 // ±10 %

export function backoffDelayMs(attempt: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
  const jitter = exp * BACKOFF_JITTER * (Math.random() * 2 - 1)
  return Math.round(exp + jitter)
}
```

**Strengths:**
- Proper exponential backoff with configurable base (250ms) and cap (30s)
- Jitter implementation (±10%) prevents thundering herd
- Graceful degrades to in-memory cursor if Redis fails

#### Redis Reconnection Loop (Lines 153-172)
```typescript
retryStrategy(times: number): number | null {
  attempt = times
  if (times > 50) {
    logger.error({ attempts: times }, "Redis retry limit reached; stopping reconnect")
    return null
  }
  const delay = backoffDelayMs(times - 1)
  logger.warn({ attempt: times, delayMs: delay }, "Redis reconnect scheduled")
  return delay
}
```

**Strengths:**
- Calls `backoffDelayMs()` for each retry
- Hard limit at 50 retries (~30 min with cap) prevents infinite loops
- Logs each reconnect attempt with delay

#### Ledger Sync Gap Recovery (Lines 332-356)
```typescript
// When cursor falls outside retention window:
await recordRetentionGap(db, contractId, fromLedger, oldest - 1)
pagingToken = undefined
startLedger = oldest
lastLedger = oldest
if (db) await saveMongoCursor(db, null, oldest)
response = await fetchEvents()
```

**Strengths:**
- Detects retention gaps via `parseRetentionError()`
- Records gaps in `indexer_gaps` collection for manual recovery
- Resumes from oldest retained ledger
- Per-event idempotency via unique `event_id` prevents duplicates

### Identified Gaps

**Gap 1: Redis Disconnect Signal Not Explicitly Handled**
- **Line 166:** `retryStrategy()` is called by ioredis AFTER a failed connection, but the Redis client never explicitly signals "we just reconnected after a gap"
- **Issue:** If Redis drops and reconnects, the indexer may not know to validate that MongoDB cursor is still valid
- **Severity:** LOW - Mongo cursor is authoritative (line 284), so silent recovery is acceptable

**Gap 2: No Ledger Continuity Check After Redis Reconnect**
- **Line 284:** After loading from Mongo cursor, there's no check that the `last_ledger` hasn't advanced beyond current RPC's retention window
- **Scenario:** If the indexer pauses for 30+ min and Soroban retention is 24h, the cursor may be silently stale on reconnect
- **Severity:** MEDIUM - Gap would only be detected on the next `pollOnce()` call, creating a potential race window

**Gap 3: Missed Events Possible if Redis Cursor Ahead of Mongo**
- **Lines 282-285:** If Redis has a newer cursor than Mongo (replication lag), and we disconnect before saving to Mongo, we may skip events
- **Current Behavior:** Line 284 prioritizes Mongo if available; Redis is fallback only
- **Severity:** LOW - Mongo is authoritative; Redis gap shouldn't occur

### Test Coverage
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/tests/indexer-redis-reconnect.test.ts`

**Covered:**
- ✓ `backoffDelayMs()` produces exponential delays (lines 18-39)
- ✓ Fallback to in-memory cursor when Redis down (lines 50-60)
- ✓ `saveCursor()` persists and gracefully degrades (lines 62-85)
- ✓ Indexer continues polling after Redis drop (lines 97-140)

**Gaps:**
- ✗ No test for ledger continuity after reconnect (Gap 2 above)
- ✗ No test for race condition when Mongo cursor becomes stale due to retention window shrinking

---

## Issue 2: Pool Size & Idle Timeout Tuning (mongo.ts)

### Current Implementation Status
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/db/mongo.ts`

#### Connection Pool Configuration (Lines 184-208)
```typescript
const MONGO_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
}
```

### Analysis of Settings

| Setting | Value | Assessment | Risk |
|---------|-------|-----------|------|
| `maxPoolSize` | 10 | Reasonable for typical backend; may be low for high-concurrency indexer + API | LOW |
| `minPoolSize` | 2 | Conservative; keeps 2 idle connections warm | OPTIMAL |
| `serverSelectionTimeoutMS` | 5_000 (5s) | Tight; startup failures detected quickly | POTENTIAL ISSUE |
| `connectTimeoutMS` | 10_000 (10s) | Moderate; new connections get 10s to establish | POTENTIAL ISSUE |
| `socketTimeoutMS` | 45_000 (45s) | Aggressive; long operations may timeout | **CRITICAL** |

### Identified Issues

**Issue 1: serverSelectionTimeoutMS May Be Too Aggressive (Line 190)**
- **Current:** 5 seconds
- **Problem:** During topology discovery or maintenance, 5s may trigger premature failures
- **Symptom:** Transient 503 errors even when Mongo recovers quickly
- **Recommendation:** Increase to 10-15 seconds for better resilience
- **Current Behavior:** Line 218-226 provides clear error messages, so this is caught and logged

**Issue 2: socketTimeoutMS (45s) vs. Soroban RPC Latency (30s)**
- **Current:** 45 seconds for socket operations
- **Problem:** Soroban simulation can take up to 30s (submitContractCall line 489 has 30s timeout). If MongoDB socket also times out after 45s during a concurrent Soroban call, the error is ambiguous
- **Scenario:** 
  - Soroban simulation pending for 30s
  - MongoDB query blocked waiting for Soroban response
  - Query takes >45s total (simul + Mongo overhead)
  - Socket timeout fires, looks like Mongo failure not Soroban
- **Severity:** MEDIUM

**Issue 3: No Keepalive Configuration**
- **Missing:** No `tcpKeepaliveMS` or socket keepalive settings
- **Risk:** Long-idle connections may be silently dropped by network hardware
- **Current Pool:** `minPoolSize: 2` means 2 connections could be idle for hours
- **Impact:** First request after idle period may hit stale connection and retry

**Issue 4: No Socket No-Delay (Nagle's Algorithm)**
- **Missing:** No `nagle: false` or equivalent
- **Risk:** Small queries (indexer cursor updates, settlement lookups) could be batched by TCP, adding latency
- **Severity:** LOW in this context (batch sizes are not extreme)

### Pool Contention Scenario

Current settings with peak load:
- 10 max connections
- Indexer polling every 5s = 1 connection per cycle
- API handling 100 req/sec = potentially 100 connections needed
- **Result:** Queue builds, new requests wait on available slots
- **Timeout cascade:** After 10s (connectTimeoutMS), waiting requests fail

**Recommended Adjustment:**
```typescript
const MONGO_OPTIONS = {
  maxPoolSize: 25,              // Increased from 10 to handle API + indexer
  minPoolSize: 5,               // Increased from 2 to pre-warm more connections
  serverSelectionTimeoutMS: 15_000,  // Increased from 5s to 15s
  connectTimeoutMS: 20_000,     // Increased from 10s to 20s
  socketTimeoutMS: 60_000,      // Increased from 45s to 60s
  tcpKeepaliveMS: 30_000,       // NEW: keepalive every 30s
}
```

### Test Coverage
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/tests/mongo-hardening.test.ts`

**Covered:**
- ✓ Unreachable server returns 503 with clear error (lines 50-62)
- ✓ Error includes MONGODB_URI for operator clarity (lines 64-75)
- ✓ Non-selection-error wrapped with 503 (lines 77-88)
- ✓ Successful connection returns Db handle (lines 90-101)
- ✓ HTTP route returns 5xx not hang (lines 126-145)

**Gaps:**
- ✗ No test for pool contention / connection queue buildup
- ✗ No test for socket timeout under sustained load
- ✗ No test for keepalive behavior with idle connections

---

## Issue 3: Multi-Asset Conversion Helpers Boundary Checks (soroban.ts)

### Current Implementation Status
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/lib/soroban.ts`

#### i128ToBigInt Conversion (Lines 43-52)
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  return (hi << 64n) | lo
}
```

**Strengths:**
- Correctly reconstructs i128 from hi/lo parts (comment #898 explains the fix)
- Handles 128-bit signed integers properly
- Used consistently in `getTokenBalance()` and `getSettlementSimulation()`

#### Boundary Scenarios Tested
```typescript
// Test: getTokenBalance with i128 conversion
const balance = await getTokenBalance(client, TOKEN_CONTRACT, HOLDER, SOURCE_ACCT, NETWORK)
expect(balance).toBe(5_000_000n)

// Test: Zero balance
expect(balance).toBe(0n)
```
*From soroban.test.ts lines 120-140*

### Identified Gaps

**Gap 1: Signed i128 Boundary Values Not Tested**
- **Issue:** i128ToBigInt correctly handles reconstruction, but there's no test for:
  - Max positive value: `2^127 - 1` = `170141183460469231731687303715884105727n`
  - Min negative value: `-2^127` = `-170141183460469231731687303715884105728n`
  - Negative balance values (if contract uses signed int)
- **Current Test:** Only tests positive values (5,000,000n, 0n) — see soroban.test.ts lines 120-140
- **Severity:** MEDIUM - If a balance query returns a negative value, it would be silently wrapped to a large positive (JavaScript BigInt arithmetic behavior)

**Gap 2: Loss of Precision in Round-Trip Conversion**
- **Path:** On-chain i128 → `Int128Parts` → `i128ToBigInt()` → JSON stringification → HTTP response
- **Issue:** No validation that bigint serialization doesn't lose precision
- **Current:** Lines 243-249 return bigint as `.toString()` in JSON response:
  ```typescript
  return {
    settlement_id: body.settlement_id,
    ...
    treasury_balance: simulation.treasuryBalance.toString(),  // Serialized here
    projected_balance: simulation.projectedBalance.toString(),
  }
  ```
- **Risk:** If the consuming client parses with `Number()` instead of `BigInt()`, values > 2^53 overflow
- **Severity:** LOW for current use case (token amounts typically < 2^64), but architectural risk for future assets

**Gap 3: No Boundary Check on Input to ScVal Conversion**
- **Lines 256-261 (getSettlementSimulation):** Parsing i128 values from a map:
  ```typescript
  treasuryBalance: i128ToBigInt(entries.treasury_balance?.i128() ?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))),
  projectedBalance: i128ToBigInt(entries.projected_balance?.i128() ?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))),
  ```
- **Problem:** Fallback creates zero-filled i128 if the key is missing, which silently becomes `0n`
- **Risk:** If the contract accidentally omits these fields, we report balance as 0 instead of erroring
- **Severity:** MEDIUM - Should validate presence rather than fall back

**Gap 4: Negative Balance Handling Undefined**
- **Scenario:** Settlement amount is positive, but if computed balance somehow becomes negative (contract bug), the JavaScript code doesn't distinguish it
- **Issue:** `(hi << 64n) | lo` doesn't properly handle the sign bit for signed i128
- **Fix Required:** Check if hi's sign bit is set and handle two's complement properly
- **Current Implementation:** Assumes unsigned OR operation is correct; it is not for signed i128

### Corrected i128ToBigInt for Signed Values
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  
  // For signed i128: check if the high bit is set (negative value)
  const MAX_SIGNED = 1n << 127n
  const combined = (hi << 64n) | lo
  
  if (combined >= MAX_SIGNED) {
    // Negative: convert from two's complement
    return combined - (1n << 128n)
  }
  return combined
}
```

### Test Coverage
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/tests/soroban.test.ts`

**Covered:**
- ✓ `getTokenBalance()` returns correct positive balance (lines 119-128)
- ✓ Zero balance correctly parsed (lines 130-140)
- ✓ Invalid i128 ScVal throws error (lines 142-155)
- ✓ `getOnChainSettlement()` parses valid settlement (lines 178-202)
- ✓ Executed status parsed correctly (lines 204-220)

**Gaps:**
- ✗ No test for i128 boundary values (max/min)
- ✗ No test for negative balances / signed i128 interpretation
- ✗ No test for round-trip serialization/deserialization
- ✗ No test for precision loss in BigInt → JSON → string path
- ✗ No test for missing treasury_balance key in simulation response

### Recommended Tests
```typescript
it("handles max positive i128 value", async () => {
  const maxValue = (1n << 127n) - 1n  // 2^127 - 1
  const client = makeMockClient({...})
  const scval = makeI128ScVal(maxValue)
  const balance = await getTokenBalance(client, ...)
  expect(balance).toBe(maxValue)
})

it("correctly interprets negative i128 values", async () => {
  const negativeValue = -(1n << 64n)
  const client = makeMockClient({...})
  const scval = makeI128ScVal(negativeValue)
  // Should throw or return error, not wrap to positive
  await expect(getTokenBalance(client, ...)).rejects...
})

it("preserves precision in BigInt stringification", () => {
  const largeValue = (1n << 120n)  // Very large but valid i128
  const json = JSON.stringify({ balance: largeValue.toString() })
  const parsed = BigInt(JSON.parse(json).balance)
  expect(parsed).toBe(largeValue)
})
```

---

## Issue 4: Contract Simulation Without Submission (treasury.ts)

### Current Implementation Status
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/routes/treasury.ts`

#### simulateSettlement Endpoint (Lines 393-447)
```typescript
export async function simulateSettlement(
  body: SimulateSettlementBody,
  env: {...},
  clientOverride?: SorobanClient,
  deps: SimulateSettlementDeps = defaultSimulateSettlementDeps,
): Promise<{...}> {
  const client = clientOverride ?? buildSorobanClient(env.rpcUrl)
  const keypair = Keypair.fromSecret(env.signerSecret)

  const simulation = await deps.getSettlementSimulation(...)
  return {
    settlement_id: body.settlement_id,
    status: simulation.status,
    would_succeed: simulation.wouldSucceed,
    ...
  }
}
```

**Strengths:**
- ✓ Read-only simulation (no transaction submission)
- ✓ Calls `getSettlementSimulation()` which internally uses `simulateContractRead()` (soroban.ts line 215)
- ✓ No auth entries attached, no state mutation
- ✓ Route `/api/treasury/simulate-settlement` (line 449) does not require admin (can be called by operators for planning)

#### Routing & Access (Lines 449-451)
```typescript
router.post("/simulate-settlement", validateBody(settlementIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const env = requireEnv({
    treasuryContractId: "TREASURY_CONTRACT_ID",
    signerSecret: "SIGNER_SECRET_KEY",
  })
```

**Note:** Does NOT use `requireAdmin` middleware, allowing any authenticated caller to preview settlements

#### Underlying Simulation (soroban.ts Lines 215-237)
```typescript
export async function getSettlementSimulation(
  client: SorobanClient,
  treasuryContractId: string,
  settlementId: bigint,
  sourceAccount: string,
  networkPassphrase: string,
): Promise<SettlementSimulation> {
  const retval = await simulateContractRead(
    client,
    treasuryContractId,
    "simulate_settlement",  // ← Read-only contract method
    [nativeToScVal(settlementId, { type: "u64" })],
    sourceAccount,
    networkPassphrase,
  )
  // Parse and return simulation results
}
```

**simulateContractRead (soroban.ts Lines 65-95):**
```typescript
export async function simulateContractRead(
  client: SorobanClient,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourceAccount: string,
  networkPassphrase: string,
): Promise<xdr.ScVal> {
  // ... build transaction ...
  const simulated = await client.simulateTransaction(tx)
  // ... return result.retval, never submit ...
}
```

**Key:** Calls `simulateTransaction()` only, never `sendTransaction()` ✓

### Identified Gaps

**Gap 1: No Authorization Boundary Check**
- **Issue:** Line 449 does NOT require `requireAdmin` middleware
- **Current Behavior:** Any caller with a valid HTTP request can simulate any settlement
- **Risk:** Information disclosure - operators can enumerate and preview all settlements
- **Severity:** LOW in context of current design (treasury simulations are not confidential), but inconsistent with execute-settlement (line 395, uses `requireAdmin`)
- **Recommendation:** Consider whether simulator should also require admin or role-based authorization

**Gap 2: No Rate Limiting on Simulation Calls**
- **Issue:** Simulation is "free" (no state mutation), but RPC still charges or rate-limits
- **Risk:** Malicious actor could DOS the Soroban RPC by flooding simulation calls
- **Current Mitigation:** None in the code
- **Severity:** MEDIUM - RPC will eventually reject if threshold is exceeded, but no preemptive guard

**Gap 3: Simulation Response Doesn't Include Read-Only Guarantee**
- **Line 427-438:** Response includes `would_succeed`, `approval_weight`, `treasury_balance` etc., but no explicit marker that this is a simulation-only result
- **Risk:** Calling code might treat this as a settled result or confuse it with on-chain state
- **Mitigation:** Response structure is clear (named `simulateSettlement()`, endpoint has `simulate-` prefix), but no `is_simulation: true` field
- **Severity:** LOW - naming is clear

**Gap 4: Stale Simulation Cache Possible**
- **Issue:** Settlement might be approved between simulation and execution
- **Scenario:**
  1. Operator calls `/simulate-settlement` → returns `would_succeed: true`
  2. Another operator calls `/execute-settlement` → settlement executes
  3. First operator calls `/execute-settlement` with same ID → fails (not pending anymore)
- **Current Handling:** Line 189 in executeSettlementWithBalanceCheck checks status is "Pending", so this is caught
- **Severity:** LOW - idempotency guard exists (lines 189-200)

**Gap 5: No Simulation Error Propagation**
- **Line 393-447:** Simulation can fail (e.g., settlement not found) but error is just thrown as 422
- **Issue:** Error message might not distinguish between:
  - Settlement doesn't exist (not found)
  - Treasury contract broken
  - RPC connection failure
- **Current:** soroban.ts line 90 throws 422 with message, but callers see generic "Soroban simulation failure"
- **Severity:** LOW - errors are logged and returned with details in the message

### Test Coverage
**File:** `/workspaces/COMEBACKHERE/comebackhere-backend/src/tests/treasury.test.ts`

**Covered:**
- ✓ POST /execute-settlement validates input (lines 49-53)
- ✓ POST /execute-settlement returns 503 if env vars missing (lines 55-60)
- ✓ executeSettlementWithBalanceCheck rejects if balance insufficient (lines 72-95)
- ✓ executeSettlementWithBalanceCheck submits when balance sufficient (lines 97-116)

**Gaps:**
- ✗ No test for POST /simulate-settlement endpoint itself
- ✗ No test for simulateSettlement() function
- ✗ No test for read-only guarantee (verify no state mutation)
- ✗ No test for authorization boundary (is simulate-settlement correctly NOT requiring admin?)
- ✗ No test for stale simulation + concurrent execution race
- ✗ No test for simulation failure error messages

### Recommended Tests
```typescript
describe("POST /api/treasury/simulate-settlement", () => {
  it("returns simulation result without submitting transaction", async () => {
    const sendTransaction = vi.fn()  // Should never be called
    const client = makeMockClient({
      sendTransaction,
      // ... other mocks ...
    })
    
    const result = await simulateSettlement(
      { settlement_id: 1 },
      env,
      client,
    )
    
    expect(sendTransaction).not.toHaveBeenCalled()
    expect(result.would_succeed).toBe(true)
  })

  it("allows non-admin callers to simulate", async () => {
    const app = createApp()
    const res = await request(app)
      .post("/api/treasury/simulate-settlement")
      .send({ settlement_id: 1 })
    // Should not reject with 401/403 Unauthorized
  })

  it("returns 422 when settlement not found", async () => {
    const client = makeMockClient({
      // ... setup to simulate "not found" ...
    })
    
    await expect(
      simulateSettlement({ settlement_id: 999 }, env, client)
    ).rejects.toMatchObject({ status: 422 })
  })

  it("includes read-only confirmation in response", async () => {
    const result = await simulateSettlement(...)
    expect(result).toHaveProperty("would_succeed")
    expect(result).toHaveProperty("treasury_balance")
    // Confirm no submitted_tx_hash or similar
    expect(result).not.toHaveProperty("tx_hash")
  })
})
```

---

## Summary Table

| Issue | Component | Severity | Gap Type | Recommended Fix |
|-------|-----------|----------|----------|-----------------|
| 1a | indexer.ts | LOW | Silent recovery | Add explicit reconnect validation |
| 1b | indexer.ts | MEDIUM | Race condition | Check ledger retention after reconnect |
| 2a | mongo.ts | MEDIUM | Pool tuning | Increase maxPoolSize to 25, timeouts to 15/20/60s |
| 2b | mongo.ts | CRITICAL | Socket timeout | Reduce socketTimeoutMS or increase Soroban timeout |
| 2c | mongo.ts | LOW | Keepalive | Add tcpKeepaliveMS: 30_000 |
| 3a | soroban.ts | MEDIUM | Boundary test | Add tests for i128 max/min values |
| 3b | soroban.ts | MEDIUM | Signed int handling | Fix i128ToBigInt to handle sign bit correctly |
| 3c | soroban.ts | MEDIUM | Fallback behavior | Validate presence of balance fields, don't fall back to 0 |
| 4a | treasury.ts | LOW | Authorization | Consider requiring admin for simulate-settlement |
| 4b | treasury.ts | MEDIUM | Rate limiting | Add rate limit check before simulation |
| 4c | treasury.ts | LOW | Test coverage | Add integration test for simulate-settlement endpoint |

---

## Recommendations Priority Order

### Critical (Do First)
1. **Fix MongoDB socket timeout cascade** (Issue 2b)
   - Impact: Prevents transient failures under load
   - Effort: 1 line change + thorough testing

2. **Fix i128 signed integer handling** (Issue 3b)
   - Impact: Prevents silent balance corruption on negative values
   - Effort: ~10 lines + 3-4 test cases

### High (Do Soon)
3. **Increase MongoDB pool size & timeouts** (Issue 2a)
   - Impact: Prevents queue-induced 503 errors
   - Effort: 5 line changes + load testing

4. **Add boundary tests for i128 values** (Issue 3a)
   - Impact: Confidence in conversion correctness
   - Effort: 4-5 test cases

### Medium (Do in Next Sprint)
5. **Add ledger continuity check after Redis reconnect** (Issue 1b)
   - Impact: Prevents rare gap window
   - Effort: ~15 lines + test case

6. **Add simulate-settlement integration tests** (Issue 4c)
   - Impact: Ensures read-only guarantee
   - Effort: 3-4 test cases

7. **Add rate limiting to simulation endpoint** (Issue 4b)
   - Impact: Protects RPC from DOS
   - Effort: ~20 lines (middleware or counter)

### Low (Polish)
8. **Explicit reconnection validation** (Issue 1a)
   - Impact: Better observability
   - Effort: ~5 lines

9. **Consider admin boundary for simulate-settlement** (Issue 4a)
   - Impact: Consistency with execute-settlement
   - Effort: 1 line change

---

## File References for Implementation

| File | Lines | Change Type |
|------|-------|-------------|
| mongo.ts | 184-208 | Config tuning |
| soroban.ts | 43-52 | Algorithm fix |
| soroban.ts | 256-261 | Validation add |
| indexer.ts | 282-290 | Validation add |
| treasury.ts | 449 | Middleware add (optional) |
| Tests: soroban.test.ts | 119-220 | New test cases |
| Tests: indexer-redis-reconnect.test.ts | 1-150 | New test case |
| Tests: treasury.test.ts | 1-150 | New test case |
