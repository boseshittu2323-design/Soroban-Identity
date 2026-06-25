/**
 * Versioned namespace export for the Soroban Identity SDK.
 *
 * Import via the named `v1` export from the package root so that future
 * breaking changes can be introduced under `v2` while `v1` stays importable:
 *
 * ```ts
 * import { v1 } from '@soroban-identity/sdk';
 * const identity = new v1.IdentityClient(config);
 * ```
 *
 * All symbols here are also available as flat top-level exports for consumers
 * that prefer direct imports.
 */

export { IdentityClient } from './identity';
export { CredentialClient } from './credentials';
export { ReputationClient } from './reputation';
export { healthCheck } from './health';
export type { HealthCheckResult } from './health';
export { SorobanEventListener, getEvents } from './events';
export { SorobanTransactionBuilder } from './transaction-builder';
export { RequestQueue } from './request-queue';
export {
  retryWithBackoff,
  checkConnection,
  validateStellarAddress,
  computeCredentialId,
  runConcurrent,
} from './utils';
export {
  ContractError,
  SorobanIdentityError,
  classifyError,
  wrapError,
} from './errors';
export type {
  SorobanErrorCode,
  SorobanIdentityErrorInit,
} from './errors';
export {
  IDENTITY_REGISTRY_ERRORS,
  CREDENTIAL_MANAGER_ERRORS,
  REPUTATION_ERRORS,
} from './error-codes';
export { toW3CDidDocument, exportDidDocumentAsJsonLd } from './serializers';
export {
  buildCreateDidArgs,
  buildUpdateDidArgs,
  buildResolveDidArgs,
  buildHasActiveDidArgs,
  buildDeactivateDidArgs,
  buildIssueCredentialArgs,
  buildVerifyCredentialArgs,
  buildGetCredentialArgs,
  buildGetSubjectCredentialsArgs,
  buildIsIssuerArgs,
  buildGetCredentialCountArgs,
  buildListSubjectCredentialsArgs,
  buildListIssuersArgs,
  buildGetReputationArgs,
  buildGetHistoryArgs,
  buildPassesSybilCheckDefaultArgs,
  buildPassesSybilCheckArgs,
  buildSubmitScoreArgs,
  buildListReportersArgs,
  buildListHistoryArgs,
} from './contract-args';
export type {
  DidDocument,
  ServiceEndpoint,
  Credential,
  CredentialType,
  CredentialListOptions,
  VerifyResult,
  VerifyFailReason,
  CallOptions,
  IdentityStorageStats,
  CredentialStorageStats,
  ReputationStorageStats,
  Page,
  PaginationOptions,
  SorobanIdentityContractIdField,
  ValidateConfigOptions,
  SorobanIdentityConfig,
  SorobanIdentityLogger,
} from './types';
export { validateConfig } from './types';
export type { ReputationRecord, ScoreHistoryEntry } from './reputation';
export type { EventFilter, ContractEvent, GetEventsOptions } from './events';

export const TESTNET_CONFIG = {
  rpcUrl: ['https://soroban-testnet.stellar.org', 'https://soroban-testnet-backup.stellar.org'],
  networkPassphrase: 'Test SDF Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
} as const;

export const MAINNET_CONFIG = {
  rpcUrl: ['https://soroban-mainnet.stellar.org', 'https://soroban-mainnet-backup.stellar.org'],
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
} as const;
