import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface UseFocusTrapOptions {
  /** Whether the trap is currently active (e.g. modal open). */
  active?: boolean;
  /** Called when the user presses Escape while the trap is active. */
  onEscape?: () => void;
  /** Restore focus to the previously focused element on deactivate. Defaults to true. */
  restoreFocus?: boolean;
}

/**
 * Traps keyboard focus within the referenced container while active.
 *
 * - Tab / Shift+Tab cycle through focusable elements inside the container.
 * - Escape invokes `onEscape` (typically to close the dialog).
 * - Focus is moved into the container on activation and restored on deactivation.
 *
 * Usage:
 *   const trapRef = useFocusTrap<HTMLDivElement>({ active: isOpen, onEscape: close });
 *   <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="checkout-title">…</div>
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  options: UseFocusTrapOptions = {},
) {
  const { active = true, onEscape, restoreFocus = true } = options;
  const containerRef = useRef<T | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusable = (): HTMLElement[] => {
      const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      return Array.from(nodes).filter(
        (el) =>
          !el.hasAttribute('disabled') &&
          el.getAttribute('aria-hidden') !== 'true' &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement),
      );
    };

    // Move initial focus into the dialog.
    const initial = getFocusable();
    if (initial.length > 0) {
      initial[0].focus();
    } else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (onEscape) {
          event.stopPropagation();
          onEscape();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (restoreFocus && previouslyFocusedRef.current) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [active, onEscape, restoreFocus]);

  return containerRef;
}

export default useFocusTrap;
