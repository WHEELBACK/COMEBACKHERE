#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Mainnet deployment requires multi-sig approval and an external signing ceremony."
echo "Refusing to deploy from a single local shell."

# shellcheck disable=SC1091
source scripts/validate_env.sh .env.mainnet mainnet deployment

exit 1
