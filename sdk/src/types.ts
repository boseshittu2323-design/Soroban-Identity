export interface DidDocument {
  id: string; // did:stellar:<address>
  controller: string;
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

export type CredentialType = "Kyc" | "Reputation" | "Achievement" | "Custom";

export interface Credential {
  id: string; // hex-encoded 32-byte hash
  subject: string;
  issuer: string;
  credentialType: CredentialType;
  claims: Record<string, string>;
  /** SHA-256 hash of the off-chain claims payload (hex-encoded 32 bytes) */
  claimsHash: string;
  signature: string; // hex
  issuedAt: number;
  expiresAt: number; // 0 = no expiry
  revoked: boolean;
}

export type VerifyFailReason = "not_found" | "revoked" | "expired" | "unknown";

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailReason };

export interface SorobanIdentityConfig {
  rpcUrl: string | string[];
  networkPassphrase: string;
  identityRegistryId: string;
  credentialManagerId: string;
  reputationId?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  txTimeout?: number;
  /** Maximum concurrent RPC requests. Defaults to 5. */
  maxConcurrentRequests?: number;
  /** Request retry delay in ms. Defaults to 1000. */
  retryDelay?: number;
}

/** Per-call options that override the global config. */
export interface CallOptions {
  /** Override transaction timeout in seconds for this call only. */
  timeoutSeconds?: number;
}

/** Returned by write methods — includes the prepared transaction and estimated fee. */
export interface WriteResult {
  /** Estimated fee in stroops (1 XLM = 10_000_000 stroops). */
  estimatedFee: number;
  /** Estimated fee in XLM (human-readable). */
  estimatedFeeXlm: string;
}

export interface IdentityStorageStats {
  totalDids: number;
  activeDids: number;
}

export interface CredentialStorageStats {
  totalCredentials: number;
  revokedCredentials: number;
  activeCredentials: number;
}

export interface ReputationStorageStats {
  totalSubjects: number;
  totalScoreEntries: number;
}
