'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type SocketStatus = 'connecting' | 'open' | 'closed' | 'error';

const STATUS_STYLES: Record<SocketStatus, { dot: string; label: string; text: string }> = {
  connecting: { dot: 'bg-amber-400', label: 'Connecting', text: 'text-amber-600' },
  open: { dot: 'bg-green-500', label: 'Live', text: 'text-green-600' },
  closed: { dot: 'bg-red-500', label: 'Disconnected', text: 'text-red-600' },
  error: { dot: 'bg-red-500', label: 'Error', text: 'text-red-600' },
};

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/payments', label: 'Payments' },
  { href: '/dashboard/settings', label: 'Settings' },
];

function getWebSocketUrl(): string {
  const base = process.env.NEXT_PUBLIC_WS_URL;
  if (base) return base;
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    const connect = () => {
      if (unmountedRef.current) return;
      const url = getWebSocketUrl();
      if (!url) return;

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
        retryRef.current = 0;
        setStatus('open');
      };

      socket.onerror = () => {
        setStatus('error');
      };

      socket.onclose = () => {
        if (unmountedRef.current) return;
        setStatus('closed');
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (unmountedRef.current) return;
      const attempt = retryRef.current;
      retryRef.current = attempt + 1;
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const socket = socketRef.current;
      if (socket) {
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  const statusStyle = STATUS_STYLES[status];

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-lg font-semibold text-gray-900">Merchant Portal</span>
            <div className="flex items-center gap-4">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`text-sm ${
                    pathname === item.href
                      ? 'font-medium text-gray-900'
                      : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div
            className="flex items-center gap-2"
            role="status"
            aria-live="polite"
            title={`Real-time feed: ${statusStyle.label}`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${statusStyle.dot}`} />
            <span className={`text-xs font-medium ${statusStyle.text}`}>{statusStyle.label}</span>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
