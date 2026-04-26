import { useState, useEffect } from "react";
import type { CredentialType } from "../../../sdk/src/types";
import type { WalletState } from "../hooks/useWallet";
import { validateStellarAddress } from "../../../sdk/src/utils";
import SkeletonCard from "./SkeletonCard";

interface Props {
  wallet: WalletState & {
    connect: () => void;
    signTransaction: (xdr: string) => Promise<string>;
  };
}

type VerifyState =
  | "idle"
  | "valid"
  | "not_found"
  | "revoked"
  | "expired"
  | "invalid";

type FilterType = "All" | CredentialType;

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

// Mock credentials for demonstration — replace with SDK data when wired
const MOCK_CREDENTIALS = [
  { id: "abc001", credentialType: "Kyc" as CredentialType, subject: "GABC…", expiresAt: 0, claims: { name: "John Doe", country: "US" } },
  { id: "abc002", credentialType: "Kyc" as CredentialType, subject: "GABC…", expiresAt: Math.floor((Date.now() + 12 * 24 * 60 * 60 * 1000) / 1000), claims: { verified: "true" } },
  { id: "abc003", credentialType: "Reputation" as CredentialType, subject: "GABC…", expiresAt: Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000), claims: { score: "850", level: "gold" } },
  { id: "abc004", credentialType: "Achievement" as CredentialType, subject: "GABC…", expiresAt: Math.floor((Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000), claims: {} },
  { id: "abc005", credentialType: "Custom" as CredentialType, subject: "GABC…", expiresAt: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000), claims: { custom_field: "custom_value" } },
];

const FILTER_OPTIONS: FilterType[] = ["All", "Kyc", "Reputation", "Achievement", "Custom"];

const CREDENTIAL_TYPE_ICONS: Record<CredentialType, string> = {
  Kyc: "🆔",
  Reputation: "⭐",
  Achievement: "🏆",
  Custom: "📋",
};

function countByType(creds: typeof MOCK_CREDENTIALS, type: FilterType): number {
  if (type === "All") return creds.length;
  return creds.filter((c) => c.credentialType === type).length;
}

export default function CredentialsPanel({ wallet }: Props) {
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
  const [searchedAddress, setSearchedAddress] = useState<string | null>(null);
  const [fetchedCredentials, setFetchedCredentials] = useState<typeof MOCK_CREDENTIALS | null>(null);
  const [fetching, setFetching] = useState(false);

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

  const handleSearch = async () => {
    const addr = searchAddress.trim();
    if (!addr) return;
    setFetching(true);
    setFetchedCredentials(null);
    setSearchedAddress(addr);
    try {
      // TODO: wire CredentialClient.getCredentialsBySubject() from SDK
      await new Promise((r) => setTimeout(r, 600));
      // Mock: return credentials only for addresses that match existing mock subjects
      const results = MOCK_CREDENTIALS.filter((c) => c.subject === addr);
      setFetchedCredentials(results);
    } catch {
      setFetchedCredentials([]);
    } finally {
      setFetching(false);
    }
  };

  const validateIssueForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Validate subject address
    if (!subject.trim()) {
      errors.subject = "Subject address is required";
    } else {
      try {
        validateStellarAddress(subject);
      } catch {
        errors.subject = "Invalid Stellar address";
      }
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

  const handleVerify = async () => {
    if (!credId.trim()) return;
    setVerifying(true);
    setVerifyState("idle");
    try {
      // TODO: wire CredentialClient.verifyCredential() from SDK
      await new Promise((r) => setTimeout(r, 800));
      const mockResult = credId.startsWith("0")
        ? { valid: false as const, reason: "revoked" as const }
        : { valid: true as const };
      if (mockResult.valid) {
        setVerifyState("valid");
      } else {
        setVerifyState(mockResult.reason);
      }
    } catch {
      setVerifyState("invalid");
    } finally {
      setVerifying(false);
    }
  };

  const handleIssue = async () => {
    if (!wallet.connected) return;
    
    if (!validateIssueForm()) return;

    setIssuing(true);
    setIssueResult(null);
    try {
      // TODO: build tx via CredentialClient, sign via wallet.signTransaction(), submit
      await new Promise((r) => setTimeout(r, 1000));
      const mockId = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const mockFee = 100;
      setIssueResult(
        `Credential issued.\nID: ${mockId}\nEstimated fee: ${mockFee} stroops (${(mockFee / 10_000_000).toFixed(7)} XLM)`
      );
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
            {filteredCredentials.map((cred) => (
              <li
                key={cred.id}
                style={{
                  background: "var(--cred-item-bg)",
                  borderRadius: "0.5rem",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "0.6rem 1rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "0.85rem",
                    color: "var(--text)",
                    gap: "1rem",
                    cursor: "pointer",
                  }}
                  onClick={() => setExpandedCredId(expandedCredId === cred.id ? null : cred.id)}
                >
                  <span style={{ fontSize: "1.2rem", minWidth: "1.5rem" }}>
                    {CREDENTIAL_TYPE_ICONS[cred.credentialType] || "📋"}
                  </span>
                  <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>{cred.id}</span>
                  <span className="badge badge-green">{cred.credentialType}</span>
                  <span style={getExpiryStyle(cred.expiresAt)}>{formatExpiry(cred.expiresAt)}</span>
                  <span style={{ marginLeft: "auto", fontSize: "1rem" }}>
                    {expandedCredId === cred.id ? "▼" : "▶"}
                  </span>
                </div>
                {expandedCredId === cred.id && (
                  <div style={{ padding: "0.75rem 1rem", borderTop: "1px solid var(--border-input)", background: "var(--card-bg-accent)" }}>
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
            ))}
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
