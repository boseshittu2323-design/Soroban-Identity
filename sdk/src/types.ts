import { StrKey } from "@stellar/stellar-sdk";

/**
 * W3C DID Core service endpoint embedded in a {@link DidDocument}.
 *
 * Mirrors the Rust `ServiceEndpoint` contracttype from the identity-registry.
 * Note: the Soroban field is named `type_` (reserved keyword in Rust); this
 * interface follows the same serialisation name.
 *
 * @see https://www.w3.org/TR/did-core/#services
 */
export interface ServiceEndpoint {
  /** URI identifying this endpoint (e.g. `did:stellar:…#messaging`). */
  id: string;
  /** Service type (e.g. `DIDCommMessaging`, `CredentialService`). */
  type_: string;
  /** URL or URI where the service can be reached. */
  service_endpoint: string;
}

/**
 * Decentralised identifier document as stored by the identity-registry contract.
 *
 * `id` follows the `did:stellar:<address>` form. `metadata` is a free-form
 * `string → string` map the controller can update via
 * {@link IdentityClient.updateDid}.
 */
export interface DidDocument {
  /** Full DID — `did:stellar:<address>`. */
  id: string;
  /** Stellar address with authority to update or deactivate this DID. */
  controller: string;
  /** Arbitrary key-value metadata associated with the DID. */
  metadata: Record<string, string>;
  /** Unix timestamp (seconds) of initial creation. */
  createdAt: number;
  /** Unix timestamp (seconds) of last metadata update. */
  updatedAt: number;
  /** `false` once `deactivateDid` has been called for this DID. */
  active: boolean;
  /**
   * Optional W3C DID Core service endpoints.
   * Empty array by default; updated via the identity-registry admin flow.
   */
  services: ServiceEndpoint[];
}

/**
 * Credential category recognised by the credential-manager contract.
 * `Custom` is the catch-all for application-defined types.
 */
export type CredentialType = "Kyc" | "Reputation" | "Achievement" | "Custom";

/**
 * On-chain credential record returned by
 * {@link CredentialClient.getCredential}.
 */
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

/**
 * Reason a credential is invalid. Returned in {@link VerifyResult}.
 *
 * - `EXPIRED` — the credential's `expiresAt` timestamp has passed.
 * - `REVOKED` — the issuer has explicitly revoked the credential.
 * - `INVALID_SIGNATURE` — the stored issuer signature does not match.
 * - `UNKNOWN_ISSUER` — no credential was found for the given ID, or the
 *   credential's issuer is no longer registered.
 * - `INACTIVE_SUBJECT` — the subject's DID has been deactivated.
 */
export type VerifyFailReason =
  | 'EXPIRED'
  | 'REVOKED'
  | 'INVALID_SIGNATURE'
  | 'UNKNOWN_ISSUER'
  | 'INACTIVE_SUBJECT';

/**
 * Result from {@link CredentialClient.verifyCredential}.
 *
 * `valid` is `true` when the credential is active and unexpired.
 * `reason` is present when `valid` is `false` and a specific failure cause
 * could be determined from the contract's typed error response.
 */
export type VerifyResult = { valid: boolean; reason?: VerifyFailReason };

export interface SorobanIdentityLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface SorobanIdentityConfig {
  rpcUrl: string | string[];
  networkPassphrase: string;
  identityRegistryId: string;
  credentialManagerId: string;
  /** Contract ID for the reputation contract. Required when using {@link ReputationClient}. */
  reputationId: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  txTimeout?: number;
  /** Maximum concurrent RPC requests. Defaults to 5. */
  maxConcurrentRequests?: number;
  /** Request retry delay in ms. Defaults to 1000. */
  retryDelay?: number;
  /** Optional pluggable logger for RPC simulation/submission traces. */
  logger?: SorobanIdentityLogger;
  /**
   * Expected contract deployment version string (e.g. `"0.1.0"`).
   *
   * When set and it does not match the SDK's own version constant the SDK
   * emits a `warn` log at construction time so operators can catch
   * contract/SDK mismatches before they cause runtime failures.
   */
  version?: string;
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

/**
 * One page of results from a cursor-paginated list endpoint.
 *
 * `nextCursor` is `null` once the iterator is exhausted. While it is a number,
 * pass it back as the `cursor` argument on the next call to continue iteration.
 * Filtered queries may return fewer items than `limit` on a non-final page —
 * always advance while `nextCursor !== null`, not while `items.length === limit`.
 *
 * @see https://github.com/El-Chapo-Npm/Soroban-Identity/issues/248
 */
export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

/**
 * Options accepted by cursor-paginated list endpoints.
 *
 * @property cursor   Resume index from a prior page's `nextCursor`. Omit on the
 *                    first call to start from the beginning.
 * @property limit    Maximum items to return on this page. Clamped to 100 at
 *                    the contract layer; `0` is treated as "use the cap".
 */
export interface PaginationOptions extends CallOptions {
  cursor?: number;
  limit?: number;
}

/**
 * Extends {@link PaginationOptions} with a credential-type filter for
 * {@link CredentialClient.listCredentialsBySubject}. See issue #251.
 */
export interface CredentialListOptions extends PaginationOptions {
  credentialType?: CredentialType;
}

/** Contract ID field validated by {@link validateConfig} for a specific client. */
export type SorobanIdentityContractIdField =
  | "identityRegistryId"
  | "credentialManagerId"
  | "reputationId";

export interface ValidateConfigOptions {
  /** Contract ID that must be present and valid for the calling client. */
  contractIdField: SorobanIdentityContractIdField;
}

/**
 * Validates a {@link SorobanIdentityConfig} at client construction time so
 * misconfiguration fails fast with a descriptive error instead of a deep RPC failure.
 */
export function validateConfig(
  config: SorobanIdentityConfig,
  options: ValidateConfigOptions
): void {
  const rpcUrls = Array.isArray(config.rpcUrl) ? config.rpcUrl : [config.rpcUrl];
  if (rpcUrls.length === 0 || rpcUrls.some((url) => !url?.trim())) {
    throw new Error("rpcUrl is required");
  }

  if (!config.networkPassphrase?.trim()) {
    throw new Error("networkPassphrase is required");
  }

  const contractId = config[options.contractIdField];
  if (!contractId?.trim()) {
    throw new Error(`${options.contractIdField} is required`);
  }
  if (!StrKey.isValidContract(contractId)) {
    throw new Error(`${options.contractIdField} is not a valid contract ID`);
  }
}
