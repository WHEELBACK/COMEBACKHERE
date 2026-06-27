import express from "express"
import invoicesRouter from "./routes/invoices.js"
import treasuryRouter from "./routes/treasury.js"
import invoiceSettingsRouter from "./routes/invoice-settings.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/invoices", invoicesRouter)
  app.use("/api/treasury", treasuryRouter)
  app.use("/api/invoice", invoiceSettingsRouter)
  return app
}
