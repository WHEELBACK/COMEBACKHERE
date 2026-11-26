import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '5000', 10),
  maxUses: parseInt(process.env.DB_POOL_MAX_USES || '7500', 10),
};

export const pool = new Pool(poolConfig);

// Connection pool health check metrics
export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  acquireFailures: number;
  acquireTimeouts: number;
  lastAcquireFailureAt: string | null;
}

const metrics = {
  acquireFailures: 0,
  acquireTimeouts: 0,
  lastAcquireFailureAt: null as string | null,
};

export function getPoolMetrics(): PoolMetrics {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    acquireFailures: metrics.acquireFailures,
    acquireTimeouts: metrics.acquireTimeouts,
    lastAcquireFailureAt: metrics.lastAcquireFailureAt,
  };
}

export class PoolExhaustedError extends Error {
  public readonly code = 'POOL_EXHAUSTED';
  public readonly statusCode = 503;

  constructor(message = 'Database connection pool exhausted. Please retry shortly.') {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

function isPoolTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') return true;
  return typeof e.message === 'string' && /timeout exceeded when trying to connect/i.test(e.message);
}

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

export async function getClient(): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err) {
    if (isPoolTimeoutError(err)) {
      metrics.acquireTimeouts += 1;
      metrics.acquireFailures += 1;
      metrics.lastAcquireFailureAt = new Date().toISOString();
      logger.error('PostgreSQL pool acquire timed out', {
        waitingCount: pool.waitingCount,
        totalCount: pool.totalCount,
      });
      throw new PoolExhaustedError();
    }
    metrics.acquireFailures += 1;
    metrics.lastAcquireFailureAt = new Date().toISOString();
    throw err;
  }
}

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
  const client = await getClient();
  try {
    const result = await client.query(text, params as never[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Failed to rollback transaction', { error: (rollbackErr as Error).message });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
