# Changelog

All notable changes to the COMEBACKHERE Protocol will be documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are organized by component: **Contract**, **Backend**, and **Frontend**.

---

## [Unreleased]

### Contract

#### Added

- Invoice contract with `create_invoice` supporting minimum amount validation.
- Treasury contract with multi-sig settlement proposals, approvals, and
  execution.
- Dispute lifecycle: `raise_dispute` and `resolve_dispute` on treasury.
- Token allowlist management (`add_token_to_allowlist`,
  `remove_token_from_allowlist`).
- Compliance contract for address verification.
- Contract pause/unpause functionality.
- Paginated `get_pending_settlements` query with configurable offset and limit.

### Backend

#### Added

- Redis-backed event consumer for contract event streaming.
- REST API for treasury operations (settlements, disputes, signers).
- Webhook delivery pipeline via Redis pub/sub.

### Frontend

#### Added

- Merchant dashboard with stats overview (pending invoices, total settled, open
  disputes).
- Sidebar navigation with route-based active state.
- Settlement proposal form with approval workflow.
- Dispute voting panel with real-time weight tracking.
- Signer management UI (add, remove, rotate).
- ABI Explorer for inspecting deployed contract interfaces.
- Onboarding wizard for new merchant setup.

---

## [0.2.0] - 2026-09-15

### Contract

#### Changed

- Treasury contract error handling: replaced panic! with proper `ContractError` returns.
- Storage TTL management: extended persistent entry lifetimes to prevent premature eviction.

#### Fixed

- Instance storage migration for admin and configuration keys.
- Per-address bet list pagination to bound memory usage.

### Backend

#### Fixed

- Cache shutdown and environment variable handling in Docker containers.
- API hardening and dispute resolution workflows.

### Frontend

#### Added

- Merchant dashboard tabs for viewing different payment states.
- UX improvements for wallet connection and state management.

#### Changed

- Event indexing and analytics CSV export support.

---

## [0.1.1] - 2026-08-20

### Contract

#### Added

- Benchmarks for treasury contract operations (see [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182)).
- Event modules for invoice and treasury contract audit trails (see [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186)).
- Integration tests for settlement multisig workflows.

### Backend

#### Added

- Additional webhook delivery retry logic.
- Enhanced error reporting and logging.

#### Fixed

- Request handling for concurrent webhook deliveries.

### Frontend

#### Added

- Merchant tabs feature for wallet state visualization.
- UX polish for navigation and form inputs.

#### Changed

- Freighter wallet integration improvements.

---

## [0.1.0] - 2026-06-26

Initial release of the COMEBACKHERE Protocol workspace.

### Contract

#### Added

- Soroban invoice contract scaffold with `InvoiceStatus` enum and
  `InvoiceError` definitions.
- Treasury contract with settlement lifecycle and multi-sig governance.

### Backend

#### Added

- Docker Compose environment with Soroban standalone node and Redis.
- Deployment scripts for local, testnet, and mainnet environments.
- ABI snapshot generation and verification tooling.

### Frontend

#### Added

- React + Vite project setup with TypeScript.
- Dashboard layout with sidebar navigation.
- Settlement, dispute, and signer management views.

---

## Backfill Notes

The changelog was restructured on 2026-09-25 to adopt the Keep a Changelog format more thoroughly and backfill notable merged PRs since v0.1.0. Entries in versions [0.1.1] and [0.2.0] are grouped by approximate month/release window, as exact version tags were not available for all merged PRs. Breaking changes are marked in descriptions.

For future entries:
- Use semver versioning: MAJOR.MINOR.PATCH
- Mark breaking changes clearly (e.g., "**BREAKING:**" prefix)
- Group changes under "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"
- Reference issue numbers (e.g., "[#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186)") for traceability
