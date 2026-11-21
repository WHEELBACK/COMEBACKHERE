# Four Issues Analysis — Document Index

This directory contains a comprehensive analysis of four critical code areas in the COMEBACKHERE backend. Read the documents in this order:

## 1. **FOUR_ISSUES_SUMMARY.md** — Start Here
   - Executive summary of all four issues
   - Current status and severity levels
   - Test coverage assessment
   - Implementation recommendations with priority order
   - **Read Time:** 10 minutes

## 2. **FOUR_ISSUES_QUICK_REFERENCE.md** — For Developers
   - Exact line numbers for every issue
   - Code snippets showing problems
   - Quick fixes (copy-paste ready)
   - Test commands and deployment checklist
   - **Read Time:** 15 minutes
   - **Use Case:** When implementing fixes

## 3. **FOUR_ISSUES_ANALYSIS.md** — Deep Dive
   - Detailed analysis of each issue
   - Current implementation status
   - All identified gaps explained
   - Test coverage details
   - Recommended fixes with specifics
   - **Read Time:** 30 minutes
   - **Use Case:** Understanding the full context

## 4. **FOUR_ISSUES_FIXES.md** — Implementation Guide
   - Step-by-step code fixes for each issue
   - Before/after code examples
   - Justification for each change
   - Test cases to add
   - **Read Time:** 20 minutes
   - **Use Case:** Implementing the fixes

---

## Issues at a Glance

| # | Component | Status | Severity | Priority |
|---|-----------|--------|----------|----------|
| 1 | **indexer.ts** — Redis reconnect backoff & ledger sync | ✓ Good | MEDIUM | Phase 3 |
| 2 | **mongo.ts** — Pool size & timeout tuning | ⚠ Risky | **CRITICAL** | Phase 1-2 |
| 3 | **soroban.ts** — i128 conversion helpers | ⚠ Risky | **CRITICAL** | Phase 1-2 |
| 4 | **treasury.ts** — Settlement simulation | ✓ Good | LOW | Phase 4 |

---

## Quick Navigation

### By Issue Number
- **Issue 1 — WebSocket/Redis:** See SUMMARY (page 1-2), ANALYSIS (page 3-4), FIXES (page 3)
- **Issue 2 — MongoDB:** See SUMMARY (page 2-3), ANALYSIS (page 5-13), FIXES (page 13-15)
- **Issue 3 — i128:** See SUMMARY (page 3-4), ANALYSIS (page 14-26), FIXES (page 16-20)
- **Issue 4 — Simulation:** See SUMMARY (page 4), ANALYSIS (page 27-34), FIXES (page 20-22)

### By Role
- **Engineering Manager:** Read SUMMARY.md (10 min)
- **Developer (Implementing Fixes):** Read QUICK_REFERENCE.md (15 min), then FIXES.md (20 min)
- **Code Reviewer:** Read ANALYSIS.md (30 min) + FIXES.md (20 min)
- **Test Engineer:** Read ANALYSIS.md (focus on test gaps) + FIXES.md (test cases)

### By Urgency
- **Critical (Do First):** Issue 2 (socket timeout), Issue 3 (i128 signed)
- **High (Do Soon):** Issue 2 (pool size), Issue 3 (boundary tests & validation)
- **Medium (Next Sprint):** Issue 1 (continuity check), Issue 4 (tests)
- **Low (Polish):** Issue 4 (rate limiting)

---

## Files Modified / Created

### Analysis Documents (This Folder)
- ✅ FOUR_ISSUES_SUMMARY.md
- ✅ FOUR_ISSUES_ANALYSIS.md
- ✅ FOUR_ISSUES_FIXES.md
- ✅ FOUR_ISSUES_QUICK_REFERENCE.md
- ✅ FOUR_ISSUES_INDEX.md (this file)

### Source Files to Modify (After Reading)
- `src/db/mongo.ts` — Lines 184-208
- `src/lib/soroban.ts` — Lines 43-52, 256-261
- `src/indexer.ts` — Lines 282-310
- `src/routes/treasury.ts` — Line 449
- `src/tests/soroban.test.ts` — Add tests
- `src/tests/treasury.test.ts` — Add tests

---

## Key Statistics

| Metric | Value |
|--------|-------|
| Total Issues Analyzed | 4 |
| Sub-Issues Identified | 8 |
| Critical Issues | 2 |
| Test Coverage Gaps | 5 |
| Lines of Code to Change | ~100 |
| New Tests to Add | ~20 |
| Implementation Time | 8-10 hours |
| Load Testing Time | 2-3 hours |

---

## Implementation Checklist

### Phase 1 (Critical)
- [ ] Fix i128 signed integer handling (soroban.ts line 43-52)
- [ ] Increase MongoDB socket timeout to 60s (mongo.ts line 197)

### Phase 2 (High)
- [ ] Increase MongoDB pool sizes (mongo.ts lines 185-189)
- [ ] Add MongoDB TCP keepalive (mongo.ts line 208)
- [ ] Add i128 boundary value tests (soroban.test.ts)
- [ ] Add settlement simulation response validation (soroban.ts line 256-261)

### Phase 3 (Medium)
- [ ] Add ledger continuity check (indexer.ts line 282-310)
- [ ] Add simulation endpoint integration tests (treasury.test.ts)

### Phase 4 (Low/Polish)
- [ ] Add rate limiting to simulation endpoint (treasury.ts line 449)

---

## Testing After Implementation

```bash
# Unit tests
npm test

# All tests with coverage
npm test -- --coverage

# Specific test file
npm test -- soroban.test.ts

# Linting
npm run lint

# Build
npm run build

# Load testing (manual)
# Monitor: connection pool, timeouts, query latency
# Target: 50 concurrent req/sec, 0% timeout rate
```

---

## Questions & Answers

**Q: Which issue is most critical?**
A: Issue 2 (socket timeout conflict) and Issue 3 (i128 signed int). Both can silently cause failures.

**Q: Can I skip the fixes?**
A: No. At minimum, fix Issues 2b (socket timeout) and 3b (i128 signed). The others are high-probability.

**Q: How long will fixes take?**
A: 8-10 hours coding + testing. Add 2-3 hours for load testing to verify pool tuning.

**Q: Do I need to restart services?**
A: MongoDB pool changes require restart. i128 fix is in-service deployment. Indexer check is in-service.

**Q: Will this break existing behavior?**
A: No. All changes are backward-compatible. Pool increase and timeout raise only improve behavior.

**Q: What if I only fix some issues?**
A: At minimum: fix 2b (socket timeout) + 3b (i128 signed). These are critical. Others can be phased in.

---

## Document Version

- **Created:** 2025-01-24
- **Last Updated:** 2025-01-24
- **Analysis Scope:** indexer.ts, mongo.ts, soroban.ts, treasury.ts
- **Coverage:** Implementation status, gaps, test coverage, fixes, recommendations

---

## Contact & Escalation

- Critical issues: See FOUR_ISSUES_SUMMARY.md "Critical Issues" section
- Implementation details: See FOUR_ISSUES_FIXES.md with code examples
- Test coverage gaps: See FOUR_ISSUES_ANALYSIS.md "Test Coverage" sections
- Line-by-line reference: See FOUR_ISSUES_QUICK_REFERENCE.md

---

**Next Step:** Read FOUR_ISSUES_SUMMARY.md
