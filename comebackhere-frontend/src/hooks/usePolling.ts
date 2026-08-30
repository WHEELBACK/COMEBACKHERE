import { useCallback, useEffect, useRef, useState } from "react"

export interface UsePollingOptions {
  /** Polling interval in milliseconds. Defaults to 10 000 (10 s). */
  interval?: number
  /** Set to false to disable polling entirely (e.g. wallet not connected). */
  enabled?: boolean
}

export interface UsePollingResult {
  /** ISO timestamp of the last successful poll, or null before the first call. */
  lastUpdatedAt: Date | null
  /** Whether a poll is currently in-flight. */
  polling: boolean
}

/**
 * Periodically calls `callback` at the given `interval`.
 * Automatically pauses when the browser tab is hidden (Page Visibility API)
 * and resumes when the tab becomes visible again.
 */
export function usePolling(
  callback: () => Promise<void>,
  { interval = 10_000, enabled = true }: UsePollingOptions = {},
): UsePollingResult {
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const [polling, setPolling] = useState(false)

  // Keep a stable reference to the latest callback so the interval closure
  // never captures a stale version.
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  const runPoll = useCallback(async () => {
    if (document.hidden) return
    setPolling(true)
    try {
      await callbackRef.current()
      setLastUpdatedAt(new Date())
    } catch {
      // Errors from the callback (e.g. transient network failures) are
      // silently swallowed here. Callers should handle error state internally
      // (e.g. by calling setError inside their own callback).
    } finally {
      setPolling(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return

    // Fire once immediately when enabled / address changes.
    runPoll()

    let id: ReturnType<typeof setInterval> | null = null
    const startInterval = () => {
      if (id === null) id = setInterval(runPoll, interval)
    }
    const stopInterval = () => {
      if (id !== null) {
        clearInterval(id)
        id = null
      }
    }

    // Only tick while the tab is visible; tearing the timer down entirely
    // while hidden avoids waking up on every interval just to no-op.
    if (!document.hidden) startInterval()

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopInterval()
      } else {
        runPoll()
        startInterval()
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      stopInterval()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [enabled, interval, runPoll])

  return { lastUpdatedAt, polling }
}
