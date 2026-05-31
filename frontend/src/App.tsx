import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SorobanRpc } from "@stellar/stellar-sdk";
import IdentityPanel from "./components/IdentityPanel";
import CredentialsPanel from "./components/CredentialsPanel";
import WalletButton from "./components/WalletButton";
import ErrorBoundary from "./components/ErrorBoundary";
import { useWallet } from "./hooks/useWallet";
import { useCredentialExpiryCheck } from "./hooks/useCredentialExpiryCheck";
import {
  DEFAULT_NETWORK,
  NETWORK_CONFIGS,
  NETWORK_OPTIONS,
  isMainnet,
  type NetworkName,
} from "./network";
import { checkConnection, IdentityClient, CredentialClient, ReputationClient } from "../../sdk/src/index";
import type { Credential } from "../../sdk/src/types";

type Tab = "identity" | "credentials";

function useDarkMode(): [boolean, () => void] {
  const [isDark, setIsDark] = useState<boolean>(() => {
    const stored = localStorage.getItem("dark-mode");
    if (stored !== null) return stored === "true";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("dark", isDark);
    html.classList.toggle("light", !isDark);
    localStorage.setItem("dark-mode", String(isDark));
  }, [isDark]);

  return [isDark, () => setIsDark((d) => !d)];
}

export default function App() {
  const [tab, setTab] = useState<Tab>("identity");
  const [activeNetwork, setActiveNetwork] = useState<NetworkName>(DEFAULT_NETWORK);
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const networkConfig = NETWORK_CONFIGS[activeNetwork];
  const wallet = useWallet(networkConfig);
  const [isDark, toggleDark] = useDarkMode();
  const { t, i18n } = useTranslation();
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [uninitializedContracts, setUninitializedContracts] = useState<string[]>([]);

  // Check for verify query param on load
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const verifyParam = urlParams.get("verify");
    if (verifyParam) {
      setVerifyId(verifyParam);
      setTab("credentials");
    }
  }, []);

  const onMainnet = isMainnet(activeNetwork);

  // Check RPC connection health on load
  useEffect(() => {
    const checkRpcHealth = async () => {
      const rpcUrl = Array.isArray(networkConfig.rpcUrl)
        ? networkConfig.rpcUrl[0]
        : networkConfig.rpcUrl;
      const server = new SorobanRpc.Server(rpcUrl);
      const healthy = await checkConnection(server);
      setIsConnected(healthy);
    };
    checkRpcHealth();
  }, [networkConfig.rpcUrl]);

  // Check contract initialization on load
  useEffect(() => {
    const checkInit = async () => {
      const identity = new IdentityClient(networkConfig);
      const credentials = new CredentialClient(networkConfig);
      const reputation = new ReputationClient(networkConfig);
      const [idOk, credOk, repOk] = await Promise.all([
        identity.isInitialized(),
        credentials.isInitialized(),
        reputation.isInitialized(),
      ]);
      const uninitialized: string[] = [];
      if (!idOk) uninitialized.push("Identity Registry");
      if (!credOk) uninitialized.push("Credential Manager");
      if (!repOk) uninitialized.push("Reputation");
      setUninitializedContracts(uninitialized);
    };
    checkInit();
  }, [networkConfig.rpcUrl]);

  // Mock fetch — replace with CredentialClient.getCredentialsBySubject() when wired
  const fetchCredentials = useCallback(
    async (_address: string): Promise<Credential[]> => {
      await new Promise((r) => setTimeout(r, 200));
      const now = Math.floor(Date.now() / 1000);
      return [
        {
          id: "abc003",
          credentialType: "Reputation",
          subject: _address,
          issuer: "GISSUER",
          claims: {},
          claimsHash: "mockhash",
          signature: "",
          issuedAt: now - 100,
          expiresAt: now + 3 * 24 * 60 * 60,
          revoked: false,
        },
      ];
    },
    [],
  );

  const { notification, dismiss } = useCredentialExpiryCheck(
    wallet.publicKey,
    fetchCredentials,
  );

  const toggleLang = () => {
    const next = i18n.language === "en" ? "es" : "en";
    i18n.changeLanguage(next);
    localStorage.setItem("lang", next);
  };

  return (
    <div className="container">
      <header style={{ position: "relative" }}>
        <h1>{t("app.title")}</h1>
        <p>{t("app.subtitle")}</p>
        <div
          style={{
            position: "absolute",
            top: "1rem",
            right: 0,
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
          }}
        >
          {isConnected !== null && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.4rem 0.8rem",
                borderRadius: "0.25rem",
                backgroundColor: isConnected
                  ? "var(--success-bg, #d4edda)"
                  : "var(--danger-bg, #f8d7da)",
                color: isConnected
                  ? "var(--success-text, #155724)"
                  : "var(--danger-text, #721c24)",
                fontSize: "0.85rem",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: isConnected ? "#28a745" : "#dc3545",
                }}
              />
              {isConnected ? t("app.networkOnline") : t("app.networkOffline")}
            </div>
          )}
          <button
            className="theme-toggle"
            onClick={toggleLang}
            aria-label="Switch language"
          >
            {i18n.language === "en" ? "ES" : "EN"}
          </button>
          <label className="network-switcher" aria-label="Network">
            <span>Network</span>
            <select
              value={activeNetwork}
              onChange={(e) => setActiveNetwork(e.target.value as NetworkName)}
            >
              {NETWORK_OPTIONS.map((network) => (
                <option key={network.name} value={network.name}>
                  {network.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="theme-toggle"
            onClick={toggleDark}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? t("app.lightMode") : t("app.darkMode")}
          </button>
          <WalletButton wallet={wallet} />
        </div>
      </header>

      {uninitializedContracts.length > 0 && (
        <div
          role="alert"
          aria-label="Contract not initialized warning"
          style={{
            background: "var(--warning-bg, #fff3cd)",
            color: "var(--warning-text, #856404)",
            border: "1px solid var(--warning-border, #ffc107)",
            borderRadius: "0.5rem",
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          ⚠ Contract not initialized: <strong>{uninitializedContracts.join(", ")}</strong>.
          Please run the deploy script and update your contract IDs.{" "}
          <a
            href="docs/architecture.md"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            Deployment guide
          </a>
        </div>
      )}

      {onMainnet && (
        <div
          role="alert"
          aria-label="Mainnet warning"
          style={{
            background: "var(--badge-red-bg)",
            color: "var(--badge-red-text)",
            border: "1px solid var(--badge-red-text)",
            borderRadius: "0.5rem",
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
            fontWeight: 600,
          }}
        >
          ⚠ You are connected to Stellar <strong>mainnet</strong>. All actions submit real
          transactions and may incur on-chain fees.
        </div>
      )}

      {notification && !notification.dismissed && (
        <div
          role="alert"
          style={{
            background: "var(--warning-bg, #fff3cd)",
            color: "var(--warning-text, #856404)",
            border: "1px solid var(--warning-border, #ffc107)",
            borderRadius: "0.5rem",
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "0.9rem",
          }}
        >
          <span>
            ⚠ {notification.count} credential{notification.count > 1 ? "s" : ""}{" "}
            expiring within 7 days
          </span>
          <button
            onClick={dismiss}
            aria-label="Dismiss notification"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "1rem",
              color: "inherit",
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${tab === "identity" ? "active" : ""}`}
          onClick={() => setTab("identity")}
        >
          {t("tabs.identity")}
        </button>
        <button
          className={`tab ${tab === "credentials" ? "active" : ""}`}
          onClick={() => setTab("credentials")}
        >
          {t("tabs.credentials")}
        </button>
      </div>

      <ErrorBoundary>
        {tab === "identity" && <IdentityPanel />}
        {tab === "credentials" && (
          <CredentialsPanel verifyId={verifyId} />
        )}
      </ErrorBoundary>
    </div>
  );
}
