# Contract Source Tree Migration Record

The legacy contract workspace was removed in PR #948. `COMEBACKHERE-contracts/` is now the only in-repository contract source and is covered by the canonical contract CI workflow. The inventory below records the differences that led to the removal; it is historical, not a current parity checklist.

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
| **API integration tests** | ✅ `contracts/api-integration-tests/` | ✅ `contracts/api-integration-tests/` | Canonical suite exercises the Soroban RPC and treasury contract APIs |

---

## Cross-referenced issues

| Issue | Description | Status |
| --- | --- | --- |
| [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182) | Add benchmarks to treasury contract | ✅ Present in canonical tree (`benchmark.rs`) |
| [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) | Add audit trail (event indexing) | ✅ Present in canonical tree (`events.rs` in invoice and treasury) |

---

## Historical notes

The historical inventory above records the legacy invoice gaps and the treasury/compliance features that were not mirrored. The settlement-only legacy contract was superseded by the canonical treasury contract. New work belongs in `COMEBACKHERE-contracts/`.
