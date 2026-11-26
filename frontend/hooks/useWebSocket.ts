import { useCallback, useEffect, useRef, useState } from 'react';

export type WebSocketStatus = 'connecting' | 'open' | 'closed' | 'error';

interface UseWebSocketOptions {
  url: string;
  onMessage?: (event: MessageEvent) => void;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  enabled?: boolean;
  /** Base delay in ms for exponential backoff. */
  reconnectBaseDelay?: number;
  /** Maximum delay in ms between reconnection attempts. */
  reconnectMaxDelay?: number;
  /** Maximum number of buffered outbound messages while the socket is not open. */
  maxQueuedMessages?: number;
}

interface UseWebSocketResult {
  status: WebSocketStatus;
  reconnectAttempt: number;
  send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => boolean;
  reconnect: () => void;
}

/**
 * Manages a WebSocket connection and exposes its live status so the UI can
 * render an accurate connection indicator. Automatically reconnects with
 * exponential backoff when the socket closes unexpectedly.
 *
 * To keep memory bounded under peak load, outbound messages sent while the
 * socket is not open are buffered in a capped FIFO queue (oldest dropped first)
 * and flushed on reconnect. Callbacks are stored in refs so identity changes do
 * not tear down and rebuild the socket.
 */
export function useWebSocket({
  url,
  onMessage,
  onOpen,
  onClose,
  onError,
  enabled = true,
  reconnectBaseDelay = 1000,
  reconnectMaxDelay = 30000,
  maxQueuedMessages = 100,
}: UseWebSocketOptions): UseWebSocketResult {
  const [status, setStatus] = useState<WebSocketStatus>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const manualCloseRef = useRef(false);
  const queueRef = useRef<Array<string | ArrayBufferLike | Blob | ArrayBufferView>>([]);

  // Keep the latest callbacks in refs so the connection effect does not depend
  // on their identity (avoids needless reconnects and socket churn).
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onOpenRef.current = onOpen;
    onCloseRef.current = onClose;
    onErrorRef.current = onError;
  }, [onMessage, onOpen, onClose, onError]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const flushQueue = useCallback((socket: WebSocket) => {
    const queue = queueRef.current;
    while (queue.length > 0 && socket.readyState === WebSocket.OPEN) {
      const next = queue.shift();
      if (next === undefined) {
        break;
      }
      try {
        socket.send(next);
      } catch {
        // Drop the message on failure rather than growing the queue unbounded.
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled) {
      return;
    }

    clearReconnectTimer();
    manualCloseRef.current = false;
    setStatus('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setStatus('error');
      return;
    }

    socketRef.current = socket;

    socket.onopen = (event) => {
      attemptRef.current = 0;
      setReconnectAttempt(0);
      setStatus('open');
      flushQueue(socket);
      onOpenRef.current?.(event);
    };

    socket.onmessage = (event) => {
      onMessageRef.current?.(event);
    };

    socket.onerror = (event) => {
      setStatus('error');
      onErrorRef.current?.(event);
    };

    socket.onclose = (event) => {
      socketRef.current = null;
      onCloseRef.current?.(event);

      if (manualCloseRef.current || !enabled) {
        setStatus('closed');
        return;
      }

      setStatus('closed');

      const attempt = attemptRef.current;
      const delay = Math.min(
        reconnectBaseDelay * 2 ** attempt,
        reconnectMaxDelay,
      );
      attemptRef.current = attempt + 1;
      setReconnectAttempt(attempt + 1);

      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, [
    enabled,
    url,
    reconnectBaseDelay,
    reconnectMaxDelay,
    clearReconnectTimer,
    flushQueue,
  ]);

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }

    connect();

    return () => {
      manualCloseRef.current = true;
      clearReconnectTimer();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [connect, enabled, clearReconnectTimer]);

  const send = useCallback(
    (data: string | ArrayBufferLike | Blob | ArrayBufferView): boolean => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(data);
          return true;
        } catch {
          return false;
        }
      }

      // Buffer while connecting/reconnecting, bounded to avoid unbounded growth.
      const queue = queueRef.current;
      if (queue.length >= maxQueuedMessages) {
        queue.shift();
      }
      queue.push(data);
      return false;
    },
    [maxQueuedMessages],
  );

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setReconnectAttempt(0);
    const socket = socketRef.current;
    if (socket) {
      manualCloseRef.current = true;
      socket.close();
    }
    connect();
  }, [connect]);

  return { status, reconnectAttempt, send, reconnect };
}

export default useWebSocket;
