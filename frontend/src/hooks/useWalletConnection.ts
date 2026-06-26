import { useCallback, useEffect, useRef } from "react";
import SignClient from "@walletconnect/sign-client";
import type { FrontendNetworkConfig } from "../network";
import { getNetworkConfig, getActiveNetwork } from "../network";
import type { WalletState } from "./useWalletState";
import { DISCONNECTED_STATE } from "./useWalletState";
import type { WalletType } from "./useWallet";

const WC_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "YOUR_PROJECT_ID";

interface UseWalletConnectionOptions {
  networkConfig: FrontendNetworkConfig;
  setState: React.Dispatch<React.SetStateAction<WalletState>>;
}

/**
 * Handles wallet connection and disconnection for both Freighter and
 * WalletConnect. Single responsibility: establish / tear down sessions.
 *
 * Returns `connect`, `disconnect`, and the WalletConnect refs so the signing
 * hook can access the live session.
 */
export function useWalletConnection({
  networkConfig,
  setState,
}: UseWalletConnectionOptions) {
  const wcClientRef =
    useRef<Awaited<ReturnType<typeof SignClient.init>> | null>(null);
  const wcTopicRef = useRef<string | null>(null);

  // ── Freighter ─────────────────────────────────────────────────────────────

  const connectFreighter = useCallback(async () => {
    if (!window.freighter) {
      setState((s) => ({
        ...s,
        connecting: false,
        error: "Freighter not found. Install it from freighter.app",
      }));
      return;
    }

    try {
      const isConnected = await window.freighter.isConnected();
      if (!isConnected) {
        setState((s) => ({
          ...s,
          connecting: false,
          error: "Please unlock Freighter and try again.",
        }));
        return;
      }

      const [publicKey, { networkPassphrase }] = await Promise.all([
        window.freighter.getPublicKey(),
        window.freighter.getNetwork(),
      ]);

      const activeNetworkConfig = getNetworkConfig();
      if (networkPassphrase !== activeNetworkConfig.networkPassphrase) {
        setState((s) => ({
          ...s,
          connecting: false,
          error: `Freighter is on the wrong network. Expected ${getActiveNetwork()}.`,
        }));
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
      });
    } catch (e: unknown) {
      setState((s) => ({
        ...s,
        connecting: false,
        error: e instanceof Error ? e.message : "Freighter connection failed",
      }));
    }
  }, [setState]);

  // ── WalletConnect ──────────────────────────────────────────────────────────

  const connectWalletConnect = useCallback(async () => {
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
          "_blank"
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
      });

      client.on("session_delete", () => {
        wcTopicRef.current = null;
        localStorage.removeItem("soroban-wallet-connected");
        setState(DISCONNECTED_STATE);
      });
    } catch (e: unknown) {
      setState((s) => ({
        ...s,
        connecting: false,
        error:
          e instanceof Error ? e.message : "WalletConnect connection failed",
      }));
    }
  }, [networkConfig.networkPassphrase, networkConfig.walletConnectChain, setState]);

  // ── Auto-reconnect on mount ────────────────────────────────────────────────

  useEffect(() => {
    const saved = localStorage.getItem("soroban-wallet-connected");
    if (saved === "freighter") {
      connectFreighter();
    } else if (saved === "walletconnect") {
      connectWalletConnect();
    }
  }, [connectFreighter, connectWalletConnect]);

  // ── Public API ─────────────────────────────────────────────────────────────

  const connect = useCallback(
    async (walletType: WalletType = "freighter") => {
      setState((s) => ({ ...s, connecting: true, error: null }));
      if (walletType === "walletconnect") {
        await connectWalletConnect();
      } else {
        await connectFreighter();
      }
    },
    [connectFreighter, connectWalletConnect, setState]
  );

  const disconnect = useCallback(
    async (currentWalletType: WalletType | null) => {
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
    },
    [setState]
  );

  return { connect, disconnect, wcClientRef, wcTopicRef };
}
