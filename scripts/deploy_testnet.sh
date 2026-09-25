#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source scripts/validate_env.sh .env.testnet testnet deployment

mkdir -p abis

: "${SOROBAN_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${STELLAR_NETWORK:=testnet}"

echo "Building COMEBACKHERE contracts for $STELLAR_NETWORK via $SOROBAN_RPC_URL"
# Build from the contracts repo (sibling directory)
(cd ../COMEBACKHERE-contracts && cargo build --target wasm32-unknown-unknown --release)

# Deploy contracts and capture IDs
# These are placeholder deploy commands — actual deployment logic should be integrated here
INVOICE_WASM="../COMEBACKHERE-contracts/target/wasm32-unknown-unknown/release/invoice_contract.wasm"
TREASURY_WASM="../COMEBACKHERE-contracts/target/wasm32-unknown-unknown/release/treasury_contract.wasm"
COMPLIANCE_WASM="../COMEBACKHERE-contracts/target/wasm32-unknown-unknown/release/compliance_contract.wasm"

if [ ! -f "$INVOICE_WASM" ] || [ ! -f "$TREASURY_WASM" ] || [ ! -f "$COMPLIANCE_WASM" ]; then
  echo "ERROR: Contract WASM binaries not found after build" >&2
  exit 1
fi

echo "Deploying contracts to $STELLAR_NETWORK…"
# Uncomment and integrate actual soroban contract deploy commands:
# soroban contract deploy --wasm "$INVOICE_WASM" ... > /tmp/invoice_deploy.txt 2>&1
# soroban contract deploy --wasm "$TREASURY_WASM" ... > /tmp/treasury_deploy.txt 2>&1
# soroban contract deploy --wasm "$COMPLIANCE_WASM" ... > /tmp/compliance_deploy.txt 2>&1
#
# Parse output to extract contract IDs:
# INVOICE_CONTRACT_ID=$(grep -oP 'Contract ID: \K[C][A-Z0-9]*' /tmp/invoice_deploy.txt || echo "C...")
# TREASURY_CONTRACT_ID=$(grep -oP 'Contract ID: \K[C][A-Z0-9]*' /tmp/treasury_deploy.txt || echo "C...")
# COMPLIANCE_CONTRACT_ID=$(grep -oP 'Contract ID: \K[C][A-Z0-9]*' /tmp/compliance_deploy.txt || echo "C...")

if [ -f .env.testnet ]; then
  # shellcheck disable=SC1091
  set -a
  source .env.testnet
  set +a
fi

export STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
export INVOICE_CONTRACT_ID="${INVOICE_CONTRACT_ID:-C...}"
export TREASURY_CONTRACT_ID="${TREASURY_CONTRACT_ID:-C...}"
export COMPLIANCE_CONTRACT_ID="${COMPLIANCE_CONTRACT_ID:-C...}"

echo "Running deployment validation…"
"$ROOT_DIR/scripts/export_deployed_addresses.sh"
