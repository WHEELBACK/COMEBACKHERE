import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPublicKey,
  isConnected,
  signTransaction,
  getNetwork,
} from '@stellar/freighter-api';

export interface FreighterState {
  publicKey: string | null;
  connected: boolean;
  network: string | null;
  loading: boolean;
  error: string | null;
  disconnected: boolean;
}

const DISCONNECT_POLL_INTERVAL_MS = 2000;

const initialState: FreighterState = {
  publicKey: null,
  connected: false,
  network: null,
  loading: false,
  error: null,
  disconnected: false,
};

export function useFreighter() {
  const [state, setState] = useState<FreighterState>(initialState);
  const broadcastInFlight = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    broadcastInFlight.current = false;
    clearPoll();
    setState((prev) => ({
      ...prev,
      publicKey: null,
      connected: false,
      network: null,
      loading: false,
      error: 'Wallet disconnected. Please reconnect Freighter to continue.',
      disconnected: true,
    }));
  }, [clearPoll]);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    try {
      const result = await isConnected();
      const connected = typeof result === 'boolean' ? result : Boolean(result?.isConnected);
      if (!connected) {
        handleDisconnect();
        return false;
      }
      return true;
    } catch {
      handleDisconnect();
      return false;
    }
  }, [handleDisconnect]);

  const startPolling = useCallback(() => {
    if (pollTimer.current !== null) return;
    pollTimer.current = setInterval(() => {
      void checkConnection();
    }, DISCONNECT_POLL_INTERVAL_MS);
  }, [checkConnection]);

  const connect = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const keyResult = await getPublicKey();
      const publicKey =
        typeof keyResult === 'string' ? keyResult : keyResult?.publicKey ?? null;
      if (!publicKey) {
        throw new Error('Unable to retrieve public key from Freighter.');
      }
      const networkResult = await getNetwork();
      const network =
        typeof networkResult === 'string'
          ? networkResult
          : networkResult?.network ?? null;
      setState({
        publicKey,
        connected: true,
        network,
        loading: false,
        error: null,
        disconnected: false,
      });
      startPolling();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to connect Freighter.',
      }));
    }
  }, [startPolling]);

  const disconnect = useCallback(() => {
    handleDisconnect();
  }, [handleDisconnect]);

  const sign = useCallback(
    async (xdr: string, opts?: { network?: string; networkPassphrase?: string }) => {
      broadcastInFlight.current = true;
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const stillConnected = await checkConnection();
        if (!stillConnected) {
          return null;
        }
        const signed = await signTransaction(xdr, {
          network: opts?.network ?? state.network ?? undefined,
          networkPassphrase: opts?.networkPassphrase,
        });
        if (!broadcastInFlight.current) {
          return null;
        }
        setState((prev) => ({ ...prev, loading: false }));
        return signed;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transaction signing failed.';
        const looksDisconnected = /lock|disconnect|not connected|unauthor/i.test(message);
        if (looksDisconnected) {
          handleDisconnect();
        } else {
          setState((prev) => ({ ...prev, loading: false, error: message }));
        }
        return null;
      } finally {
        broadcastInFlight.current = false;
      }
    },
    [checkConnection, handleDisconnect, state.network],
  );

  useEffect(() => {
    return () => {
      clearPoll();
    };
  }, [clearPoll]);

  return {
    ...state,
    connect,
    disconnect,
    sign,
    checkConnection,
  };
}
