import { randomBytes, timingSafeEqual } from 'crypto';
import argon2 from 'argon2';

export const API_KEY_PREFIX = 'mch_';
export const API_KEY_BYTES = 32;
export const API_KEY_HASH_ALGORITHM = 'argon2id' as const;

export interface GeneratedApiKey {
  /** Full plaintext key, shown to the merchant exactly once. */
  key: string;
  /** Non-secret lookup prefix stored alongside the hash. */
  prefix: string;
  /** Argon2id hash of the full key. */
  hash: string;
}

/**
 * Generate a cryptographically secure merchant API key.
 * Uses 32 random bytes (256 bits) of entropy, hex-encoded, with a
 * recognizable `mch_` prefix so keys can be identified in logs/UI.
 */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString('hex')}`;
}

/**
 * Generate a key and its Argon2id hash in one call.
 */
export async function generateHashedApiKey(): Promise<GeneratedApiKey> {
  const key = generateApiKey();
  const hash = await hashApiKey(key);
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 8), hash };
}

/**
 * Hash an API key with Argon2id.
 */
export async function hashApiKey(key: string): Promise<string> {
  return argon2.hash(key, { type: argon2.argon2id });
}

/**
 * Verify a plaintext API key against a stored Argon2id hash.
 * Argon2's verify is constant-time with respect to the hash comparison.
 */
export async function verifyApiKey(key: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, key);
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison of two API keys (or any equal-length strings).
 * Returns false when lengths differ without leaking timing on content.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
