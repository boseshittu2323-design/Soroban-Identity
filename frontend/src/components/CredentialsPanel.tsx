import { useState, useEffect, useReducer } from "react";
import { StrKey, SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal, Contract, scValToNative } from '@stellar/stellar-sdk';
import type { CredentialType, Credential, VerifyResult } from "../../../sdk/src/types";
import { CredentialClient } from '../../../sdk/src';
import { validateStellarAddress } from "../../../sdk/src/utils";
import { getNetworkConfig } from '../network';
import SkeletonCard from "./SkeletonCard";
import { formatTimestamp } from "../utils/formatDate";
import { useWalletContext } from "../context/WalletContext";

type VerifyState =
  | "idle"
  | "valid"
  | "not_found"
  | "revoked"
  | "expired"
  | "invalid";

type FilterType = "All" | CredentialType;
type CredentialStatus = "active" | "expired" | "revoked";
type Credential = {
  id: string;
  credentialType: CredentialType;
  subject: string;
  issuer: string;
  claims: Record<string, string>;
  claimsHash: string;
  signature: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
};

function formatExpiry(expiresAt: number): string {
  if (expiresAt === 0) return "No expiry";

  const now = Date.now();
  const expiryMs = expiresAt * 1000;
  const diffMs = expiryMs - now;
  const diffDays = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
  const diffMinutes = Math.floor(Math.abs(diffMs) / (1000 * 60));

  if (diffMs < 0) {
    if (diffDays > 0) return `Expired ${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    if (diffHours > 0) return `Expired ${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    return `Expired ${diffMinutes} min${diffMinutes > 1 ? "s" : ""} ago`;
  }

  if (diffDays > 0) return `Expires in ${diffDays} day${diffDays > 1 ? "s" : ""}`;
  if (diffHours > 0) return `Expires in ${diffHours} hour${diffHours > 1 ? "s" : ""}`;
  return `Expires in ${diffMinutes} min${diffMinutes > 1 ? "s" : ""}`;
}

function getExpiryStyle(expiresAt: number): React.CSSProperties {
  if (expiresAt === 0) return { color: "var(--text-muted)" };

  const now = Date.now();
  const expiryMs = expiresAt * 1000;
  const diffMs = expiryMs - now;
  const diffDays = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    return { color: "var(--error)", fontWeight: 600 };
  }
  if (diffDays <= 7) {
    return { color: "var(--warning)", fontWeight: 600 };
  }
  return { color: "var(--text-muted)" };
}

function isExpired(expiresAt: number): boolean {
  return expiresAt > 0 && Date.now() / 1000 > expiresAt;
}

function getCredentialStatus(credential: Credential): CredentialStatus {
  if (credential.revoked) return "revoked";
  if (isExpired(credential.expiresAt)) return "expired";
  return "active";
}

function getStatusBadgeClass(status: CredentialStatus): string {
  if (status === "revoked") return "badge badge-red";
  if (status === "expired") return "badge badge-gray";
  return "badge badge-green";
}

function getStatusLabel(status: CredentialStatus): string {
  if (status === "revoked") return "Revoked";
  if (status === "expired") return "Expired";
  return "Active";
}

function getStatusSortRank(credential: Credential): number {
  const status = getCredentialStatus(credential);
  if (status === "active") return 0;
  if (status === "expired") return 1;
  return 2;
}

// Mock credentials for demonstration — replace with SDK data when wired
const MOCK_CREDENTIALS: Credential[] = [
  { id: "abc001", credentialType: "Kyc", subject: "GABC…", issuer: "GISSUER", claims: { name: "John Doe", country: "US" }, claimsHash: "hash1", signature: "sig1", issuedAt: Math.floor(Date.now() / 1000) - 1000, expiresAt: 0, revoked: false },
  { id: "abc002", credentialType: "Kyc", subject: "GABC…", issuer: "GISSUER", claims: { verified: "true" }, claimsHash: "hash2", signature: "sig2", issuedAt: Math.floor(Date.now() / 1000) - 1000, expiresAt: Math.floor((Date.now() + 12 * 24 * 60 * 60 * 1000) / 1000), revoked: false },
  { id: "abc003", credentialType: "Reputation", subject: "GABC…", issuer: "GISSUER", claims: { score: "850", level: "gold" }, claimsHash: "hash3", signature: "sig3", issuedAt: Math.floor(Date.now() / 1000) - 1000, expiresAt: Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000), revoked: false },
  { id: "abc004", credentialType: "Achievement", subject: "GABC…", issuer: "GISSUER", claims: {}, claimsHash: "hash4", signature: "sig4", issuedAt: Math.floor(Date.now() / 1000) - 1000, expiresAt: Math.floor((Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000), revoked: false },
  { id: "abc005", credentialType: "Custom", subject: "GABC…", issuer: "GISSUER", claims: { custom_field: "custom_value" }, claimsHash: "hash5", signature: "sig5", issuedAt: Math.floor(Date.now() / 1000) - 1000, expiresAt: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000), revoked: true },
  { id: "abc006", credentialType: "Kyc", subject: "GABC…", issuer: "GISSUER", claims: { reason: "compromised" }, claimsHash: "hash6", signature: "sig6", issuedAt: Math.floor(Date.now() / 1000) - 2000, expiresAt: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000), revoked: true },
];

const FILTER_OPTIONS: FilterType[] = ["All", "Kyc", "Reputation", "Achievement", "Custom"];

const CREDENTIAL_TYPE_ICONS: Record<CredentialType, string> = {
  Kyc: "🆔",
  Reputation: "⭐",
  Achievement: "🏆",
  Custom: "📋",
};

function countByType(creds: Credential[], type: FilterType): number {
  if (type === "All") return creds.length;
  return creds.filter((c) => c.credentialType === type).length;
}

type CredentialState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; credentials: Credential[]; searchedAddress: string }
  | { status: 'error'; message: string };

type CredentialAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; credentials: Credential[]; searchedAddress: string }
  | { type: 'FETCH_ERROR'; message: string }
  | { type: 'RESET' };

function credentialReducer(_state: CredentialState, action: CredentialAction): CredentialState {
  switch (action.type) {
    case 'FETCH_START': return { status: 'loading' };
    case 'FETCH_SUCCESS': return { status: 'success', credentials: action.credentials, searchedAddress: action.searchedAddress };
    case 'FETCH_ERROR': return { status: 'error', message: action.message };
    case 'RESET': return { status: 'idle' };
  }
}

export default function CredentialsPanel({ verifyId }: { verifyId?: string | null }) {
  const wallet = useWalletContext();
  const [credentialState, dispatchCredential] = useReducer(credentialReducer, { status: 'idle' });

  const fetchedCredentials = credentialState.status === 'success' ? credentialState.credentials : null;
  const fetching = credentialState.status === 'loading';
  const searchedAddress = credentialState.status === 'success' ? credentialState.searchedAddress : null;

  const [credId, setCredId] = useState("");
  const [verifyState, setVerifyState] = useState<VerifyState>("idle");
  const [verifying, setVerifying] = useState(false);
  const [expandedCredId, setExpandedCredId] = useState<string | null>(null);

  const [subject, setSubject] = useState("");
  const [claims, setClaims] = useState<Array<{ key: string; value: string }>>([{ key: "", value: "" }]);
  const [expiresAt, setExpiresAt] = useState("0");
  const [issueResult, setIssueResult] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueErrors, setIssueErrors] = useState<Record<string, string>>({});

  const [activeFilter, setActiveFilter] = useState<FilterType>("All");
  const [isIssuer, setIsIssuer] = useState(false);
  const [checkingIssuer, setCheckingIssuer] = useState(false);

  const [searchAddress, setSearchAddress] = useState("");

  const handleVerify = async () => {
    if (!credId.trim()) return;
    setVerifying(true);
    setVerifyState("idle");
    try {
      const networkConfig = getNetworkConfig();
      const credentialClient = new CredentialClient(networkConfig);
      const caller = wallet.publicKey || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
      const result = await credentialClient.verifyCredential(caller, credId.trim());
      setVerifyState(result.valid ? "valid" : result.reason || "invalid");
    } catch {
      setVerifyState("invalid");
    } finally {
      setVerifying(false);
    }
  };

  // Check if connected wallet is a registered issuer
  useEffect(() => {
    if (!wallet.connected || !wallet.publicKey) {
      setIsIssuer(false);
      return;
    }

    const checkIssuerStatus = async () => {
      setCheckingIssuer(true);
      try {
        // TODO: wire CredentialClient.isIssuer() from SDK
        // For now, mock the check
        await new Promise((r) => setTimeout(r, 300));
        // Mock: assume addresses starting with specific pattern are issuers
        setIsIssuer(wallet.publicKey?.startsWith("G") ?? false);
      } catch {
        setIsIssuer(false);
      } finally {
        setCheckingIssuer(false);
      }
    };

    checkIssuerStatus();
  }, [wallet.connected, wallet.publicKey]);

  // Handle deep link verification
  useEffect(() => {
    if (verifyId) {
      setCredId(verifyId);
      // Trigger verification after a short delay to ensure state is set
      setTimeout(() => {
        handleVerify();
      }, 100);
    }
  }, [verifyId]);

  const handleSearch = async () => {
    const addr = searchAddress.trim();
    if (!addr) return;
    
    // Validate Stellar address format
    if (!StrKey.isValidEd25519PublicKey(addr)) {
      dispatchCredential({ 
        type: 'FETCH_ERROR', 
        message: 'Invalid Stellar address format. Address must start with "G" and be 56 characters long.'
      });
      return;
    }
    
    dispatchCredential({ type: 'FETCH_START' });
    try {
      const networkConfig = getNetworkConfig();
      const credentialClient = new CredentialClient(networkConfig);
      const caller = wallet.publicKey || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
      const results = await credentialClient.getCredentialsBySubject(caller, addr);
      dispatchCredential({ type: 'FETCH_SUCCESS', credentials: results, searchedAddress: addr });
    } catch (e: unknown) {
      dispatchCredential({ type: 'FETCH_ERROR', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const validateIssueForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Validate subject address
    if (!subject.trim()) {
      errors.subject = "Subject address is required";
    } else if (!StrKey.isValidEd25519PublicKey(subject.trim())) {
      errors.subject = "Invalid Stellar address format. Address must start with 'G' and be 56 characters long.";
    }

    // Validate at least one claim
    const filledClaims = claims.filter((c) => c.key.trim() || c.value.trim());
    if (filledClaims.length === 0) {
      errors.claims = "At least one claim key-value pair is required";
    }

    // Validate expiry date
    const expiryNum = parseInt(expiresAt, 10);
    if (isNaN(expiryNum) || expiryNum < 0) {
      errors.expiresAt = "Expiry must be 0 or a positive number";
    } else if (expiryNum > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (expiryNum <= now) {
        errors.expiresAt = "Expiry date must be in the future";
      }
    }

    setIssueErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleAddClaim = () => {
    setClaims([...claims, { key: "", value: "" }]);
  };

  const handleRemoveClaim = (index: number) => {
    setClaims(claims.filter((_, i) => i !== index));
  };

  const handleClaimChange = (index: number, field: "key" | "value", value: string) => {
    const updated = [...claims];
    updated[index][field] = value;
    setClaims(updated);
  };

  const displayCredentials = fetchedCredentials ?? MOCK_CREDENTIALS;

  const filteredCredentials =
    activeFilter === "All"
      ? displayCredentials
      : displayCredentials.filter((c) => c.credentialType === activeFilter);

  const sortedCredentials = [...filteredCredentials].sort(
    (a, b) => getStatusSortRank(a) - getStatusSortRank(b)
  );

  const handleIssue = async () => {
    if (!wallet.connected) return;
    
    if (!validateIssueForm()) return;

    setIssuing(true);
    setIssueResult(null);
    try {
      const networkConfig = getNetworkConfig();
      const server = new SorobanRpc.Server(typeof networkConfig.rpcUrl === 'string' ? networkConfig.rpcUrl : networkConfig.rpcUrl[0]);
      const contract = new Contract(networkConfig.credentialManagerId);
      const account = await server.getAccount(wallet.publicKey);
      
      const claimsMap = claims.reduce((acc, { key, value }) => {
        if (key.trim() && value.trim()) acc[key.trim()] = value.trim();
        return acc;
      }, {} as Record<string, string>);
      
      const claimsHashHex = "0000000000000000000000000000000000000000000000000000000000000000";
      const sigHex = Buffer.alloc(64, 0).toString("hex");

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkConfig.networkPassphrase,
      })
        .addOperation(
          contract.call(
            "issue_credential",
            nativeToScVal(wallet.publicKey, { type: "address" }),
            nativeToScVal(subject.trim(), { type: "address" }),
            nativeToScVal("Kyc", { type: "symbol" }),
            nativeToScVal(claimsMap, { type: "map" }),
            nativeToScVal(Buffer.from(claimsHashHex, "hex"), { type: "bytes" }),
            nativeToScVal(Buffer.from(sigHex, "hex"), { type: "bytes" }),
            nativeToScVal(parseInt(expiresAt || "0", 10), { type: "u64" })
          )
        )
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(tx);
      const estimatedFee = parseInt(prepared.fee, 10);
      const signedXdr = await wallet.signTransaction(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, networkConfig.networkPassphrase);
      const result = await server.sendTransaction(signedTx as any);
      
      if (result.status !== "PENDING") throw new Error(`Transaction failed: ${result.status}`);
      
      let txStatus = await server.getTransaction(result.hash);
      while (txStatus.status === "NOT_FOUND") {
        await new Promise(r => setTimeout(r, 2000));
        txStatus = await server.getTransaction(result.hash);
      }
      if (txStatus.status === "FAILED") throw new Error("Transaction failed on-chain");
      
      const raw = scValToNative((txStatus as any).returnValue) as Uint8Array;
      const mockId = Buffer.from(raw).toString("hex");
      
      setIssueResult(`Credential issued successfully!\nID: ${mockId}\nEstimated fee: ${(estimatedFee / 10_000_000).toFixed(7)} XLM`);
    } catch (e: unknown) {
      setIssueResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIssuing(false);
    }
  };

  return (
    <>
      {/* Filter bar */}
      <div className="card">
        <h2>Credentials</h2>

        {/* Subject search */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input
            placeholder="Search by subject address (G…)"
            value={searchAddress}
            onChange={(e) => setSearchAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1 }}
          />
          <button onClick={handleSearch} disabled={fetching || !searchAddress.trim()}>
            {fetching ? "Searching…" : "Search"}
          </button>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {FILTER_OPTIONS.map((type) => {
            const count = countByType(displayCredentials, type);
            const isActive = activeFilter === type;
            return (
              <button
                key={type}
                onClick={() => setActiveFilter(type)}
                style={{
                  padding: "0.3rem 0.75rem",
                  borderRadius: "999px",
                  border: isActive ? "2px solid var(--accent-light)" : "2px solid var(--border-input)",
                  background: isActive ? "var(--card-bg-accent)" : "transparent",
                  color: isActive ? "var(--accent-light)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  fontWeight: isActive ? 600 : 400,
                }}
                aria-pressed={isActive}
              >
                {type}{" "}
                <span
                  style={{
                    background: isActive ? "var(--filter-badge-active-bg)" : "var(--border-input)",
                    color: isActive ? "var(--filter-badge-active-text)" : "var(--text-muted)",
                    borderRadius: "999px",
                    padding: "0 0.4rem",
                    fontSize: "0.75rem",
                    marginLeft: "0.25rem",
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {fetching ? (
          <SkeletonCard rows={3} />
        ) : fetchedCredentials !== null && fetchedCredentials.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem 1rem", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🪪</div>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              No credentials found for this address.
            </p>
          </div>
        ) : filteredCredentials.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No {activeFilter} credentials found.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {sortedCredentials.map((cred) => {
              const status = getCredentialStatus(cred);
              return (
              <li
                key={cred.id}
                style={{
                  background: "var(--cred-item-bg)",
                  borderRadius: "0.5rem",
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  aria-expanded={expandedCredId === cred.id}
                  style={{
                    padding: "0.6rem 1rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    width: "100%",
                    fontSize: "0.85rem",
                    color: "var(--text)",
                    gap: "1rem",
                    cursor: "pointer",
                    background: "var(--cred-item-bg)",
                    border: 0,
                    borderRadius: 0,
                    textAlign: "left",
                  }}
                  onClick={() => setExpandedCredId(expandedCredId === cred.id ? null : cred.id)}
                >
                  <span style={{ fontSize: "1.2rem", minWidth: "1.5rem" }}>
                    {CREDENTIAL_TYPE_ICONS[cred.credentialType] || "📋"}
                  </span>
                  <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>{cred.id}</span>
                  <span className="badge badge-green">{cred.credentialType}</span>
                  <span
                    className={getStatusBadgeClass(status)}
                    aria-label={`Credential status: ${getStatusLabel(status)}`}
                  >
                    {getStatusLabel(status)}
                  </span>
                  <span style={getExpiryStyle(cred.expiresAt)}>{formatExpiry(cred.expiresAt)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const url = new URL(window.location.href);
                      url.searchParams.set('verify', cred.id);
                      navigator.clipboard.writeText(url.toString()).then(() => {
                        alert('Share link copied to clipboard!');
                      }).catch(() => {
                        alert('Failed to copy link');
                      });
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontSize: "1rem",
                      color: "var(--accent-light)",
                      marginLeft: "auto",
                      marginRight: "0.5rem",
                    }}
                    title="Copy share link"
                  >
                    🔗
                  </button>
                  <span style={{ fontSize: "1rem" }}>
                    {expandedCredId === cred.id ? "▼" : "▶"}
                  </span>
                </button>
                {expandedCredId === cred.id && (
                  <div style={{ padding: "0.75rem 1rem", borderTop: "1px solid var(--border-input)", background: "var(--card-bg-accent)" }}>
                    <dl style={{ margin: "0 0 0.75rem", fontSize: "0.8rem" }}>
                      <div style={{ display: "flex", gap: "1rem", marginBottom: "0.25rem" }}>
                        <dt style={{ fontWeight: 600, color: "var(--text-muted)", minWidth: "120px" }}>Issued</dt>
                        <dd style={{ margin: 0, color: "var(--text-muted)" }}>{formatTimestamp(cred.issuedAt)}</dd>
                      </div>
                      <div style={{ display: "flex", gap: "1rem", marginBottom: "0.5rem" }}>
                        <dt style={{ fontWeight: 600, color: "var(--text-muted)", minWidth: "120px" }}>Expires</dt>
                        <dd style={{ margin: 0, ...getExpiryStyle(cred.expiresAt) }}>{formatTimestamp(cred.expiresAt)}</dd>
                      </div>
                    </dl>
                    {Object.keys(cred.claims).length > 0 ? (
                      <dl style={{ margin: 0, fontSize: "0.85rem" }}>
                        {Object.entries(cred.claims).map(([key, value]) => (
                          <div key={key} style={{ display: "flex", gap: "1rem", marginBottom: "0.5rem" }}>
                            <dt style={{ fontWeight: 600, color: "var(--text-muted)", minWidth: "120px" }}>{key}</dt>
                            <dd style={{ margin: 0, color: "var(--text)" }}>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.8rem" }}>No claims</p>
                    )}
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Verify Credential</h2>
        <input
          placeholder="Credential ID (hex)"
          value={credId}
          onChange={(e) => setCredId(e.target.value)}
        />
        <button onClick={handleVerify} disabled={verifying || !credId}>
          {verifying ? "Verifying…" : "Verify"}
        </button>
        {verifying && <SkeletonCard rows={2} />}
        {!verifying && verifyState !== "idle" && (
          <div style={{ marginTop: "1rem" }}>
            {verifyState === "valid" && (
              <span className="badge badge-green">Valid</span>
            )}
            {verifyState === "revoked" && (
              <span className="badge badge-red">Invalid — credential has been revoked</span>
            )}
            {verifyState === "expired" && (
              <span className="badge badge-red">Invalid — credential has expired</span>
            )}
            {verifyState === "not_found" && (
              <span className="badge badge-red">Invalid — credential not found</span>
            )}
            {(verifyState === "invalid" || verifyState === "unknown" as string) && (
              <span className="badge badge-red">Invalid</span>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Issue Credential</h2>
        {wallet.connected ? (
          isIssuer ? (
            <>
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "1rem" }}>
                Issuing as{" "}
                <span style={{ color: "var(--accent-light)" }}>
                  {wallet.publicKey?.slice(0, 6)}…{wallet.publicKey?.slice(-4)}
                </span>
              </p>
              
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Subject Address
                </label>
                <input
                  placeholder="Subject address (G…)"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  style={{
                    borderColor: issueErrors.subject ? "var(--error)" : undefined,
                  }}
                />
                {issueErrors.subject && (
                  <p style={{ color: "var(--error)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {issueErrors.subject}
                  </p>
                )}
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Claims
                </label>
                {claims.map((claim, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <input
                      placeholder="Key"
                      value={claim.key}
                      onChange={(e) => handleClaimChange(idx, "key", e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <input
                      placeholder="Value"
                      value={claim.value}
                      onChange={(e) => handleClaimChange(idx, "value", e.target.value)}
                      style={{ flex: 1 }}
                    />
                    {claims.length > 1 && (
                      <button
                        onClick={() => handleRemoveClaim(idx)}
                        style={{
                          padding: "0.5rem 0.75rem",
                          background: "var(--error)",
                          color: "white",
                          border: "none",
                          borderRadius: "0.25rem",
                          cursor: "pointer",
                          fontSize: "0.85rem",
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={handleAddClaim}
                  style={{
                    padding: "0.5rem 0.75rem",
                    background: "var(--accent-light)",
                    color: "white",
                    border: "none",
                    borderRadius: "0.25rem",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  + Add Claim
                </button>
                {issueErrors.claims && (
                  <p style={{ color: "var(--error)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {issueErrors.claims}
                  </p>
                )}
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Expires At (Unix timestamp, 0 for no expiry)
                </label>
                <input
                  type="number"
                  placeholder="0"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  style={{
                    borderColor: issueErrors.expiresAt ? "var(--error)" : undefined,
                  }}
                />
                {issueErrors.expiresAt && (
                  <p style={{ color: "var(--error)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {issueErrors.expiresAt}
                  </p>
                )}
              </div>

              <button onClick={handleIssue} disabled={issuing || Object.keys(issueErrors).length > 0}>
                {issuing ? "Issuing…" : "Issue KYC Credential"}
              </button>
            </>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {checkingIssuer ? "Checking issuer status…" : "Your wallet is not registered as an issuer. Contact the admin to register."}
            </p>
          )
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            Connect your Freighter wallet to issue credentials as a registered issuer.
          </p>
        )}
        {issueResult && <pre className="result">{issueResult}</pre>}
      </div>
    </>
  );
}
