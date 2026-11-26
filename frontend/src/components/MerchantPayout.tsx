import { useCallback, useRef, useState } from 'react';

interface MerchantPayoutProps {
  merchantId: string;
  amount: string;
  asset: string;
  onInitiatePayout: (payload: {
    merchantId: string;
    amount: string;
    asset: string;
  }) => Promise<void>;
}

export default function MerchantPayout({
  merchantId,
  amount,
  asset,
  onInitiatePayout,
}: MerchantPayoutProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionLock = useRef(false);

  const handleSubmit = useCallback(async () => {
    if (submissionLock.current) {
      return;
    }

    submissionLock.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      await onInitiatePayout({ merchantId, amount, asset });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to initiate payout',
      );
    } finally {
      submissionLock.current = false;
      setIsSubmitting(false);
    }
  }, [merchantId, amount, asset, onInitiatePayout]);

  return (
    <div className="merchant-payout">
      <h2>Initiate Payout</h2>
      <dl>
        <dt>Merchant</dt>
        <dd>{merchantId}</dd>
        <dt>Amount</dt>
        <dd>
          {amount} {asset}
        </dd>
      </dl>

      {error && (
        <p className="merchant-payout__error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="merchant-payout__submit"
        onClick={handleSubmit}
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
