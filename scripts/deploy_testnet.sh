#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Guard: check for required environment variables
if [ -z "${SOROBAN_RPC_URL:-}" ] && [ ! -f .env.testnet ]; then
  echo "Error: SOROBAN_RPC_URL is not set and .env.testnet not found"
  echo "Set SOROBAN_RPC_URL or create .env.testnet with required variables"
  exit 1
fi

if [ -z "${SOROBAN_NETWORK_PASSPHRASE:-}" ] && [ ! -f .env.testnet ]; then
  echo "Error: SOROBAN_NETWORK_PASSPHRASE is not set and .env.testnet not found"
  echo "Required variables: SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE"
  exit 1
fi

mkdir -p abis

: "${SOROBAN_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${STELLAR_NETWORK:=testnet}"

echo "Building COMEBACKHERE contracts for $STELLAR_NETWORK via $SOROBAN_RPC_URL"
# Build from the contracts repo (sibling directory)
(cd ../COMEBACKHERE-contracts && cargo build --target wasm32-unknown-unknown --release)

cat > abis/deployed.testnet.json <<JSON
{
  "network": "$STELLAR_NETWORK",
  "rpc_url": "$SOROBAN_RPC_URL",
  "invoice_contract_id": "${INVOICE_CONTRACT_ID:-C...}",
  "treasury_contract_id": "${TREASURY_CONTRACT_ID:-C...}",
  "compliance_contract_id": "${COMPLIANCE_CONTRACT_ID:-C...}",
  "generated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

echo "Contract deployment metadata written to abis/deployed.testnet.json"
echo "Replace placeholder IDs with soroban contract deploy output before backend integration."

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
scripts/export_deployed_addresses.sh
