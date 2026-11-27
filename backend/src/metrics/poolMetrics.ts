import type { Pool } from 'pg';

export interface PoolMetricsSnapshot {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  acquireFailures: number;
  acquireTimeouts: number;
  lastAcquireFailureAt: string | null;
}

/**
 * Tracks PostgreSQL connection pool health so exhaustion under load is
 * observable. Counts are read live from the pool; failure counters are
 * incremented by the acquire wrapper in the DB module.
 */
export class PoolMetrics {
  private acquireFailures = 0;
  private acquireTimeouts = 0;
  private lastAcquireFailureAt: Date | null = null;

  constructor(private readonly pool: Pool) {}

  recordAcquireFailure(isTimeout: boolean): void {
    this.acquireFailures += 1;
    if (isTimeout) {
      this.acquireTimeouts += 1;
    }
    this.lastAcquireFailureAt = new Date();
  }

  snapshot(): PoolMetricsSnapshot {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      acquireFailures: this.acquireFailures,
      acquireTimeouts: this.acquireTimeouts,
      lastAcquireFailureAt: this.lastAcquireFailureAt
        ? this.lastAcquireFailureAt.toISOString()
        : null,
    };
  }
}

/**
 * Returns true when an error thrown while acquiring a connection indicates
 * pool exhaustion (acquire timeout) rather than an unrelated DB failure.
 */
export function isPoolExhaustionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = (error as { message?: string }).message ?? '';
  return (
    /timeout exceeded when trying to connect/i.test(message) ||
    /connection pool/i.test(message) ||
    /too many clients/i.test(message)
  );
}
