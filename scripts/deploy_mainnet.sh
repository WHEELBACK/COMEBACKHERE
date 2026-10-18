#!/usr/bin/env bash
# Mainnet deployment entry point for COMEBACKHERE Protocol.
#
# Live deployment requires governance approval, multi-sig signing, and a recorded
# signing ceremony — this script intentionally refuses to submit transactions from
# a single local shell.
#
# Use --dry-run to print the planned actions (contracts, addresses, network config)
# without submitting any transaction.  The output is formatted to be easy to paste
# into a deployment-checklist PR or issue.
#
# Use --rollback to revert artifacts/addresses.json to the last known-good
# deployment recorded in artifacts/addresses.json.bak.  This does NOT un-deploy
# any contracts on-chain; it only restores the local address registry so that
# downstream services can be pointed back at the previous deployment.
#
# Usage:
#   scripts/deploy_mainnet.sh --dry-run    # preview only — zero network-mutating calls
#   scripts/deploy_mainnet.sh --rollback   # restore addresses.json from backup
#   scripts/deploy_mainnet.sh              # refuses; live deploy requires multi-sig ceremony
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DRY_RUN=0
ROLLBACK=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run | --rollback]" >&2
      exit 1
      ;;
  esac
done

# ── rollback mode ─────────────────────────────────────────────────────────────

if [ "$ROLLBACK" -eq 1 ]; then
  ADDRESSES_FILE="$ROOT_DIR/artifacts/addresses.json"
  BACKUP_FILE="$ROOT_DIR/artifacts/addresses.json.bak"

  if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: No rollback backup found at $BACKUP_FILE." >&2
    echo "" >&2
    echo "A backup is created automatically at $BACKUP_FILE each time this script" >&2
    echo "writes a new artifacts/addresses.json.  If no backup exists, either:" >&2
    echo "  - This is the first ever deployment (no prior state to roll back to)" >&2
    echo "  - The backup was manually deleted" >&2
    echo "" >&2
    echo "To recover manually, consult the on-chain deployment ceremony record" >&2
    echo "in the deployment issue and reconstruct artifacts/addresses.json from" >&2
    echo "the recorded contract IDs." >&2
    echo "" >&2
    echo "IMPORTANT: Rolling back artifacts/addresses.json does NOT un-deploy" >&2
    echo "contracts on Soroban. Contracts cannot be removed from the ledger once" >&2
    echo "deployed. This rollback only restores the local address registry so" >&2
    echo "that backend services can be pointed back at the previous deployment." >&2
    exit 1
  fi

  TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  echo "========================================================"
  echo "  COMEBACKHERE MAINNET DEPLOYMENT — ROLLBACK"
  echo "  Generated: $TIMESTAMP"
  echo "========================================================"
  echo ""
  echo "Restoring artifacts/addresses.json from backup..."
  echo ""

  if [ -f "$ADDRESSES_FILE" ]; then
    # Save the current (failed) state for forensic reference
    cp "$ADDRESSES_FILE" "${ADDRESSES_FILE}.rollback-$(date -u +"%Y%m%dT%H%M%SZ")"
    echo "  Saved current addresses.json as addresses.json.rollback-${TIMESTAMP} for forensic reference."
  fi

  cp "$BACKUP_FILE" "$ADDRESSES_FILE"
  echo "  Restored: artifacts/addresses.json from artifacts/addresses.json.bak"
  echo ""
  echo "IMPORTANT — Contract-level implications:"
  echo ""
  echo "  1. Contracts already deployed on-chain CANNOT be un-deployed."
  echo "     Any contract that was deployed during the failed deployment remains"
  echo "     on the Stellar ledger and is accessible by anyone with its contract ID."
  echo ""
  echo "  2. This rollback only restores the local artifacts/addresses.json registry."
  echo "     Downstream services (backend, frontend) pointed at the NEW contract IDs"
  echo "     must be manually reconfigured to use the PREVIOUS contract IDs from the"
  echo "     restored addresses.json."
  echo ""
  echo "  3. If any newly deployed contract was partially initialized (e.g., the"
  echo "     compliance contract was deployed but the invoice contract was not),"
  echo "     the partially-initialized contract should be documented in the"
  echo "     post-incident record. It may need to be treated as an abandoned"
  echo "     deployment."
  echo ""
  echo "  4. Open an emergency deployment issue to document the partial deployment,"
  echo "     record all deployed contract IDs (including abandoned ones), and plan"
  echo "     any corrective redeployment through the full multi-sig ceremony process."
  echo ""
  echo "  See docs/MAINNET_DEPLOYMENT.md — Emergency Rollback section for full guidance."
  echo ""
  echo "Rollback complete."
  echo "========================================================"
  exit 0
fi

# ── resolve env ───────────────────────────────────────────────────────────────

# shellcheck disable=SC1091
source scripts/validate_env.sh .env.mainnet mainnet deployment --env mainnet

# ── dry-run mode ──────────────────────────────────────────────────────────────

if [ "$DRY_RUN" -eq 1 ]; then
  ADMIN_PUBLIC_KEY="${ADMIN_PUBLIC_KEY:-<not set>}"
  USDC_CONTRACT_ID="${USDC_CONTRACT_ID:-<not set>}"
  TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  cat <<DRYRUN
========================================================
  COMEBACKHERE MAINNET DEPLOYMENT — DRY RUN
  Generated: $TIMESTAMP
  ** No transactions will be submitted **
========================================================

NETWORK CONFIGURATION
  STELLAR_NETWORK            : ${STELLAR_NETWORK:-<not set>}
  SOROBAN_RPC_URL            : ${SOROBAN_RPC_URL:-<not set>}
  SOROBAN_NETWORK_PASSPHRASE : ${SOROBAN_NETWORK_PASSPHRASE:-<not set>}

SIGNING AUTHORITY
  ADMIN_PUBLIC_KEY           : $ADMIN_PUBLIC_KEY

CONTRACT ADDRESSES
  INVOICE_CONTRACT_ID        : ${INVOICE_CONTRACT_ID:-<not set>}
  TREASURY_CONTRACT_ID       : ${TREASURY_CONTRACT_ID:-<not set>}
  COMPLIANCE_CONTRACT_ID     : ${COMPLIANCE_CONTRACT_ID:-<not set>}
  USDC_CONTRACT_ID           : $USDC_CONTRACT_ID

PLANNED ACTIONS
  [1] Verify WASM hashes match deployment-issue expectations
  [2] Verify Soroban RPC is reachable at ${SOROBAN_RPC_URL:-<not set>}
  [3] Verify ADMIN_PUBLIC_KEY is funded and authorised on ${STELLAR_NETWORK:-mainnet}
  [4] Deploy invoice contract       → INVOICE_CONTRACT_ID
  [5] Deploy treasury contract      → TREASURY_CONTRACT_ID
  [6] Deploy compliance contract    → COMPLIANCE_CONTRACT_ID
  [7] Initialize contracts with admin $ADMIN_PUBLIC_KEY
  [8] Export deployed addresses to artifacts/addresses.json
  [9] Run smoke tests (GET /health/rpc + low-value payment)

DRY RUN COMPLETE — review the above before running the signing ceremony.
Paste this output into the deployment-checklist PR as the pre-flight record.
========================================================
DRYRUN
  exit 0
fi

# ── live deploy — refused ─────────────────────────────────────────────────────

echo "Mainnet deployment requires multi-sig approval and an external signing ceremony."
echo "Refusing to deploy from a single local shell."
echo ""
echo "Run with --dry-run to preview planned actions without submitting transactions."
echo "See docs/MAINNET_DEPLOYMENT.md for the full ceremony checklist."
exit 1
