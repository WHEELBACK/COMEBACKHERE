# Four Issues Analysis — Executive Summary

## Analysis Scope

Four critical code areas were analyzed for correctness, test coverage, and boundary condition handling:

1. **indexer.ts** — Redis reconnect backoff & ledger gap recovery
2. **mongo.ts** — MongoDB connection pool tuning
3. **soroban.ts** — Multi-asset i128 conversion helpers
4. **treasury.ts** — Settlement simulation endpoint

---

## Key Findings

### Issue 1: WebSocket Reconnect Backoff & Ledger Sync (indexer.ts)

**Status:** ✓ IMPLEMENTED with MINOR GAPS

**Implementation Quality:**
- ✓ Exponential backoff with jitter correctly implemented
- ✓ 50-retry hard limit (~30 min) prevents infinite loops
- ✓ Cursor persistence uses Mongo as authoritative source
- ✓ Per-event idempotency prevents duplicates on replay

**Identified Gaps:**
1. **Race Condition (MEDIUM):** After Redis reconnect, no check that Mongo cursor hasn't exceeded retention window. If indexer pauses >24h and RPC retention shrinks, gap could be missed.
   - *Fix:* Add pre-check in `pollOnce()` line ~285 to validate `startLedger` is within retention window before polling

2. **Silent Recovery (LOW):** Redis disconnect + reconnect doesn't explicitly signal to validation layer. Works in practice because Mongo is authoritative.
   - *Fix:* Log warning when resuming after reconnect

**Test Coverage:** Good (indexer-redis-reconnect.test.ts)
- ✓ Backoff delay calculation
- ✓ Cursor fallback to in-memory
- ✓ Continued polling after disconnect

Missing:
- ✗ Retention window edge case after long pause
- ✗ Concurrent execution of reconnect + gap detection

**Recommendation:** Add ledger continuity check before first poll after cursor load. Cost: ~15 lines.

---

### Issue 2: Pool Size & Idle Timeout Tuning (mongo.ts)

**Status:** ⚠ POTENTIALLY PROBLEMATIC under load

**Current Settings:**
```
maxPoolSize:              10  ← Too small for API + indexer workload
minPoolSize:               2  ← Conservative
serverSelectionTimeoutMS:  5s ← May be too tight
connectTimeoutMS:         10s ← Moderate
socketTimeoutMS:          45s ← CRITICAL: conflict with Soroban's 30s timeout
tcpKeepaliveMS:          N/A ← Missing (connections can be silently dropped)
```

**Identified Issues:**

1. **CRITICAL: Socket Timeout vs Soroban Timeout Mismatch**
   - Soroban simulation max: 30 seconds
   - MongoDB socket timeout: 45 seconds
   - **Problem:** If a Mongo query awaits Soroban result, it could timeout at 45s and mask the real issue as "database failure" not "RPC timeout"
   - **Scenario:** Settlement execution flow: API → Mongo → Soroban → Mongo (cursor save). If Soroban takes 30s, total could exceed 45s.
   - **Fix:** Increase socketTimeoutMS to 60 seconds

2. **MEDIUM: Pool Size Too Small**
   - Indexer uses 1-2 persistent connections (polling + cursor saves)
   - API can have 50+ concurrent requests during peak
   - Current max 10 creates queue + delays
   - **Fix:** Increase to 25 (or load-test to determine exact number)

3. **MEDIUM: Server Selection Timeout Aggressive**
   - 5 seconds can fail during topology recovery or maintenance window
   - **Fix:** Increase to 15 seconds

4. **LOW: Missing TCP Keepalive**
   - Long-idle connections (2 minPoolSize sitting idle for hours) can be dropped by network hardware
   - Next request hits stale connection, must reconnect
   - **Fix:** Add `tcpKeepaliveMS: 30_000`

**Test Coverage:** Good (mongo-hardening.test.ts)
- ✓ Unreachable server returns 503 with clear error
- ✓ Error includes MONGODB_URI for troubleshooting
- ✓ HTTP route doesn't hang

Missing:
- ✗ Pool contention under load (50+ concurrent requests)
- ✗ Socket timeout behavior with long-running queries
- ✗ Keepalive effectiveness on stale connections

**Recommended Changes:**
```typescript
maxPoolSize: 25              // was 10
minPoolSize: 5               // was 2
serverSelectionTimeoutMS: 15_000  // was 5_000
connectTimeoutMS: 20_000     // was 10_000
socketTimeoutMS: 60_000      // was 45_000
tcpKeepaliveMS: 30_000       // NEW
```

**Recommendation:** Apply all changes + run load test at 50 req/sec. Cost: 5 line changes + 1-2 hour load testing.

---

### Issue 3: Multi-Asset Conversion Helpers — Boundary Checks (soroban.ts)

**Status:** ⚠ PARTIALLY CORRECT with CRITICAL SIGNED INT ISSUE

**Current Implementation:**
```typescript
function i128ToBigInt(parts: xdr.Int128Parts): bigint {
  const lo = BigInt(parts.lo().toString())
  const hi = BigInt(parts.hi().toString())
  return (hi << 64n) | lo  // ← Doesn't handle sign bit correctly
}
```

**Identified Issues:**

1. **CRITICAL: Signed Integer Handling Broken**
   - Current code treats i128 as unsigned
   - If a contract returns negative balance (shouldn't happen, but if it does), conversion is wrong
   - **Example:** -1 becomes 2^128 - 1 (huge positive)
   - **Impact:** Silent balance corruption
   - **Fix:** Check sign bit before combining, handle two's complement
   - **Severity:** HIGH (though negative balances shouldn't occur in practice)

2. **MEDIUM: Missing Boundary Tests**
   - Tests only cover normal values (5M, 0)
   - No tests for i128 limits: ±2^127
   - No round-trip serialization test
   - **Fix:** Add 4-5 test cases for boundary values

3. **MEDIUM: Missing Field Validation**
   - In `getSettlementSimulation()` (line 256-261), missing balance fields silently fall back to 0n
   - **Fix:** Validate all required fields present; throw 422 if not

4. **LOW: Precision Loss Not Documented**
   - Balances converted to string in JSON response (line 427)
   - No validation that JSON deserialization doesn't overflow
   - **Issue:** If client parses with `Number()` instead of `BigInt()`, values >2^53 overflow
   - **Fix:** Document assumption that values fit in JSON number range (they do for current assets)

**Test Coverage:** Partial (soroban.test.ts)
- ✓ Positive balance parsing
- ✓ Zero balance
- ✓ Invalid response handling

Missing:
- ✗ i128 boundary values (max/min)
- ✗ Signed vs. unsigned interpretation
- ✗ Negative balance handling
- ✗ Missing field validation in simulation response

**Recommended Fixes:**

1. **High Priority:** Fix i128ToBigInt for signed values
   ```typescript
   // Check sign bit and apply two's complement if negative
   if (hi < 0n) {
     return combined - (1n << 128n)
   }
   ```
   Cost: ~5 lines

2. **Medium Priority:** Add validation for missing simulation fields
   ```typescript
   const requiredFields = ["treasury_balance", "projected_balance", ...]
   for (const field of requiredFields) {
     if (!entries[field]) throw new Error(`Missing ${field}`)
   }
   ```
   Cost: ~10 lines

3. **Medium Priority:** Add boundary test cases
   Cost: ~30 lines (4-5 test cases)

**Recommendation:** Apply all three fixes. Cost: ~50 lines code + tests.

---

### Issue 4: Contract Simulation Without Submission (treasury.ts)

**Status:** ✓ CORRECTLY IMPLEMENTED with MINOR OBSERVATION

**Implementation Quality:**
- ✓ Uses read-only `simulateContractRead()` (never calls `sendTransaction`)
- ✓ No state mutation
- ✓ Clear endpoint naming (`/simulate-settlement`)
- ✓ No auth entry injection required for simulation

**Observations:**

1. **LOW: Authorization Boundary Not Required Admin**
   - `simulateSettlement` does NOT use `requireAdmin` middleware
   - Unlike `executeSettlement` (requires admin)
   - **Current Behavior:** Any caller can preview any settlement
   - **Assessment:** Acceptable (simulations are not confidential), but inconsistent
   - **Recommendation:** Consider consistency — require admin if settlements are sensitive, or explicitly document that simulations are public

2. **MEDIUM: No Rate Limiting**
   - Simulation is "free" (no state cost), but RPC can be rate-limited
   - Malicious actor could DOS Soroban RPC with floods of simulation calls
   - **Fix:** Add rate limit middleware (30 calls/min per IP)
   - **Cost:** ~20 lines

3. **LOW: Stale Simulation Possible**
   - Operator gets simulation result, then settlement executes before they submit
   - **Mitigation:** Already exists (executeSettlementWithBalanceCheck re-checks status on line 189)
   - **Assessment:** Acceptable

4. **LOW: Test Coverage Gap**
   - No explicit test for `simulateSettlement()` function
   - No test verifying no transactions submitted
   - **Fix:** Add 3-4 integration tests

**Test Coverage:** Minimal (treasury.test.ts)
- ✓ Execute settlement balance check
- ✓ Input validation

Missing:
- ✗ Simulate settlement endpoint integration test
- ✗ Verification that no transactions submitted
- ✗ Error case handling (settlement not found)
- ✗ Response shape validation

**Recommendation:** Add integration tests (optional) + consider rate limiting (medium priority). Cost: ~50 lines.

---

## Summary Table

| Issue | File | Status | Severity | Test Gap | Recommended Fix | Effort |
|-------|------|--------|----------|----------|-----------------|--------|
| 1: Reconnect Gap | indexer.ts | ✓ Good | MEDIUM | Retention edge case | Add pre-check logic | 1-2h |
| 2: Pool Tuning | mongo.ts | ⚠ Risky | **CRITICAL** | Load test needed | Increase limits, add keepalive | 1-2h + test |
| 3: i128 Conversion | soroban.ts | ⚠ Risky | **CRITICAL** | Boundary tests missing | Fix signed int + add tests | 2-3h |
| 4: Simulation | treasury.ts | ✓ Good | LOW | Integration test missing | Add tests, optional rate limit | 1-2h |

---

## Recommended Implementation Order

### Phase 1 (Critical — Do First)
1. **Fix i128 signed integer handling** (soroban.ts line 43-52)
   - Impact: Prevents silent balance corruption
   - Risk if not done: Potential for wrong settlement amounts in edge cases
   - Time: 30 min

2. **Increase MongoDB socket timeout** (mongo.ts line 197)
   - Impact: Prevents timeout cascade under load
   - Risk if not done: Transient 503 errors when Soroban takes >30s
   - Time: 5 min change + 1h load testing

### Phase 2 (High — Do Soon)
3. **Increase MongoDB pool sizes** (mongo.ts lines 185-189)
   - Impact: Prevents connection queue under concurrent load
   - Risk if not done: Queue timeouts during API load spike
   - Time: 10 min change + 1h load testing

4. **Add missing i128 boundary tests** (soroban.test.ts)
   - Impact: Confidence in conversion correctness
   - Risk if not done: Edge case bugs in future (balances at i128 limits)
   - Time: 1h

5. **Add validation for simulation response** (soroban.ts line 256-261)
   - Impact: Fail-fast on malformed response instead of silently using 0
   - Risk if not done: Silent balance mismatches if contract changes
   - Time: 30 min + 30 min tests

### Phase 3 (Medium — Next Sprint)
6. **Add ledger continuity check** (indexer.ts line 282-310)
   - Impact: Explicit logging of potential gaps
   - Risk if not done: Silent gap if indexer pauses >24h
   - Time: 1h

7. **Add simulation integration tests** (treasury.test.ts)
   - Impact: Verify read-only guarantee
   - Risk if not done: Accidental state mutation not caught
   - Time: 1-2h

### Phase 4 (Polish — Low Priority)
8. **Add rate limiting to simulation** (treasury.ts line 449)
   - Impact: DOS protection for RPC
   - Risk if not done: Malicious actor can DOS RPC
   - Time: 30 min

---

## File References

| File | Issue | Line Range | Change Type |
|------|-------|-----------|------------|
| mongo.ts | #2 | 184-208 | Configuration |
| soroban.ts | #3 | 43-52 | Algorithm |
| soroban.ts | #3 | 256-261 | Validation |
| indexer.ts | #1 | 282-310 | Logic |
| treasury.ts | #4 | 449 | Middleware |
| soroban.test.ts | #3 | 119-240 | Tests |
| indexer-redis-reconnect.test.ts | #1 | - | Tests |
| treasury.test.ts | #4 | - | Tests |

---

## Conclusion

**Overall Assessment:** Code is well-structured with good error handling, but three issues require attention:

1. **CRITICAL:** MongoDB timeout mismatch with Soroban (Issue 2 critical part) — can cause cascade failures
2. **CRITICAL:** i128 signed integer handling (Issue 3) — can silently corrupt balances  
3. **MEDIUM:** Connection pool undersized (Issue 2 medium part) — causes queue timeouts under load

All issues are fixable with localized changes. No architectural redesign needed.

**Next Steps:**
1. Review this analysis for correctness
2. Prioritize fixes: Phase 1 & 2 are mandatory, Phases 3-4 are recommended
3. Run load tests after pool tuning to verify improvements
4. Add missing test cases to improve confidence
