import express from "express"
import invoicesRouter from "./routes/invoices.js"
import complianceRouter from "./routes/compliance.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/invoices", invoicesRouter)
  app.use("/compliance", complianceRouter)
  return app
}
