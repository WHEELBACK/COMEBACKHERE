import { describe, it, expect } from 'vitest';
import { validateStellarRpcBoundary, validateTreasurySyncBoundary } from '../lib/stellar-rpc-guard.js';

describe('Stellar RPC Guard & Input Boundary Tests', () => {
  it('validates proper JSON-RPC 2.0 requests', () => {
    const res = validateStellarRpcBoundary({
      jsonrpc: '2.0',
      id: 1,
      method: 'getHealth'
    });
    expect(res.valid).toBe(true);
  });

  it('rejects injection characters in method names', () => {
    const res = validateStellarRpcBoundary({
      jsonrpc: '2.0',
      id: 2,
      method: 'getHealth; DROP TABLE users;'
    });
    expect(res.valid).toBe(false);
  });

  it('validates stellar account public key format in treasury sync', () => {
    const validKey = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7K0Z5ZQUO3327663P4JH';
    expect(validateTreasurySyncBoundary({ accountId: validKey }).valid).toBe(true);
    expect(validateTreasurySyncBoundary({ accountId: 'invalid_key' }).valid).toBe(false);
  });
});
