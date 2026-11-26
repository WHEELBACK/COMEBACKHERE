import { useEffect, useRef, useState } from 'react';
import { getFreighterApi } from '../lib/freighter';

type TransactionModalProps = {
  open: boolean;
  onClose: () => void;
  onBroadcast: () => Promise<void>;
  onReconnect: () => void;
};

export function TransactionModal({ open, onClose, onBroadcast, onReconnect }: TransactionModalProps) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'disconnected' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const broadcastRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setStatus('idle');
      setError(null);
      broadcastRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open || status !== 'pending') return;

    let cancelled = false;

    const checkConnection = async () => {
      try {
        const api = await getFreighterApi();
        const connected = await api.isConnected();
        if (!connected && !cancelled) {
          broadcastRef.current = false;
          setStatus('disconnected');
        }
      } catch {
        if (!cancelled) {
          broadcastRef.current = false;
          setStatus('disconnected');
        }
      }
    };

    const interval = window.setInterval(checkConnection, 1500);
    void checkConnection();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, status]);

  const handleBroadcast = async () => {
    setError(null);
    setStatus('pending');
    broadcastRef.current = true;
    try {
      await onBroadcast();
      if (broadcastRef.current) {
        setStatus('idle');
        onClose();
      }
    } catch (err) {
      if (!broadcastRef.current) return;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Transaction failed');
    }
  };

  const handleReconnect = () => {
    setError(null);
    setStatus('idle');
    onReconnect();
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-content">
        <h2>Confirm Transaction</h2>

        {status === 'pending' && (
          <p className="modal-status">Broadcasting transaction… please wait.</p>
        )}

        {status === 'disconnected' && (
          <div className="modal-disconnected" role="alert">
            <p>Your Freighter wallet was disconnected. Reconnect to continue.</p>
            <button type="button" onClick={handleReconnect}>
              Reconnect Wallet
            </button>
          </div>
        )}

        {status === 'error' && error && (
          <p className="modal-error" role="alert">{error}</p>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={status === 'pending'}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleBroadcast}
            disabled={status === 'pending' || status === 'disconnected'}
          >
            Broadcast
          </button>
        </div>
      </div>
    </div>
  );
}
