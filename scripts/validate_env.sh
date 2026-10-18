#!/usr/bin/env bash
# Validate required environment variables before deployment.
#
# Usage:
#   scripts/validate_env.sh [ENV_FILE] [ENV_LABEL] [--env testnet|mainnet|local]
#
# The --env flag selects which set of required variables to enforce:
#   local    — minimal set for local Docker Compose development
#   testnet  — standard set for testnet deployments
#   mainnet  — strict set for mainnet deployments (no test keys, additional checks)
#
# If --env is not specified, the script validates the common baseline variables
# (compatible with prior behaviour).
#
# Examples:
#   scripts/validate_env.sh .env.testnet testnet --env testnet
#   scripts/validate_env.sh .env.mainnet mainnet  --env mainnet
#   scripts/validate_env.sh .env.local   local    --env local
set -euo pipefail

ENV_FILE="${1:-}"
ENV_LABEL="${2:-deployment}"
ENV_MODE=""

# Parse --env flag from remaining arguments
for arg in "$@"; do
  case "$arg" in
    --env)
      # next iteration will capture the value
      ;;
  esac
done

# Robust flag parsing: scan all args for --env <mode>
i=1
for arg in "$@"; do
  if [[ "$arg" == "--env" ]]; then
    next_i=$((i + 1))
    eval "ENV_MODE=\"\${${next_i}:-}\""
    break
  fi
  i=$((i + 1))
done

# Validate the mode value if provided
if [[ -n "$ENV_MODE" ]]; then
  case "$ENV_MODE" in
    local|testnet|mainnet) ;;
    *)
      echo "Error: --env must be one of: local, testnet, mainnet (got '$ENV_MODE')." >&2
      exit 1
      ;;
  esac
fi

if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

declare -a missing=()
declare -a invalid=()

require_var() {
  local name="$1"
  local hint="$2"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    echo "Error: Required environment variable '$name' is missing or empty." >&2
    echo "Set it in your shell or in ${ENV_FILE:-the environment file} before running this ${ENV_LABEL}." >&2
    echo "Hint: $hint" >&2
    missing+=("$name")
    return 1
  fi

  case "$name" in
    ADMIN_PUBLIC_KEY|CONTRACT_ADMIN)
      if [[ "$value" != G* ]]; then
        echo "Error: '$name' must start with 'G' for a Stellar public key." >&2
        echo "Hint: use a valid public key such as G..." >&2
        invalid+=("$name")
        return 1
      fi
      ;;
    ADMIN_SECRET_KEY|SECRET_KEY)
      if [[ "$value" != S* ]]; then
        echo "Error: '$name' must start with 'S' for a Stellar secret key." >&2
        echo "Hint: use a valid secret key such as S..." >&2
        invalid+=("$name")
        return 1
      fi
      ;;
    SOROBAN_RPC_URL|RPC_URL)
      if [[ "$value" != http://* && "$value" != https://* ]]; then
        echo "Error: '$name' must be a valid HTTP(S) URL." >&2
        echo "Hint: use a value such as https://soroban-testnet.stellar.org" >&2
        invalid+=("$name")
        return 1
      fi
      ;;
  esac

  if [[ "$value" == *"..."* ]]; then
    echo "Error: '$name' still contains a placeholder value." >&2
    echo "Replace it with a real value before deploying." >&2
    invalid+=("$name")
    return 1
  fi
}

require_any_var() {
  local hint="$1"
  shift
  local names=("$@")
  local name
  local value

  for name in "${names[@]}"; do
    value="${!name:-}"
    if [[ -n "$value" ]]; then
      if [[ "$name" == "ADMIN_PUBLIC_KEY" || "$name" == "CONTRACT_ADMIN" ]]; then
        if [[ "$value" != G* ]]; then
          echo "Error: '$name' must start with 'G' for a Stellar public key." >&2
          echo "Hint: use a valid public key such as G..." >&2
          invalid+=("$name")
          return 1
        fi
      elif [[ "$name" == "ADMIN_SECRET_KEY" || "$name" == "SECRET_KEY" ]]; then
        if [[ "$value" != S* ]]; then
          echo "Error: '$name' must start with 'S' for a Stellar secret key." >&2
          echo "Hint: use a valid secret key such as S..." >&2
          invalid+=("$name")
          return 1
        fi
      elif [[ "$name" == "SOROBAN_RPC_URL" || "$name" == "RPC_URL" ]]; then
        if [[ "$value" != http://* && "$value" != https://* ]]; then
          echo "Error: '$name' must be a valid HTTP(S) URL." >&2
          echo "Hint: use a value such as https://soroban-testnet.stellar.org" >&2
          invalid+=("$name")
          return 1
        fi
      fi

      if [[ "$value" == *"..."* ]]; then
        echo "Error: '$name' still contains a placeholder value." >&2
        echo "Replace it with a real value before deploying." >&2
        invalid+=("$name")
        return 1
      fi

      return 0
    fi
  done

  echo "Error: Required environment variable(s) ${names[*]} are missing or empty." >&2
  echo "Set one of them in your shell or in ${ENV_FILE:-the environment file} before running this ${ENV_LABEL}." >&2
  echo "Hint: $hint" >&2
  for name in "${names[@]}"; do
    missing+=("$name")
  done
  return 1
}

# ── common baseline variables (all modes) ────────────────────────────────────

if ! require_any_var "Set SOROBAN_RPC_URL (or RPC_URL) to your Soroban RPC endpoint." "SOROBAN_RPC_URL" "RPC_URL"; then
  :
fi

# Allow legacy/README env variable name for network passphrase.
if [[ -z "${SOROBAN_NETWORK_PASSPHRASE:-}" && -n "${NETWORK_PASSPHRASE:-}" ]]; then
  export SOROBAN_NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE"
fi

if ! require_any_var "Set SOROBAN_NETWORK_PASSPHRASE (or NETWORK_PASSPHRASE) to the network passphrase for the target network." "SOROBAN_NETWORK_PASSPHRASE" "NETWORK_PASSPHRASE"; then
  :
fi

if ! require_any_var "Set ADMIN_PUBLIC_KEY (or CONTRACT_ADMIN) to the Stellar public key that will act as the admin." "ADMIN_PUBLIC_KEY" "CONTRACT_ADMIN"; then
  :
fi

if ! require_any_var "Set ADMIN_SECRET_KEY (or SECRET_KEY) to the corresponding Stellar secret key for deployment signing." "ADMIN_SECRET_KEY" "SECRET_KEY"; then
  :
fi

# ── mode-specific variable checks ────────────────────────────────────────────

case "$ENV_MODE" in

  local)
    # Local development: RPC is typically the local Docker Compose node.
    # Verify that the RPC URL points to localhost or a local address.
    _rpc_url="${SOROBAN_RPC_URL:-${RPC_URL:-}}"
    if [[ -n "$_rpc_url" && "$_rpc_url" != *"localhost"* && "$_rpc_url" != *"127.0.0.1"* && "$_rpc_url" != *"0.0.0.0"* ]]; then
      echo "Warning: --env local is set but SOROBAN_RPC_URL ('$_rpc_url') does not appear to point to a local node." >&2
      echo "Hint: For local mode, use http://localhost:8000/soroban/rpc or similar." >&2
    fi
    ;;

  testnet)
    # Testnet: requires STELLAR_NETWORK to be explicitly set to 'testnet'.
    if ! require_var "STELLAR_NETWORK" "Set STELLAR_NETWORK=testnet for testnet deployments."; then
      :
    else
      if [[ "${STELLAR_NETWORK}" != "testnet" ]]; then
        echo "Error: --env testnet requires STELLAR_NETWORK=testnet (got '${STELLAR_NETWORK}')." >&2
        invalid+=("STELLAR_NETWORK")
      fi
    fi
    # Testnet also requires deployed contract IDs to be present.
    if ! require_var "INVOICE_CONTRACT_ID" "Set INVOICE_CONTRACT_ID to the deployed testnet invoice contract address."; then
      :
    fi
    if ! require_var "TREASURY_CONTRACT_ID" "Set TREASURY_CONTRACT_ID to the deployed testnet treasury contract address."; then
      :
    fi
    if ! require_var "COMPLIANCE_CONTRACT_ID" "Set COMPLIANCE_CONTRACT_ID to the deployed testnet compliance contract address."; then
      :
    fi
    ;;

  mainnet)
    # Mainnet: strictest checks. Secret keys must not use testnet-only values,
    # and the network passphrase must match the Stellar mainnet passphrase.
    MAINNET_PASSPHRASE="Public Global Stellar Network ; September 2015"

    _passphrase="${SOROBAN_NETWORK_PASSPHRASE:-${NETWORK_PASSPHRASE:-}}"
    if [[ -n "$_passphrase" && "$_passphrase" != "$MAINNET_PASSPHRASE" ]]; then
      echo "Error: --env mainnet requires SOROBAN_NETWORK_PASSPHRASE to equal the Stellar mainnet passphrase." >&2
      echo "  Expected: '$MAINNET_PASSPHRASE'" >&2
      echo "  Got:      '$_passphrase'" >&2
      invalid+=("SOROBAN_NETWORK_PASSPHRASE")
    fi

    if ! require_var "STELLAR_NETWORK" "Set STELLAR_NETWORK=mainnet for mainnet deployments."; then
      :
    else
      if [[ "${STELLAR_NETWORK}" != "mainnet" ]]; then
        echo "Error: --env mainnet requires STELLAR_NETWORK=mainnet (got '${STELLAR_NETWORK}')." >&2
        invalid+=("STELLAR_NETWORK")
      fi
    fi

    # Deployed contract IDs are required for mainnet.
    if ! require_var "INVOICE_CONTRACT_ID" "Set INVOICE_CONTRACT_ID to the deployed mainnet invoice contract address."; then
      :
    fi
    if ! require_var "TREASURY_CONTRACT_ID" "Set TREASURY_CONTRACT_ID to the deployed mainnet treasury contract address."; then
      :
    fi
    if ! require_var "COMPLIANCE_CONTRACT_ID" "Set COMPLIANCE_CONTRACT_ID to the deployed mainnet compliance contract address."; then
      :
    fi

    # USDC contract ID is required on mainnet.
    if ! require_var "USDC_CONTRACT_ID" "Set USDC_CONTRACT_ID to the official USDC asset contract ID on Stellar mainnet."; then
      :
    fi

    # Reject obviously-testnet RPC URLs on mainnet mode.
    _rpc_url="${SOROBAN_RPC_URL:-${RPC_URL:-}}"
    if [[ -n "$_rpc_url" && "$_rpc_url" == *"testnet"* ]]; then
      echo "Error: --env mainnet is set but SOROBAN_RPC_URL ('$_rpc_url') contains 'testnet'. Use a mainnet RPC endpoint." >&2
      invalid+=("SOROBAN_RPC_URL")
    fi

    # Warn if RPC points to localhost — unusual for mainnet.
    if [[ -n "$_rpc_url" && ( "$_rpc_url" == *"localhost"* || "$_rpc_url" == *"127.0.0.1"* ) ]]; then
      echo "Warning: --env mainnet is set but SOROBAN_RPC_URL ('$_rpc_url') points to localhost. Confirm this is intentional." >&2
    fi
    ;;

esac

# ── final summary ─────────────────────────────────────────────────────────────

if (( ${#missing[@]} > 0 )); then
  echo "Missing required environment variables:" >&2
  printf ' - %s\n' "${missing[@]}" >&2
  exit 1
fi

if (( ${#invalid[@]} > 0 )); then
  echo "Invalid required environment variables:" >&2
  printf ' - %s\n' "${invalid[@]}" >&2
  exit 1
fi
