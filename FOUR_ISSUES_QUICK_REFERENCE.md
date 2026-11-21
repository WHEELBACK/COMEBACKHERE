# Four Issues — Quick Reference & Line Numbers

## Issue 1: Redis Reconnect Backoff (indexer.ts)

### Backoff Implementation — WORKS CORRECTLY
- **File:** `src/indexer.ts`
- **Lines:** 119-128
- **Function:** `backoffDelayMs(attempt: number)`
- **Status:** ✓ Correct exponential backoff with jitter
- **Verified:** backoffDelayMs(0) → ~225-275ms, backoffDelayMs(10) → ~30s

### Redis Connection Strategy — WORKS CORRECTLY
- **File:** `src/indexer.ts`
- **Lines:** 153-172
- **Function:** `createRedisClient()` → `retryStrategy()`
- **Status:** ✓ Proper retry loop with limit
- **Verified:** Hard limit at 50 retries, logs each attempt

### Mongo Cursor Loading — WORKS CORRECTLY
- **File:** `src/indexer.ts`
- **Lines:** 282-290
- **Function:** `pollOnce()` - cursor load section
- **Status:** ✓ Mongo is authoritative source
- **Verified:** Redis is fallback only

### ISSUE: Retention Gap Not Pre-Checked
- **File:** `src/indexer.ts`
- **Lines:** 282-310 (the whole cursor load section)
- **Problem:** No validation that `startLedger` is within RPC retention BEFORE polling
- **Detection Method:** Currently happens inside `fetchEvents()` (line 327-356)
- **Gap:** Race condition if retention window shrinks between cursor load and first poll
- **Fix Location:** Add check at line ~295, after loading cursor but before `fetchEvents()`

### ISSUE: Gap Recovery and Recording
- **File:** `src/indexer.ts`
- **Lines:** 332-356
- **Function:** `pollOnce()` - gap handling section
- **Status:** ✓ Correctly detects and records gaps
- **Verified:** `recordRetentionGap()` stores in MongoDB, resumes from oldest ledger

### Related Code
- **Retention Error Parser:** Line 542-566 (`parseRetentionError()`)
- **Oldest Ledger Retrieval:** Line 568-574 (`getOldestRetainedLedger()`)
- **Paging Token Decoder:** Line 576-582 (`ledgerFromPagingToken()`)

### Test Coverage
- **File:** `src/tests/indexer-redis-reconnect.test.ts`
- **Backoff Tests:** Lines 18-39 ✓
- **Cursor Fallback:** Lines 50-85 ✓
- **Resilience:** Lines 97-140 ✓
- **Missing:** Retention edge case test (line ~120)

---

## Issue 2: MongoDB Pool Tuning (mongo.ts)

### Current Configuration
- **File:** `src/db/mongo.ts`
- **Lines:** 184-208
- **Variable:** `const MONGO_OPTIONS = {...}`

### Current Settings (PROBLEMATIC)
```
Line 186: maxPoolSize: 10           ← TOO SMALL
Line 188: minPoolSize: 2            ← OK but could be higher
Line 193: serverSelectionTimeoutMS: 5_000    ← TIGHT (5s)
Line 199: connectTimeoutMS: 10_000           ← MODERATE (10s)
Line 206: socketTimeoutMS: 45_000            ← CONFLICTS WITH SOROBAN (30s)
(Missing): tcpKeepaliveMS                     ← NOT SET
```

### Critical Issue: Socket Timeout
- **Current:** 45 seconds
- **Soroban Max:** 30 seconds (line 489 in submitContractCall)
- **Problem:** Query + Soroban can exceed 45s, looks like DB timeout not RPC timeout
- **Path:** API request → Mongo query → Soroban simulation (30s) → Mongo cursor save
- **Total:** ~35s minimum, could exceed 45s under load
- **Fix:** Increase socketTimeoutMS to 60_000

### Pool Size Issue
- **Current:** 10 max connections
- **Indexer Usage:** 1-2 persistent connections
- **API Usage:** 50+ concurrent during peak
- **Queue Wait:** After 10 slots full, new connections wait
- **Result:** Transient timeouts under load
- **Fix:** Increase maxPoolSize to 25, minPoolSize to 5

### Missing Keepalive
- **Risk:** Idle connections dropped by network hardware after hours
- **Impact:** First request after idle period fails, must reconnect
- **Fix:** Add tcpKeepaliveMS: 30_000

### Test Coverage
- **File:** `src/tests/mongo-hardening.test.ts`
- **Connection Failure:** Lines 50-88 ✓
- **HTTP Layer:** Lines 126-145 ✓
- **Missing:** Pool contention test, socket timeout behavior, keepalive verification

### Connection Establishment
- **File:** `src/db/mongo.ts`
- **Lines:** 211-236
- **Function:** `connectMongoOnce()`
- **Status:** ✓ Proper error handling with status 503

### Recommended Changes (Copy-Paste Ready)
```typescript
// BEFORE (line 184-208)
const MONGO_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
}

// AFTER
const MONGO_OPTIONS = {
  maxPoolSize: 25,              // Increased from 10
  minPoolSize: 5,               // Increased from 2
  serverSelectionTimeoutMS: 15_000,  // Increased from 5_000
  connectTimeoutMS: 20_000,     // Increased from 10_000
  socketTimeoutMS: 60_000,      // Increased from 45_000
  tcpKeepaliveMS: 30_000,       // NEW
}
```

---

## Issue 3: i128 Conversion (soroban.ts)

### Current Implementation (BROKEN FOR NEGATIVE)
- **File:** `src/lib/soroban.ts`
- **Lines:** 43-52
- **Function:** `i128ToBigInt(parts: xdr.Int128Parts)`
- **Status:** ✓ Works for positive values, ✗ BROKEN for negative

### Current Code
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  return (hi << 64n) | lo  // ← Doesn't handle sign bit
}
```

### Usage in getTokenBalance
- **File:** `src/lib/soroban.ts`
- **Lines:** 117-131
- **Function:** `getTokenBalance()`
- **Calls:** Line 128 → `i128ToBigInt(balance)`
- **Status:** ✓ Works for normal balances (always positive)

### Usage in getSettlementSimulation
- **File:** `src/lib/soroban.ts`
- **Lines:** 215-262
- **Function:** `getSettlementSimulation()`
- **Calls:** Lines 256-257 → `i128ToBigInt()` for treasuryBalance and projectedBalance
- **Status:** ✓ Works for normal amounts
- **ISSUE:** Lines 256-257 have fallback to zero if missing ← SHOULD VALIDATE

### Fallback Issue (Line 256-261)
```typescript
// CURRENT (WRONG)
treasuryBalance: i128ToBigInt(entries.treasury_balance?.i128() ?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))),
projectedBalance: i128ToBigInt(entries.projected_balance?.i128() ?? xdr.Int128Parts.fromXDR(Buffer.alloc(16))),

// SHOULD BE (with validation)
treasuryBalance: i128ToBigInt(entries.treasury_balance!.i128()),  // with check first
projectedBalance: i128ToBigInt(entries.projected_balance!.i128()),
```

### Test Coverage
- **File:** `src/tests/soroban.test.ts`
- **getTokenBalance Tests:** Lines 119-155
  - ✓ Positive balance (5M)
  - ✓ Zero balance
  - ✗ Max i128 value (2^127-1)
  - ✗ Negative values
  - ✗ Round-trip precision
- **getOnChainSettlement Tests:** Lines 178-240
  - ✓ Pending settlement
  - ✓ Executed settlement
  - ✗ Missing field validation
- **getSettlementSimulation Tests:** Lines - (NONE)

### Test Helper (Available in Test File)
- **File:** `src/tests/soroban.test.ts`
- **Function:** `makeI128ScVal(value: bigint)` (lines 95-109)
- **Usage:** Call this to create test i128 values

### Recommended Fix
```typescript
// CORRECT IMPLEMENTATION
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  
  // i128 is two 64-bit signed integers (hi, lo) in two's complement.
  // Reconstruct the 128-bit value from the parts.
  const combined = (hi << 64n) | lo
  
  // If hi is negative, the whole number is negative.
  // Convert from two's complement: 2^128 - |value|
  if (hi < 0n) {
    return combined - (1n << 128n)
  }
  
  return combined
}
```

### Recommended Field Validation
```typescript
// ADD before extracting values (line ~243)
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

// THEN safely access (line ~256)
treasuryBalance: i128ToBigInt(entries.treasury_balance.i128()),
projectedBalance: i128ToBigInt(entries.projected_balance.i128()),
```

---

## Issue 4: Simulation Endpoint (treasury.ts)

### Simulation Function
- **File:** `src/routes/treasury.ts`
- **Lines:** 371-390
- **Function:** `simulateSettlement(body, env, clientOverride?, deps?)`
- **Status:** ✓ Read-only, correct implementation

### Route Handler
- **File:** `src/routes/treasury.ts`
- **Lines:** 449-468
- **Route:** `POST /api/treasury/simulate-settlement`
- **Middleware:** NO `requireAdmin` ← By design, simulations are "preview only"
- **Status:** ✓ Correct, though inconsistent with execute-settlement (line 394 has `requireAdmin`)

### Underlying Call
- **File:** `src/lib/soroban.ts`
- **Function:** `getSettlementSimulation()` at lines 215-262
- **Calls:** Line 218 → `simulateContractRead()` (read-only)
- **Never Calls:** `sendTransaction()` (state mutation)
- **Status:** ✓ Correct

### Read-Only Method
- **File:** `src/lib/soroban.ts`
- **Lines:** 65-95
- **Function:** `simulateContractRead()`
- **Key Line:** 85 → `client.simulateTransaction(tx)`
- **Never:** No `client.sendTransaction()` call
- **Status:** ✓ Correct

### Response Structure
- **File:** `src/routes/treasury.ts`
- **Lines:** 378-389
- **Returns:** settlement_id, status, would_succeed, approval_weight, threshold, settlement_amount, treasury_balance, projected_balance
- **Note:** No `tx_hash` (would indicate execution)
- **Status:** ✓ Correct

### Authorization Check (Optional)
- **Current:** NO requireAdmin on simulate-settlement
- **Compare:** execute-settlement (line 394) HAS requireAdmin
- **Consistency:** Inconsistent but acceptable (simulations are preview-only)
- **Recommendation:** Document or align

### Rate Limiting
- **Current:** NONE
- **Risk:** Malicious actor could DOS Soroban RPC
- **Recommendation:** Add middleware at line 449

### Test Coverage
- **File:** `src/tests/treasury.test.ts`
- **Simulation Tests:** NONE - gap identified
- **Execute Tests:** Lines 24-116 ✓
- **Missing:**
  - ✗ POST /simulate-settlement integration test
  - ✗ Verify no transaction submitted
  - ✗ Error case (settlement not found)
  - ✗ Stale simulation handling

### Recommended Test Addition
```typescript
// Add to treasury.test.ts around line 116

describe("POST /api/treasury/simulate-settlement", () => {
  it("returns simulation without submitting transaction", async () => {
    const sendTransaction = vi.fn()
    const client = makeMockClient({
      getAccount: vi.fn().mockResolvedValue(fakeAccount),
      simulateTransaction: vi.fn().mockResolvedValue(PARSED_SIM_SUCCESS),
      sendTransaction,
      // Note: sendTransaction mock is defined but should never be called
    })

    const result = await simulateSettlement(
      { settlement_id: 1 },
      env,
      client,
      {
        getSettlementSimulation: vi.fn().mockResolvedValue({
          settlementId: 1n,
          status: "Pending",
          wouldSucceed: true,
          approvalWeight: 2n,
          threshold: 2n,
          settlementAmount: 1_000_000n,
          treasuryBalance: 5_000_000n,
          projectedBalance: 4_000_000n,
        }),
      }
    )

    expect(sendTransaction).not.toHaveBeenCalled()
    expect(result.would_succeed).toBe(true)
  })
})
```

### Recommended Rate Limiting Addition
```typescript
// Add at line 449 (before validateBody)
import { rateLimit } from "express-rate-limit"

const simulationLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 30,               // Max 30 per window
  message: "Too many simulation requests",
})

router.post(
  "/simulate-settlement",
  simulationLimiter,  // ← ADD THIS
  validateBody(settlementIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    // ... existing code ...
  })
)
```

---

## Cross-Reference: Related Code

### Soroban RPC Timeouts
- **Primary Timeout:** 30 seconds (submitContractCall line 489)
- **Related:** MongoDB socketTimeoutMS should be > 30s
- **Current:** 45s (too close to Soroban), Recommended: 60s

### Idempotency Guards
- **File:** `src/routes/treasury.ts`
- **Lines:** 189-200 (executeSettlementWithBalanceCheck)
- **Purpose:** Protect against duplicate execution
- **Status:** ✓ Correct

### Mongo Cursor Idempotency
- **File:** `src/indexer.ts`
- **Lines:** 250-272 (recordTransition)
- **Purpose:** Prevent duplicate event processing
- **Status:** ✓ Correct

---

## Testing Quick Commands

```bash
# Run specific test file
npm test -- soroban.test.ts
npm test -- mongo-hardening.test.ts
npm test -- indexer-redis-reconnect.test.ts
npm test -- treasury.test.ts

# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Build and lint
npm run build
npm run lint
```

---

## Deployment Checklist

After applying fixes:

- [ ] All tests pass: `npm test`
- [ ] No linter warnings: `npm run lint`
- [ ] Build succeeds: `npm run build`
- [ ] Load test MongoDB with increased pool size
  ```bash
  # Simulate 50 concurrent requests, measure queue/timeout rate
  ```
- [ ] Verify i128 edge cases with Soroban contract (if available)
- [ ] Verify simulation doesn't submit transactions (check logs for sendTransaction calls)
- [ ] Monitor indexer logs for new retention gap pre-check warnings
- [ ] Verify MongoDB TCP keepalive (if monitoring available)

---

## Summary Statistics

| Category | Count |
|----------|-------|
| **Total Issues Found** | 4 (8 sub-issues) |
| **Critical Issues** | 2 (i128 signed, socket timeout) |
| **High Priority Fixes** | 4 |
| **Test Coverage Gaps** | 5 areas |
| **Lines of Code to Change** | ~100 |
| **Estimated Implementation Time** | 8-10 hours |
| **Estimated Load Testing Time** | 2-3 hours |
| **Total Project Time** | 10-13 hours |

