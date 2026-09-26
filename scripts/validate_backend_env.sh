#!/usr/bin/env bash
# Validate that all required comebackhere-backend environment variables are present
# and non-empty before docker-compose up or a local backend start.
#
# Usage:
#   scripts/validate_backend_env.sh [ENV_FILE]
#
# If ENV_FILE is supplied the script sources it first; otherwise it checks the
# currently-exported environment.  A missing or blank variable causes the script
# to print a clear error message and exit 1 — matching the error-reporting style
# used by the contract deployment validation scripts.
#
# Required variables:
#   MONGO_URI        — MongoDB connection string (mongo:// or mongodb+srv://)
#   REDIS_URL        — Redis connection string   (redis://)
#   WEBHOOK_SECRET   — HMAC secret for webhook payload signing
#
# Optionally-checked contract variables (warn only; override with STRICT=1):
#   INVOICE_CONTRACT_ID
#   TREASURY_CONTRACT_ID
#   COMPLIANCE_CONTRACT_ID
#
# Stellar identifier format (always enforced when the variable is set; mirrors
# comebackhere-backend/src/lib/env.ts):
#   C... contract ids : INVOICE_CONTRACT_ID TREASURY_CONTRACT_ID
#                       COMPLIANCE_CONTRACT_ID USDC_CONTRACT_ID SETTLEMENT_CONTRACT_ID
#   G... account keys : ADMIN_PUBLIC_KEY
#   S... secret seeds : SIGNER_SECRET_KEY (value is never printed)
# Full strkey validation (base32 + version byte + CRC16 checksum) uses python3;
# without python3 only the shape (prefix, length, alphabet) is checked.

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RESET='\033[0m'

STRICT="${STRICT:-0}"
ENV_FILE="${1:-}"
ERRORS=0
WARNINGS=0

# ── helpers ──────────────────────────────────────────────────────────────────

err() {
  echo -e "${RED}[ERROR]${RESET} $*" >&2
  ERRORS=$(( ERRORS + 1 ))
}

warn() {
  echo -e "${YELLOW}[WARN]${RESET}  $*" >&2
  WARNINGS=$(( WARNINGS + 1 ))
}

ok() {
  echo -e "${GREEN}[OK]${RESET}    $*"
}

check_required() {
  local var="$1"
  local hint="${2:-}"
  local val
  val="${!var:-}"
  if [ -z "$val" ]; then
    err "$var is not set or blank.${hint:+ Hint: $hint}"
  else
    ok "$var"
  fi
}

check_optional() {
  local var="$1"
  local val
  val="${!var:-}"
  if [ -z "$val" ]; then
    if [ "$STRICT" = "1" ]; then
      err "$var is not set (STRICT=1)."
    else
      warn "$var is not set — required for full contract integration."
    fi
  else
    ok "$var"
  fi
}

# is_valid_strkey KIND VALUE — KIND is contract | account | seed.
# Same rules as stellar-sdk StrKey.isValidContract / isValidEd25519PublicKey /
# isValidEd25519SecretSeed.
is_valid_strkey() {
  local kind="$1" value="$2" prefix
  case "$kind" in
    contract) prefix="C" ;;
    account)  prefix="G" ;;
    seed)     prefix="S" ;;
    *) return 1 ;;
  esac

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$kind" "$value" <<'PY'
import base64, sys

kind, value = sys.argv[1], sys.argv[2]
version = {"contract": 2 << 3, "account": 6 << 3, "seed": 18 << 3}[kind]

def crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc

try:
    raw = base64.b32decode(value)
except Exception:
    sys.exit(1)

ok = (
    len(value) == 56
    and len(raw) == 35
    and raw[0] == version
    and int.from_bytes(raw[-2:], "little") == crc16_xmodem(raw[:-2])
    and base64.b32encode(raw).decode() == value
)
sys.exit(0 if ok else 1)
PY
  else
    [[ "$value" =~ ^${prefix}[A-Z2-7]{55}$ ]]
  fi
}

check_strkey() {
  local var="$1" kind="$2"
  local val="${!var:-}"
  [ -z "$val" ] && return 0
  if is_valid_strkey "$kind" "$val"; then
    ok "$var is a valid $kind strkey"
    return 0
  fi
  case "$kind" in
    contract) err "$var is not a valid Stellar contract id (expected C... address, got \"$val\")." ;;
    account)  err "$var is not a valid Stellar account key (expected G... address, got \"$val\")." ;;
    seed)     err "$var is not a valid Stellar secret seed (expected S... key)." ;;
  esac
}

# ── source env file if provided ───────────────────────────────────────────────

if [ -n "$ENV_FILE" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}[ERROR]${RESET} ENV_FILE '$ENV_FILE' not found." >&2
    exit 1
  fi
  echo "Sourcing $ENV_FILE ..."
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

# ── required backend variables ────────────────────────────────────────────────

echo ""
echo "=== comebackhere-backend required variables ==="

check_required MONGO_URI \
  "e.g. mongodb://localhost:27017/comebackhere or mongodb+srv://..."

check_required REDIS_URL \
  "e.g. redis://localhost:6379"

check_required WEBHOOK_SECRET \
  "HMAC secret used to sign outgoing webhook payloads — must be at least 32 chars"

# Extra length check for WEBHOOK_SECRET
_ws="${WEBHOOK_SECRET:-}"
if [ -n "$_ws" ] && [ "${#_ws}" -lt 32 ]; then
  err "WEBHOOK_SECRET is set but shorter than 32 characters (got ${#_ws}). Use a longer secret."
fi
unset _ws

# ── optional contract variables (integration) ─────────────────────────────────

echo ""
echo "=== contract integration variables (optional, STRICT=1 to enforce) ==="

check_optional INVOICE_CONTRACT_ID
check_optional TREASURY_CONTRACT_ID
check_optional COMPLIANCE_CONTRACT_ID

# ── Stellar identifier format ─────────────────────────────────────────────────

echo ""
echo "=== Stellar identifier format ==="

for _var in INVOICE_CONTRACT_ID TREASURY_CONTRACT_ID COMPLIANCE_CONTRACT_ID \
            USDC_CONTRACT_ID SETTLEMENT_CONTRACT_ID; do
  check_strkey "$_var" contract
done
check_strkey ADMIN_PUBLIC_KEY account
check_strkey SIGNER_SECRET_KEY seed
unset _var

if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found — Stellar ids were only checked for shape, not checksum."
fi

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}Validation failed: $ERRORS error(s)${RESET}${WARNINGS:+ and $WARNINGS warning(s)}." >&2
  echo "Fix the variables above before starting the backend." >&2
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo -e "${YELLOW}Validation passed with $WARNINGS warning(s).${RESET} Contract integration may not function without the optional variables."
else
  echo -e "${GREEN}All backend environment variables OK.${RESET}"
fi
