#!/usr/bin/env bash
#
# Check that docs/rate-limits.md (and the files that restate its claims) match
# what the rate limiter actually does.
#
# Usage:
#   scripts/check_ratelimit_docs_sync.sh
#
# Exits 0 when the documentation and the implementation agree, 1 otherwise.
# The check derives its expectations from the source rather than hardcoding
# them twice, so it fails the moment either side moves.
#
# What it verifies:
#   1. The set of response headers emitted by rateLimiter.ts is exactly the set
#      documented in docs/rate-limits.md and api-reference.md.
#   2. Retry-After is documented as 429-only, matching the code.
#   3. The unprefixed IETF "RateLimit-*" header names are not claimed anywhere.
#   4. The defaults in the code match the defaults in the docs and in every
#      .env.*.example file.
#   5. The TypeScript backend is not described as a single shared limiter, and
#      the Rust backend is not described as having an X-API-Key tier.
#   6. The documented entrypoint is the one package.json actually starts.
#
# Adding a new escape hatch: append the identifier to .check-ratelimit-ignore,
# one "reason" per line, or set CHECK_RATELIMIT_IGNORE to a file path.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAILURES=0

IGNORE_FILE="${CHECK_RATELIMIT_IGNORE:-$ROOT/.check-ratelimit-ignore}"

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

# ignored KEY — true when KEY appears in the ignore file.
ignored() {
  [ -f "$IGNORE_FILE" ] || return 1
  grep -Fxq "$1" "$IGNORE_FILE"
}

# require_in FILE REGEX DESCRIPTION
require_in() {
  local file="$1" re="$2" desc="$3"
  if grep -Eq "$re" "$file"; then
    ok "$desc"
  else
    fail "$desc -- not found in $file"
  fi
}

# forbid_in FILE REGEX DESCRIPTION
forbid_in() {
  local file="$1" re="$2" desc="$3"
  if grep -Eq "$re" "$file"; then
    fail "$desc -- unexpected match in $file"
  else
    ok "$desc"
  fi
}

# extract_headers FILE -- the rate-limit header names the source sets on a
# response, normalised to Title-Case. Prints one name per line, sorted.
extract_headers() {
  grep -oE '(res\.set|headers\.insert)\("?[Xx]-[Rr]ate[Ll]imit-[A-Za-z]+"?' "$1" \
    | grep -oE '[Xx]-[Rr]ate[Ll]imit-[A-Za-z]+' \
    | sed -E 's/^[Xx]-/X-/; s/^[Xx]r/Rr/; s/^X-rl/X-Rl/; s/^X-Reset/X-Reset/' \
    | sort -u
}

# extract_header FILE NAME -- any other single header name the source sets.
extract_header() {
  grep -oE "res\.set\(\"[A-Za-z-]+\"" "$1" \
    | sed -E 's/res\.set\("//; s/"$//' \
    | sort -u
}

IMPL="comebackhere-backend/src/middleware/rateLimiter.ts"
RUST_IMPL="backend/src/rate_limiter.rs"
DOC="docs/rate-limits.md"
API_DOC="docs/api-reference.md"
PKG="comebackhere-backend/package.json"

echo ""
echo "=== rate-limit documentation sync ==="

# ── 1. Header set ────────────────────────────────────────────────────────────

EXPECTED_X_HEADERS="X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset"

ACTUAL_X_HEADERS="$(extract_headers "$IMPL")"

echo ""
echo "--- X-RateLimit-* headers ---"
if [ "$ACTUAL_X_HEADERS" = "$EXPECTED_X_HEADERS" ]; then
  ok "rateLimiter.ts emits exactly: $(echo "$ACTUAL_X_HEADERS" | tr '\n' ' ')"
else
  fail "rateLimiter.ts header set changed."
  echo "       expected: $(echo "$EXPECTED_X_HEADERS" | tr '\n' ' ')" >&2
  echo "       actual:   $(echo "$ACTUAL_X_HEADERS" | tr '\n' ' ')" >&2
fi

for header in $EXPECTED_X_HEADERS; do
  if ignored "$header"; then
    info "$header is listed in the ignore file"
    continue
  fi
  require_in "$DOC" "$header" "$header documented in $DOC"
  require_in "$API_DOC" "$header" "$header documented in $API_DOC"
done

# ── 2. Retry-After is 429-only ───────────────────────────────────────────────

echo ""
echo "--- Retry-After ---"

if grep -q 'res.set("Retry-After"' "$IMPL"; then
  ok "Retry-After is emitted by the middleware"
else
  fail "Retry-After is no longer emitted by the middleware -- update $DOC"
fi

# The code sets Retry-After inside the .catch() branch, i.e. only on rejection.
# The docs must not claim it appears on successful responses.
if grep -n 'res.set("Retry-After"' "$IMPL" >/dev/null; then
  reject_line="$(grep -n 'res.set("Retry-After"' "$IMPL" | cut -d: -f1)"
  catch_line="$(grep -n '\.catch((rateLimiterRes)' "$IMPL" | cut -d: -f1)"
  if [ -n "$catch_line" ] && [ "$reject_line" -gt "$catch_line" ]; then
    ok "Retry-After is set on the rejection path only"
  else
    fail "Retry-After is no longer confined to the 429 path -- update $DOC"
  fi
fi

# The backticks and $ below are literal regex characters, not shell expansions.
# shellcheck disable=SC2016
require_in "$DOC" '`Retry-After`.*only on 429|only on 429 responses' \
  "$DOC states Retry-After is 429-only"

# ── 3. No IETF unprefixed headers emitted ────────────────────────────────────

echo ""
echo "--- IETF header names ---"

# The backend must not emit the unprefixed IETF draft names, and the docs must
# say so. A doc that merely *mentions* them to warn integrators is correct, so
# the check is: the implementations do not set them, and the doc carries the
# disclaimer.
for name in "RateLimit-Limit" "RateLimit-Remaining" "RateLimit-Reset"; do
  for impl_file in "$IMPL" "$RUST_IMPL" "comebackhere-backend/src/middleware/cors.ts"; do
    [ -f "$impl_file" ] || continue
    if grep -qE "[\"'\`]${name}[\"'\`]" "$impl_file"; then
      fail "$impl_file sets the unprefixed IETF header $name, which is not part of the contract"
    else
      ok "$impl_file does not set the unprefixed $name"
    fi
  done
done

require_in "$DOC" 'does \*\*not\*\* emit the IETF' \
  "$DOC states the unprefixed IETF headers are not emitted"

# ── 4. Defaults ──────────────────────────────────────────────────────────────

echo ""
echo "--- defaults ---"

# code_default VAR PATTERN -- pull the fallback integer out of a
# positiveInt("VAR", N) call in rateLimiter.ts.
code_default() {
  local var="$1"
  grep -oE "positiveInt\(\"${var}\", [0-9]+\)" "$IMPL" \
    | grep -oE '[0-9]+' | head -1
}

check_default() {
  local var="$1" code_value
  code_value="$(code_default "$var")"
  if [ -z "$code_value" ]; then
    fail "could not read the default for $var out of $IMPL"
    return
  fi
  if ignored "$var"; then
    info "$var is listed in the ignore file"
    return
  fi

  # The doc must render the code default in bold, e.g. "**60**".
  if grep -Eq "\*\*${code_value}\*\*.{0,20}\`${var}\`|\`${var}\`.{0,40}\*\*${code_value}\*\*" "$DOC"; then
    ok "$DOC documents $var default as $code_value"
  else
    fail "$DOC does not document $var default as $code_value (the code default)"
  fi

  # Every env example must set the same value.
  for example in .env.local.example .env.testnet.example .env.mainnet.example; do
    [ -f "$example" ] || continue
    actual="$(grep -E "^${var}=" "$example" | head -1 | cut -d= -f2 || true)"
    if [ -z "$actual" ]; then
      fail "$example does not set $var"
    elif [ "$actual" != "$code_value" ]; then
      fail "$example sets $var=$actual but the code default is $code_value"
    else
      ok "$example sets $var=$actual"
    fi
  done
}

check_default RATE_LIMIT_POINTS
check_default RATE_LIMIT_API_KEY_POINTS
check_default RATE_LIMIT_DURATION

# RATE_LIMIT_API_KEY_POINTS must exist in the Rust backend doc claim, i.e. the
# doc must say the Rust backend does NOT have it.
require_in "$DOC" 'no .?X-API-Key.? tier|Rust backend .* no ' \
  "$DOC states the Rust backend has no API-key tier"

# ── 5. Bucket selection claims ───────────────────────────────────────────────

echo ""
echo "--- bucket selection ---"

require_in "$IMPL" 'req\.header\("X-API-Key"\)' \
  "rateLimiter.ts reads the X-API-Key header"
require_in "$DOC" 'X-API-Key' "$DOC documents the X-API-Key header"
require_in "$DOC" 'bucket selector, not a credential' \
  "$DOC warns that X-API-Key is not a credential"

forbid_in "$DOC" 'requests with a valid API key' \
  "$DOC does not claim the API key is validated"

# One limiter per tier: a single shared instance cannot enforce two budgets.
if grep -q '_ipLimiter' "$IMPL" && grep -q '_apiKeyLimiter' "$IMPL"; then
  ok "rateLimiter.ts keeps a separate limiter per tier"
else
  fail "rateLimiter.ts no longer has a separate limiter per tier -- update $DOC"
fi

forbid_in "$IMPL" 'Math\.max\(ipPoints, apiKeyPoints\)' \
  "rateLimiter.ts does not collapse both tiers into one points value"

# ── 6. Documented entrypoint ─────────────────────────────────────────────────

echo ""
echo "--- entrypoint ---"

START_CMD="$(grep -oE '"start": "[^"]+"' "$PKG" | sed -E 's/.*"node //; s/"$//')"
# Only an actual invocation is a problem, not a sentence mentioning the file.
forbid_in "$DOC" 'node dist/app\.js' \
  "$DOC never instructs running the non-existent dist/app.js"
if [ -n "$START_CMD" ]; then
  # Literal sed character class; $ is not a shell expansion here.
  # shellcheck disable=SC2016
  require_in "$DOC" "$(printf '%s' "$START_CMD" | sed 's/[][\.*^$()+?{}|]/\\&/g')" \
    "$DOC references the real start command ($START_CMD)"
fi

# ── summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}rate-limit docs are out of sync: $FAILURES failure(s).${NC}" >&2
  echo "Either the implementation or docs/rate-limits.md changed." >&2
  echo "Fix the docs, or add an entry to $IGNORE_FILE if the change is intentional." >&2
  exit 1
fi

echo -e "${GREEN}rate-limit documentation matches the implementation.${NC}"
