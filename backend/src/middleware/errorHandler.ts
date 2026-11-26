import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

/**
 * PostgreSQL pool exhaustion / acquire-timeout error codes.
 * - 53300: too_many_connections (server-side limit reached)
 * - 57P03: cannot_connect_now (server starting / shutting down)
 * - ECONNREFUSED / ETIMEDOUT: socket-level connection failures
 * - POOL_TIMEOUT: node-pg connectionTimeoutMillis elapsed while waiting for a client
 */
const POOL_EXHAUSTION_CODES = new Set([
  '53300',
  '57P03',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'POOL_TIMEOUT',
]);

const POOL_EXHAUSTION_MESSAGES = [
  'timeout exceeded when trying to connect',
  'connection timeout',
  'too many clients already',
  'remaining connection slots are reserved',
];

interface PoolErrorLike {
  code?: string;
  message?: string;
}

/**
 * Detects whether an error originates from PostgreSQL connection pool
 * exhaustion or an acquire timeout.
 */
export function isPoolExhaustionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const { code, message } = err as PoolErrorLike;
  if (code && POOL_EXHAUSTION_CODES.has(code)) {
    return true;
  }
  if (typeof message === 'string') {
    const normalized = message.toLowerCase();
    return POOL_EXHAUSTION_MESSAGES.some((needle) => normalized.includes(needle));
  }
  return false;
}

/**
 * Builds a snapshot of pool health metrics for monitoring endpoints.
 */
export function getPoolHealthMetrics(pool: Pool) {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

/**
 * Express error-handling middleware.
 * Returns 503 Service Unavailable with a descriptive payload when the
 * PostgreSQL connection pool is exhausted, otherwise falls back to 500.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    return;
  }

  if (isPoolExhaustionError(err)) {
    res.status(503).json({
      error: 'Service Unavailable',
      code: 'DB_POOL_EXHAUSTED',
      message:
        'The database connection pool is exhausted. Please retry shortly.',
    });
    return;
  }

  const message =
    err instanceof Error ? err.message : 'An unexpected error occurred.';

  res.status(500).json({
    error: 'Internal Server Error',
    message,
  });
}

export default errorHandler;
