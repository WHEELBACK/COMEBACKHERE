const votes = new Map<string, Map<string, number>>()

export function recordVote(disputeId: string, signer: string, weight: number): { accepted: boolean; totalWeight: number } {
  const disputeVotes = votes.get(disputeId) ?? new Map<string, number>()
  const existing = disputeVotes.get(signer)

  if (existing !== undefined) {
    return { accepted: false, totalWeight: Array.from(disputeVotes.values()).reduce((a, b) => a + b, 0) }
  }

  disputeVotes.set(signer, weight)
  votes.set(disputeId, disputeVotes)

  return {
    accepted: true,
    totalWeight: Array.from(disputeVotes.values()).reduce((a, b) => a + b, 0),
  }
}
