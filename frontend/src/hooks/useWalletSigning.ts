import { useCallback, useState } from "react";
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
 * Returns `true` for rejections that originate from the user dismissing the
 * Freighter prompt, rather than genuine errors.
 *
 * Freighter surfaces user rejections as errors whose message contains
 * "User declined" or "Transaction declined". We treat these as non-error
 * user-initiated cancellations and do not forward them to the ErrorBoundary.
 */
function isUserRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("user declined") ||
    msg.includes("transaction declined") ||
    msg.includes("user rejected") ||
    msg.includes("cancelled") ||
    msg.includes("canceled")
  );
}

/**
 * Handles transaction signing for whichever wallet is currently active.
 * Single responsibility: sign an XDR string and return the signed XDR.
 *
 * When the user rejects the Freighter signing prompt the hook sets
 * `signingError` with a user-facing message and the panel remains mounted
 * (the error does NOT propagate to the ErrorBoundary).
 */
export function useWalletSigning({
  networkConfig,
  state,
  setState,
  wcClientRef,
  wcTopicRef,
}: UseWalletSigningOptions) {
  const [signingError, setSigningError] = useState<string | null>(null);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.connected) throw new Error("Wallet not connected");

      // Clear any previous rejection message before each attempt.
      setSigningError(null);
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

        try {
          return await window.freighter.signTransaction(xdr, {
            networkPassphrase: state.networkPassphrase,
          });
        } catch (freighterErr: unknown) {
          if (isUserRejection(freighterErr)) {
            // User cancelled — surface a friendly message, keep the panel alive.
            setSigningError("Transaction signing was cancelled.");
            // Return a rejected promise so the caller knows signing did not
            // complete, but do NOT re-throw so the ErrorBoundary is bypassed.
            return Promise.reject(new Error("Transaction signing was cancelled."));
          }
          // Genuine Freighter error — re-throw so callers can handle it.
          throw freighterErr;
        }
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

  return { signTransaction, signingError, clearSigningError: () => setSigningError(null) };
}
