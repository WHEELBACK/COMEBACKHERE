# Threat Model for COMEBACKHERE Protocol

This document outlines potential threats to fund-handling and critical-path operations in the COMEBACKHERE protocol, using STRIDE threat categories. It serves as a reference for security reviewers and contributors assessing PRs that touch fund-safety-critical code.

**Last updated:** 2026-09-25  
**Scope:** Invoice escrow, treasury settlement & multisig, compliance checks, webhooks, backend admin routes.

---

## Threat Categories (STRIDE)

- **Spoofing Identity** — Attacker impersonates a legitimate actor (merchant, payer, signer, backend).
- **Tampering with Data** — Attacker modifies data in transit or at rest (invoices, escrow, settlement proposals, webhooks).
- **Repudiation** — Actor denies performing an action, leaving no audit trail.
- **Information Disclosure** — Sensitive data (private keys, escrow amounts, signer lists) leaks to unauthorized parties.
- **Denial of Service** — Attacker prevents legitimate operations (invoice creation, payment, settlement).
- **Elevation of Privilege** — Attacker gains unauthorized access to admin functions, contract upgrades, or signer authority.

---

## Asset: Invoice Escrow

**Flow:** Payer transfers USDC to escrow contract → contract holds funds until merchant releases or refund window closes.

### Threats

#### Spoofing Identity

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Payer impersonated | Attacker signs a payment with someone else's private key. | Stellar SDK enforces valid signature before contract invocation; Freighter wallet holds private keys locally. | If private key is stolen (compromised wallet/device), escrow releases to attacker-controlled merchant. **Mitigation in progress:** See [#150](https://github.com/WHEELBACK/COMEBACKHERE/issues/150) — multi-factor confirmation for escrow release. |
| Merchant key stolen | Attacker with merchant's private key can release escrow and claim funds. | Private key stored in Freighter or hardware wallet; backend stores public keys only. | If Freighter is compromised or key is extracted, funds are lost. **Mitigation:** Educate merchants on key security; consider escrow-recovery workflow. |

#### Tampering with Data

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Invoice amount modified after creation | Attacker modifies the `amount` field in the contract. | Contracts are immutable WASM; all state transitions validated in `lib.rs`. Invoice amount is part of the contract state (cannot be modified post-creation). | None known. State root is verified on-chain. |
| Escrow recipient changed | Attacker changes the `merchant` or escrow destination address. | Escrow recipient is hardcoded in the contract invoke; no proxy or redirection. | If contract is upgraded (via admin key), escrow destination could change. **Mitigation:** Upgrade must pass governance review; see multisig governance section. |
| Refund grace period extended | Attacker extends the refund window to allow later claims. | Grace period is immutable; set at invoice creation time. Backend reads `grace_window` from contract and validates. | If contract is upgraded, grace period rules change. Governance review required. |

#### Repudiation

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Merchant denies receiving payment | Merchant claims escrow release didn't happen or payer didn't pay. | All escrow events are logged to Redis and indexed in MongoDB. Stellar ledger provides immutable event history. | Backend indexer could fail silently; events might not be persisted if Redis/MongoDB are unavailable. **Mitigation:** See [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) — event audit trail with storage verification. |
| Payer denies authorization | Payer claims they didn't approve the payment. | Stellar blockchain contains cryptographic proof of signature; impossible to deny. | User may have clicked "approve" without understanding. **Mitigation:** UI shows clear confirmation; terms of service document. |

#### Information Disclosure

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Invoice details leaked | Invoice amounts, payer/merchant identities, due dates visible to unauthorized parties. | On-chain, all invoice data is public (Stellar ledger is transparent). Backend database requires MongoDB authentication. | If MongoDB connection is exposed (unencrypted over network), data is readable. **Mitigation:** MongoDB runs on private Docker network; external clients must authenticate. |
| Merchant private key exposed | Attacker gains access to merchant's private key (in Freighter or backend config). | Freighter manages keys locally; backend stores public keys only and never stores private keys. | If merchant's device is compromised, key is extractable. **Mitigation:** Educate on key security; hardware wallet support. |
| Escrow amounts visible in contract state | Any observer can query escrow amounts on-chain. | By design — Stellar is transparent; no confidential escrow amounts. | Adversary can correlate invoice creator (merchant) with payment amounts and timing, inferring business volume. **Mitigation:** Accepted trade-off for on-chain auditability; privacy-sensitive operators should use separate merchant identities. |

#### Denial of Service

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Spam invoice creation | Attacker creates thousands of invoices to overwhelm the network. | Soroban network has per-account rate limits (15 invokes per ledger); contract storage has size limits. | If an attacker controls many accounts, they can create many invoices. **Mitigation:** Backend rate-limits invoice creation per merchant; see [#140](https://github.com/WHEELBACK/COMEBACKHERE/issues/140). |
| Escrow release blocked | Attacker repeatedly calls a non-existent refund function to jam the contract. | Contract only accepts valid invoke names; invalid calls fail fast. | Malformed invoke attempts consume gas. Network recovers quickly. **Mitigation:** None required; protocol handles gracefully. |

#### Elevation of Privilege

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Attacker claims merchant role | Attacker invokes `release_escrow` without being the invoice merchant. | Contract enforces `invoice.merchant == caller` check in `release_escrow`. | If merchant private key is compromised, check fails to prevent misuse. **Mitigation:** Key security best practices. |

---

## Asset: Treasury Settlement & Multisig Governance

**Flow:** Signers propose settlement → settle batch of invoices → multisig approval → settlement executes.

### Threats

#### Spoofing Identity

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Rogue signer | Attacker with a signer's private key creates fake settlement proposals. | Private keys held by signers locally; backend stores public keys only. Signer list is stored in contract state and is immutable per proposal. | If signer key is compromised, attacker can sign proposals. **Mitigation:** Signer key rotation via governance (replace key in signer list); see multisig section. |
| Admin key stolen | Attacker with admin key can add/remove signers, execute settlements without quorum. | Admin key is separate from signer keys; stored securely by operator. Backend enforces quorum checks before settlement. | If admin key is exposed, attacker can upgrade contract or bypass governance. **Mitigation:** Admin key stored in hardware wallet or secure key management system; governance PR review for all upgrades. |

#### Tampering with Data

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Settlement amount modified | Attacker changes the total amount to settle before execution. | Settlement amount is computed from the batch of invoices at creation time; immutable until approval. Quorum must re-approve if details change. | If contract state is corrupted (unlikely but possible in Soroban 1.x), settlement amounts could be incorrect. **Mitigation:** Contract audit; see [#155](https://github.com/WHEELBACK/COMEBACKHERE/issues/155) — formal verification of arithmetic. |
| Signer list changed mid-vote | Attacker removes signers from the list while a proposal is pending approval. | Signer list is frozen for each proposal; voting uses a snapshot of signers at proposal creation. New signer changes don't retroactively affect pending votes. | If contract state storage TTL expires before quorum is reached, proposal is lost. **Mitigation:** Extend TTL for pending proposals; see [#152](https://github.com/WHEELBACK/COMEBACKHERE/issues/152). |

#### Repudiation

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Signer denies approval | Signer claims they didn't approve a settlement. | All settlement approval events are logged to contract ledger; Stellar provides immutable proof. | If event indexing fails, backend has no record of approval. **Mitigation:** See [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) — audit trail. |

#### Information Disclosure

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Settlement amounts visible | All settlement batches and amounts are public on-chain. | By design — Stellar is transparent. Backend does not store settlement amounts in encrypted form. | Observers can infer business volume and signer voting patterns. **Mitigation:** Accepted trade-off; if needed, use separate settlement accounts for privacy. |
| Signer list publicly visible | Addresses of all treasury signers are visible on-chain. | By design — signer list is contract state. Useful for audit but leaks governance structure. | Adversary can target signers for social engineering or key theft. **Mitigation:** Educate signers on key security; consider signer identity obfuscation (future enhancement). |

#### Denial of Service

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Spam settlement proposals | Attacker creates many proposals to fill storage or delay voting. | Soroban storage has size limits; contract can enforce max proposals per signer. | Storage TTL could be exceeded if proposals aren't resolved. **Mitigation:** Contract cleanup logic to prune expired proposals; see [#152](https://github.com/WHEELBACK/COMEBACKHERE/issues/152). |
| Voting stalled | Attacker repeatedly proposes settlements that fail quorum, jamming the queue. | No queue — each proposal is independent. New proposals can be created. | Only nuisance; voting always progresses for new proposals. **Mitigation:** None required. |

#### Elevation of Privilege

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Non-signer executes settlement | Attacker calls `execute_settlement` without being a signer. | Contract enforces `approvals.contains(caller)` check. | If signer key is stolen, this check passes. **Mitigation:** Signer key security. |
| Insufficient quorum bypassed | Attacker executes settlement with fewer approvals than required. | Contract enforces `approvals.len() >= required_quorum` check in `execute_settlement`. | None known. Check is straightforward and auditable. **Mitigation:** Regular contract audits. |

---

## Asset: Compliance Checks

**Flow:** Backend queries compliance contract before allowing invoice operations.

### Threats

#### Spoofing Identity

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Attacker submits false compliance attestation | Attacker impersonates a compliance provider and certifies a bad actor. | Only admin-approved compliance providers are in the allowlist; backend checks provider identity. | If admin adds a rogue provider, fake certifications are accepted. **Mitigation:** Governance review of provider additions; see admin routes section. |

#### Tampering with Data

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Compliance certificate modified | Attacker changes a valid cert to cover a different address. | Certificates are stored in contract state; immutable once written. Provider cannot retroactively change a cert. | If contract state storage is corrupted, certs could be lost or modified. **Mitigation:** Contract audit; storage verification. |
| Allowlist of providers changed | Attacker removes a trusted provider or adds an untrusted one. | Only admin (via governance) can modify provider list. | If admin key is stolen, attacker can modify allowlist. **Mitigation:** Admin key security; governance oversight. |

#### Information Disclosure

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Compliance records are public | All compliance attestations are visible on-chain; can infer identity verification details. | By design — Stellar is transparent. Compliance records are minimal (address, provider, timestamp). | Adversary can infer which providers service which regions or users. **Mitigation:** Accepted trade-off; if needed, use privacy-preserving providers (e.g., zero-knowledge proofs). |

#### Elevation of Privilege

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Non-compliance-provider submits cert | Attacker claims to be a compliance provider. | Contract checks `provider in allowlist` before accepting cert. | If allowlist is compromised (admin key stolen), check fails. **Mitigation:** Admin key security. |

---

## Asset: Webhooks

**Flow:** Backend sends signed webhook events to merchant servers when invoices/settlements change.

### Threats

#### Spoofing Identity

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Attacker forges webhook signature | Attacker sends fake webhook claiming to be from the backend. | Backend signs webhooks with `WEBHOOK_SECRET` (HMAC-SHA256); merchant must verify signature. | If `WEBHOOK_SECRET` is leaked or weak, signature is forgeable. **Mitigation:** Strong secret (≥32 chars); docs recommend env-var-based secrets. |
| Webhook receiver spoofed | Attacker redirects webhook URL to their server during env setup. | Backend reads webhook URL from merchant profile in MongoDB. | If MongoDB is compromised, webhook URL can be changed. **Mitigation:** MongoDB authentication + network isolation. |

#### Tampering with Data

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Webhook payload modified in transit | Attacker intercepts HTTP and changes invoice amount. | Webhooks are HTTPS only (enforced by backend). Payload is signed; merchant verifies. | If HTTPS certificate is compromised (rare), payload can be modified. **Mitigation:** TLS 1.3; certificate pinning for critical integrations. |

#### Information Disclosure

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Webhook payload contains sensitive data | Invoice amounts, payer/merchant identities sent over network. | Webhooks are HTTPS (encrypted in transit). Payload content depends on merchant's registration (address verification level). | If merchant's webhook endpoint is logged/cached by third parties, data leaks. **Mitigation:** Merchant should minimize sensitive data in webhook URLs; document PII handling. |

#### Denial of Service

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Attacker floods webhook delivery queue | Attacker creates many invoices to trigger webhook storms. | Backend rate-limits invoice creation per merchant (IP, account). Redis pub/sub has message limits. | If rate-limiting is disabled in config, webhooks can overwhelm merchant receivers. **Mitigation:** Document rate-limits in webhook guide; enable by default. |
| Webhook delivery fails, events lost | Merchant receiver is down; backend cannot redeliver. | Backend uses Redis for durable queue; failed webhooks are retried. | If Redis loses data (crash without persistence), webhooks are lost. **Mitigation:** Redis `AOF` or RDB persistence enabled; see [#160](https://github.com/WHEELBACK/COMEBACKHERE/issues/160). |

#### Elevation of Privilege

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Attacker modifies webhook URL to intercept events | Attacker changes merchant's webhook endpoint in MongoDB. | Requires MongoDB auth; backend logs all URL changes. | If MongoDB auth is weak, attacker can change URL. **Mitigation:** Strong MongoDB password; network isolation. |

---

## Asset: Backend Admin Routes

**Flow:** Backend admin (authenticated via API key or OAuth) creates invoices, approves settlements, manages merchants.

### Threats

#### Spoofing Identity

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| API key stolen | Attacker obtains the backend admin API key and makes unauthorized requests. | API keys are stored hashed in MongoDB; not returned to client. Keys transmitted over HTTPS only. | If admin key is logged (error logs, request logs), it could be exposed. **Mitigation:** Never log API keys; redact before logging. |
| Session hijacking | Attacker intercepts or guesses an admin session token. | Backend uses HTTP-only secure cookies for sessions. Session tokens are short-lived (15 min default). | If server-side session store is compromised, tokens can be forged. **Mitigation:** Secure session store (Redis); session validation on every request. |

#### Tampering with Data

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Admin creates invoice with wrong merchant | Admin or attacker with admin key creates invoice for unauthorized merchant. | Backend validates `merchant_id` against authenticated user's scope. | If authorization check is missing, attacker can create invoices for any merchant. **Mitigation:** Audit all admin routes for authorization checks; see [#165](https://github.com/WHEELBACK/COMEBACKHERE/issues/165). |

#### Repudiation

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Admin denies action | Admin claims they didn't create an invoice or approve a settlement. | All admin actions are logged to MongoDB with timestamp and admin ID. | If audit log is not written (DB failure) or is deleted, actions are not recorded. **Mitigation:** Write audit log before returning success; immutable audit table. |

#### Information Disclosure

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Admin API exposes all merchant data | Admin can query all merchants, invoices, settlements without restriction. | Depends on implementation; not yet reviewed. | If authorization is coarse-grained (all admins see all data), privacy is weak. **Mitigation:** Role-based access control (RBAC); see [#165](https://github.com/WHEELBACK/COMEBACKHERE/issues/165). |

#### Denial of Service

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Admin routes hammered by requests | Attacker with admin key makes thousands of requests to exhaust backend resources. | Depends on rate-limiting implementation; not yet deployed. | If rate-limiting is missing, attacker can crash the backend. **Mitigation:** Rate-limit all admin routes; see [#140](https://github.com/WHEELBACK/COMEBACKHERE/issues/140). |

#### Elevation of Privilege

| Threat | Description | Existing Mitigations | Known Gaps |
| --- | --- | --- | --- |
| Non-admin accesses admin routes | Attacker without API key or session token calls `/admin/*`. | Backend requires authentication header or valid session before handling request. | If auth middleware is bypassed (e.g., misconfigured routing), attacker gains access. **Mitigation:** Security review of auth middleware; integration tests for denied requests. |

---

## Cross-Cutting Concerns

### Contract Upgrades

- **Risk:** Admin upgrades contract with buggy logic, breaking escrow or settlement.
- **Mitigation:** Governance PR review required for all upgrades; only admin can invoke upgrade (see signer section).
- **Gap:** No automated testing of upgrade compatibility. **Issue:** [#170](https://github.com/WHEELBACK/COMEBACKHERE/issues/170).

### Private Key Management

- **Risk:** Merchant, signer, or admin keys stolen from device or backend config.
- **Mitigation:** Keys stored locally in Freighter or hardware wallet; backend stores only public keys.
- **Gap:** No backup/recovery mechanism if key is lost. **Mitigation:** User responsibility; encourage hardware wallets.

### Network Resilience

- **Risk:** Soroban network fails; invoices cannot be created or settled.
- **Mitigation:** Stellar is highly available (maintained by Stellar Development Foundation).
- **Gap:** No fallback network (e.g., testnet mirror). **Acceptable risk** for v0.1.

### Audit Trail

- **Risk:** Critical events (escrow release, settlement approval) are not recorded.
- **Mitigation:** All events logged to Redis and indexed in MongoDB.
- **Gap:** Event indexer can fail silently. **Issue:** [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186).

---

## References

- [SECURITY.md](../SECURITY.md) — Responsible disclosure policy.
- [docs/error-codes.md](./error-codes.md) — Contract error enums and their meanings.
- [docs/webhooks.md](./webhooks.md) — Webhook signature verification.
- [docs/contract-interaction-guide.md](./contract-interaction-guide.md) — Contract API reference.
- [ARCHITECTURE.md](../ARCHITECTURE.md) — System overview.

---

## Related Issues

- [#140](https://github.com/WHEELBACK/COMEBACKHERE/issues/140) — Rate limiting for invoice creation.
- [#150](https://github.com/WHEELBACK/COMEBACKHERE/issues/150) — Multi-factor confirmation for escrow release.
- [#152](https://github.com/WHEELBACK/COMEBACKHERE/issues/152) — Storage TTL management for settlements.
- [#155](https://github.com/WHEELBACK/COMEBACKHERE/issues/155) — Formal verification of contract arithmetic.
- [#160](https://github.com/WHEELBACK/COMEBACKHERE/issues/160) — Redis persistence configuration.
- [#165](https://github.com/WHEELBACK/COMEBACKHERE/issues/165) — Role-based access control for admin routes.
- [#170](https://github.com/WHEELBACK/COMEBACKHERE/issues/170) — Contract upgrade compatibility testing.
- [#182](https://github.com/WHEELBACK/COMEBACKHERE/issues/182) — Add benchmarks to treasury contract.
- [#186](https://github.com/WHEELBACK/COMEBACKHERE/issues/186) — Add audit trail (event indexing).

---

## Review Checklist for Security-Sensitive PRs

Use this checklist when reviewing PRs that touch fund-handling or governance code:

- [ ] **Identity spoofing:** Are callers validated? Are private keys handled securely?
- [ ] **Data tampering:** Can contract state be modified by non-authorized parties? Are values immutable after creation?
- [ ] **Repudiation:** Are all critical actions logged?
- [ ] **Information disclosure:** Does the PR leak private keys, balances, or signer lists unintentionally?
- [ ] **Denial of service:** Can spam or large requests crash the service?
- [ ] **Elevation of privilege:** Do authorization checks prevent unauthorized access?
- [ ] **Cross-cutting:** Does the PR introduce new keys or configs that need secure handling?
