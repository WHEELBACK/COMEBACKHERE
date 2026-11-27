import { useCallback, useRef, useState } from 'react';

interface PayoutResponse {
  id?: string;
  status?: string;
  message?: string;
}

interface MerchantPayoutProps {
  merchantId?: string;
  amount?: string;
  asset?: string;
  onSuccess?: (result: PayoutResponse) => void;
}

const PAYOUT_ENDPOINT = '/api/merchant/payouts';

export default function MerchantPayout({
  merchantId,
  amount,
  asset = 'USDC',
  onSuccess,
}: MerchantPayoutProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PayoutResponse | null>(null);

  // Synchronous lock: state updates are async, so a ref guards against
  // rapid clicks that land before React re-renders the disabled button.
  const submissionLock = useRef(false);

  const handleConfirmPayout = useCallback(async () => {
    if (submissionLock.current) {
      return;
    }
    submissionLock.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(PAYOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantId, amount, asset }),
      });

      if (!response.ok) {
        throw new Error(`Payout request failed (${response.status})`);
      }

      const data: PayoutResponse = await response.json();
      setResult(data);
      onSuccess?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payout request failed');
    } finally {
      submissionLock.current = false;
      setIsSubmitting(false);
    }
  }, [merchantId, amount, asset, onSuccess]);

  return (
    <div className="merchant-payout">
      <h2>Initiate Payout</h2>
      <p>
        Amount: {amount ?? '—'} {asset}
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <p className="success" role="status">
          Payout {result.status ?? 'submitted'}
          {result.id ? ` (${result.id})` : ''}
        </p>
      )}

      <button
        type="button"
        onClick={handleConfirmPayout}
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Processing…
          </>
        ) : (
          'Confirm Payout'
        )}
      </button>
    </div>
  );
}
