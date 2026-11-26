export type WebSocketStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface WebSocketClientOptions {
  url: string;
  onMessage?: (event: MessageEvent) => void;
  onStatusChange?: (status: WebSocketStatus) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxReconnectAttempts?: number;
}

/**
 * Thin WebSocket wrapper that exposes connection status and performs
 * exponential backoff reconnection when the socket drops.
 */
export class WebSocketClient {
  private socket: WebSocket | null = null;
  private status: WebSocketStatus = 'closed';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;

  private readonly url: string;
  private readonly onMessage?: (event: MessageEvent) => void;
  private readonly onStatusChange?: (status: WebSocketStatus) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(options: WebSocketClientOptions) {
    this.url = options.url;
    this.onMessage = options.onMessage;
    this.onStatusChange = options.onStatusChange;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
  }

  getStatus(): WebSocketStatus {
    return this.status;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.setStatus('connecting');

    try {
      this.socket = new WebSocket(this.url);
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus('open');
    };

    this.socket.onmessage = (event) => {
      this.onMessage?.(event);
    };

    this.socket.onerror = () => {
      this.setStatus('error');
    };

    this.socket.onclose = () => {
      this.socket = null;
      if (this.manuallyClosed) {
        this.setStatus('closed');
        return;
      }
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = Math.min(
      this.initialBackoffMs * 2 ** this.reconnectAttempts,
      this.maxBackoffMs,
    );
    this.reconnectAttempts += 1;

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: WebSocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }
}
