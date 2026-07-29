import { Router, type Request, type Response } from "express"
import { connectMongo, getThresholdsCollection, getAuditLogsCollection } from "../db/mongo.js"
import { validate, thresholdUpdateSchema } from "../middleware/validation.js"

const router = Router()

/**
 * POST /api/treasury/threshold
 * Updates the treasury voting threshold and persists an audit record.
 * Body: { threshold: number, caller?: string }
 */
router.post(
  "/",
  validate(thresholdUpdateSchema),
  async (req: Request, res: Response) => {
    try {
      const database = await connectMongo()
      const thresholds = getThresholdsCollection(database)
      const auditLogs = getAuditLogsCollection(database)

      const current = await thresholds.findOne({}, { sort: { updated_at: -1 } })
      const previousThreshold = current?.threshold ?? 0

      const thresholdValue = req.body.threshold as number
      const txHash = `threshold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      await thresholds.insertOne({
        threshold: thresholdValue,
        previous_threshold: previousThreshold,
        caller: (req.body as { caller?: string }).caller ?? req.ip ?? "unknown",
        tx_hash: txHash,
        updated_at: new Date(),
      })

      await auditLogs.insertOne({
        action: "threshold_update",
        resource: "treasury",
        caller: (req.body as { caller?: string }).caller ?? req.ip ?? "unknown",
        previous_value: previousThreshold,
        new_value: thresholdValue,
        tx_hash: txHash,
        created_at: new Date(),
      })

      res.json({
        threshold: thresholdValue,
        previous_threshold: previousThreshold,
        tx_hash: txHash,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  },
)

/**
 * GET /api/treasury/threshold/audit
 * Returns the audit trail for threshold updates.
 */
router.get("/audit", async (_req: Request, res: Response) => {
  try {
    const database = await connectMongo()
    const auditLogs = getAuditLogsCollection(database)

    const entries = await auditLogs
      .find({ action: "threshold_update" })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray()

    res.json(
      entries.map((e) => ({
        action: e.action,
        resource: e.resource,
        caller: e.caller,
        previous_value: e.previous_value,
        new_value: e.new_value,
        tx_hash: e.tx_hash,
        created_at: e.created_at,
      })),
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

export default router
