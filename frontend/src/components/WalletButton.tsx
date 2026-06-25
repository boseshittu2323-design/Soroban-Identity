import { useState } from "react";
import type { WalletType } from "../hooks/useWallet";
import { useWalletContext } from "../context/WalletContext";

export default function WalletButton() {
  const { connected, publicKey, connecting, txLoading, error, walletType, connect, disconnect } = useWalletContext();
  const [showPicker, setShowPicker] = useState(false);

  const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

  const handleSelect = (type: WalletType) => {
    setShowPicker(false);
    connect(type);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.25rem", position: "relative" }}>
      {connected && publicKey ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            via {walletType === "walletconnect" ? "WalletConnect" : "Freighter"}
          </span>
          <span className="badge badge-green" title={publicKey} style={{ cursor: "pointer" }}>
            {short(publicKey)}
          </span>
          <button
            onClick={disconnect}
            disabled={txLoading}
            style={{ background: "transparent", border: "1px solid var(--border-input)", color: "var(--text-muted)", padding: "0.3rem 0.7rem" }}
          >
            {txLoading ? (
              <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span className="spinner" aria-hidden="true" /> Transaction pending…
              </span>
            ) : "Disconnect"}
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={() => setShowPicker((v) => !v)}
            disabled={connecting}
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>

          {showPicker && (
            <div style={{
              position: "absolute",
              top: "calc(100% + 0.5rem)",
              right: 0,
              background: "var(--dropdown-bg)",
              border: "1px solid var(--border-input)",
              borderRadius: "0.5rem",
              padding: "0.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
              minWidth: "180px",
              zIndex: 10,
            }}>
              <button
                onClick={() => handleSelect("freighter")}
                style={{ justifyContent: "flex-start", gap: "0.5rem", display: "flex", alignItems: "center" }}
              >
                🪐 Freighter
              </button>
              <button
                onClick={() => handleSelect("walletconnect")}
                style={{ justifyContent: "flex-start", gap: "0.5rem", display: "flex", alignItems: "center" }}
              >
                🔗 WalletConnect
              </button>
            </div>
          )}
        </>
      )}

      {error && (
        <span style={{ fontSize: "0.75rem", color: "var(--error-text)" }}>
          {(() => {
            const msg = error instanceof Error ? error.message : typeof error === "string" && error ? error : "Wallet connection failed. Please try again.";
            return msg.toLowerCase().includes("freighter not found") ? (
              <>Freighter not installed.{" "}
                <a href="https://freighter.app" target="_blank" rel="noopener noreferrer"
                  style={{ color: "var(--accent-light)", textDecoration: "underline" }}>
                  Install it here
                </a>
              </>
            ) : msg;
          })()}
        </span>
      )}
    </div>
  );
}
