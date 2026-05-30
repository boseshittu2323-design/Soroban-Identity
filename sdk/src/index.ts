export { IdentityClient } from './identity';
export { CredentialClient } from './credentials';
export { ReputationClient } from './reputation';
export { SorobanEventListener } from './events';
export { SorobanTransactionBuilder } from './transaction-builder';
export { RequestQueue } from './request-queue';
export {
  retryWithBackoff,
  checkConnection,
  validateStellarAddress,
  computeCredentialId,
} from './utils';
export { ContractError } from './errors';
export {
  IDENTITY_REGISTRY_ERRORS,
  CREDENTIAL_MANAGER_ERRORS,
  REPUTATION_ERRORS,
} from './error-codes';
export { clearServerCache } from './base-client';
export { toW3CDidDocument, exportDidDocumentAsJsonLd } from './serializers';
export type {
  DidDocument,
  Credential,
  CredentialType,
  VerifyResult,
  VerifyFailReason,
  CallOptions,
  IdentityStorageStats,
  CredentialStorageStats,
  ReputationStorageStats,
} from './types';
export type { ReputationRecord, ScoreHistoryEntry } from './reputation';
export type { EventFilter, ContractEvent } from './events';
import type { SorobanIdentityConfig } from './types';
export type { SorobanIdentityConfig };

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
