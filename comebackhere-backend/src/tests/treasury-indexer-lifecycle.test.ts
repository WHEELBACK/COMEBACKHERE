import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { startTreasuryIndexer, stopTreasuryIndexer } from "../services/treasury-indexer.js"

const mocks = vi.hoisted(() => ({
  connectMongo: vi.fn(),
  buildSorobanClient: vi.fn(),
  cursors: {
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
  settlements: {
    createIndex: vi.fn(),
    updateOne: vi.fn(),
  },
}))

vi.mock("../db/mongo.js", () => ({
  connectMongo: mocks.connectMongo,
  getCursorsCollection: () => mocks.cursors,
  getSettlementsCollection: () => mocks.settlements,
}))

vi.mock("../lib/soroban.js", () => ({
  buildSorobanClient: mocks.buildSorobanClient,
}))

describe("treasury indexer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv("SOROBAN_RPC_URL", "https://rpc.example.test")
    vi.stubEnv("TREASURY_CONTRACT_ID", "CONTRACT_TEST")
    mocks.connectMongo.mockReset()
    mocks.buildSorobanClient.mockReset()
    mocks.cursors.findOne.mockReset().mockResolvedValue(null)
    mocks.cursors.updateOne.mockReset().mockResolvedValue({})
    mocks.settlements.createIndex.mockReset().mockResolvedValue("index")
    mocks.settlements.updateOne.mockReset().mockResolvedValue({})
    mocks.buildSorobanClient.mockReturnValue({
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 100 }),
    })
  })

  afterEach(() => {
    stopTreasuryIndexer()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it("skips a timer tick while the previous tick is still running", async () => {
    let resolveConnection!: (database: object) => void
    mocks.connectMongo.mockImplementation(
      () => new Promise((resolve) => { resolveConnection = resolve }),
    )

    startTreasuryIndexer()
    expect(mocks.connectMongo).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.connectMongo).toHaveBeenCalledTimes(1)

    stopTreasuryIndexer()
    resolveConnection({})
    await Promise.resolve()
    await Promise.resolve()
  })
})
