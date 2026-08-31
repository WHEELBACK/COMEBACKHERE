# Contract Source Tree Feature Parity

This page tracks feature parity between the two in-tree contract workspaces:

- **`COMEBACKHERE-contracts/`** — the canonical, CI-enforced workspace.
- **`contracts/`** — the legacy, mirrored workspace.

> **Rule of thumb:** target `COMEBACKHERE-contracts/` for all new work.
> See [ARCHITECTURE.md](../ARCHITECTURE.md) for background.

---

## Workspace layout

| | `COMEBACKHERE-contracts/` | `contracts/` |
| --- | --- | --- |
| Workspace file | `Cargo.toml` (members: `contracts/*`) | `Cargo.toml` (members listed explicitly) |
| CI coverage | `ci-contracts.yml` (build + test) | No dedicated CI; only file-matching jobs |
| ABI generation | Source for `make update-abi-snapshots` | Not used for ABI snapshots |

---

## Contract and module inventory

| Module | `COMEBACKHERE-contracts/` | `contracts/` | Notes |
| --- | --- | --- | --- |
| **Invoice contract** | ✅ `contracts/invoice/` | ✅ `contracts/invoice/` | Legacy copy lacks `events.rs`, `test.rs`, `tests.rs` |
| Invoice — `events.rs` | ✅ | ❌ | |
| Invoice — `test.rs` | ✅ | ❌ | |
| Invoice — `tests.rs` | ✅ | ❌ | |
| **Treasury contract** | ✅ `contracts/treasury/` | ❌ | Legacy tree has `settlement/` instead (different contract) |
| Treasury — `benchmark.rs` | ✅ | ❌ | |
| Treasury — `events.rs` | ✅ | ❌ | |
| Treasury — `integration_dispute_lifecycle.rs` | ✅ | ❌ | |
| Treasury — `integration_settlement_multisig.rs` | ✅ | ❌ | |
| Treasury — `integration_update_merchant.rs` | ✅ | ❌ | |
| **Compliance contract** | ✅ `contracts/compliance/` | ❌ | Not present in legacy tree |
| **Settlement contract** | ❌ | ✅ `contracts/settlement/` | Legacy-only; superseded by treasury in canonical tree |
| **API integration tests** | ❌ | ✅ `contracts/api-integration-tests/` | Legacy-only; no equivalent in canonical workspace |

---

## Cross-referenced issues

| Issue | Description | Status |
| --- | --- | --- |
| [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182) | Add benchmarks to treasury contract | ✅ Present in canonical tree (`benchmark.rs`) |
| [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) | Add audit trail (event indexing) | ✅ Present in canonical tree (`events.rs` in invoice and treasury) |

---

## When to target the legacy tree

The legacy `contracts/` tree is a valid PR target only when:

1. The change is a **narrow fix** to a file that CI already covers
   (e.g. a doc tweak or a small Rust fix in `contracts/invoice/src/lib.rs`).
2. You are intentionally maintaining backward compatibility with the
   legacy workspace for a transitional period.

For **all new features, bug fixes, and contract changes**, target
`COMEBACKHERE-contracts/` to inherit full CI coverage.

---

## Migration checklist

As features are ported or parity issues resolved, update this table by
flipping the status column. The goal is full parity — at which point the
legacy tree can be removed.

- [ ] Port `api-integration-tests` to canonical workspace (or remove)
- [ ] Resolve `settlement` vs `treasury` naming alignment
- [ ] Add `events.rs` and `test.rs` / `tests.rs` to legacy invoice (or remove legacy tree)
- [ ] Remove legacy tree once no doc references remain
