# ADR-0001: Dual Contract/Backend/Frontend Source Trees

## Status

Accepted

## Context

The repository contains two parallel source trees for each layer of the stack:

| Layer | Canonical tree | Legacy tree |
| --- | --- | --- |
| Contracts (Rust) | `COMEBACKHERE-contracts/` | Removed in PR #948 |
| Backend (Node/Express) | `comebackhere-backend/` | `backend/` |
| Frontend (React) | `comebackhere-frontend/` | `frontend/` |

The legacy trees were the original in-tree copies of the source code. The
contract mirror was removed in PR #948; the backend and frontend mirrors remain.
When the project reorganised to use
dedicated CI workflows per layer (`.github/workflows/ci-contracts.yml`,
`ci.yml`), new canonical directories were introduced with the `COMEBACKHERE-`
prefix. The legacy trees were kept in place rather than deleted.

### Why the duplication was introduced

1. **CI restructure.** The canonical trees are wired into GitHub Actions
   workflows that run `cargo test`, `npm ci`, `tsc --noEmit`, and
   `npm run build` on every PR. The former contract mirror had no
   equivalent dedicated CI coverage.

2. **Backward-compatible doc references.** Documentation once cited
   files in the contract mirror. Those references now point to canonical
   contract sources or identify historical error codes.

3. **Reviewer familiarity.** Contributors accustomed to the old backend
   and frontend paths could continue reviewing changes there during the
   transition period.

4. **No-breaking-change migration.** Deleting the legacy trees in a
   single PR would force every open PR and branch to rebase, creating
   unnecessary churn across dozens of in-flight contributions.

### What each tree contains

The canonical trees carry the full current source plus event modules,
benchmark suites, integration tests, and ABI-generation hooks. The
remaining backend and frontend mirrors carry older snapshots.

See [docs/contract-tree-feature-parity.md](./contract-tree-feature-parity.md)
for a detailed comparison.

---

## Decision

The contract migration is complete: the legacy contract tree was removed
in PR #948, and its documentation and CI references were updated. The
backend and frontend mirrors remain until their migrations are complete.
For those remaining mirrors:

1. **All doc references** to legacy paths are updated or removed.
2. **Full feature parity** is achieved (see the migration checklist in
   `contract-tree-feature-parity.md`).
3. **No open PRs** target the legacy trees.
4. A **single PR** removes each remaining legacy tree and updates its
   references.

Until then, the rule is simple:

> New work targets the `COMEBACKHERE-*` tree. Follow the repository's
> contributor guidance for any remaining backend or frontend mirrors.

---

## Consequences

### Positive

- No breaking changes to existing PRs or branches.
- Contributors can onboard at their own pace without re-learning paths.
- CI coverage is unambiguous — the canonical tree is the only one with
  dedicated status checks.

### Negative

- Contributors must learn which tree to target (mitigated by
  `CONTRIBUTING.md` and `ARCHITECTURE.md`).
- Feature parity gaps can accumulate silently (mitigated by the
  parity table in `docs/contract-tree-feature-parity.md`).
- The repository carries more files than strictly necessary until the
  legacy trees are removed.

### Risks

- If the migration stalls, the legacy trees could drift far enough
  apart that porting changes becomes error-prone. The parity table
  and regular reviews should prevent this.

---

## References

- [ARCHITECTURE.md](../ARCHITECTURE.md) — canonical vs mirrored trees.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — which tree to target.
- [docs/contract-tree-feature-parity.md](./contract-tree-feature-parity.md) — feature parity comparison.
