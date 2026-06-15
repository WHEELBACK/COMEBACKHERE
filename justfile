# COMEBACKHERE task runner

# Regenerate ABI snapshots (requires COMEBACKHERE-contracts/ as sibling)
snapshot:
    @./scripts/generate_abi_metadata.sh abis

# Verify committed ABI snapshots match contract sources (no writes)
check-snapshot:
    @./scripts/generate_abi_metadata.sh /tmp/comebackhere-abis-check
    @diff -ru abis/ /tmp/comebackhere-abis-check/

# Lint markdown documentation
lint-docs:
    @./scripts/lint-docs.sh

# Run deployment verification checks
verify:
    @./scripts/verify.sh

# Default target
default: verify
