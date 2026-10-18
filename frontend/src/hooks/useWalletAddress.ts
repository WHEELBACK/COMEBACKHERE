import { useState, useEffect } from "react";

/**
 * Returns the public key of the currently-connected Freighter wallet, or null
 * if no wallet is connected / Freighter is not installed.
 *
 * Polls every 5 seconds so the Sidebar updates if the user connects or
 * disconnects their wallet while the page is open.
 */
export function useWalletAddress(): string | null {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    async function check() {
      try {
        if (
          typeof window === "undefined" ||
          !(window as any).freighterApi?.getPublicKey
        ) {
          setAddress(null);
          return;
        }
        const key: string = await (window as any).freighterApi.getPublicKey();
        setAddress(key || null);
      } catch {
        setAddress(null);
      }
    }

    check();
    const interval = setInterval(check, 5_000);
    return () => clearInterval(interval);
  }, []);

  return address;
}
