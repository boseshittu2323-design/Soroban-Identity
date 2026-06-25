import { useState } from "react";
import type { WalletType } from "./useWallet";

export interface WalletState {
  publicKey: string | null;
  networkPassphrase: string | null;
  connected: boolean;
  connecting: boolean;
  txLoading: boolean;
  walletType: WalletType | null;
  error: string | null;
}

export const DISCONNECTED_STATE: WalletState = {
  publicKey: null,
  networkPassphrase: null,
  connected: false,
  connecting: false,
  txLoading: false,
  walletType: null,
  error: null,
};

/**
 * Manages the raw wallet state atom.
 * Separated so connection and signing hooks can share a single state setter
 * without duplicating the shape definition.
 */
export function useWalletState() {
  const [state, setState] = useState<WalletState>(DISCONNECTED_STATE);
  return { state, setState };
}
