#!/usr/bin/env bash
#
# Startup smoke test for the full stack.
#
# Confirms that the services started by `docker-compose up` actually come up
# together and answer on their published ports. Unlike invoice_lifecycle.sh this
# needs no deployed contracts, no soroban CLI and no funded accounts — it is
# the fast "did the stack boot?" check to run before anything else.
#
# Usage:
#   ./tests/smoke_stack.sh                 # check an already-running stack
#   ./tests/smoke_stack.sh --up            # docker compose up -d --wait first
#   ./tests/smoke_stack.sh --up --down     # ...and tear it down afterwards
#   ./tests/smoke_stack.sh --timeout 180   # longer wait for slow machines
#
# Environment:
#   BACKEND_URL    — backend base URL   (default: http://localhost:3000)
#   FRONTEND_URL   — frontend base URL  (default: http://localhost:5173)
#   SOROBAN_HEALTH — Soroban/Horizon    (default: http://localhost:8000/health)
#   REDIS_HOST/PORT— Redis              (default: localhost / 6379)
#   MONGODB_PORT   — MongoDB            (default: 27017)
#   SMOKE_TIMEOUT  — per-service wait in seconds (default: 120)
#   SMOKE_SKIP     — comma-separated services to skip, from
#                    soroban,redis,mongodb,backend,frontend
#
# Exit codes: 0 all checks passed, 1 one or more checks failed,
#             2 the script could not run (missing tool, bad flag).

set -euo pipefail

REDIS="${REDIS_HOST:-localhost}"
REDIS_PORT_NUM="${REDIS_PORT:-6379}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"
SOROBAN_HEALTH="${SOROBAN_HEALTH:-http://localhost:8000/health}"
MONGODB_PORT="${MONGODB_PORT:-27017}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-120}"
SMOKE_SKIP="${SMOKE_SKIP:-}"

START_STACK=0
STOP_STACK=0
declare -a FAILURES=()

pass_count=0
fail_count=0

log_pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  pass_count=$((pass_count + 1))
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  fail_count=$((fail_count + 1))
  FAILURES+=("$1")
}

log_info() {
  echo -e "${YELLOW}[INFO]${NC} $1"
}

# Skipped checks are reported, never silent, so a green run cannot hide a
# service that was quietly excluded.
log_skip() {
  echo -e "${YELLOW}[SKIP]${NC} $1 ($2)"
}

# should_skip SERVICE — true when SERVICE is in SMOKE_SKIP.
should_skip() {
  case ",${SMOKE_SKIP}," in
    *,"$1",*) return 0 ;;
    *) return 1 ;;
  esac
}

# run_or_skip SERVICE REASON -- runs "$@" unless the service is skipped.
run_or_skip() {
  local service="$1" reason="$2"
  shift 2
  if should_skip "$service"; then
    log_skip "$service" "$reason"
    return 0
  fi
  "$@"
}

die() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
  exit 2
}

# ── preflight ────────────────────────────────────────────────────────────────

require_cmd() {
  command -v "$1" > /dev/null 2>&1 \
    || die "'$1' is required but not installed. $2"
}

compose() {
  # Prefer the v2 plugin, fall back to the v1 binary.
  if docker compose version > /dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose > /dev/null 2>&1; then
    docker-compose "$@"
  else
    return 1
  fi
}

have_compose() {
  compose version > /dev/null 2>&1
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --up)     START_STACK=1 ;;
      --down)   STOP_STACK=1 ;;
      --timeout) shift; [ $# -gt 0 ] || die "--timeout needs a value"
                 SMOKE_TIMEOUT="$1" ;;
      --skip)    shift; [ $# -gt 0 ] || die "--skip needs a value"
                 SMOKE_SKIP="$1" ;;
      -h|--help)
        sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
  done
}

# ── helpers ──────────────────────────────────────────────────────────────────

# describe_service NAME -- a short hint used in failure output. NAME may carry a
# path suffix ("backend /health"), so match on the service word.
describe_service() {
  case "$1" in
    backend*)  echo "comebackhere-backend (Node) — try: compose logs backend" ;;
    frontend*) echo "comebackhere-frontend (Vite) — try: compose logs frontend" ;;
    soroban*)  echo "stellar/quickstart — try: compose logs soroban" ;;
    redis*)    echo "redis:7-alpine — try: compose logs redis" ;;
    mongodb*)  echo "mongo:7 — try: compose logs mongodb" ;;
    *)         echo "try: compose ps" ;;
  esac
}

# wait_for NAME RETRY_CMD -- polls RETRY_CMD until it succeeds or the timeout
# elapses. Returns 0 on success, 1 on timeout.
wait_for() {
  local name="$1" retry_cmd="$2"
  local waited=0
  log_info "Waiting for $name (timeout ${SMOKE_TIMEOUT}s) ..."
  while [ "$waited" -lt "$SMOKE_TIMEOUT" ]; do
    if eval "$retry_cmd" > /dev/null 2>&1; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# check_http NAME URL EXPECTED_STATUS [BODY_REGEX]
#
# Retries until the endpoint answers with EXPECTED_STATUS (and, when given,
# a body matching BODY_REGEX). Echoes the last observed status and body on
# failure so the operator does not have to re-run curl by hand.
check_http() {
  local name="$1" url="$2" expect="$3" body_re="${4:-}"
  local waited=0 last_status="" last_body=""
  local body_file
  body_file="$(mktemp)"

  log_info "Checking $name at $url ..."
  while [ "$waited" -lt "$SMOKE_TIMEOUT" ]; do
    # On a connection failure curl still writes "000" via -w, so discard that
    # and set the status explicitly rather than appending to it.
    last_status="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)" \
      || last_status="000"
    last_body="$(cat "$body_file" 2>/dev/null || true)"

    if [ "$last_status" = "$expect" ]; then
      if [ -z "$body_re" ] || printf '%s' "$last_body" | grep -Eq "$body_re"; then
        rm -f "$body_file"
        log_pass "$name responded $last_status"
        return 0
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done

  rm -f "$body_file"
  log_fail "$name did not respond $expect (last status: ${last_status:-none})"
  if [ -n "$last_body" ]; then
    echo -e "       body: ${last_body:0:400}" >&2
  fi
  echo -e "       $(describe_service "$name")" >&2
  return 1
}

# ── checks ───────────────────────────────────────────────────────────────────

check_soroban() {
  if wait_for "Soroban/Horizon" "curl -sf --max-time 5 '$SOROBAN_HEALTH'"; then
    log_pass "Soroban/Horizon is healthy at $SOROBAN_HEALTH"
  else
    log_fail "Soroban/Horizon never became healthy at $SOROBAN_HEALTH"
    echo -e "       $(describe_service soroban)" >&2
    echo "       The first container start pulls and initialises quickstart, which can take minutes." >&2
  fi
}

check_redis() {
  if wait_for "Redis" "redis-cli -h '$REDIS' -p '$REDIS_PORT_NUM' ping | grep -q PONG"; then
    log_pass "Redis answered PING on $REDIS:$REDIS_PORT_NUM"
  else
    log_fail "Redis did not answer PING on $REDIS:$REDIS_PORT_NUM"
    echo -e "       $(describe_service redis)" >&2
    echo "       Install redis-cli, or point REDIS_HOST/REDIS_PORT at the running instance." >&2
  fi
}

check_mongodb() {
  # The host and port are expanded here, so the eval'd command sees concrete
  # values. bash's /dev/tcp is the only portable "is anything listening" probe
  # that needs no extra client binary.
  if wait_for "MongoDB" "bash -c \"</dev/tcp/${REDIS}/${MONGODB_PORT}\""; then
    log_pass "MongoDB is accepting connections on $REDIS:$MONGODB_PORT"
  else
    log_fail "MongoDB is not accepting connections on $REDIS:$MONGODB_PORT"
    echo -e "       $(describe_service mongodb)" >&2
  fi
}

# The backend is the piece most likely to be broken: validateEnv() refuses to
# bind a port when required variables are missing or a Stellar id is malformed.
check_backend() {
  if check_http "backend /health" "$BACKEND_URL/health" 200 '"status"'; then
    return
  fi

  echo "       The backend exits at startup if required env vars are missing." >&2
  echo "       Required: MONGODB_URI, REDIS_URL, SOROBAN_RPC_URL," >&2
  echo "                 TREASURY_CONTRACT_ID, INVOICE_CONTRACT_ID, ADMIN_KEY," >&2
  echo "                 WEBHOOK_SIGNING_SECRET" >&2
  echo "       Validate a local env file with:" >&2
  echo "         scripts/validate_backend_env.sh comebackhere-backend/.env" >&2
}

check_frontend() {
  check_http "frontend /" "$FRONTEND_URL/" 200 '<!doctype html|<html'
}

# The rate-limit headers are documented in docs/rate-limits.md; if the middleware
# is not mounted the docs are wrong, so assert the contract the docs promise.
check_rate_limit_headers() {
  local headers
  headers="$(curl -s -D - -o /dev/null --max-time 5 "$BACKEND_URL/health" 2>/dev/null || true)"

  local missing=""
  for header in X-RateLimit-Limit X-RateLimit-Remaining X-RateLimit-Reset; do
    printf '%s' "$headers" | grep -qi "^${header}:" || missing="$missing $header"
  done

  if [ -z "$missing" ]; then
    log_pass "backend emits the documented X-RateLimit-* headers"
  else
    log_fail "backend is missing documented rate-limit headers:$missing"
    echo "       docs/rate-limits.md promises these on every response." >&2
    echo "       Check rateLimitMiddleware is mounted in src/app.ts." >&2
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

start_stack() {
  have_compose || die "docker compose is required for --up but was not found."
  log_info "Starting the stack (docker compose up -d --wait) ..."
  if ! compose up -d --wait; then
    # --wait is unavailable on older Compose; fall back to a plain start and
    # let the per-service waits below do the work.
    log_info "compose up --wait failed or is unsupported; retrying without --wait ..."
    compose up -d || {
      echo "       $(describe_service "")" >&2
      die "docker compose up failed."
    }
  fi
}

stop_stack() {
  have_compose || return 0
  log_info "Tearing the stack down ..."
  compose down -v || true
}

main() {
  parse_args "$@"

  require_cmd curl "Install curl and re-run."
  require_cmd bash "bash is required."

  echo "============================================"
  echo " COMEBACKHERE Smoke Test"
  echo " Full Stack Startup"
  echo "============================================"
  echo ""
  echo " backend  : $BACKEND_URL"
  echo " frontend : $FRONTEND_URL"
  echo " soroban  : $SOROBAN_HEALTH"
  echo " timeout  : ${SMOKE_TIMEOUT}s"
  echo " skip     : ${SMOKE_SKIP:-<nothing>}"
  echo ""

  if [ "$START_STACK" -eq 1 ]; then
    start_stack
  elif ! have_compose; then
    log_info "docker compose not found; only checking endpoints on the given URLs"
  fi

  echo ""
  run_or_skip soroban "stellar/quickstart not started for this run" check_soroban
  echo ""
  run_or_skip redis "redis-cli unavailable or Redis not started" check_redis
  echo ""
  run_or_skip mongodb "MongoDB not started for this run" check_mongodb
  echo ""
  run_or_skip backend "backend not started for this run" check_backend
  echo ""
  # `set -e` would abort the run on the first failing check, which is exactly
  # what this test must not do: it reports every service, not just the first.
  run_or_skip frontend "frontend not started for this run" check_frontend || true
  echo ""
  if should_skip backend; then
    log_skip "backend rate-limit headers" "backend check skipped"
  else
    check_rate_limit_headers || true
  fi

  if [ "$STOP_STACK" -eq 1 ]; then
    echo ""
    stop_stack
  fi

  echo ""
  echo "============================================"
  echo -e " Results: ${GREEN}${pass_count} passed${NC}, ${RED}${fail_count} failed${NC}"
  echo "============================================"

  if [ "$fail_count" -gt 0 ]; then
    echo ""
    echo "Startup smoke test failed. Most likely causes:" >&2
    echo "  - a required backend env var is missing or malformed (see above)" >&2
    echo "  - docker compose logs <service> for the service that did not come up" >&2
    echo "  - a port is already taken by a process outside compose" >&2
    return 1
  fi
}

main "$@"
