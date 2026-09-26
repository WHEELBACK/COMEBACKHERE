import { ServiceMisconfiguredError } from "./errors.js"
import { getNetworkPassphrase } from "./soroban.js"

/**
 * Env object returned by {@link requireEnv} for a route.
 *
 * `rpcUrl` and `networkPassphrase` are always present. Every additional
 * property comes from the `vars` mapping passed to {@link requireEnv}.
 */
export type ContractEnv<P extends Record<string, string>> = {
  rpcUrl: string
  networkPassphrase: string
} & { [Prop in keyof P]: string }

/**
 * Reads and validates the env vars a route needs from `process.env`.
 *
 * `SOROBAN_RPC_URL` (returned as `rpcUrl`) and the network passphrase
 * (returned as `networkPassphrase`) are always validated. `vars` maps each
 * additional property name to the env var it should be read from, e.g.
 * `{ treasuryContractId: "TREASURY_CONTRACT_ID" }`.
 *
 * If any referenced var is unset, throws a {@link ServiceMisconfiguredError}
 * (503 in the standard error envelope).
 */
export function requireEnv<P extends Record<string, string>>(vars: P): ContractEnv<P> {
  const missing = [
    !process.env.SOROBAN_RPC_URL ? "SOROBAN_RPC_URL" : null,
    ...Object.values(vars).filter((envName) => !process.env[envName]),
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new ServiceMisconfiguredError()
  }

  const values = Object.fromEntries(
    Object.entries(vars).map(([prop, envName]) => [prop, process.env[envName] as string]),
  ) as { [Prop in keyof P]: string }

  return {
    rpcUrl: process.env.SOROBAN_RPC_URL as string,
    networkPassphrase: getNetworkPassphrase(),
    ...values,
  }
}

/**
 * Parses and validates `CORS_ORIGINS`, a comma-separated allowlist of origins
 * permitted to call the API from a browser, e.g.
 * `http://localhost:5173,https://app.example.com`.
 *
 * Each entry must be a bare http(s) origin — scheme, host and optional port,
 * with no path, query or trailing slash. Wildcards are rejected because the
 * API has authenticated routes. Unset or empty means no cross-origin browser
 * access is allowed (same-origin and non-browser clients are unaffected).
 *
 * Throws with every invalid entry listed so misconfiguration fails at startup.
 */
export function parseCorsOrigins(raw: string | undefined = process.env.CORS_ORIGINS): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

  const invalid: string[] = []
  const origins = new Set<string>()
  for (const entry of entries) {
    let url: URL | null = null
    try {
      url = new URL(entry)
    } catch {
      url = null
    }
    const isBareOrigin =
      url !== null &&
      !entry.includes("*") &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname === "/" &&
      !entry.endsWith("/") &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    if (!isBareOrigin) {
      invalid.push(entry)
      continue
    }
    origins.add(url!.origin)
  }

  if (invalid.length > 0) {
    throw new Error(
      `Invalid CORS_ORIGINS entries: ${invalid.map((e) => JSON.stringify(e)).join(", ")}. ` +
        "Each entry must be an http(s) origin such as https://app.example.com (no path, trailing slash or wildcard).",
    )
  }

  return [...origins]
}

export interface WebhookRetryConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

/** Reads webhook retry policy from the environment, falling back to safe defaults. */
export function getWebhookRetryConfig(env: NodeJS.ProcessEnv = process.env): WebhookRetryConfig {
  const positiveInteger = (name: string, fallback: number): number => {
    const value = env[name]
    if (value === undefined || value === "") return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer`)
    }
    return parsed
  }

  const maxAttempts = positiveInteger("WEBHOOK_MAX_ATTEMPTS", 5)
  const baseDelayMs = positiveInteger("WEBHOOK_BASE_DELAY_MS", 1_000)
  const maxDelayMs = positiveInteger("WEBHOOK_MAX_DELAY_MS", 60_000)
  const jitterRaw = env.WEBHOOK_JITTER_RATIO
  const jitterRatio = jitterRaw === undefined || jitterRaw === "" ? 0.2 : Number(jitterRaw)
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("WEBHOOK_JITTER_RATIO must be between 0 and 1")
  }

  return { maxAttempts, baseDelayMs, maxDelayMs, jitterRatio }
}
