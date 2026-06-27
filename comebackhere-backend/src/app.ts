import express from "express"
import invoicesRouter from "./routes/invoices.js"
import disputesRouter from "./routes/disputes.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/invoices", invoicesRouter)
  app.use("/disputes", disputesRouter)
  return app
}
