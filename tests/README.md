# Integration Tests

Workspace-level integration tests that run against the local Soroban
environment started by `docker-compose`.

## Test suites

| Script | Needs contracts? | What it checks |
| --- | --- | --- |
| [`smoke_stack.sh`](./smoke_stack.sh) | No | The stack boots: every service answers on its published port |
| [`invoice_lifecycle.sh`](./invoice_lifecycle.sh) | Yes | On-chain invoice lifecycle against deployed contracts |

Run the smoke test first. It is the fast check that catches a broken startup
path — a missing backend env var, a port clash, a frontend that will not compile
— before you spend time deploying contracts.

## Smoke test — `smoke_stack.sh`

Verifies that the services started by `docker-compose up` come up together:

| Service | Check |
| --- | --- |
| `soroban` | `GET /health` on `http://localhost:8000` |
| `redis` | `PING` returns `PONG` on `localhost:6379` |
| `mongodb` | Accepts connections on `localhost:27017` |
| `backend` | `GET /health` returns `200` with a `status` field |
| `frontend` | `GET /` returns `200` and serves an HTML document |
| `backend` | Emits the `X-RateLimit-*` headers `docs/rate-limits.md` promises |

The last check is deliberate: it asserts the contract the documentation makes
about every response, so a refactor that drops the rate-limit middleware fails
here rather than silently contradicting the docs.

### Prerequisites

Only Docker, Docker Compose and `curl` (plus `redis-cli` for the Redis check).
**No deployed contracts, no `soroban` CLI, no funded accounts.**

### Running

```sh
# Bring the stack up, smoke test it, then tear it down
./tests/smoke_stack.sh --up --down

# Or check a stack that is already running
./tests/smoke_stack.sh

# Just the task runner equivalents
make smoke-up
just smoke-up
```

### Options and environment

| Flag | Effect |
| --- | --- |
| `--up` | Run `docker compose up -d --wait` first |
| `--down` | Run `docker compose down -v` afterwards |
| `--timeout N` | Per-service wait in seconds (default `120`) |

| Variable | Default |
| --- | --- |
| `BACKEND_URL` | `http://localhost:3000` |
| `FRONTEND_URL` | `http://localhost:5173` |
| `SOROBAN_HEALTH` | `http://localhost:8000/health` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` |
| `MONGODB_PORT` | `27017` |
| `SMOKE_TIMEOUT` | `120` |

The first start of `stellar/quickstart` pulls and initialises a network, which
can take several minutes — raise `--timeout` if the Soroban check times out on
a cold machine.

### Reading a failure

Every check runs even after one fails, so a single run tells you everything
that is broken. Each failure names the service, the last observed status or
body, and the command to inspect it. If the backend never answers, the output
lists the variables `validateEnv()` requires at startup and points at
`scripts/validate_backend_env.sh`.

Exit codes: `0` all passed, `1` at least one check failed, `2` the script
could not run (missing tool, bad flag).

## Prerequisites for the lifecycle test

1. Docker and Docker Compose installed.
2. `soroban` CLI installed.
3. Local environment running:

   ```sh
   docker-compose up -d
   ```

4. Contracts deployed locally:

   ```sh
   cp .env.local.example .env.local
   scripts/deploy_local.sh
   ```

## Running the lifecycle test

Export the deployed contract addresses, then run the test script:

```sh
export INVOICE_CONTRACT_ID=<deployed invoice contract>
export TREASURY_CONTRACT_ID=<deployed treasury contract>
export USDC_CONTRACT_ID=<deployed USDC token contract>

./tests/invoice_lifecycle.sh
```

## Test Coverage

| Test | Description |
| --- | --- |
| Create invoice | Creates a valid invoice with minimum amount |
| Pay invoice | Pays the invoice with USDC via the payer account |
| Escrow release | Proposes, approves, and executes a treasury settlement |
| Invalid amount | Verifies rejection of invoices below the minimum amount |
| Refund flow | Exercises create -> pay -> refund-request -> refund end-to-end |

## Documentation checks

Not a stack test, but the other repeatable check in this repository — both run
in CI and can be run locally:

```sh
./scripts/check_webhook_docs_sync.sh     # docs/webhooks.md vs the signing code
./scripts/check_ratelimit_docs_sync.sh   # docs/rate-limits.md vs the limiter
```
