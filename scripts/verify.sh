#!/usr/bin/env bash
set -euo pipefail

test -f abis/invoice.json
test -f abis/treasury.json
echo "ABI metadata present."

if [ -f abis/deployed.testnet.json ]; then
  echo "Testnet deployment metadata present."
else
  echo "Warning: abis/deployed.testnet.json not found. Run scripts/deploy_testnet.sh first."
fi
