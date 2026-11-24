import { describe, it, expect } from "vitest"
import { getExplorerTxBaseUrl } from "../utils/explorerUrl"

describe("getExplorerTxBaseUrl", () => {
  it("uses the public network segment for mainnet", () => {
    expect(getExplorerTxBaseUrl("Public Global Stellar Network ; September 2015")).toBe(
      "https://stellar.expert/explorer/public/tx",
    )
  })

  it("uses the testnet segment for testnet and unknown networks", () => {
    expect(getExplorerTxBaseUrl("Test SDF Network ; September 2015")).toBe(
      "https://stellar.expert/explorer/testnet/tx",
    )
    expect(getExplorerTxBaseUrl("something else")).toBe("https://stellar.expert/explorer/testnet/tx")
  })
})
