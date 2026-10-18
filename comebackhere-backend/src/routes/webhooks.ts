import { Router, type Request, type Response } from "express"
import { connectMongo, type WebhookDeliveryHistoryRecord } from "../db/mongo.js"
import { asyncHandler, ConflictError, NotFoundError } from "../lib/errors.js"
import { requireMerchantApiKey } from "../middleware/apiKey.js"
import { validateParams } from "../middleware/validate.js"
import { webhookDeliveryIdSchema } from "../schemas/index.js"
import { dispatchWebhook, type WebhookPayload } from "../services/webhooks.js"

const router = Router()

/**
 * @openapi
 * /webhooks/{deliveryId}/replay:
 *   post:
 *     tags: [Webhooks]
 *     summary: Replay a failed webhook delivery
 *     parameters:
 *       - in: path
 *         name: deliveryId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema: { type: string, example: Bearer merchant-api-key }
 *     responses:
 *       200:
 *         description: Replay delivered
 *       401:
 *         description: Merchant API key is missing, invalid, or revoked
 *       404:
 *         description: Delivery does not belong to this merchant
 *       409:
 *         description: Only failed deliveries can be replayed
 *       502:
 *         description: Merchant endpoint returned a non-success response
 */
router.post("/:deliveryId/replay", requireMerchantApiKey, validateParams(webhookDeliveryIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const merchantAddress = res.locals.merchantAddress as string
  const collection = (await connectMongo()).collection<WebhookDeliveryHistoryRecord>("webhook_deliveries")
  const delivery = await collection.findOne({
    delivery_id: req.params.deliveryId,
    merchant_address: merchantAddress,
  })
  if (!delivery) throw new NotFoundError("Webhook delivery not found")
  if (delivery.status !== "failed") throw new ConflictError("Only failed webhook deliveries can be replayed")

  const result = await dispatchWebhook(
    delivery.endpoint,
    delivery.payload as WebhookPayload,
    undefined,
    fetch,
    {
      merchantAddress,
      correlationId: typeof res.locals.requestId === "string" ? res.locals.requestId : undefined,
      replayOf: delivery.delivery_id,
    },
  )
  res.status(result.ok ? 200 : 502).json({
    delivery_id: delivery.delivery_id,
    replay_id: result.deliveryId,
    status: result.ok ? "delivered" : "failed",
    status_code: result.status,
  })
}))

export default router
