import { Pool, PoolClient, PoolConfig } from 'pg';

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CLIENTS = 20;

/**
 * Error thrown when the connection pool is exhausted or an acquire times out.
 * Consumers (e.g. HTTP error middleware) can detect this via `isPoolExhaustedError`
 * and respond with 503 Service Unavailable.
 */
export class PoolExhaustedError extends Error {
  public readonly code = 'POOL_EXHAUSTED';
  public readonly statusCode = 503;

  constructor(message = 'Database connection pool exhausted, please retry shortly') {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

export function isPoolExhaustedError(err: unknown): err is PoolExhaustedError {
  return err instanceof PoolExhaustedError;
}

/**
 * Snapshot of connection pool health, suitable for exposing via a metrics endpoint.
 */
export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  acquireFailures: number;
  acquireTimeouts: number;
  lastAcquireFailureAt: string | null;
}

const acquireFailures = { count: 0, timeouts: 0, lastAt: null as string | null };

function recordAcquireFailure(isTimeout: boolean): void {
  acquireFailures.count += 1;
  if (isTimeout) {
    acquireFailures.timeouts += 1;
  }
  acquireFailures.lastAt = new Date().toISOString();
}

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? DEFAULT_MAX_CLIENTS),
  connectionTimeoutMillis: Number(
    process.env.PG_CONNECTION_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  ),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS),
};

export const pool = new Pool(poolConfig);

// Surface unexpected idle-client errors instead of crashing the process.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] unexpected idle client error', err);
});

/**
 * Acquire a client from the pool, translating pool exhaustion / acquire timeouts
 * into a descriptive PoolExhaustedError so callers can return 503.
 */
export async function getClient(): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout|timed out/i.test(message);
    recordAcquireFailure(isTimeout);
    throw new PoolExhaustedError(
      `Failed to acquire database connection: ${message}`,
    );
  }
}

/**
 * Run a query using a pooled client, releasing it back to the pool afterwards.
 */
export async function query<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const client = await getClient();
  try {
    return await client.query(text, params as never);
  } finally {
    client.release();
  }
}

/**
 * Collect current connection pool health metrics for monitoring.
 */
export function getPoolMetrics(): PoolMetrics {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    acquireFailures: acquireFailures.count,
    acquireTimeouts: acquireFailures.timeouts,
    lastAcquireFailureAt: acquireFailures.lastAt,
  };
}
