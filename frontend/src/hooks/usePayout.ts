import { useCallback, useRef, useState } from 'react';

export interface PayoutRequest {
  merchantId: string;
  amount: string;
  asset?: string;
  destination?: string;
}

export interface PayoutResult {
  id: string;
  status: string;
  [key: string]: unknown;
}

export interface UsePayoutOptions {
  /**
   * Function that performs the actual payout API call.
   * Injected so the hook stays transport-agnostic.
   */
  initiatePayout: (request: PayoutRequest) => Promise<PayoutResult>;
  onSuccess?: (result: PayoutResult) => void;
  onError?: (error: unknown) => void;
}

export interface UsePayoutReturn {
  /** True while a payout request is in flight. */
  isSubmitting: boolean;
  /** Last successful payout result, if any. */
  result: PayoutResult | null;
  /** Last error thrown by the payout request, if any. */
  error: unknown;
  /**
   * Guarded submit handler. Repeated calls while a request is in flight are
   * ignored, guaranteeing only a single payout request is dispatched.
   */
  submitPayout: (request: PayoutRequest) => Promise<PayoutResult | null>;
  /** Resets result/error state (does not affect an in-flight request). */
  reset: () => void;
}

/**
 * Hook that manages merchant payout initiation with a submission state lock
 * to prevent double-submission from rapid clicks.
 */
export function usePayout({
  initiatePayout,
  onSuccess,
  onError,
}: UsePayoutOptions): UsePayoutReturn {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<PayoutResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Synchronous lock: state updates are async, so a ref is required to
  // reliably reject clicks that land before React re-renders the button.
  const inFlightRef = useRef(false);

  const submitPayout = useCallback(
    async (request: PayoutRequest): Promise<PayoutResult | null> => {
      if (inFlightRef.current) {
        return null;
      }

      inFlightRef.current = true;
      setIsSubmitting(true);
      setError(null);

      try {
        const payoutResult = await initiatePayout(request);
        setResult(payoutResult);
        onSuccess?.(payoutResult);
        return payoutResult;
      } catch (err) {
        setError(err);
        onError?.(err);
        return null;
      } finally {
        inFlightRef.current = false;
        setIsSubmitting(false);
      }
    },
    [initiatePayout, onSuccess, onError],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { isSubmitting, result, error, submitPayout, reset };
}

export default usePayout;
