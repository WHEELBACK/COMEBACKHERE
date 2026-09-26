import { test, expect, Page } from "@playwright/test"

interface FreighterApi {
  getAddress: () => Promise<{ address: string }>
  getNetworkDetails: () => Promise<{ passphrase: string }>
  isConnected: () => Promise<{ isConnected: boolean }>
  signTransaction: (xdr: string) => Promise<string>
}

interface WindowWithFreighter extends Window {
  freighterApi?: FreighterApi
}

// ---------------------------------------------------------------------------
// Freighter stub helpers
// ---------------------------------------------------------------------------

/** Full connected stub — used as the baseline for most states. */
async function stubFreighterConnected(page: Page, address: string) {
  await page.addInitScript((addr: string) => {
    ;(window as WindowWithFreighter).freighterApi = {
      getAddress: async () => ({ address: addr }),
      getNetworkDetails: async () => ({
        passphrase: "Test SDF Network ; September 2015",
      }),
      isConnected: async () => ({ isConnected: true }),
      signTransaction: async (xdr: string) => xdr,
    }
  }, address)
}

const TEST_ADDRESS = "GTEST000WALLET0ADDRESS0000000000000000000000000000000000"

// ---------------------------------------------------------------------------
// Wallet states
// ---------------------------------------------------------------------------

test.describe("WalletBar — wallet states", () => {
  // ------------------------------------------------------------------
  // not-installed
  // ------------------------------------------------------------------
  test("not-installed: shows alert and Install Extension link", async ({ page }) => {
    // Remove the API entirely so the app sees no extension
    await page.addInitScript(() => {
      delete (window as WindowWithFreighter).freighterApi
    })

    await page.goto("/")

    const walletBar = page.locator("[data-wallet-status='not-installed']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--not-installed/)

    // Alert region
    const alert = page.getByRole("alert").filter({ hasText: /Freighter wallet not detected/i })
    await expect(alert).toBeVisible()

    // Install extension link
    const installLink = page.getByRole("link", { name: /Install Extension/i })
    await expect(installLink).toBeVisible()

    await page.screenshot({ path: "e2e/screenshots/wallet-not-installed.png", fullPage: true })
  })

  // ------------------------------------------------------------------
  // disconnected
  // ------------------------------------------------------------------
  test("disconnected: shows Connect Wallet button", async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as WindowWithFreighter).freighterApi = {
        getAddress: async () => ({ address: "" }), // empty address = not connected
        getNetworkDetails: async () => ({
          passphrase: "Test SDF Network ; September 2015",
        }),
        isConnected: async () => ({ isConnected: true }),
        signTransaction: async (xdr: string) => xdr,
      }
    })

    await page.goto("/")

    const walletBar = page.locator("[data-wallet-status='disconnected']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--disconnected/)

    const connectBtn = page.getByTestId("connect-wallet-btn")
    await expect(connectBtn).toBeVisible()
    await expect(connectBtn).toHaveText(/Connect Wallet/i)

    await page.screenshot({ path: "e2e/screenshots/wallet-disconnected.png", fullPage: true })
  })

  // ------------------------------------------------------------------
  // connecting
  // ------------------------------------------------------------------
  test("connecting: page loads and connecting state can be observed", async ({ page }) => {
    // The connecting state is transient (in-flight async call); we set up a
    // stub whose getAddress never resolves so the component stays in the
    // connecting state indefinitely.
    await page.addInitScript(() => {
      ;(window as WindowWithFreighter).freighterApi = {
        getAddress: () => new Promise<{ address: string }>(() => { /* never resolves */ }),
        getNetworkDetails: async () => ({
          passphrase: "Test SDF Network ; September 2015",
        }),
        isConnected: async () => ({ isConnected: true }),
        signTransaction: async (xdr: string) => xdr,
      }
    })

    await page.goto("/")

    // The component should eventually render the connecting state while the
    // promise is pending.  We wait for the status attribute to appear.
    const walletBar = page.locator("[data-wallet-status='connecting']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--connecting/)

    // Status region with messaging
    const statusRegion = page.getByRole("status").filter({ hasText: /approve the request in Freighter/i })
    await expect(statusRegion).toBeVisible()

    // Disabled Connecting… button
    const connectingBtn = page.getByRole("button", { name: /Connecting\.\.\./i })
    await expect(connectingBtn).toBeVisible()
    await expect(connectingBtn).toBeDisabled()

    await page.screenshot({ path: "e2e/screenshots/wallet-connecting.png", fullPage: true })
  })

  // ------------------------------------------------------------------
  // rejected — reason: rejected
  // ------------------------------------------------------------------
  test("rejected (reason=rejected): shows alert and retry button", async ({ page }) => {
    // Simulate a rejection by having getAddress throw with a rejection error
    await page.addInitScript(() => {
      ;(window as WindowWithFreighter).freighterApi = {
        getAddress: async () => { throw new Error("User declined access") },
        getNetworkDetails: async () => ({
          passphrase: "Test SDF Network ; September 2015",
        }),
        isConnected: async () => ({ isConnected: true }),
        signTransaction: async (xdr: string) => xdr,
      }
    })

    await page.goto("/")

    const walletBar = page.locator("[data-wallet-status='rejected']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--rejected/)

    const alert = page.getByRole("alert").filter({ hasText: /Connection request rejected/i })
    await expect(alert).toBeVisible()

    const retryBtn = page.getByTestId("retry-connect-btn")
    await expect(retryBtn).toBeVisible()

    await page.screenshot({ path: "e2e/screenshots/wallet-rejected.png", fullPage: true })
  })

  // ------------------------------------------------------------------
  // rejected — reason: locked
  // ------------------------------------------------------------------
  test("rejected (reason=locked): shows alert and unlock button", async ({ page }) => {
    // Simulate a locked-wallet rejection
    await page.addInitScript(() => {
      ;(window as WindowWithFreighter).freighterApi = {
        getAddress: async () => { throw new Error("Wallet is locked") },
        getNetworkDetails: async () => ({
          passphrase: "Test SDF Network ; September 2015",
        }),
        isConnected: async () => ({ isConnected: true }),
        signTransaction: async (xdr: string) => xdr,
      }
    })

    await page.goto("/")

    const walletBar = page.locator("[data-wallet-status='rejected']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--rejected/)

    const alert = page.getByRole("alert").filter({ hasText: /Wallet is locked/i })
    await expect(alert).toBeVisible()

    const unlockBtn = page.getByTestId("unlock-wallet-btn")
    await expect(unlockBtn).toBeVisible()

    await page.screenshot({ path: "e2e/screenshots/wallet-rejected-locked.png", fullPage: true })
  })

  // ------------------------------------------------------------------
  // connected
  // ------------------------------------------------------------------
  test("connected: shows truncated wallet address", async ({ page }) => {
    await stubFreighterConnected(page, TEST_ADDRESS)

    await page.goto("/")

    const walletBar = page.locator("[data-wallet-status='connected']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--connected/)

    const addressEl = page.getByTestId("wallet-address")
    await expect(addressEl).toBeVisible()
    // The displayed address should be a truncated form of the full address
    const displayed = await addressEl.textContent()
    expect(displayed).toBeTruthy()
    expect(displayed!.length).toBeLessThan(TEST_ADDRESS.length)

    await page.screenshot({ path: "e2e/screenshots/wallet-connected.png", fullPage: true })
  })

  // ------------------------------------------------------------------
  // wrong-network
  // ------------------------------------------------------------------
  test("wrong-network: shows network warning alert", async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as WindowWithFreighter).freighterApi = {
        getAddress: async () => ({ address: "GTEST000WALLET0ADDRESS0000000000000000000000000000000000" }),
        // Return a passphrase that does not match VITE_NETWORK_PASSPHRASE
        getNetworkDetails: async () => ({
          passphrase: "Public Global Stellar Network ; September 2015",
        }),
        isConnected: async () => ({ isConnected: true }),
        signTransaction: async (xdr: string) => xdr,
      }
    })

    await page.goto("/")

    const walletBar = page.locator("[data-wallet-status='wrong-network']")
    await expect(walletBar).toBeVisible()
    await expect(walletBar).toHaveClass(/wallet-bar--wrong-network/)

    const networkWarning = page.getByTestId("network-warning")
    await expect(networkWarning).toBeVisible()
    await expect(networkWarning).toHaveAttribute("role", "alert")

    const alertText = page.getByRole("alert").filter({ hasText: /Wrong network/i })
    await expect(alertText).toBeVisible()

    await page.screenshot({ path: "e2e/screenshots/wallet-wrong-network.png", fullPage: true })
  })
})
