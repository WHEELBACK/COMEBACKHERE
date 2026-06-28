import express from "express"
import invoicesRouter from "./routes/invoices.js"
import disputesRouter from "./routes/disputes.js"
import treasuryRouter from "./routes/treasury.js"
import invoiceSettingsRouter from "./routes/invoice-settings.js"
import thresholdRouter from "./routes/threshold.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/invoices", invoicesRouter)
  app.use("/disputes", disputesRouter)
  app.use("/api/treasury", treasuryRouter)
  app.use("/api/invoice", invoiceSettingsRouter)
  app.use("/api/treasury", thresholdRouter)
  return app
}
