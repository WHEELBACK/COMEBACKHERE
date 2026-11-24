#!/usr/bin/env bash
# Regenerate committed ABI metadata under abis/ from contract sources.
# Contract sources are searched in two locations (CI checkout and local sibling):
#   1. $ROOT_DIR/COMEBACKHERE-contracts  (GitHub Actions checkout path)
#   2. $ROOT_DIR/../COMEBACKHERE-contracts  (local sibling directory)
#
# Usage:
#   scripts/generate_abi_metadata.sh [OUT_DIR]
#       Regenerate ABI metadata and write to OUT_DIR (default: abis/).
#
#   scripts/generate_abi_metadata.sh --check
#       Generate ABI metadata to a temp directory and diff against committed
#       abis/*.json without overwriting them. Exits non-zero if there are
#       differences (like `prettier --check`). OUT_DIR is ignored when
#       --check is specified.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CHECK_MODE=0
OUT_DIR="${1:-"$ROOT_DIR/abis"}"

for arg in "$@"; do
  case "$arg" in
    --check)
      CHECK_MODE=1
      ;;
  esac
done

if [ -d "$ROOT_DIR/COMEBACKHERE-contracts" ]; then
  CONTRACTS_DIR="$ROOT_DIR/COMEBACKHERE-contracts"
elif [ -d "$ROOT_DIR/../COMEBACKHERE-contracts" ]; then
  CONTRACTS_DIR="$(cd "$ROOT_DIR/../COMEBACKHERE-contracts" && pwd)"
else
  echo "ERROR: COMEBACKHERE-contracts directory not found." >&2
  echo "  Looked in: $ROOT_DIR/COMEBACKHERE-contracts" >&2
  echo "  Looked in: $ROOT_DIR/../COMEBACKHERE-contracts" >&2
  echo "  Clone it with: git clone https://github.com/WHEELBACK/COMEBACKHERE-contracts ../COMEBACKHERE-contracts" >&2
  exit 1
fi

export LC_ALL=C
export LANG=C

if [ "$CHECK_MODE" -eq 1 ]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT

  echo "Building COMEBACKHERE contracts (workspace test build)..."
  (cd "$CONTRACTS_DIR" && cargo test --no-run --workspace)

  mkdir -p "$TEMP_DIR"
  python3 "$ROOT_DIR/scripts/generate_abi_metadata.py" "$TEMP_DIR"

  echo "Comparing generated ABI metadata against committed abis/..."
  if diff -ru "$ROOT_DIR/abis/" "$TEMP_DIR/"; then
    echo "ABI snapshots are up to date."
    exit 0
  else
    echo "" >&2
    echo "ERROR: ABI snapshots in abis/ are out of sync with COMEBACKHERE-contracts/." >&2
    echo "Run 'make update-abi-snapshots' (or 'just snapshot') locally and commit the updated files." >&2
    exit 1
  fi
fi

echo "Building COMEBACKHERE contracts (workspace test build)..."
(cd "$CONTRACTS_DIR" && cargo test --no-run --workspace)

mkdir -p "$OUT_DIR"
python3 "$ROOT_DIR/scripts/generate_abi_metadata.py" "$OUT_DIR"

echo "ABI metadata written to $OUT_DIR"
