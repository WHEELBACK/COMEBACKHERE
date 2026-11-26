// Idempotent webhook delivery with unique event deduplication
export class WebhookDeduplicator {
  private processedEvents: Map<string, number> = new Map();
  private ttlMs: number;

  constructor(ttlMs = 86400000) { // default 24h retention
    this.ttlMs = ttlMs;
  }

  isDuplicate(eventId: string): boolean {
    const now = Date.now();
    this.cleanExpired(now);
    return this.processedEvents.has(eventId);
  }

  recordEvent(eventId: string): boolean {
    if (this.isDuplicate(eventId)) {
      return false;
    }
    this.processedEvents.set(eventId, Date.now());
    return true;
  }

  private cleanExpired(now: number) {
    for (const [id, timestamp] of this.processedEvents.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.processedEvents.delete(id);
      }
    }
  }
}

export const webhookDeduplicator = new WebhookDeduplicator();
