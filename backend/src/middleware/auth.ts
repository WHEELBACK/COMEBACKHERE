import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createClient, RedisClientType } from 'redis';
import { config } from '../config';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    jti?: string;
  };
}

const REVOCATION_PREFIX = 'jwt:revoked:';

let redisClient: RedisClientType | null = null;

function getRedisClient(): RedisClientType {
  if (!redisClient) {
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on('error', (err) => {
      console.error('Redis client error (auth revocation):', err);
    });
    redisClient.connect().catch((err) => {
      console.error('Failed to connect Redis client (auth revocation):', err);
    });
  }
  return redisClient;
}

/**
 * Add a token's jti to the short-lived revocation blacklist.
 * TTL matches the token's remaining lifetime so entries expire naturally.
 */
export async function revokeToken(jti: string, ttlSeconds: number): Promise<void> {
  if (!jti || ttlSeconds <= 0) {
    return;
  }
  const client = getRedisClient();
  await client.set(`${REVOCATION_PREFIX}${jti}`, '1', { EX: ttlSeconds });
}

/**
 * Check whether a token's jti has been revoked.
 */
export async function isTokenRevoked(jti: string): Promise<boolean> {
  if (!jti) {
    return false;
  }
  const client = getRedisClient();
  const result = await client.get(`${REVOCATION_PREFIX}${jti}`);
  return result !== null;
}

export async function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;

  if (jti) {
    try {
      if (await isTokenRevoked(jti)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    } catch (err) {
      console.error('Failed to check token revocation status:', err);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  req.user = {
    id: String(payload.sub ?? payload.id ?? ''),
    email: String(payload.email ?? ''),
    role: String(payload.role ?? ''),
    jti,
  };

  next();
}
