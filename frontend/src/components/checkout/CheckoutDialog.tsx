import React, { useCallback, useEffect, useRef } from 'react';

export interface CheckoutDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: React.ReactNode;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function CheckoutDialog({ open, onClose, title, children }: CheckoutDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useRef(`checkout-dialog-title-${Math.random().toString(36).slice(2)}`);

  const getFocusable = useCallback((): HTMLElement[] => {
    const root = dialogRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }, []);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const focusables = getFocusable();
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      dialogRef.current?.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !dialogRef.current?.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, getFocusable]);

  if (!open) return null;

  return (
    <div
      className="checkout-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        className="checkout-dialog"
      >
        <h2 id={titleId.current} className="checkout-dialog-title">
          {title}
        </h2>
        <button
          type="button"
          className="checkout-dialog-close"
          aria-label="Close checkout dialog"
          onClick={onClose}
        >
          &times;
        </button>
        <div className="checkout-dialog-body">{children}</div>
      </div>
    </div>
  );
}

export default CheckoutDialog;
