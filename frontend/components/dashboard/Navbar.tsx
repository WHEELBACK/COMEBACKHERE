import { useEffect, useRef, useState } from 'react';

type SocketStatus = 'connecting' | 'open' | 'closed' | 'error';

const STATUS_META: Record<SocketStatus, { label: string; dot: string; text: string }> = {
  open: { label: 'Live', dot: 'bg-green-500', text: 'text-green-700' },
  connecting: { label: 'Connecting', dot: 'bg-amber-500', text: 'text-amber-700' },
  closed: { label: 'Disconnected', dot: 'bg-red-500', text: 'text-red-700' },
  error: { label: 'Disconnected', dot: 'bg-red-500', text: 'text-red-700' },
};

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function resolveSocketUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_WS_URL;
  if (!base) return null;
  return base;
}

export default function Navbar() {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUnmountRef = useRef(false);

  useEffect(() => {
    const url = resolveSocketUrl();
    if (!url) {
      setStatus('closed');
      return;
    }

    closedByUnmountRef.current = false;

    const connect = () => {
      setStatus('connecting');
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        setStatus('error');
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        backoffRef.current = INITIAL_BACKOFF_MS;
        setStatus('open');
      };

      socket.onerror = () => {
        setStatus('error');
      };

      socket.onclose = () => {
        socketRef.current = null;
        if (closedByUnmountRef.current) return;
        setStatus('closed');
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (closedByUnmountRef.current) return;
      if (reconnectTimerRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      closedByUnmountRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.onopen = null;
        socketRef.current.onerror = null;
        socketRef.current.onclose = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, []);

  const meta = STATUS_META[status];

  return (
    <nav className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
      <div className="text-lg font-semibold text-gray-900">Dashboard</div>
      <div
        className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1"
        role="status"
        aria-live="polite"
        aria-label={`Real-time connection: ${meta.label}`}
        title={`Real-time connection: ${meta.label}`}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} aria-hidden="true" />
        <span className={`text-xs font-medium ${meta.text}`}>{meta.label}</span>
      </div>
    </nav>
  );
}
