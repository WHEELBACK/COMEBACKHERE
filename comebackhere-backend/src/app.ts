import express from "express"
import invoicesRouter from "./routes/invoices.js"
import disputesRouter from "./routes/disputes.js"
import treasuryRouter from "./routes/treasury.js"
import complianceRouter from "./routes/compliance.js"
import invoiceSettingsRouter from "./routes/invoice-settings.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/invoices", invoicesRouter)
  app.use("/disputes", disputesRouter)
  app.use("/api/treasury", treasuryRouter)
  app.use("/api/compliance", complianceRouter)
  app.use("/api/invoice", invoiceSettingsRouter)
  return app
}
