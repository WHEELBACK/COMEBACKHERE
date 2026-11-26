import { useCallback, useRef, useState } from 'react';

interface PayoutConfirmationButtonProps {
  onConfirm: () => Promise<void> | void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

/**
 * Confirmation button for merchant payout initiation.
 *
 * Guards against double-submission: the button is disabled and shows a
 * loading spinner on the first click, and a submission state lock ensures
 * repeated clicks are ignored so only a single payout request is dispatched.
 */
export default function PayoutConfirmationButton({
  onConfirm,
  disabled = false,
  label = 'Confirm Payout',
  className,
}: PayoutConfirmationButtonProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleClick = useCallback(async () => {
    // Submission state lock: ignore any click while a request is in flight.
    if (submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);

    try {
      await onConfirm();
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [onConfirm]);

  const isDisabled = disabled || isSubmitting;

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      disabled={isDisabled}
      aria-busy={isSubmitting}
    >
      {isSubmitting ? (
        <>
          <span
            className="payout-spinner"
            role="status"
            aria-label="Submitting payout"
            style={{
              display: 'inline-block',
              width: '1em',
              height: '1em',
              marginRight: '0.5em',
              border: '2px solid currentColor',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'payout-spin 0.6s linear infinite',
              verticalAlign: 'middle',
            }}
          />
          Processing…
        </>
      ) : (
        label
      )}
    </button>
  );
}
