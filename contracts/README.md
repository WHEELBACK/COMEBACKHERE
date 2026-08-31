# `contracts/`

This is the **legacy, mirrored** Rust contracts tree. It is a valid PR
target — it does not have its own CI workflow, and it is still referenced
from documentation such as [`docs/error-codes.md`](../docs/error-codes.md)
— but it is not the canonical source of truth.

**[`COMEBACKHERE-contracts/`](../COMEBACKHERE-contracts/) is canonical for
CI.** New contract work should target that tree: it is the one built and
tested by `make test` and `.github/workflows/ci-contracts.yml` (and the
other `ci-*.yml` workflows), and it is the source ABI snapshots in
[`abis/`](../abis/) are generated from.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md#which-stack-do-i-work-on) for the
full rule on which tree to target, and
[`ARCHITECTURE.md`](../ARCHITECTURE.md) for why both trees exist and how
they're kept in sync.
