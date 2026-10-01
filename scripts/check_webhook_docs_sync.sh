#!/usr/bin/env bash
#
# Check that docs/webhooks.md and docs/api-reference.md match what the webhook
# signing implementation actually sends.
#
# Usage:
#   scripts/check_webhook_docs_sync.sh
#
# Exits 0 when the documentation and the implementation agree, 1 otherwise.
# Every expectation is derived from the source, so the check fails as soon as
# either side moves.
#
# What it verifies:
#   1. The signature header name in the code is the one in the docs.
#   2. The algorithm is HMAC-SHA256 and the encoding is lowercase hex.
#   3. The signing secret is WEBHOOK_SIGNING_SECRET -- the backend must not read
#      a variable named WEBHOOK_SECRET, and no doc or .env example may tell an
#      operator to set one.
#   4. WEBHOOK_SIGNING_SECRET is in the startup-validated set, so the docs do
#      not describe it as optional.
#   5. The docs do not claim the live dispatch path sends X-Idempotency-Key.
#   6. The docs do not promise an envelope (event_type/idempotency_key/data)
#      that the live payload does not contain.
#
# Adding a new escape hatch: append the identifier to .check-webhook-ignore,
# one per line, or set CHECK_WEBHOOK_IGNORE to a file path.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAILURES=0

IGNORE_FILE="${CHECK_WEBHOOK_IGNORE:-$ROOT/.check-webhook-ignore}"

IMPL="comebackhere-backend/src/services/webhooks.ts"
ENV_IMPL="comebackhere-backend/src/lib/env.ts"
DOC="docs/webhooks.md"
API_DOC="docs/api-reference.md"
THREAT="docs/threat-model.md"
DEV_DOC="docs/dev-environment.md"

ENV_EXAMPLES=".env.local.example .env.testnet.example .env.mainnet.example"

# The variable the code actually reads.
SECRET_VAR="WEBHOOK_SIGNING_SECRET"
# The name that appears in older docs but that no code reads.
LEGACY_SECRET_VAR="WEBHOOK_SECRET"

echo ""
echo "=== webhook documentation sync ==="

# ── helpers ──────────────────────────────────────────────────────────────────

fail() {
  echo -e "${RED}[FAIL]${NC} $*" >&2
  FAILURES=$(( FAILURES + 1 ))
}

ok() {
  echo -e "${GREEN}[OK]${NC}   $*"
}

info() {
  echo -e "${YELLOW}[INFO]${NC} $*"
}

ignored() {
  [ -f "$IGNORE_FILE" ] || return 1
  grep -Fxq "$1" "$IGNORE_FILE"
}

require_in() {
  local file="$1" re="$2" desc="$3"
  if [ ! -f "$file" ]; then
    fail "$desc -- $file does not exist"
    return
  fi
  if grep -Eq "$re" "$file"; then
    ok "$desc"
  else
    fail "$desc -- not found in $file"
  fi
}

# require_code_header HEADER -- the header must be what the source sends.
require_code_header() {
  local header="$1"
  if grep -qE "WEBHOOK_SIGNATURE_HEADER = \"${header}\"" "$IMPL"; then
    ok "webhooks.ts sends $header"
  else
    fail "webhooks.ts does not send $header -- update $DOC and $API_DOC"
  fi
}

# require_corrective_mention FILE TOKEN PATTERN DESC
#
# FILE may mention TOKEN only to correct the reader. Corrective notes are
# exactly what these docs need ("there is no WEBHOOK_SECRET"), so a file that
# mentions TOKEN at all must also carry the correction somewhere in it. The
# match is whole-file rather than per-line because markdown wraps sentences.
require_corrective_mention() {
  local file="$1" token="$2" pattern="$3" desc="$4"
  if [ ! -f "$file" ]; then
    fail "$desc -- $file does not exist"
    return
  fi

  if ! grep -qE "$token" "$file"; then
    ok "$desc"
    return
  fi

  if grep -qE "$pattern" "$file"; then
    ok "$desc"
  else
    fail "$desc -- $file mentions it without correcting the reader"
  fi
}

# forbid_outright FILE TOKEN DESC -- TOKEN must not appear at all.
forbid_outright() {
  local file="$1" token="$2" desc="$3"
  if [ ! -f "$file" ]; then
    fail "$desc -- $file does not exist"
    return
  fi
  if grep -qE "$token" "$file"; then
    fail "$desc -- unexpected match in $file"
  else
    ok "$desc"
  fi
}

# ── 1. Signature header name ─────────────────────────────────────────────────

echo ""
echo "--- signature header ---"

CODE_HEADER="$(grep -oE 'WEBHOOK_SIGNATURE_HEADER = "[^"]+"' "$IMPL" | sed -E 's/.*"([^"]+)"/\1/')"

if [ -z "$CODE_HEADER" ]; then
  fail "could not read WEBHOOK_SIGNATURE_HEADER out of $IMPL"
else
  ok "webhooks.ts sends $CODE_HEADER"
  for doc in "$DOC" "$API_DOC"; do
    require_in "$doc" "$CODE_HEADER" "$doc documents the $CODE_HEADER header"
  done
  # The Go example reads the header straight off the request.
  require_in "$DOC" 'r\.Header\.Get\("[^"]+"\)' \
    "$DOC shows how to read the header from an HTTP request"
fi

# ── 2. Algorithm and encoding ────────────────────────────────────────────────

echo ""
echo "--- algorithm ---"

require_in "$IMPL" 'createHmac\("sha256"' \
  "webhooks.ts signs with HMAC-SHA256"
require_in "$IMPL" 'digest\("hex"\)' \
  "webhooks.ts hex-encodes the digest"
require_in "$IMPL" 'timingSafeEqual' \
  "webhooks.ts compares signatures in constant time"
require_in "$IMPL" 'length !== actualBuf\.length' \
  "webhooks.ts length-checks before timingSafeEqual"

require_in "$DOC" 'HMAC-SHA256' "$DOC names the HMAC-SHA256 algorithm"
require_in "$DOC" 'lowercase hex' "$DOC states the encoding is lowercase hex"
require_in "$DOC" 'constant-time' "$DOC requires a constant-time comparison"
require_in "$DOC" 'timingSafeEqual.*throws|timingSafeEqual` throws' \
  "$DOC warns that timingSafeEqual throws on a length mismatch"

# The signature carries no timestamp, so the docs must not promise one.
if grep -qE 't=[^ ]*,v1=|svix|Stripe-Signature' "$IMPL"; then
  info "$IMPL now builds a signature envelope -- update the Signature format table in $DOC"
else
  ok "webhooks.ts sends a bare digest with no timestamp envelope"
  require_in "$DOC" 'no signature timestamp|no timestamp' \
    "$DOC states there is no signature timestamp"
fi

# ── 3. Secret variable name ──────────────────────────────────────────────────

echo ""
echo "--- signing secret ---"

# The name is read from the source, not hardcoded here.
if ! grep -q "process\.env\.${SECRET_VAR}" "$IMPL"; then
  fail "$IMPL does not read process.env.$SECRET_VAR"
else
  ok "webhooks.ts reads process.env.$SECRET_VAR"
fi

if ignored "$LEGACY_SECRET_VAR"; then
  info "$LEGACY_SECRET_VAR is listed in the ignore file"
else
  # No source file may read the legacy name. Test fixtures are excluded: they
  # assert the name is rejected rather than depending on it.
  while IFS= read -r src; do
    if grep -qE "(^|[^A-Za-z_])${LEGACY_SECRET_VAR}([^A-Za-z_]|$)" "$src"; then
      fail "$src reads $LEGACY_SECRET_VAR, which is not the signing secret"
    fi
  done < <(find comebackhere-backend/src -name '*.ts' -not -path '*/tests/*')
  ok "no backend source reads $LEGACY_SECRET_VAR"

  # Docs and the validation script may mention it only to correct the reader.
  NO_LEGACY='no .?`?WEBHOOK_SECRET|not .*WEBHOOK_SECRET|never reads|does not read|only reads|not the signing secret'
  for doc in "$DOC" "$API_DOC" "$DEV_DOC" "$THREAT"; do
    require_corrective_mention "$doc" "(^|[^A-Za-z_])${LEGACY_SECRET_VAR}([^A-Za-z_]|$)" "$NO_LEGACY" \
      "$doc mentions $LEGACY_SECRET_VAR only to correct the reader"
  done
  require_corrective_mention scripts/validate_backend_env.sh \
    "(^|[^A-Za-z_])${LEGACY_SECRET_VAR}([^A-Za-z_]|$)" \
    'not read by the backend|only reads' \
    "scripts/validate_backend_env.sh mentions $LEGACY_SECRET_VAR only to reject it"

  # An .env example must never set a variable nothing reads.
  for example in $ENV_EXAMPLES; do
    [ -f "$example" ] || continue
    forbid_outright "$example" "^${LEGACY_SECRET_VAR}=" \
      "$example does not set the unreadable $LEGACY_SECRET_VAR"
  done
fi

# ── 4. Required, not optional ────────────────────────────────────────────────

echo ""
echo "--- required at startup ---"

if grep -qE "^\s+\"${SECRET_VAR}\"," "$ENV_IMPL"; then
  ok "$ENV_IMPL validates $SECRET_VAR at startup"
else
  fail "$ENV_IMPL no longer lists $SECRET_VAR as required -- update $DOC and $API_DOC"
fi

for example in $ENV_EXAMPLES; do
  [ -f "$example" ] || continue
  if grep -qE "^${SECRET_VAR}=" "$example"; then
    ok "$example sets $SECRET_VAR"
  else
    fail "$example does not document $SECRET_VAR"
  fi
done

require_in "$DOC" 'Required at startup' \
  "$DOC marks $SECRET_VAR as required at startup"
require_in "$API_DOC" 'Required at startup' \
  "$API_DOC marks $SECRET_VAR as required at startup"

# ── 5. Headers actually sent on the live path ────────────────────────────────

echo ""
echo "--- headers on the live path ---"

# dispatchWebhook is the signed path. Anything it sets must be documented as
# sent, and the headers it does NOT set must not be claimed as sent.
SEND_BLOCK="$(awk '/^export async function dispatchWebhook/,/^}/' "$IMPL")"

for header in $(printf '%s' "$SEND_BLOCK" | grep -oE '"[A-Za-z-]+":' | tr -d '":' | sort -u); do
  if printf '%s' "$SEND_BLOCK" | grep -qE "\[?\[?[\"']?${header}"; then
    ok "dispatchWebhook sends $header"
  fi
done

if printf '%s' "$SEND_BLOCK" | grep -q 'X-Idempotency-Key'; then
  ok "dispatchWebhook sends X-Idempotency-Key -- the docs may describe it as sent"
else
  ok "dispatchWebhook does not send X-Idempotency-Key"
  # The doc must not claim every outbound POST carries it.
  if grep -qiE '(every|all) (outbound )?webhooks? .*includes an? .?X-Idempotency-Key' "$DOC"; then
    fail "$DOC claims every outbound webhook carries X-Idempotency-Key, but the live path does not send it"
  else
    ok "$DOC does not claim the live path sends X-Idempotency-Key"
  fi
  require_in "$DOC" 'not sent|does not send|no.*idempotency key' \
    "$DOC states that the live path sends no idempotency key"
fi

# ── 6. Payload shape ─────────────────────────────────────────────────────────

echo ""
echo "--- payload shape ---"

# The live payload is built by the indexer; it uses `event`, not `event_type`,
# and does not nest under `data`.
INDEXER="comebackhere-backend/src/services/treasury-indexer.ts"

require_in "$INDEXER" 'event: "settlement_' \
  "$INDEXER builds payloads with an \`event\` field"

if grep -qE 'event_type:' "$INDEXER"; then
  fail "$INDEXER now emits event_type -- update the payload tables in $DOC"
else
  ok "$INDEXER does not emit an event_type field"
fi

if grep -qE '\bdata:\s*\{' "$INDEXER"; then
  info "$INDEXER now nests payload fields under \`data\` -- update the payload tables in $DOC"
else
  ok "$INDEXER does not nest payload fields under \`data\`"
  # The docs may say "there is no event_type" -- that is the correction we want.
  for doc in "$DOC" "$API_DOC"; do
    # The backticks and $ are literal regex characters here.
    # shellcheck disable=SC2016
    require_corrective_mention "$doc" '"event_type"|`event_type`' \
      '[Nn]o .?event_type|not .?event_type|spelled' \
      "$doc mentions event_type only to correct the reader"
  done
fi

require_in "$DOC" 'flat JSON object' \
  "$DOC describes the payload as a flat object"
require_in "$DOC" 'There is no .?invoice_paid. event|no .?invoice_paid. event' \
  "$DOC states there is no invoice_paid event"

# ── summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}webhook docs are out of sync: $FAILURES failure(s).${NC}" >&2
  echo "Either the implementation or docs/webhooks.md changed." >&2
  echo "Fix the docs, or add an entry to $IGNORE_FILE if the change is intentional." >&2
  exit 1
fi

echo -e "${GREEN}webhook documentation matches the implementation.${NC}"
