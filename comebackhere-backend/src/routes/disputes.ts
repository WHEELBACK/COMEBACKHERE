import { Router, type Request, type Response } from "express"
import { requireEnv } from "../lib/env.js"
import { asyncHandler, ConflictError, NotFoundError, UnauthorizedError } from "../lib/errors.js"
import { validateBody, validateQuery } from "../middleware/validate.js"
import {
  voteBodySchema,
  createDisputeSchema,
  disputeListQuerySchema,
  type disputeStatuses,
} from "../schemas/index.js"

const router = Router()

type VoteValue = "ResolvedClaimant" | "ResolvedCounterparty"
type DisputeStatus = (typeof disputeStatuses)[number]

interface DisputeVote {
  signer: string
  vote: VoteValue
  weight: number
  voted_at: Date
}

// In-memory dispute store (keyed by dispute id). Votes are kept in insertion
// order so the admin view lists them chronologically.
interface DisputeRecord {
  dispute_id: string
  settlement_id: string
  claimant_address: string
  reason: string | null
  created_at: Date
  resolved_at: Date | null
  votes: Map<string, DisputeVote>
  claimant_weight: number
  counterparty_weight: number
  outcome: VoteValue | null
}
const disputes = new Map<string, DisputeRecord>()

/** Clears every stored dispute — used by tests for isolation. */
export function _resetDisputeStore(): void {
  disputes.clear()
}

const VOTE_THRESHOLD = Number(process.env.DISPUTE_VOTE_THRESHOLD ?? 2)

function statusOf(record: DisputeRecord): DisputeStatus {
  return record.outcome === null ? "Raised" : "Resolved"
}

function getDisputeOrThrow(id: string): DisputeRecord {
  const record = disputes.get(id)
  if (!record) throw new NotFoundError(`Dispute ${id} not found`)
  return record
}

/**
 * Voter identities are only visible to admins (valid `x-admin-key`).
 *
 * Everyone else sees the tallies and vote count but not who voted which way:
 * signers are treasury multi-sig keys, and publishing each key's vote makes it
 * easy to single out and pressure individual signers. A wrong key is a 401
 * rather than a silent downgrade, so misconfigured admin clients notice.
 */
function canSeeVoters(req: Request): boolean {
  const adminKey = req.headers["x-admin-key"]
  if (adminKey === undefined) return false
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    throw new UnauthorizedError()
  }
  return true
}

function serializeDispute(record: DisputeRecord, includeVoters: boolean) {
  const base = {
    dispute_id: record.dispute_id,
    settlement_id: record.settlement_id,
    claimant_address: record.claimant_address,
    reason: record.reason,
    status: statusOf(record),
    outcome: record.outcome,
    claimant_weight: record.claimant_weight,
    counterparty_weight: record.counterparty_weight,
    resolution_weight: record.claimant_weight + record.counterparty_weight,
    threshold: VOTE_THRESHOLD,
    vote_count: record.votes.size,
    created_at: record.created_at.toISOString(),
    resolved_at: record.resolved_at?.toISOString() ?? null,
  }
  if (!includeVoters) return base
  return {
    ...base,
    votes: [...record.votes.values()].map((v) => ({
      signer: v.signer,
      vote: v.vote,
      weight: v.weight,
      voted_at: v.voted_at.toISOString(),
    })),
  }
}

/**
 * @openapi
 * components:
 *   schemas:
 *     DisputeStatus:
 *       type: string
 *       enum: [Raised, Resolved]
 *     DisputeVote:
 *       type: object
 *       properties:
 *         signer:
 *           type: string
 *           description: Stellar public key of the voting signer
 *         vote:
 *           type: string
 *           enum: [ResolvedClaimant, ResolvedCounterparty]
 *         weight:
 *           type: integer
 *         voted_at:
 *           type: string
 *           format: date-time
 *     Dispute:
 *       type: object
 *       properties:
 *         dispute_id:
 *           type: string
 *           example: "5-1720000000000"
 *         settlement_id:
 *           type: string
 *           example: "5"
 *         claimant_address:
 *           type: string
 *         reason:
 *           type: string
 *           nullable: true
 *         status:
 *           $ref: '#/components/schemas/DisputeStatus'
 *         outcome:
 *           type: string
 *           enum: [ResolvedClaimant, ResolvedCounterparty]
 *           nullable: true
 *         claimant_weight:
 *           type: integer
 *         counterparty_weight:
 *           type: integer
 *         resolution_weight:
 *           type: integer
 *           description: claimant_weight + counterparty_weight
 *         threshold:
 *           type: integer
 *           description: Weight either side needs to resolve the dispute
 *         vote_count:
 *           type: integer
 *         created_at:
 *           type: string
 *           format: date-time
 *         resolved_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         votes:
 *           type: array
 *           description: >-
 *             Individual votes with signer identities. Only present when the
 *             request carries a valid x-admin-key header.
 *           items:
 *             $ref: '#/components/schemas/DisputeVote'
 */

/**
 * @openapi
 * /disputes:
 *   get:
 *     tags: [Disputes]
 *     summary: List disputes with vote tallies
 *     description: >-
 *       Newest first. Voter identities (`votes`) are included only for admins
 *       (valid `x-admin-key`); everyone else sees tallies and `vote_count`.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           $ref: '#/components/schemas/DisputeStatus'
 *       - in: query
 *         name: settlement_id
 *         schema:
 *           type: string
 *         description: Positive integer string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: header
 *         name: x-admin-key
 *         required: false
 *         schema:
 *           type: string
 *         description: Include voter identities
 *     responses:
 *       200:
 *         description: Paginated dispute list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dispute'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: x-admin-key supplied but invalid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", validateQuery(disputeListQuerySchema), asyncHandler(async (req: Request, res: Response) => {
  const includeVoters = canSeeVoters(req)
  const { status, settlement_id, page, limit } = disputeListQuerySchema.parse(req.query)

  const matching = [...disputes.values()]
    .filter((d) => (status ? statusOf(d) === status : true))
    .filter((d) => (settlement_id ? d.settlement_id === settlement_id : true))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())

  const total = matching.length
  const skip = (page - 1) * limit

  res.json({
    data: matching.slice(skip, skip + limit).map((d) => serializeDispute(d, includeVoters)),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  })
}))

/**
 * @openapi
 * /disputes/{id}:
 *   get:
 *     tags: [Disputes]
 *     summary: Get a dispute with its votes and tallies
 *     description: >-
 *       Voter identities (`votes`) are included only for admins (valid
 *       `x-admin-key`); everyone else sees tallies and `vote_count`.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ID
 *       - in: header
 *         name: x-admin-key
 *         required: false
 *         schema:
 *           type: string
 *         description: Include voter identities
 *     responses:
 *       200:
 *         description: Dispute found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Dispute'
 *       401:
 *         description: x-admin-key supplied but invalid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Dispute not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const includeVoters = canSeeVoters(req)
  const record = getDisputeOrThrow(req.params.id)
  res.json(serializeDispute(record, includeVoters))
}))

/**
 * @openapi
 * /disputes/{id}/vote:
 *   post:
 *     tags: [Disputes]
 *     summary: Cast a vote on a dispute
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [signer_address, vote]
 *             properties:
 *               signer_address:
 *                 type: string
 *                 description: Valid Stellar public key of the voting signer
 *               vote:
 *                 type: string
 *                 enum: [ResolvedClaimant, ResolvedCounterparty]
 *               weight:
 *                 type: integer
 *                 default: 1
 *     responses:
 *       200:
 *         description: Vote recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute_id:
 *                   type: string
 *                 signer_address:
 *                   type: string
 *                 vote:
 *                   type: string
 *                 claimant_weight:
 *                   type: integer
 *                 counterparty_weight:
 *                   type: integer
 *                 resolution_weight:
 *                   type: integer
 *                 threshold:
 *                   type: integer
 *                 outcome:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Dispute not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Dispute already resolved or signer already voted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/:id/vote", validateBody(voteBodySchema), asyncHandler(async (req: Request, res: Response) => {
  const disputeId = req.params.id
  const { signer_address, vote, weight } = req.body as {
    signer_address: string
    vote: VoteValue
    weight: number
  }

  const state = getDisputeOrThrow(disputeId)

  if (state.outcome !== null) {
    throw new ConflictError("Dispute already resolved", { outcome: state.outcome })
  }

  if (state.votes.has(signer_address)) {
    throw new ConflictError("Signer has already voted on this dispute")
  }

  state.votes.set(signer_address, { signer: signer_address, vote, weight, voted_at: new Date() })
  if (vote === "ResolvedClaimant") {
    state.claimant_weight += weight
  } else {
    state.counterparty_weight += weight
  }

  const threshold = VOTE_THRESHOLD
  const resolution_weight = state.claimant_weight + state.counterparty_weight

  if (state.claimant_weight >= threshold) {
    state.outcome = "ResolvedClaimant"
  } else if (state.counterparty_weight >= threshold) {
    state.outcome = "ResolvedCounterparty"
  }
  if (state.outcome !== null) state.resolved_at = new Date()

  res.status(200).json({
    dispute_id: disputeId,
    signer_address,
    vote,
    claimant_weight: state.claimant_weight,
    counterparty_weight: state.counterparty_weight,
    resolution_weight,
    threshold,
    outcome: state.outcome,
  })
}))

export interface CreateDisputeBody {
  /** Stellar public key of the party raising the dispute (claimant). */
  claimant_address: string
  /** ID of the settlement this dispute is linked to. */
  settlement_id: string
  /** Optional human-readable reason for the dispute. */
  reason?: string
}

/**
 * @openapi
 * /disputes:
 *   post:
 *     tags: [Disputes]
 *     summary: Raise a dispute linked to a settlement
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [claimant_address, settlement_id]
 *             properties:
 *               claimant_address:
 *                 type: string
 *                 description: Valid Stellar public key of the disputing party
 *               settlement_id:
 *                 type: string
 *                 description: Positive integer string identifying the settlement
 *                 example: "5"
 *               reason:
 *                 type: string
 *                 description: Human-readable reason for the dispute
 *     responses:
 *       201:
 *         description: Dispute raised; settlement transitioned to OnHold
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute_id:
 *                   type: string
 *                   example: "5-1720000000000"
 *                 settlement_id:
 *                   type: string
 *                   example: "5"
 *                 claimant_address:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: "Raised"
 *                 settlement_status:
 *                   type: string
 *                   example: "OnHold"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       503:
 *         description: Service misconfiguration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/", validateBody(createDisputeSchema), asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as CreateDisputeBody

  requireEnv({ settlementContractId: "SETTLEMENT_CONTRACT_ID", signerSecret: "SIGNER_SECRET_KEY" })

  const settlementId = body.settlement_id
  const claimantAddress = body.claimant_address

  // In production this would call raise_dispute on the settlement contract via Soroban RPC.
  // The contract transitions the settlement to OnHold atomically. Here we return the
  // expected shape so downstream clients can integrate without a live node.
  let createdAt = Date.now()
  while (disputes.has(`${settlementId}-${createdAt}`)) createdAt++
  const disputeId = `${settlementId}-${createdAt}`

  disputes.set(disputeId, {
    dispute_id: disputeId,
    settlement_id: settlementId,
    claimant_address: claimantAddress,
    reason: body.reason ?? null,
    created_at: new Date(createdAt),
    resolved_at: null,
    votes: new Map(),
    claimant_weight: 0,
    counterparty_weight: 0,
    outcome: null,
  })

  res.status(201).json({
    dispute_id: disputeId,
    settlement_id: settlementId,
    claimant_address: claimantAddress,
    status: "Raised",
    settlement_status: "OnHold",
  })
}))

export default router
