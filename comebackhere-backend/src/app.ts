import express from "express"
import invoicesRouter from "./routes/invoices.js"
import { rateLimitMiddleware } from "./middleware/rateLimiter.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  // Per-IP rate limiting applied only to public invoice endpoints
  app.use("/invoices", rateLimitMiddleware, invoicesRouter)
  return app
}
