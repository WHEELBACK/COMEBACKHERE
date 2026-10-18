import { useCallback, useSyncExternalStore } from "react"
import { getNetworkPassphrase } from "../utils/soroban"

interface FreighterApi {
  getAddress: () => Promise<{ address: string; error?: string }>
  getNetworkDetails?: () => Promise<{ passphrase?: string }>
}

interface WindowWithFreighter extends Window {
  freighterApi?: FreighterApi
}

/**
 * Every state the wallet can be in. Consumers should switch on `status`
 * exhaustively (see WalletBar) so a new state is a compile error until it
 * is handled.
 */
export type WalletState =
  | { status: "not-installed" }
  | { status: "disconnected"; error: string | null }
  | { status: "connecting" }
  | { status: "rejected"; reason: "rejected" | "locked"; error: string }
  | { status: "connected"; address: string; network: string | null }
  | { status: "wrong-network"; address: string; network: string; expectedNetwork: string }

export type WalletStatus = WalletState["status"]

const INITIAL_STATE: WalletState = { status: "disconnected", error: null }
const POLL_INTERVAL_MS = 5000

const REJECTION_INDICATORS = ["locked", "user rejected", "rejected", "declined", "not approved", "not allowed", "unauthorized"]

/** Classify an error as the user rejecting the request or the wallet being locked. */
function rejectionReason(error: unknown): "rejected" | "locked" | null {
  if (!error) return null
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (!REJECTION_INDICATORS.some((indicator) => message.includes(indicator))) return null
  return message.includes("locked") ? "locked" : "rejected"
}

function getFreighter(): FreighterApi | undefined {
  return (window as WindowWithFreighter).freighterApi
}

async function getNetwork(freighterApi: FreighterApi): Promise<string | null> {
  try {
    const networkDetails = await freighterApi.getNetworkDetails?.()
    return networkDetails?.passphrase ?? null
  } catch {
    return null
  }
}

function connectedState(address: string, network: string | null): WalletState {
  const expectedNetwork = getNetworkPassphrase()
  if (network !== null && expectedNetwork && network !== expectedNetwork) {
    return { status: "wrong-network", address, network, expectedNetwork }
  }
  return { status: "connected", address, network }
}

function errorState(err: unknown, fallback: string): WalletState {
  const message = err instanceof Error ? err.message : fallback
  const reason = rejectionReason(err)
  return reason ? { status: "rejected", reason, error: message } : { status: "disconnected", error: message }
}

/** Ask Freighter for the current account and turn the answer into a state. */
async function readWallet(fallbackError: string): Promise<WalletState> {
  const freighterApi = getFreighter()
  if (!freighterApi) return { status: "not-installed" }
  try {
    const { address, error } = await freighterApi.getAddress()
    if (error) throw new Error(error)
    if (!address) return { status: "disconnected", error: null }
    return connectedState(address, await getNetwork(freighterApi))
  } catch (err: unknown) {
    return errorState(err, fallbackError)
  }
}

// ---------------------------------------------------------------------------
// Shared store: all useWallet() callers see the same wallet state, so the
// header and every tab agree on whether actions can be signed.
// ---------------------------------------------------------------------------

let state: WalletState = INITIAL_STATE
let userDisconnected = false
let requestSeq = 0
let pollTimer: number | undefined
const listeners = new Set<() => void>()

function setState(next: WalletState) {
  state = next
  listeners.forEach((listener) => listener())
}

/** Poll results must not clobber an in-flight connect or an explicit disconnect. */
function pollPaused(): boolean {
  return getSnapshot().status === "connecting" || userDisconnected
}

async function checkConnection() {
  if (pollPaused()) return
  // Freighter not installed is known synchronously, so show it right away.
  if (!getFreighter()) {
    if (state.status !== "not-installed") setState({ status: "not-installed" })
    return
  }
  const seq = ++requestSeq
  const next = await readWallet("Unknown error")
  if (seq === requestSeq && !pollPaused()) setState(next)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    void checkConnection()
    pollTimer = window.setInterval(() => void checkConnection(), POLL_INTERVAL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.clearInterval(pollTimer)
      pollTimer = undefined
      // Nothing is watching the wallet any more: start fresh next time.
      state = INITIAL_STATE
      userDisconnected = false
      requestSeq++
    }
  }
}

function getSnapshot() {
  return state
}

async function connectWallet(): Promise<WalletState> {
  userDisconnected = false
  const seq = ++requestSeq
  if (!getFreighter()) {
    setState({ status: "not-installed" })
    return state
  }
  setState({ status: "connecting" })
  const next = await readWallet("Failed to connect wallet")
  // A disconnect (or a newer connect) while we waited wins.
  if (seq === requestSeq) setState(next)
  return state
}

function disconnectWallet() {
  userDisconnected = true
  requestSeq++
  setState(INITIAL_STATE)
}

/**
 * Explanation for why actions that need a signed transaction are unavailable,
 * or null when the wallet is ready to sign.
 */
export function walletNotReadyReason(wallet: WalletState): string | null {
  switch (wallet.status) {
    case "connected":
      return null
    case "not-installed":
      return "Install the Freighter wallet extension to sign transactions."
    case "disconnected":
      return "Connect your wallet to sign transactions."
    case "connecting":
      return "Waiting for your wallet to connect. Approve the request in Freighter."
    case "rejected":
      return wallet.reason === "locked"
        ? "Your wallet is locked. Unlock Freighter and try again."
        : "The connection request was rejected. Connect your wallet to continue."
    case "wrong-network":
      return "Your wallet is on the wrong network. Switch Freighter to the expected network."
    default: {
      const unreachable: never = wallet
      return unreachable
    }
  }
}

export function useWallet() {
  const wallet = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const connect = useCallback(() => connectWallet(), [])
  const disconnect = useCallback(() => disconnectWallet(), [])
  const retryConnect = useCallback(() => connectWallet(), [])

  const hasAccount = wallet.status === "connected" || wallet.status === "wrong-network"

  return {
    /** The full state union; prefer switching on this in components. */
    wallet,
    status: wallet.status,
    /** True only when transactions can be signed (connected, right network). */
    ready: wallet.status === "connected",
    notReadyReason: walletNotReadyReason(wallet),
    address: hasAccount ? wallet.address : null,
    network: hasAccount ? wallet.network : null,
    /** An account is linked, even if it is on the wrong network. */
    connected: hasAccount,
    connecting: wallet.status === "connecting",
    error: wallet.status === "disconnected" || wallet.status === "rejected" ? wallet.error : null,
    isLocked: wallet.status === "rejected",
    isNotInstalled: wallet.status === "not-installed",
    connect,
    disconnect,
    retryConnect,
  }
}
