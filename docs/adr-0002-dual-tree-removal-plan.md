# ADR-0002: Plan to Remove Mirrored Source Trees

## Status

Proposed

## Context

[ADR-0001](./adr-0001-dual-source-trees.md) established the dual source tree structure (canonical `COMEBACKHERE-*` and legacy `contracts/`, `backend/`, `frontend/` directories) as a temporary migration strategy. This ADR defines the concrete plan, milestones, and timeline for completing that migration and removing the legacy trees.

## Problem

The dual trees introduce:
- **Contributor confusion** — unclear which tree to target, leading to PRs against the legacy tree.
- **Silent parity drift** — changes in one tree may not propagate to the other.
- **Documentation maintenance burden** — refs to legacy paths must be updated or the legacy tree cannot be deleted.
- **Repository bloat** — unnecessary files and directories occupying space and cluttering navigation.

Without a concrete plan and timeline, the migration risk stalling indefinitely.

## Proposed Solution

### Remaining Parity Gaps

Based on [docs/contract-tree-feature-parity.md](./contract-tree-feature-parity.md), the legacy `contracts/` tree lacks:

| Module | Missing in Legacy Tree | Issue(s) |
| --- | --- | --- |
| Invoice contract | `events.rs`, `test.rs`, `tests.rs` | [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) — audit trail (events) |
| Treasury contract | Entire module + `benchmark.rs`, `events.rs`, integration tests | [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182) — benchmarks |
| Compliance contract | Entire module | |
| Legacy-only modules | `settlement/`, `api-integration-tests/` | No equivalent in canonical tree |

For `backend/` and `frontend/`, both trees are substantially in sync but the legacy copies are not actively maintained.

### Migration Milestones

#### Milestone 1: Audit Trail & Documentation (Target: 2026-10-31)

**Objective:** Close the largest feature gaps and update all doc references to legacy paths.

- [ ] Complete [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) — Add event indexing to canonical invoice and treasury contracts.
- [ ] Complete [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182) — Add benchmarks to treasury contract.
- [ ] Add `events.rs`, `test.rs`, and `tests.rs` to legacy invoice contract OR document that legacy invoice is deprecated.
- [ ] Audit `docs/error-codes.md` and other doc files that reference `contracts/invoice/src/lib.rs`; update all refs to point to `COMEBACKHERE-contracts/contracts/invoice/src/lib.rs`.
- [ ] Update CONTRIBUTING.md to explicitly state legacy trees are deprecated as of this milestone.

**Exit Criteria:**
- No doc file contains a reference to legacy tree paths that would 404 after deletion.
- All doc references are updated to canonical paths or removed.

#### Milestone 2: Backend & Frontend Feature Parity (Target: 2026-11-30)

**Objective:** Ensure backend and frontend are in sync, with no open PRs targeting the legacy trees.

- [ ] Verify `backend/` is byte-identical to `comebackhere-backend/` (or document intentional divergence).
- [ ] Verify `frontend/` is byte-identical to `comebackhere-frontend/` (or document intentional divergence).
- [ ] Resolve `contracts/settlement/` vs `COMEBACKHERE-contracts/contracts/treasury/` naming — decide whether legacy settlement is kept as a separate module or fully deprecated.
- [ ] Close or migrate any open PRs targeting `contracts/`, `backend/`, or `frontend/` to canonical paths.

**Exit Criteria:**
- No open PRs target the legacy trees.
- All intentional divergence is documented.
- No legacy-only modules remain (e.g., `settlement/` is either ported or explicitly deprecated).

#### Milestone 3: Test Coverage Assertion (Target: 2026-12-15)

**Objective:** Confirm that removing the legacy trees will not remove untested code.

- [ ] Run `cargo test --manifest-path COMEBACKHERE-contracts/Cargo.toml` to confirm full canonical contract coverage.
- [ ] Verify all contract features in the canonical tree are exercised by CI or integration tests.
- [ ] Run backend and frontend test suites to confirm they pass on canonical trees.
- [ ] Update CI to explicitly reject any new PRs that add code to `contracts/`, `backend/`, or `frontend/`.

**Exit Criteria:**
- CI coverage for canonical trees is documented and green.
- All contract logic in the canonical tree is tested.

### Exit Criteria for Tree Deletion

A mirrored tree is safe to delete when:

1. **No doc references remain** that would 404 or become invalid (see Milestone 1).
2. **All features are ported to the canonical tree** or explicitly removed (see Milestone 2).
3. **No open PRs target that tree** (see Milestone 2).
4. **CI is updated to reject new additions** to the legacy tree (see Milestone 3).
5. **A single-commit removal PR** is opened that:
   - Deletes the legacy tree directory.
   - Updates any remaining ARCHITECTURE.md, CONTRIBUTING.md, and README.md refs.
   - Adds an entry to CHANGELOG.md under `[Unreleased] > Removed` documenting the tree deletion.

### Proposed Deletion Order

1. **Contracts first:** `contracts/` (legacy Rust) — highest parity drift, clearest deprecation path.
2. **Backend second:** `backend/` (legacy Node) — simpler than frontend, fewer external integrations.
3. **Frontend last:** `frontend/` (legacy React) — highest user-facing risk; ensure Freighter wallet integrations work identically in `comebackhere-frontend/` first.

### Timeline Summary

| Milestone | Target Date | Effort | Deliverable |
| --- | --- | --- | --- |
| Milestone 1 | 2026-10-31 | 2–3 weeks | Feature gaps closed, docs updated |
| Milestone 2 | 2026-11-30 | 1–2 weeks | Backend/frontend parity confirmed, PRs migrated |
| Milestone 3 | 2026-12-15 | 1 week | Test coverage assertion, CI updated |
| Deletion PRs | 2026-12-22 | 1–2 days (3 separate PRs) | Legacy trees removed |

**Expected completion:** End of Q4 2026.

## Consequences

### Positive

- Contributor confusion eliminated — single source of truth for each layer.
- Maintenance burden reduced — no parity gaps to track or reconcile.
- Repository is leaner and faster to clone/navigate.
- CI jobs can be simplified (no file-matching rules for legacy trees).

### Negative

- Requires coordinated effort across multiple milestones.
- Risk of breaking external references to legacy paths (mitigated by Milestone 1 audit).
- May require rebasing in-flight PRs if they target legacy trees (mitigated by early communication).

### Risks

- **Drift during migration** — if features land in canonical tree but not legacy, the gap grows. **Mitigation:** Freeze new feature work on legacy tree starting immediately; accept only critical fixes.
- **Incomplete documentation audit** — external docs or user guides might reference legacy paths. **Mitigation:** Search the repo and linked docs/ for all refs before deletion.
- **Freighter wallet integrations** — if frontend changes affect wallet communication, the swap must be verified rigorously. **Mitigation:** End-to-end test on local network before Milestone 3 gate.

## References

- [ADR-0001: Dual Contract/Backend/Frontend Source Trees](./adr-0001-dual-source-trees.md)
- [docs/contract-tree-feature-parity.md](./contract-tree-feature-parity.md)
- [ARCHITECTURE.md](../ARCHITECTURE.md) — canonical vs mirrored trees.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — tree targeting guidelines.
- [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) — Add audit trail (event indexing).
- [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182) — Add benchmarks to treasury contract.
