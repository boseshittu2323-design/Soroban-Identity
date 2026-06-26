export * as v1 from './v1';
export { IdentityClient } from './identity';
export { health, healthCheck } from './health';
export type { HealthResult, HealthCheckResult } from './health';
export { CredentialClient } from './credentials';
export type { CredentialInput, BatchOptions, BatchResult } from './credentials';
export { ReputationClient } from './reputation';
export { PresentationClient } from './presentation';
export type {
  VerifiablePresentation,
  VerifiableCredentialSubset,
  PresentationProof,
  PresentationVerifyResult,
  PresentationVerifyFailReason,
} from './presentation';
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
  RateLimitError,
  classifyError,
  wrapError,
} from './errors';
export type {
  SorobanErrorCode,
  SorobanIdentityErrorInit,
} from './errors';
// #249 / #252 / #253 / #254 — server-layer helpers.
export * from './server';
export {
  SorobanErrorCodes,
  IDENTITY_REGISTRY_ERRORS,
  CREDENTIAL_MANAGER_ERRORS,
  REPUTATION_ERRORS,
} from './error-codes';
export { clearServerCache, SDK_VERSION } from './base-client';
export { toW3CDidDocument, exportDidDocumentAsJsonLd } from './serializers';
export {
  buildCreateDidArgs,
  buildUpdateDidArgs,
  buildResolveDidArgs,
  buildHasActiveDidArgs,
  buildDeactivateDidArgs,
  buildIssueCredentialArgs,
  buildRevokeCredentialArgs,
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
  buildGetIssuerCredentialsArgs,
  buildListIssuerCredentialsArgs,
} from './contract-args';
export type {
  DidDocument,
  ServiceEndpoint,
  Credential,
  RevokedCredential,
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
  SorobanResponse,
} from './types';
export { validateConfig } from './types';
export type { ReputationRecord, ScoreHistoryEntry } from './reputation';
export type { EventFilter, ContractEvent, GetEventsOptions } from './events';
export type { SorobanIdentityConfig, SorobanIdentityLogger, WriteResult } from './types';

// Testnet defaults — fill contract IDs after deployment
export const TESTNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: ['https://soroban-testnet.stellar.org', 'https://soroban-testnet-backup.stellar.org'],
  networkPassphrase: 'Test SDF Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
};

// Mainnet defaults — fill contract IDs after deployment
export const MAINNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: ['https://soroban-mainnet.stellar.org', 'https://soroban-mainnet-backup.stellar.org'],
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  identityRegistryId: '',
  credentialManagerId: '',
  reputationId: '',
};
