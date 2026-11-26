import { describe, it, expect } from "vitest"
import {
  isWalletRejection,
  friendlyWalletError,
  WALLET_REJECTED_MESSAGE,
} from "../utils/walletErrors"

describe("isWalletRejection", () => {
  it("returns true for messages containing rejection keywords", () => {
    expect(isWalletRejection("User rejected the transaction")).toBe(true)
    expect(isWalletRejection("user declined")).toBe(true)
    expect(isWalletRejection("Transaction cancelled")).toBe(true)
    expect(isWalletRejection("Request denied by user")).toBe(true)
    expect(isWalletRejection("Transaction not approved")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isWalletRejection("USER REJECTED")).toBe(true)
    expect(isWalletRejection("Declined By User")).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(isWalletRejection("Network timeout")).toBe(false)
    expect(isWalletRejection("Insufficient fee")).toBe(false)
    expect(isWalletRejection("")).toBe(false)
  })

  it("returns false for null and undefined", () => {
    expect(isWalletRejection(null)).toBe(false)
    expect(isWalletRejection(undefined)).toBe(false)
  })
})

describe("friendlyWalletError", () => {
  it("replaces the error message on a rejection result", () => {
    const result = { success: false, error: "User rejected the request" }
    const friendly = friendlyWalletError(result)
    expect(friendly.error).toBe(WALLET_REJECTED_MESSAGE)
    expect(friendly.success).toBe(false)
  })

  it("passes through successful results unchanged", () => {
    const result = { success: true, error: undefined }
    expect(friendlyWalletError(result)).toEqual(result)
  })

  it("passes through non-rejection failure results unchanged", () => {
    const result = { success: false, error: "RPC node unreachable" }
    expect(friendlyWalletError(result)).toEqual(result)
  })
})
