/**
 * config.ts
 *
 * Validates all required VITE_ environment variables at module load time.
 * If any variable is missing or malformed the module throws an error so
 * that `main.tsx` can render a clear configuration error screen instead of
 * letting the app start and fail later with a cryptic Soroban RPC error.
 *
 * The exported `config` object is the single source of truth for environment
 * configuration. All other modules should import from here rather than
 * reading `import.meta.env` directly.
 */

/** Stellar contract ID format: C followed by 55 uppercase base-32 characters. */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/

interface ConfigValidationError {
  variable: string
  message: string
}

interface AppConfig {
  apiUrl: string
  sorobanRpc: string
  horizonUrl: string
  networkPassphrase: string
  invoiceContractId: string
  complianceContractId: string
}

function validateConfig(): { config: AppConfig; errors: ConfigValidationError[] } {
  const errors: ConfigValidationError[] = []

  function require(key: string, description: string): string {
    const value = import.meta.env[key] as string | undefined
    if (!value || value.trim() === "") {
      errors.push({ variable: key, message: `${description} is required but not set` })
      return ""
    }
    return value.trim()
  }

  function requireContractId(key: string, description: string): string {
    const value = require(key, description)
    if (value && !CONTRACT_ID_RE.test(value)) {
      errors.push({
        variable: key,
        message: `${description} must be a valid Stellar contract ID (starts with C, 56 characters)`,
      })
    }
    return value
  }

  function requireUrl(key: string, description: string): string {
    const value = require(key, description)
    if (value) {
      try {
        new URL(value)
      } catch {
        errors.push({ variable: key, message: `${description} must be a valid URL` })
      }
    }
    return value
  }

  const apiUrl = requireUrl("VITE_API_URL", "Backend API URL")
  const sorobanRpc = requireUrl("VITE_SOROBAN_RPC", "Soroban RPC URL")
  const horizonUrl = requireUrl("VITE_HORIZON_URL", "Horizon API URL")
  const networkPassphrase = require("VITE_NETWORK_PASSPHRASE", "Stellar network passphrase")
  const invoiceContractId = requireContractId("VITE_INVOICE_CONTRACT_ID", "Invoice contract ID")
  const complianceContractId = requireContractId("VITE_COMPLIANCE_CONTRACT_ID", "Compliance contract ID")

  return {
    config: { apiUrl, sorobanRpc, horizonUrl, networkPassphrase, invoiceContractId, complianceContractId },
    errors,
  }
}

const { config: _config, errors: _errors } = validateConfig()

/**
 * Typed, validated application configuration.
 *
 * Guaranteed to be correct if `configErrors` is empty. Accessing individual
 * properties when there are errors will return empty strings — callers should
 * check `configErrors` (or let `main.tsx` gate rendering) before using them.
 */
export const config: Readonly<AppConfig> = _config

/**
 * Non-empty when one or more required environment variables are missing or
 * malformed. `main.tsx` renders a configuration error screen in this case.
 */
export const configErrors: ReadonlyArray<ConfigValidationError> = _errors
