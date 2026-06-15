#!/usr/bin/env bash
# Write deployed contract addresses to artifacts/addresses.json (machine-readable).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${DEPLOYED_ADDRESSES_FILE:-$ROOT_DIR/artifacts/addresses.json}"

: "${STELLAR_NETWORK:?STELLAR_NETWORK is required}"
: "${INVOICE_CONTRACT_ID:?INVOICE_CONTRACT_ID is required}"
: "${TREASURY_CONTRACT_ID:?TREASURY_CONTRACT_ID is required}"
: "${COMPLIANCE_CONTRACT_ID:?COMPLIANCE_CONTRACT_ID is required}"

mkdir -p "$(dirname "$OUT_FILE")"
export LC_ALL=C
export LANG=C

python3 - "$OUT_FILE" <<'PY'
import json
import os
import sys

out_path = sys.argv[1]
payload = {
    "network": os.environ["STELLAR_NETWORK"],
    "contracts": [
        {"name": "invoice",    "address": os.environ["INVOICE_CONTRACT_ID"]},
        {"name": "treasury",   "address": os.environ["TREASURY_CONTRACT_ID"]},
        {"name": "compliance", "address": os.environ["COMPLIANCE_CONTRACT_ID"]},
    ],
}
with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(payload, handle, indent=2, ensure_ascii=True)
    handle.write("\n")
PY

echo "Deployed addresses written to $OUT_FILE"
