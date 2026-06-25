import { useCallback } from "react";
import SignClient from "@walletconnect/sign-client";
import type { FrontendNetworkConfig } from "../network";
import type { WalletState } from "./useWalletState";

interface UseWalletSigningOptions {
  networkConfig: FrontendNetworkConfig;
  state: WalletState;
  setState: React.Dispatch<React.SetStateAction<WalletState>>;
  wcClientRef: React.MutableRefObject<Awaited<
    ReturnType<typeof SignClient.init>
  > | null>;
  wcTopicRef: React.MutableRefObject<string | null>;
}

/**
 * Handles transaction signing for whichever wallet is currently active.
 * Single responsibility: sign an XDR string and return the signed XDR.
 */
export function useWalletSigning({
  networkConfig,
  state,
  setState,
  wcClientRef,
  wcTopicRef,
}: UseWalletSigningOptions) {
  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.connected) throw new Error("Wallet not connected");

      setState((s) => ({ ...s, txLoading: true }));
      try {
        if (state.walletType === "walletconnect") {
          if (!wcClientRef.current || !wcTopicRef.current) {
            throw new Error("WalletConnect session not available");
          }
          const result = await wcClientRef.current.request<{
            signedXDR: string;
          }>({
            topic: wcTopicRef.current,
            chainId: networkConfig.walletConnectChain,
            request: {
              method: "stellar_signXDR",
              params: { xdr },
            },
          });
          return result.signedXDR;
        }

        // Freighter
        if (!window.freighter || !state.networkPassphrase) {
          throw new Error("Freighter not available");
        }
        return await window.freighter.signTransaction(xdr, {
          networkPassphrase: state.networkPassphrase,
        });
      } finally {
        setState((s) => ({ ...s, txLoading: false }));
      }
    },
    [
      networkConfig.walletConnectChain,
      state.connected,
      state.walletType,
      state.networkPassphrase,
      setState,
      wcClientRef,
      wcTopicRef,
    ]
  );

  return { signTransaction };
}
