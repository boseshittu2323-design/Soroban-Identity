import type { FrontendNetworkConfig } from "../network";
import { useWalletState } from "./useWalletState";
import { useWalletConnection } from "./useWalletConnection";
import { useWalletSigning } from "./useWalletSigning";
import { useFreighterAccountSync } from "./useFreighterAccountSync";

// ── Freighter global types ────────────────────────────────────────────────────

declare global {
  interface Window {
    freighter?: {
      isConnected: () => Promise<boolean>;
      getPublicKey: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts?: { networkPassphrase?: string }
      ) => Promise<string>;
      getNetwork: () => Promise<{
        network: string;
        networkPassphrase: string;
      }>;
    };
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export type WalletType = "freighter" | "walletconnect";

export type { WalletState } from "./useWalletState";

// ── Composed hook ─────────────────────────────────────────────────────────────

/**
 * Composes the focused wallet hooks into a single public API.
 *
 * - {@link useWalletState}            — raw state atom
 * - {@link useWalletConnection}       — connect / disconnect / auto-reconnect
 * - {@link useFreighterAccountSync}   — mid-session account-switch detection
 * - {@link useWalletSigning}          — XDR signing
 */
export function useWallet(networkConfig: FrontendNetworkConfig) {
  const { state, setState } = useWalletState();

  const { connect, disconnect: _disconnect, wcClientRef, wcTopicRef } =
    useWalletConnection({ networkConfig, setState });

  useFreighterAccountSync({ state, setState });

  const { signTransaction } = useWalletSigning({
    networkConfig,
    state,
    setState,
    wcClientRef,
    wcTopicRef,
  });

  const disconnect = () => _disconnect(state.walletType);

  return { ...state, connect, disconnect, signTransaction };
}
