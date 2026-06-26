import express from "express"
import invoicesRouter from "./routes/invoices.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/invoices", invoicesRouter)
  return app
}
