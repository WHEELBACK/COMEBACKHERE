.PHONY: update-abi-snapshots check-abi-snapshots dev test lint deploy-testnet abi-snapshot \
        smoke smoke-up check-docs-sync

# Regenerate committed ABI metadata under abis/ (deterministic; LC_ALL=C).
# Assumes COMEBACKHERE-contracts/ is a sibling directory.
update-abi-snapshots:
	@./scripts/generate_abi_metadata.sh abis

# Verify abis/ matches freshly generated metadata (no writes).
check-abi-snapshots:
	@./scripts/generate_abi_metadata.sh /tmp/comebackhere-abis-check
	@diff -ru abis/ /tmp/comebackhere-abis-check/

dev:
	docker-compose up -d

# Check that the whole stack came up (no deployed contracts needed).
smoke:
	@./tests/smoke_stack.sh

# Start the stack, smoke test it, then tear it down.
smoke-up:
	@./tests/smoke_stack.sh --up --down

# Verify webhook and rate-limit docs match the backend implementation.
check-docs-sync:
	@./scripts/check_webhook_docs_sync.sh
	@./scripts/check_ratelimit_docs_sync.sh

test:
	cargo test --manifest-path COMEBACKHERE-contracts/Cargo.toml

lint:
	@./scripts/lint-docs.sh && cargo clippy --manifest-path COMEBACKHERE-contracts/Cargo.toml -- -D warnings && (cd frontend && npx eslint src --ext ts,tsx --report-unused-disable-directives)

deploy-testnet:
	@test -n "$$STELLAR_NETWORK" || (echo "ERROR: STELLAR_NETWORK is not set" && exit 1)
	@test -n "$$DEPLOYER_SECRET" || (echo "ERROR: DEPLOYER_SECRET is not set" && exit 1)
	@./scripts/deploy_testnet.sh

abi-snapshot:
	@$(MAKE) update-abi-snapshots

verify:
	@./scripts/verify.sh

lint-docs:
	@./scripts/lint-docs.sh

snapshot:
	@$(MAKE) update-abi-snapshots

check-snapshot:
	@$(MAKE) check-abi-snapshots

default: verify

.PHONY: default snapshot check-snapshot
