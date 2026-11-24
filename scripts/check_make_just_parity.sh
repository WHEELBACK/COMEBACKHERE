#!/usr/bin/env bash
# check_make_just_parity.sh — verify Makefile and justfile have equivalent targets
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Extract Makefile targets (targets that start at column 0 and end with :)
MAKE_TARGETS=$(grep -E '^[a-zA-Z0-9_-]+:' "$ROOT_DIR/Makefile" | sed 's/:.*//g' | sort)

# Extract justfile targets (lines with # at start of recipe)
JUST_TARGETS=$(grep -E '^[a-zA-Z0-9_-]+:' "$ROOT_DIR/justfile" | sed 's/:.*//g' | sort)

# Convert to arrays for comparison
mapfile -t MAKE_ARRAY <<<"$MAKE_TARGETS"
mapfile -t JUST_ARRAY <<<"$JUST_TARGETS"

# Compare targets
MISSING_IN_JUST=()
MISSING_IN_MAKE=()

for target in "${MAKE_ARRAY[@]}"; do
  if ! grep -q "^$target:" "$ROOT_DIR/justfile"; then
    MISSING_IN_JUST+=("$target")
  fi
done

for target in "${JUST_ARRAY[@]}"; do
  if ! grep -q "^$target:" "$ROOT_DIR/Makefile"; then
    MISSING_IN_MAKE+=("$target")
  fi
done

# Report results
if [[ ${#MISSING_IN_JUST[@]} -gt 0 ]] || [[ ${#MISSING_IN_MAKE[@]} -gt 0 ]]; then
  echo "ERROR: Makefile and justfile targets are not in parity" >&2
  if [[ ${#MISSING_IN_JUST[@]} -gt 0 ]]; then
    echo "Missing in justfile: ${MISSING_IN_JUST[*]}" >&2
  fi
  if [[ ${#MISSING_IN_MAKE[@]} -gt 0 ]]; then
    echo "Missing in Makefile: ${MISSING_IN_MAKE[*]}" >&2
  fi
  exit 1
fi

echo "Makefile and justfile targets are in parity."
exit 0
