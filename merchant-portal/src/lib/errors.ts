/**
 * Shared error-handling utilities for the merchant portal.
 *
 * These helpers centralize defensive behavior so that edge cases
 * (null/undefined access, rejected promises, transient failures under
 * high load) surface as predictable, typed errors instead of unexpected
 * exceptions bubbling up through the UI.
 */

export class MerchantPortalError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(message: string, code = "MERCHANT_PORTAL_ERROR", cause?: unknown) {
    super(message);
    this.name = "MerchantPortalError";
    this.code = code;
    this.cause = cause;
    // Restore prototype chain for transpiled targets.
    Object.setPrototypeOf(this, MerchantPortalError.prototype);
  }
}

/**
 * Normalize any thrown value into an Error instance.
 * Handles strings, plain objects, and undefined throws safely.
 */
export function toError(value: unknown, fallbackMessage = "Unknown error"): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return new MerchantPortalError(value);
  }
  if (value && typeof value === "object") {
    const maybeMessage = (value as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return new MerchantPortalError(maybeMessage);
    }
  }
  return new MerchantPortalError(fallbackMessage);
}

/**
 * Safely read a nested property without throwing on null/undefined
 * intermediate values. Useful for defensive access to API payloads.
 */
export function safeGet<T = unknown>(
  source: unknown,
  path: string,
  fallback?: T
): T | undefined {
  if (source == null || typeof path !== "string" || path.length === 0) {
    return fallback;
  }
  const segments = path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") {
      return fallback;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return (current as T) ?? fallback;
}

/**
 * Wrap an async operation so that rejections are converted into a
 * typed result instead of an unhandled promise rejection. This is the
 * primary guard against unexpected exceptions under high load.
 */
export async function safeAsync<T>(
  operation: () => Promise<T>,
  fallbackMessage = "Operation failed"
): Promise<{ ok: true; data: T } | { ok: false; error: Error }> {
  try {
    const data = await operation();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toError(err, fallbackMessage) };
  }
}

/**
 * Retry an async operation with bounded attempts and backoff.
 * Guards against transient failures during high load without
 * unbounded retries that could amplify pressure on the backend.
 */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 150);
  let lastError: Error = new MerchantPortalError("Operation failed");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = toError(err, "Operation failed");
      if (attempt < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

/**
 * Install a global handler for unhandled promise rejections so that
 * stray async failures are logged rather than crashing the portal.
 * Returns a cleanup function; safe to call in non-browser environments.
 */
export function installGlobalErrorHandlers(
  onError: (error: Error) => void = () => undefined
): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }

  const handleRejection = (event: PromiseRejectionEvent) => {
    const error = toError(event?.reason, "Unhandled promise rejection");
    onError(error);
    // Prevent the default console noise/crash behavior for handled cases.
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  };

  const handleError = (event: ErrorEvent) => {
    onError(toError(event?.error ?? event?.message, "Uncaught error"));
  };

  window.addEventListener("unhandledrejection", handleRejection);
  window.addEventListener("error", handleError);

  return () => {
    window.removeEventListener("unhandledrejection", handleRejection);
    window.removeEventListener("error", handleError);
  };
}
