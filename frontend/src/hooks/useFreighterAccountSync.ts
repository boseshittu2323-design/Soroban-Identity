import { useEffect } from "react";
import type { WalletState } from "./useWalletState";
import { DISCONNECTED_STATE } from "./useWalletState";

interface UseFreighterAccountSyncOptions {
  state: WalletState;
  setState: React.Dispatch<React.SetStateAction<WalletState>>;
}

/**
 * Polls Freighter every 2 s while connected to detect mid-session account
 * switches. Disconnects gracefully if Freighter becomes unavailable.
 * Single responsibility: keep the stored public key in sync with Freighter.
 */
export function useFreighterAccountSync({
  state,
  setState,
}: UseFreighterAccountSyncOptions) {
  useEffect(() => {
    if (state.walletType !== "freighter" || !state.connected) return;

    const interval = setInterval(async () => {
      if (!window.freighter) return;
      try {
        const currentKey = await window.freighter.getPublicKey();
        if (currentKey !== state.publicKey) {
          const { networkPassphrase } = await window.freighter.getNetwork();
          setState({
            publicKey: currentKey,
            networkPassphrase,
            connected: true,
            connecting: false,
            walletType: "freighter",
            txLoading: false,
            error: null,
          });
        }
      } catch {
        // Freighter became unavailable — disconnect gracefully
        setState(DISCONNECTED_STATE);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [state.walletType, state.connected, state.publicKey, setState]);
}
