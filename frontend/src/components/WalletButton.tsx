import { useWallet } from "../hooks/useWallet";
import { formatAddress } from "../utils/formatAddress";

export default function WalletButton() {
  const { publicKey, connected, connecting, error, connect, disconnect } =
    useWallet();

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.25rem" }}>
      {connected && publicKey ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="badge badge-green" title={publicKey}>{formatAddress(publicKey)}</span>
          <button
            onClick={disconnect}
            style={{ background: "transparent", border: "1px solid #334155", color: "#94a3b8", padding: "0.3rem 0.7rem" }}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button onClick={connect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect Freighter"}
        </button>
      )}
      {error && (
        <span style={{ fontSize: "0.75rem", color: "#fca5a5" }}>{error}</span>
      )}
    </div>
  );
}
