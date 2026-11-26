import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRedisClient } from '../db/redis';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const REVOCATION_PREFIX = 'jwt:revoked:';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
}

function getRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET || getJwtSecret();
  return secret;
}

export interface TokenPayload {
  sub: string;
  jti: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function signToken(
  userId: string,
  type: 'access' | 'refresh',
  ttlSeconds: number,
  secret: string,
): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ sub: userId, jti, type }, secret, {
    expiresIn: ttlSeconds,
  });
}

export function issueTokenPair(userId: string): TokenPair {
  return {
    accessToken: signToken(userId, 'access', ACCESS_TOKEN_TTL_SECONDS, getJwtSecret()),
    refreshToken: signToken(userId, 'refresh', REFRESH_TOKEN_TTL_SECONDS, getRefreshSecret()),
  };
}

export function verifyAccessToken(token: string): TokenPayload {
  const payload = jwt.verify(token, getJwtSecret()) as TokenPayload;
  if (payload.type !== 'access') {
    throw new Error('Invalid token type');
  }
  return payload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  const payload = jwt.verify(token, getRefreshSecret()) as TokenPayload;
  if (payload.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return payload;
}

/**
 * Add a token's jti to the Redis revocation blacklist. The entry lives only
 * until the token's natural expiry, keeping the list short-lived.
 */
export async function revokeToken(payload: TokenPayload): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = (payload.exp ?? nowSeconds) - nowSeconds;
  if (ttl <= 0) {
    return;
  }
  const redis = getRedisClient();
  await redis.set(`${REVOCATION_PREFIX}${payload.jti}`, '1', 'EX', ttl);
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  const redis = getRedisClient();
  const result = await redis.get(`${REVOCATION_PREFIX}${jti}`);
  return result !== null;
}

/**
 * Rotate a refresh token: revoke the presented refresh token and issue a new
 * access/refresh pair for the same subject.
 */
export async function rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
  const payload = verifyRefreshToken(refreshToken);
  if (await isTokenRevoked(payload.jti)) {
    throw new Error('Refresh token has been revoked');
  }
  await revokeToken(payload);
  return issueTokenPair(payload.sub);
}
