# COMEBACKHERE task runner

# Regenerate ABI snapshots (requires COMEBACKHERE-contracts/ as sibling)
snapshot:
    @./scripts/generate_abi_metadata.sh abis

update-abi-snapshots: snapshot

abi-snapshot: snapshot

# Verify committed ABI snapshots match contract sources (no writes)
check-snapshot:
    @./scripts/generate_abi_metadata.sh /tmp/comebackhere-abis-check
    @diff -ru abis/ /tmp/comebackhere-abis-check/

check-abi-snapshots: check-snapshot

# Lint markdown documentation
lint-docs:
    @./scripts/lint-docs.sh

# Verify webhook and rate-limit docs match the backend implementation
check-docs-sync:
    @./scripts/check_webhook_docs_sync.sh
    @./scripts/check_ratelimit_docs_sync.sh

# Run deployment verification checks
verify:
    @./scripts/verify.sh

# Start local Docker environment
dev:
    docker-compose up -d

# Check that the whole stack came up (no contracts needed)
smoke:
    @./tests/smoke_stack.sh

# Start the stack and smoke test it, then tear it down
smoke-up:
    @./tests/smoke_stack.sh --up --down

# Run contract tests
test:
    cargo test --manifest-path COMEBACKHERE-contracts/Cargo.toml

# Lint TypeScript, contracts, and documentation
lint:
    @./scripts/lint-docs.sh && cargo clippy --manifest-path COMEBACKHERE-contracts/Cargo.toml -- -D warnings && (cd frontend && npx eslint src --ext ts,tsx --report-unused-disable-directives)

# Deploy to testnet
deploy-testnet:
    @test -n "$$STELLAR_NETWORK" || (echo "ERROR: STELLAR_NETWORK is not set" && exit 1)
    @test -n "$$DEPLOYER_SECRET" || (echo "ERROR: DEPLOYER_SECRET is not set" && exit 1)
    @./scripts/deploy_testnet.sh

# Default target
default: verify
