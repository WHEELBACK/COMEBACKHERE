import type { Response } from "express"
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

const MISSING_ENV_ERROR = "Service misconfiguration: missing required environment variables"

/**
 * Reads and validates the env vars a route needs from `process.env`.
 *
 * `SOROBAN_RPC_URL` (returned as `rpcUrl`) and the network passphrase
 * (returned as `networkPassphrase`) are always validated. `vars` maps each
 * additional property name to the env var it should be read from, e.g.
 * `{ treasuryContractId: "TREASURY_CONTRACT_ID" }`.
 *
 * If any referenced var is unset, writes a 503 with the standard
 * misconfiguration error to `res` and returns null.
 */
export function requireEnv<P extends Record<string, string>>(
  res: Response,
  vars: P,
): ContractEnv<P> | null {
  const missing = [
    !process.env.SOROBAN_RPC_URL ? "SOROBAN_RPC_URL" : null,
    ...Object.values(vars).filter((envName) => !process.env[envName]),
  ].filter(Boolean)
  if (missing.length > 0) {
    res.status(503).json({ error: MISSING_ENV_ERROR })
    return null
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
