import { useEffect, useRef } from "react"

/**
 * useFocusTrap
 *
 * Traps keyboard focus inside the given container element while the modal is
 * open. Also:
 *   - Moves focus into the container on mount.
 *   - Calls `onClose` when the user presses Escape (unless `disabled` is true).
 *   - Restores focus to the element that was active before the modal opened,
 *     when the modal closes (component unmounts).
 *
 * Usage:
 *   const containerRef = useFocusTrap({ onClose, disabled: submitting })
 *   <div ref={containerRef} role="dialog" aria-modal="true" tabIndex={-1}>
 */
const FOCUSABLE_SELECTORS = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "details > summary",
].join(", ")

interface UseFocusTrapOptions {
  /** Called when the user presses Escape. Pass the modal's close handler. */
  onClose: () => void
  /**
   * When true, Escape key handling is suppressed (e.g. while a submission is
   * in-flight). Focus trapping remains active regardless.
   */
  disabled?: boolean
}

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  options: UseFocusTrapOptions,
) {
  const { onClose, disabled = false } = options
  const containerRef = useRef<T>(null)
  // Remember what had focus before the modal opened so we can restore it.
  const previouslyFocusedRef = useRef<Element | null>(null)

  useEffect(() => {
    // Capture the element that triggered the modal.
    previouslyFocusedRef.current = document.activeElement

    // Move focus into the container immediately.
    const container = containerRef.current
    if (container) {
      // Try to focus the first focusable child; fall back to the container itself.
      const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTORS)
      if (firstFocusable) {
        firstFocusable.focus()
      } else {
        container.focus()
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!disabled) {
          event.preventDefault()
          onClose()
        }
        return
      }

      if (event.key !== "Tab") return

      const container = containerRef.current
      if (!container) return

      const focusableElements = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
      ).filter((el) => !el.closest("[hidden]"))

      if (focusableElements.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]

      if (event.shiftKey) {
        // Shift+Tab: wrap from first to last.
        if (document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
      } else {
        // Tab: wrap from last to first.
        if (document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      // Restore focus to the trigger element when the modal unmounts.
      const prev = previouslyFocusedRef.current
      if (prev instanceof HTMLElement) {
        prev.focus()
      }
    }
    // onClose identity may change between renders; using the ref pattern keeps
    // the listener stable while always calling the latest version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  return containerRef
}
