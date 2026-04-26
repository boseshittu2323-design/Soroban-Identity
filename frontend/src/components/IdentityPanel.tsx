import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { WalletState } from '../hooks/useWallet';
import type { ReputationRecord } from '../../../sdk/src/reputation';
import type { ScoreHistoryEntry } from '../../../sdk/src/reputation';
import SkeletonCard from './SkeletonCard';
import ReputationChart from './ReputationChart';

interface Props {
  wallet: WalletState & {
    connect: () => void;
    signTransaction: (xdr: string) => Promise<string>;
  };
}

type NetworkError = {
  type: "network";
  message: string;
};

type ContractError = {
  type: "contract";
  message: string;
};

type ErrorState = NetworkError | ContractError | null;

export default function IdentityPanel({ wallet }: Props) {
  const [resolveAddress, setResolveAddress] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const { history, addAddress, clearHistory } = useAddressHistory();
  const [resolveResult, setResolveResult] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [networkError, setNetworkError] = useState<ErrorState>(null);
  const [reputation, setReputation] = useState<ReputationRecord | null>(null);
  const [reputationLoading, setReputationLoading] = useState(false);
  const [scoreHistory, setScoreHistory] = useState<ScoreHistoryEntry[]>([]);

  const [createResult, setCreateResult] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [updateMetadata, setUpdateMetadata] = useState('');
  const [updating, setUpdating] = useState(false);
  const [updateSuccess, setUpdateSuccess] = useState(false);

  const [minScore, setMinScore] = useState("50");
  const [minReporters, setMinReporters] = useState("2");
  const [sybilResult, setSybilResult] = useState<boolean | null>(null);
  const [checkingsSybil, setCheckingSybil] = useState(false);

  // resolveAddress is considered "loaded" once a resolve has succeeded
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [resolvedDoc, setResolvedDoc] = useState<object | null>(null);
  const [copied, setCopied] = useState(false);

  const isNetworkError = (error: unknown): boolean => {
    if (error instanceof TypeError) {
      return error.message.includes("fetch") || error.message.includes("network");
    }
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes("ECONNREFUSED") || msg.includes("unreachable") || msg.includes("timeout");
  };

  const handleResolve = async () => {
    if (!resolveAddress.trim()) return;
    addAddress(resolveAddress);
    setResolving(true);
    setResolveResult(null);
    setReputation(null);
    setSybilResult(null);
    setScoreHistory([]);
    setNetworkError(null);
    try {
      // TODO: wire IdentityClient.resolveDid() from SDK
      await new Promise((r) => setTimeout(r, 800));
      const mock = {
        id: `did:stellar:${resolveAddress}`,
        controller: resolveAddress,
        metadata: {},
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        active: true,
      };
      setResolveResult(JSON.stringify(mock, null, 2));
      setResolvedDoc(mock);

      // Fetch reputation alongside DID resolution
      setReputationLoading(true);
      try {
        // TODO: wire ReputationClient.getReputation() from SDK
        await new Promise((r) => setTimeout(r, 600));
        const mockRep: ReputationRecord = {
          subject: resolveAddress,
          score: 42,
          reporterCount: 3,
          updatedAt: Math.floor(Date.now() / 1000),
        };
        setReputation(mockRep);

        // TODO: wire ReputationClient.getScoreHistory() from SDK
        const now = Math.floor(Date.now() / 1000);
        const mockHistory: ScoreHistoryEntry[] = [
          { reporter: resolveAddress, delta: 10, reason: "KYC verified", submittedAt: now - 30 * 86400 },
          { reporter: resolveAddress, delta: -5, reason: "Dispute", submittedAt: now - 20 * 86400 },
          { reporter: resolveAddress, delta: 20, reason: "Achievement", submittedAt: now - 10 * 86400 },
          { reporter: resolveAddress, delta: 17, reason: "Referral", submittedAt: now - 3 * 86400 },
        ];
        setScoreHistory(mockHistory);
      } catch (repError: unknown) {
        if (isNetworkError(repError)) {
          setNetworkError({
            type: "network",
            message: "Unable to reach the Soroban network. Please try again later.",
          });
        }
        setReputation(null);
      } finally {
        setReputationLoading(false);
      }
      setResolvedAddress(resolveAddress.trim());
    } catch (e: unknown) {
      if (isNetworkError(e)) {
        setNetworkError({
          type: "network",
          message: "Unable to reach the Soroban network. Please try again later.",
        });
      } else {
        setNetworkError({
          type: "contract",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      setResolveResult(null);
      setResolvedAddress(null);
      setResolvedDoc(null);
    } finally {
      setResolving(false);
    }
  };

  const handleExportDid = () => {
    if (!resolvedDoc) return;
    const blob = new Blob([JSON.stringify(resolvedDoc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'did-document.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyDid = async () => {
    if (!resolvedAddress) return;
    const did = `did:stellar:${resolvedAddress}`;
    
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(did);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        // Fallback for browsers without clipboard API
        const textarea = document.createElement('textarea');
        textarea.value = did;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      console.error('Failed to copy DID:', err);
    }
  };

  const handleCreate = async () => {
    if (!wallet.connected || !wallet.publicKey) return;
    setCreating(true);
    setCreateResult(null);
    try {
      // TODO: build tx via IdentityClient, sign via wallet.signTransaction(), submit
      await new Promise((r) => setTimeout(r, 1000));
      const mockFee = 100;
      setCreateResult(
        `DID created: did:stellar:${wallet.publicKey}\nEstimated fee: ${mockFee} stroops (${(mockFee / 10_000_000).toFixed(7)} XLM)`
      );
    } catch (e: unknown) {
      setCreateResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async () => {
    if (!wallet.connected || !wallet.publicKey) return;
    setUpdating(true);
    setUpdateSuccess(false);
    try {
      // TODO: build update_did tx via IdentityClient, sign + submit
      await new Promise((r) => setTimeout(r, 1000));
      // Re-fetch DID after successful update
      setResolving(true);
      setResolveResult(null);
      await new Promise((r) => setTimeout(r, 800));
      const updated = {
        id: `did:stellar:${wallet.publicKey}`,
        controller: wallet.publicKey,
        metadata: updateMetadata ? JSON.parse(updateMetadata) : {},
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        active: true,
      };
      setResolveResult(JSON.stringify(updated, null, 2));
      setResolvedAddress(wallet.publicKey);
      setUpdateSuccess(true);
      setTimeout(() => setUpdateSuccess(false), 3000);
    } catch (e: unknown) {
      setCreateResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdating(false);
      setResolving(false);
    }
  };

  const handleSybilCheck = async () => {
    if (!resolvedAddress) return;
    setCheckingSybil(true);
    setSybilResult(null);
    try {
      // TODO: wire ReputationClient.passesSybilCheck() from SDK
      await new Promise((r) => setTimeout(r, 800));
      // Mock: passes if minScore <= 100 and minReporters <= 5
      const passes = Number(minScore) <= 100 && Number(minReporters) <= 5;
      setSybilResult(passes);
    } catch (e: unknown) {
      setSybilResult(null);
    } finally {
      setCheckingSybil(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Resolve DID</h2>
        {networkError && (
          <div
            role="alert"
            style={{
              background: networkError.type === "network" ? "var(--error-bg, #f8d7da)" : "var(--warning-bg, #fff3cd)",
              color: networkError.type === "network" ? "var(--error-text, #721c24)" : "var(--warning-text, #856404)",
              border: `1px solid ${networkError.type === "network" ? "var(--error-border, #f5c6cb)" : "var(--warning-border, #ffc107)"}`,
              borderRadius: "0.5rem",
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "0.9rem",
            }}
          >
            <span>
              {networkError.type === "network" ? "🌐 " : "⚠ "}
              {networkError.message}
            </span>
            <button
              onClick={() => {
                setNetworkError(null);
                handleResolve();
              }}
              style={{
                marginLeft: "1rem",
                padding: "0.3rem 0.75rem",
                fontSize: "0.85rem",
                background: networkError.type === "network" ? "var(--error)" : "var(--warning)",
                color: "white",
                border: "none",
                borderRadius: "0.25rem",
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          </div>
        )}
        <input
          placeholder="Stellar address (G…)"
          value={resolveAddress}
          onChange={(e) => setResolveAddress(e.target.value)}
        />
        <button onClick={handleResolve} disabled={resolving || !resolveAddress}>
          {resolving ? 'Resolving…' : 'Resolve'}
        </button>
        {resolving && <SkeletonCard rows={4} />}
        {!resolving && resolveResult && (
          <>
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.5rem', 
              marginTop: '0.75rem',
              padding: '0.75rem',
              background: 'var(--card-bg-accent)',
              borderRadius: '0.5rem',
              border: '1px solid var(--card-border-accent)'
            }}>
              <div style={{ flex: 1, wordBreak: 'break-all', fontSize: '0.9rem', color: 'var(--accent-light)' }}>
                <strong>DID:</strong> did:stellar:{resolvedAddress}
              </div>
              <button
                onClick={handleCopyDid}
                style={{
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.85rem',
                  minWidth: '80px',
                  background: copied ? 'var(--sybil-pass-bg)' : 'var(--button-bg)',
                  color: copied ? 'var(--sybil-pass-text)' : 'var(--button-text)',
                  border: copied ? '1px solid var(--sybil-pass-border)' : '1px solid var(--button-border)',
                }}
                title="Copy DID to clipboard"
              >
                {copied ? '✓ Copied!' : '📋 Copy'}
              </button>
            </div>
            <pre className="result">{resolveResult}</pre>
          </>
        )}

        {resolvedAddress && (
          <div style={{ marginTop: '0.75rem' }}>
            <button
              onClick={() => setShowQr((v) => !v)}
              onKeyDown={(e) => { if (e.key === 'Escape') setShowQr(false); }}
              aria-expanded={showQr}
            >
              {showQr ? 'Hide QR Code' : 'Show QR Code'}
            </button>
            <button
              onClick={handleExportDid}
              disabled={!resolvedDoc}
              style={{ marginLeft: '0.5rem' }}
            >
              Export JSON
            </button>
            {showQr && (
              <div style={{ marginTop: '0.75rem', display: 'inline-block', background: '#fff', padding: '0.5rem', borderRadius: '0.5rem' }}>
                <QRCodeSVG value={`did:stellar:${resolvedAddress}`} size={180} level="M" />
              </div>
            )}
          </div>
        )}

        {reputationLoading && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '1rem' }}>
            Loading reputation…
          </p>
        )}

        {!reputationLoading && reputation && (
          <div
            className="card"
            style={{ marginTop: '1rem', background: 'var(--card-bg-accent)', border: '1px solid var(--card-border-accent)' }}
          >
            <h3 style={{ marginBottom: '0.5rem', color: 'var(--accent-light)' }}>Reputation</h3>
            <p>Score: {reputation.score}</p>
            <p>Reporters: {reputation.reporterCount}</p>
            <p>
              Last updated:{' '}
              {new Date(reputation.updatedAt * 1000).toLocaleDateString()}
            </p>
            <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Score History
            </h4>
            <ReputationChart history={scoreHistory} />
          </div>
        )}

        {!reputationLoading && resolveResult && !reputation && (
          <div
            className="card"
            style={{ marginTop: '1rem', background: 'var(--card-bg-accent)', border: '1px solid var(--border-input)' }}
          >
            <h3 style={{ marginBottom: '0.5rem', color: 'var(--text-muted)' }}>Reputation</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No reputation record found for this address.
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Anti-Sybil Check</h2>
        {resolvedAddress ? (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>
              Checking{' '}
              <span style={{ color: 'var(--accent-light)' }}>
                {resolvedAddress.slice(0, 6)}…{resolvedAddress.slice(-4)}
              </span>
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                  Min Score
                </label>
                <input
                  type="number"
                  min={0}
                  value={minScore}
                  onChange={(e) => setMinScore(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                  Min Reporters
                </label>
                <input
                  type="number"
                  min={1}
                  value={minReporters}
                  onChange={(e) => setMinReporters(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            <button onClick={handleSybilCheck} disabled={checkingsSybil}>
              {checkingsSybil ? 'Checking…' : 'Run Sybil Check'}
            </button>
            {sybilResult !== null && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '0.6rem 1rem',
                  borderRadius: '0.5rem',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  background: `var(${sybilResult ? '--sybil-pass-bg' : '--sybil-fail-bg'})`,
                  color: `var(${sybilResult ? '--sybil-pass-text' : '--sybil-fail-text'})`,
                  border: `1px solid var(${sybilResult ? '--sybil-pass-border' : '--sybil-fail-border'})`,
                }}
              >
                {sybilResult ? '✓ Passes sybil check' : '✗ Fails sybil check'}
              </div>
            )}
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Resolve a DID above to run the anti-sybil check.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Create DID</h2>
        {wallet.connected && wallet.publicKey ? (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>
              Connected as{' '}
              <span style={{ color: 'var(--accent-light)' }}>
                {wallet.publicKey.slice(0, 6)}…{wallet.publicKey.slice(-4)}
              </span>
            </p>
            <button onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating…' : 'Create DID'}
            </button>
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Connect your Freighter wallet to create a new on-chain DID.
          </p>
        )}
        {createResult && <pre className="result">{createResult}</pre>}
      </div>

      <div className="card">
        <h2>Update DID</h2>
        {wallet.connected && wallet.publicKey ? (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>
              Updating{' '}
              <span style={{ color: 'var(--accent-light)' }}>
                did:stellar:{wallet.publicKey.slice(0, 6)}…{wallet.publicKey.slice(-4)}
              </span>
            </p>
            <textarea
              placeholder='New metadata (JSON, e.g. {"name":"Alice"})'
              value={updateMetadata}
              onChange={(e) => setUpdateMetadata(e.target.value)}
              rows={3}
            />
            <button onClick={handleUpdate} disabled={updating}>
              {updating ? 'Updating…' : 'Update DID'}
            </button>
            {updateSuccess && (
              <div style={{
                marginTop: '0.75rem',
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                background: 'var(--sybil-pass-bg)',
                color: 'var(--sybil-pass-text)',
                border: '1px solid var(--sybil-pass-border)',
                fontSize: '0.9rem',
                fontWeight: 600,
              }}>
                ✓ DID updated successfully
              </div>
            )}
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Connect your wallet to update your DID metadata.
          </p>
        )}
      </div>
    </>
  );
}
