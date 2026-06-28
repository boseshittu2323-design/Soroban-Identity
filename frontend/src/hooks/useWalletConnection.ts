import { useCallback, useEffect, useRef, useState } from "react";
import SignClient from "@walletconnect/sign-client";
import type { FrontendNetworkConfig } from "../network";
import { getNetworkConfig, getActiveNetwork } from "../network";
import type { WalletState, WalletConnectionError } from "./useWalletState";
import { DISCONNECTED_STATE } from "./useWalletState";
import type { WalletType } from "./useWallet";

const WC_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "YOUR_PROJECT_ID";

interface UseWalletConnectionOptions {
  networkConfig: FrontendNetworkConfig;
  setState: React.Dispatch<React.SetStateAction<WalletState>>;
  maxRetries?: number;
  retryDelayMs?: number;
}

interface UseWalletConnectionReturn {
  connect: (walletType?: WalletType) => Promise<void>;
  disconnect: (currentWalletType: WalletType | null) => Promise<void>;
  wcClientRef: React.MutableRefObject<Awaited<
    ReturnType<typeof SignClient.init>
  > | null>;
  wcTopicRef: React.MutableRefObject<string | null>;
  retry: () => Promise<void>;
  isConnecting: boolean;
  error: WalletConnectionError | string | null;
  retryCount: number;
}

/**
 * Handles wallet connection and disconnection for both Freighter and
 * WalletConnect. Retries on timeout with configurable limits.
 *
 * Features:
 * - Retries connection with configurable maxRetries (default: 3)
 * - Exposes { isConnecting, error, retryCount, retry } for UI feedback
 * - Logs each failed attempt with attempt number and elapsed time
 * - Stops retrying after maxRetries consecutive failures
 */
export function useWalletConnection({
  networkConfig,
  setState,
  maxRetries = 3,
  retryDelayMs = 1500,
}: UseWalletConnectionOptions): UseWalletConnectionReturn {
  const wcClientRef = useRef<Awaited<
    ReturnType<typeof SignClient.init>
  > | null>(null);
  const wcTopicRef = useRef<string | null>(null);
  const retryCountRef = useRef<number>(0);
  const currentWalletTypeRef = useRef<WalletType | null>(null);
  const startTimeRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<WalletConnectionError | string | null>(
    null,
  );
  const [retryCount, setRetryCount] = useState(0);

  // ── Freighter ─────────────────────────────────────────────────────────────

  const connectFreighter = useCallback(
    async (isRetry = false) => {
      if (!isRetry) {
        retryCountRef.current = 0;
        startTimeRef.current = Date.now();
      }

      if (!window.freighter) {
        const errorMsg = "Freighter not found. Install it from freighter.app";
        setState((s) => ({
          ...s,
          connecting: false,
          error: errorMsg,
        }));
        setError(errorMsg);
        setIsConnecting(false);
        return;
      }

      try {
        const isConnected = await window.freighter.isConnected();
        if (!isConnected) {
          const errorMsg = "Please unlock Freighter and try again.";
          setState((s) => ({
            ...s,
            connecting: false,
            error: errorMsg,
          }));
          setError(errorMsg);
          setIsConnecting(false);
          return;
        }

        const [publicKey, { networkPassphrase }] = await Promise.all([
          window.freighter.getPublicKey(),
          window.freighter.getNetwork(),
        ]);

        const activeNetworkConfig = getNetworkConfig();
        if (networkPassphrase !== activeNetworkConfig.networkPassphrase) {
          const errorMsg = `Freighter is on the wrong network. Expected ${getActiveNetwork()}.`;
          setState((s) => ({
            ...s,
            connecting: false,
            error: errorMsg,
          }));
          setError(errorMsg);
          setIsConnecting(false);
          return;
        }

        localStorage.setItem("soroban-wallet-connected", "freighter");

        setState({
          publicKey,
          networkPassphrase,
          connected: true,
          connecting: false,
          txLoading: false,
          walletType: "freighter",
          error: null,
          retryCount: 0,
        });
        setError(null);
        setRetryCount(0);
        retryCountRef.current = 0;
        setIsConnecting(false);
      } catch (e: unknown) {
        const elapsed = Date.now() - startTimeRef.current;
        retryCountRef.current++;
        const attempt = retryCountRef.current;

        const errorMessage =
          e instanceof Error ? e.message : "Freighter connection failed";
        console.warn(
          `[useWalletConnection] Freighter attempt ${attempt} failed (${elapsed}ms): ${errorMessage}`,
        );

        if (attempt >= maxRetries) {
          const error: WalletConnectionError = {
            code: "WALLET_TIMEOUT",
            message: `Could not connect to Freighter after ${maxRetries} attempts.`,
          };
          setState((s) => ({
            ...s,
            connecting: false,
            error: error.message,
            retryCount: attempt,
          }));
          setError(error);
          setRetryCount(attempt);
          setIsConnecting(false);
        } else {
          // Retry after delay
          setState((s) => ({
            ...s,
            connecting: true,
            error: null,
            retryCount: attempt,
          }));
          setRetryCount(attempt);
          timeoutRef.current = setTimeout(async () => {
            await connectFreighter(true);
          }, retryDelayMs);
        }
      }
    },
    [networkConfig, setState, maxRetries, retryDelayMs],
  );

  // ── WalletConnect ──────────────────────────────────────────────────────────

  const connectWalletConnect = useCallback(
    async (isRetry = false) => {
      if (!isRetry) {
        retryCountRef.current = 0;
        startTimeRef.current = Date.now();
      }

      try {
        const client = await SignClient.init({
          projectId: WC_PROJECT_ID,
          metadata: {
            name: "Soroban Identity",
            description: "Decentralized Identity for a Trustless World",
            url: window.location.origin,
            icons: [`${window.location.origin}/favicon.ico`],
          },
        });

        wcClientRef.current = client;

        const { uri, approval } = await client.connect({
          requiredNamespaces: {
            stellar: {
              methods: ["stellar_signXDR"],
              chains: [networkConfig.walletConnectChain],
              events: ["accountsChanged"],
            },
          },
        });

        if (uri) {
          window.open(
            `https://walletconnect.com/wc?uri=${encodeURIComponent(uri)}`,
            "_blank",
          );
        }

        const session = await approval();
        wcTopicRef.current = session.topic;

        const accounts = session.namespaces.stellar?.accounts ?? [];
        const publicKey = accounts[0]?.split(":")[2] ?? null;

        localStorage.setItem("soroban-wallet-connected", "walletconnect");

        setState({
          publicKey,
          networkPassphrase: networkConfig.networkPassphrase,
          connected: true,
          connecting: false,
          txLoading: false,
          walletType: "walletconnect",
          error: null,
          retryCount: 0,
        });
        setError(null);
        setRetryCount(0);
        retryCountRef.current = 0;
        setIsConnecting(false);

        client.on("session_delete", () => {
          wcTopicRef.current = null;
          localStorage.removeItem("soroban-wallet-connected");
          setState(DISCONNECTED_STATE);
        });
      } catch (e: unknown) {
        const elapsed = Date.now() - startTimeRef.current;
        retryCountRef.current++;
        const attempt = retryCountRef.current;

        const errorMessage =
          e instanceof Error ? e.message : "WalletConnect connection failed";
        console.warn(
          `[useWalletConnection] WalletConnect attempt ${attempt} failed (${elapsed}ms): ${errorMessage}`,
        );

        if (attempt >= maxRetries) {
          const error: WalletConnectionError = {
            code: "WALLET_TIMEOUT",
            message: `Could not connect to WalletConnect after ${maxRetries} attempts.`,
          };
          setState((s) => ({
            ...s,
            connecting: false,
            error: error.message,
            retryCount: attempt,
          }));
          setError(error);
          setRetryCount(attempt);
          setIsConnecting(false);
        } else {
          // Retry after delay
          setState((s) => ({
            ...s,
            connecting: true,
            error: null,
            retryCount: attempt,
          }));
          setRetryCount(attempt);
          timeoutRef.current = setTimeout(async () => {
            await connectWalletConnect(true);
          }, retryDelayMs);
        }
      }
    },
    [
      networkConfig.networkPassphrase,
      networkConfig.walletConnectChain,
      setState,
      maxRetries,
      retryDelayMs,
    ],
  );

  // ── Auto-reconnect on mount ────────────────────────────────────────────────

  useEffect(() => {
    const saved = localStorage.getItem("soroban-wallet-connected");
    if (saved === "freighter") {
      connectFreighter();
    } else if (saved === "walletconnect") {
      connectWalletConnect();
    }
  }, [connectFreighter, connectWalletConnect]);

  // ── Cleanup ────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // ── Public API ─────────────────────────────────────────────────────────────

  const connect = useCallback(
    async (walletType: WalletType = "freighter") => {
      setIsConnecting(true);
      setError(null);
      setRetryCount(0);
      retryCountRef.current = 0;
      currentWalletTypeRef.current = walletType;

      setState((s) => ({ ...s, connecting: true, error: null, retryCount: 0 }));

      if (walletType === "walletconnect") {
        await connectWalletConnect();
      } else {
        await connectFreighter();
      }
    },
    [connectFreighter, connectWalletConnect, setState],
  );

  const retry = useCallback(async () => {
    if (!currentWalletTypeRef.current) return;
    await connect(currentWalletTypeRef.current);
  }, [connect]);

  const disconnect = useCallback(
    async (currentWalletType: WalletType | null) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (
        currentWalletType === "walletconnect" &&
        wcClientRef.current &&
        wcTopicRef.current
      ) {
        try {
          await wcClientRef.current.disconnect({
            topic: wcTopicRef.current,
            reason: { code: 6000, message: "User disconnected" },
          });
        } catch {
          // ignore — session may already be gone
        }
        wcClientRef.current = null;
        wcTopicRef.current = null;
      }

      localStorage.removeItem("soroban-wallet-connected");
      setState(DISCONNECTED_STATE);
      setError(null);
      setRetryCount(0);
      setIsConnecting(false);
      retryCountRef.current = 0;
    },
    [setState],
  );

  return {
    connect,
    disconnect,
    wcClientRef,
    wcTopicRef,
    retry,
    isConnecting,
    error,
    retryCount,
  };
}
