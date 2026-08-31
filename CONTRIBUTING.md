# Contributing

## Which stack do I work on?

The repository contains two parallel source trees for each layer — Rust
contracts, Node backend, and React frontend. From directory names alone it is
not obvious which tree receives a given change.

The short rule:

- Prefer `COMEBACKHERE-contracts/` for contract changes
- Prefer `comebackhere-backend/` for backend changes
- Prefer `comebackhere-frontend/` for frontend changes

These are the trees built and tested by CI (`make test`,
`.github/workflows/ci-contracts.yml`, `ci.yml`). They are the canonical
source of truth and the only path that gets the full required-status-check
matrix on every PR.

The sibling-less top-level `contracts/`, `backend/`, and `frontend/`
directories are also valid PR targets — they contain older in-tree copies of
the same sources and are still referenced from documentation (for example,
`docs/error-codes.md` cites `contracts/invoice/src/lib.rs` as the source of
`InvoiceError`). They do not, however, have a dedicated CI workflow of their
own, so changes there rely on whichever `ci-*.yml` job happens to match the
files. When in doubt, target the canonical `COMEBACKHERE-*` tree.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full reasoning, the exact
directory layout, and how the mirrors are kept in step.

## Local hooks

Install [pre-commit](https://pre-commit.com/) and enable the repository hooks:

```sh
pip install pre-commit
pre-commit install
```

Hooks run on each commit and enforce:

- ABI snapshot hygiene (`abis/*.json` must change together with `COMEBACKHERE-contracts/contracts/*/src/`)
- Markdown linting
- Trailing whitespace detection
- End-of-file fixing (ensure files end with a newline)
- JSON validation

Run all hooks manually:

```sh
pre-commit run --all-files
```

## Branch Protection

The `main` branch is protected. Direct pushes are not allowed; all changes must go through a pull request.

### Required status checks

Only **one** check must be listed in branch protection: **`all-checks-passed`**
(from `.github/workflows/ci-summary.yml`).

That workflow fans in every other CI workflow via `needs:`, so a single green
check means all of the following have passed:

- `ci / frontend build-and-lint` — TypeScript type check, lint, and build
- `ci / contract tests` — Soroban contract compilation and unit tests
- `ci / abi metadata` — ABI metadata consistent with contract source
- `ci / abi snapshots` — ABI snapshot files are up to date
- `ci / contract coverage` — contract line coverage above threshold
- `ci / error docs sync` — error-code variants are all documented
- `ci / backend tests` — Rust and TypeScript backend test suites
- `ci / lint docs` — Markdown documentation linting

When adding a new workflow, wire it into `ci-summary.yml` rather than
adding it directly to branch protection.

### Required reviews

- At least **1 approving review** is required for all PRs.
- At least **2 approving reviews** are required for PRs that touch mainnet-related paths
  (`docs/MAINNET_DEPLOYMENT.md`, deployment scripts, or governance configuration).

## ABI snapshots

After changing contract interfaces (in `COMEBACKHERE-contracts/`), regenerate and verify ABI metadata:

```sh
make update-abi-snapshots
# or
just snapshot

make check-abi-snapshots
# or
just check-snapshot
```
