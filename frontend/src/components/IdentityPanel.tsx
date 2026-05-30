import { useState, useReducer } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { StrKey } from '@stellar/stellar-sdk';
import type { WalletState } from '../hooks/useWallet';
import type { ReputationRecord } from '../../../sdk/src/reputation';
import type { ScoreHistoryEntry } from '../../../sdk/src/reputation';
import type { DidDocument } from '../../../sdk/src/types';
import { useAddressHistory } from '../hooks/useAddressHistory';
import SkeletonCard from './SkeletonCard';
import ReputationChart from './ReputationChart';
import { formatTimestamp } from '../utils/formatDate';
import { useWalletContext } from '../context/WalletContext';
import { exportDidDocumentAsJsonLd } from '../../../sdk/src/serializers';

type IdentityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; did: DidDocument; reputation: ReputationRecord | null; scoreHistory: ScoreHistoryEntry[] }
  | { status: 'error'; message: string; errorType: 'network' | 'contract' };

type IdentityAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; did: DidDocument; reputation: ReputationRecord | null; scoreHistory: ScoreHistoryEntry[] }
  | { type: 'FETCH_ERROR'; message: string; errorType: 'network' | 'contract' }
  | { type: 'RESET' };

function identityReducer(_state: IdentityState, action: IdentityAction): IdentityState {
  switch (action.type) {
    case 'FETCH_START': return { status: 'loading' };
    case 'FETCH_SUCCESS': return { status: 'success', did: action.did, reputation: action.reputation, scoreHistory: action.scoreHistory };
    case 'FETCH_ERROR': return { status: 'error', message: action.message, errorType: action.errorType };
    case 'RESET': return { status: 'idle' };
  }
}

export default function IdentityPanel() {
  const wallet = useWalletContext();
  const [identityState, dispatch] = useReducer(identityReducer, { status: 'idle' });

  const resolveResult = identityState.status === 'success' ? JSON.stringify(identityState.did, null, 2) : null;
  const resolving = identityState.status === 'loading';
  const networkError = identityState.status === 'error'
    ? { type: identityState.errorType as 'network' | 'contract', message: identityState.message }
    : null;
  const reputation = identityState.status === 'success' ? identityState.reputation : null;
  const reputationLoading = identityState.status === 'loading';
  const scoreHistory = identityState.status === 'success' ? identityState.scoreHistory : [];
  const resolvedAddress = identityState.status === 'success' ? identityState.did.controller : null;
  const resolvedDoc = identityState.status === 'success' ? identityState.did : null;

  const [resolveAddress, setResolveAddress] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const { history, addAddress, clearHistory } = useAddressHistory();

  const [createResult, setCreateResult] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [metadataEntries, setMetadataEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateSuccess, setUpdateSuccess] = useState(false);

  const [minScore, setMinScore] = useState("50");
  const [minReporters, setMinReporters] = useState("2");
  const [sybilResult, setSybilResult] = useState<boolean | null>(null);
  const [checkingsSybil, setCheckingSybil] = useState(false);

  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  const isNetworkError = (error: unknown): boolean => {
    if (error instanceof TypeError) {
      return error.message.includes("fetch") || error.message.includes("network");
    }
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes("ECONNREFUSED") || msg.includes("unreachable") || msg.includes("timeout");
  };

  const handleResolve = async () => {
    const address = resolveAddress.trim();
    if (!address) return;
    
    // Validate Stellar address format
    if (!StrKey.isValidEd25519PublicKey(address)) {
      dispatch({ 
        type: 'FETCH_ERROR', 
        message: 'Invalid Stellar address format. Address must start with "G" and be 56 characters long.',
        errorType: 'contract'
      });
      return;
    }
    
    addAddress(address);
    dispatch({ type: 'FETCH_START' });
    setSybilResult(null);
    try {
      // TODO: wire IdentityClient.resolveDid() from SDK
      // const identity = new IdentityClient(networkConfig);
      await new Promise((r) => setTimeout(r, 800));
      const mock: DidDocument = {
        id: `did:stellar:${address}`,
        controller: address,
        metadata: {},
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        active: true,
      };

      let resolvedRep: ReputationRecord | null = null;
      let resolvedHistory: ScoreHistoryEntry[] = [];
      try {
        // TODO: wire ReputationClient.getReputation() from SDK
        await new Promise((r) => setTimeout(r, 600));
        resolvedRep = {
          subject: address,
          score: 42,
          reporterCount: 3,
          updatedAt: Math.floor(Date.now() / 1000),
        };
        // TODO: wire ReputationClient.getScoreHistory() from SDK
        const now = Math.floor(Date.now() / 1000);
        resolvedHistory = [
          { reporter: address, delta: 10, reason: "KYC verified", submittedAt: now - 30 * 86400 },
          { reporter: address, delta: -5, reason: "Dispute", submittedAt: now - 20 * 86400 },
          { reporter: address, delta: 20, reason: "Achievement", submittedAt: now - 10 * 86400 },
          { reporter: address, delta: 17, reason: "Referral", submittedAt: now - 3 * 86400 },
        ];
      } catch {
        // reputation fetch failed — proceed with null
      }

      dispatch({ type: 'FETCH_SUCCESS', did: mock, reputation: resolvedRep, scoreHistory: resolvedHistory });
    } catch (e: unknown) {
      dispatch({
        type: 'FETCH_ERROR',
        message: isNetworkError(e)
          ? "Unable to reach the Soroban network. Please try again later."
          : (e instanceof Error ? e.message : String(e)),
        errorType: isNetworkError(e) ? 'network' : 'contract',
      });
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

  const handleExportJsonLd = () => {
    if (!resolvedDoc) return;
    const blob = new Blob([exportDidDocumentAsJsonLd(resolvedDoc)], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'did-document.jsonld';
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
    
    // Validate no duplicate keys
    const keys = metadataEntries.map(e => e.key.trim()).filter(k => k);
    const uniqueKeys = new Set(keys);
    if (keys.length !== uniqueKeys.size) {
      setMetadataError('Duplicate metadata keys are not allowed');
      return;
    }
    
    setMetadataError(null);
    setUpdating(true);
    setUpdateSuccess(false);
    try {
      // Build metadata object from entries
      const metadata: Record<string, string> = {};
      metadataEntries.forEach(entry => {
        if (entry.key.trim() && entry.value.trim()) {
          metadata[entry.key.trim()] = entry.value.trim();
        }
      });

      // TODO: build update_did tx via IdentityClient with metadata, sign + submit
      await new Promise((r) => setTimeout(r, 1000));
      await new Promise((r) => setTimeout(r, 800));
      const updatedDid: DidDocument = {
        id: `did:stellar:${wallet.publicKey}`,
        controller: wallet.publicKey!,
        metadata,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        active: true,
      };
      dispatch({ type: 'FETCH_SUCCESS', did: updatedDid, reputation: null, scoreHistory: [] });
      setUpdateSuccess(true);
      setTimeout(() => setUpdateSuccess(false), 3000);
    } catch (e: unknown) {
      setCreateResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdating(false);
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
                dispatch({ type: 'RESET' });
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
            {resolvedDoc && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', lineHeight: 1.6 }}>
                <span><strong>Created:</strong> {formatTimestamp(resolvedDoc.createdAt)}</span>
                <br />
                <span><strong>Updated:</strong> {formatTimestamp(resolvedDoc.updatedAt)}</span>
              </div>
            )}
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
            <button
              onClick={handleExportJsonLd}
              disabled={!resolvedDoc}
              style={{ marginLeft: '0.5rem' }}
            >
              Export JSON-LD
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
            <p>Last updated: {formatTimestamp(reputation.updatedAt)}</p>
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
            
            <div style={{ marginBottom: '1rem' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                Metadata Key-Value Pairs
              </p>
              {metadataEntries.map((entry, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Key"
                    value={entry.key}
                    onChange={(e) => {
                      const newEntries = [...metadataEntries];
                      newEntries[idx].key = e.target.value;
                      setMetadataEntries(newEntries);
                      setMetadataError(null);
                    }}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-light)' }}
                  />
                  <input
                    type="text"
                    placeholder="Value"
                    value={entry.value}
                    onChange={(e) => {
                      const newEntries = [...metadataEntries];
                      newEntries[idx].value = e.target.value;
                      setMetadataEntries(newEntries);
                    }}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-light)' }}
                  />
                  <button
                    onClick={() => {
                      setMetadataEntries(metadataEntries.filter((_, i) => i !== idx));
                      setMetadataError(null);
                    }}
                    style={{
                      padding: '0.5rem 1rem',
                      background: 'var(--danger-bg)',
                      color: 'var(--danger-text)',
                      border: '1px solid var(--danger-border)',
                      borderRadius: '0.25rem',
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              
              <button
                onClick={() => setMetadataEntries([...metadataEntries, { key: '', value: '' }])}
                style={{
                  marginTop: '0.5rem',
                  padding: '0.5rem 1rem',
                  background: 'var(--accent-light)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '0.25rem',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                + Add Field
              </button>
            </div>
            
            {metadataError && (
              <div style={{
                marginBottom: '1rem',
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                border: '1px solid var(--danger-border)',
                fontSize: '0.9rem',
              }}>
                ✕ {metadataError}
              </div>
            )}
            
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
