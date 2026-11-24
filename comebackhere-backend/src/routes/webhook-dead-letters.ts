import { Router, type Request, type Response } from "express"
import { asyncHandler, NotFoundError, UnauthorizedError } from "../lib/errors.js"
import { validateParams } from "../middleware/validate.js"
import { deadLetterIdParamSchema } from "../schemas/index.js"
import { webhookDeliveryQueue } from "../services/webhook-delivery.js"

const router = Router()

function requireAdmin(req: Request): void {
  const adminKey = req.headers["x-admin-key"]
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) throw new UnauthorizedError()
}

/**
 * @openapi
 * /webhooks/dead-letters:
 *   get:
 *     tags: [Webhooks]
 *     summary: List failed webhook deliveries
 *     description: Requires the x-admin-key header. Returns the most recent 100 dead letters.
 *     parameters:
 *       - in: header
 *         name: x-admin-key
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dead-letter records with payload and attempt history
 *       401:
 *         description: Missing or invalid administrator key
 */
router.get("/", asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req)
  const data = await webhookDeliveryQueue.listDeadLetters()
  res.json({ data })
}))

/**
 * @openapi
 * /webhooks/dead-letters/{id}/replay:
 *   post:
 *     tags: [Webhooks]
 *     summary: Replay a failed webhook delivery
 *     description: Requires the x-admin-key header. The dead letter is removed only after successful delivery.
 *     parameters:
 *       - in: header
 *         name: x-admin-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Replay attempt result
 *       401:
 *         description: Missing or invalid administrator key
 *       404:
 *         description: Dead letter not found
 */
router.post("/:id/replay", validateParams(deadLetterIdParamSchema), asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req)
  const result = await webhookDeliveryQueue.replayDeadLetter(req.params.id)
  if (!result) {
    throw new NotFoundError("Dead letter not found")
  }
  res.json(result)
}))

export default router