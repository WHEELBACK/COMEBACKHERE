// Stellar RPC input boundary and authentication verification guard
export interface StellarRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export function validateStellarRpcBoundary(req: StellarRpcRequest): { valid: boolean; error?: string } {
  if (!req || typeof req !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }
  if (req.jsonrpc !== '2.0') {
    return { valid: false, error: 'Unsupported JSON-RPC version' };
  }
  if (!req.method || typeof req.method !== 'string') {
    return { valid: false, error: 'Method name is required and must be a string' };
  }
  // Anti-injection check: method names must conform to allowed RPC method identifiers
  if (!/^[a-zA-Z0-9_]+$/.test(req.method)) {
    return { valid: false, error: 'Method name contains invalid characters' };
  }
  return { valid: true };
}

export function validateTreasurySyncBoundary(params: Record<string, unknown>): { valid: boolean; error?: string } {
  if (!params || typeof params !== 'object') {
    return { valid: false, error: 'Invalid treasury sync parameters' };
  }
  if (params.accountId && typeof params.accountId === 'string') {
    if (!/^G[A-Z0-9]{55}$/.test(params.accountId)) {
      return { valid: false, error: 'Invalid Stellar account public key format' };
    }
  }
  return { valid: true };
}
