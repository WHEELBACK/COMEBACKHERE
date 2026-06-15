#!/usr/bin/env bash
set -euo pipefail

echo "Mainnet deployment requires multi-sig approval and an external signing ceremony."
echo "Refusing to deploy from a single local shell."
exit 1
