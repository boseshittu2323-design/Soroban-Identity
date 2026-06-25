# Changelog

All notable changes to the Soroban Identity SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-24

### Added
- **#303** `ServiceEndpoint` struct (`id`, `type_`, `service_endpoint`) in the
  identity-registry contract; `DidDocument` now carries a `services` field
  (empty `Vec` by default) to satisfy the W3C DID Core service-endpoints spec.
  The TypeScript `DidDocument` interface and the new `ServiceEndpoint` type are
  updated to match.
- **#305** `CredentialClient.estimateIssuanceFee()` — runs the Soroban
  simulation step only (no signing, no submit) and returns `{ fee, feeXLM }`.
  UIs can call this to preview the XLM cost before asking users to sign.
- **#306** Batch operations with configurable concurrency:
  - `IdentityClient.resolveMany(addresses, options?)` — resolve N DIDs in parallel.
  - `CredentialClient.verifyMany(callerAddress, credentialIds, options?)` — verify
    N credentials in parallel; prefer this over the deprecated `verifyCredentialsBatch`.
  - `ReputationClient.getScores(callerAddress, addresses, options?)` — fetch N
    reputation records in parallel (leaderboard use case).
  - `runConcurrent<T,R>(items, fn, concurrency?)` utility exported for consumers.
- **#304** API versioning strategy:
  - `export * as v1 from '@soroban-identity/sdk'` — versioned namespace so
    future breaking changes can ship as `v2` without affecting `v1` imports.
  - `SDK_VERSION` constant exported from the package.
  - `version?: string` field added to `SorobanIdentityConfig`; the SDK emits a
    `warn` log at construction time when the configured version does not match
    `SDK_VERSION`, helping operators catch contract/SDK mismatches early.
  - `CHANGELOG.md` now follows [Keep a Changelog](https://keepachangelog.com)
    format with semantic versioning.

### Deprecated
- `CredentialClient.verifyCredentialsBatch()` — use `verifyMany()` instead,
  which accepts the same arguments and adds a configurable concurrency limit.

## [0.1.0] - 2026-04-25

### Added
- `IdentityClient` for DID management
  - `createDid()` - Create a new DID for a wallet address
  - `updateDid()` - Update DID metadata
  - `resolveDid()` - Resolve a DID document by controller address
  - `hasActiveDid()` - Check if an address has an active DID
  - `deactivateDid()` - Deactivate a DID
- `CredentialClient` for verifiable credentials
  - `issueCredential()` - Issue a credential to a subject
  - `verifyCredential()` - Verify a credential is valid (not revoked, not expired)
  - `getCredential()` - Get a credential by ID
  - `getCredentialsBySubject()` - Get all credentials issued to a subject
  - `verifyCredentialsBatch()` - Verify multiple credentials in parallel
- `ReputationClient` for on-chain reputation scoring
  - `getReputation()` - Get the reputation record for a subject
  - `getScoreHistory()` - Get score submission history for a subject from a specific reporter
  - `passesSybilCheck()` - Check if a subject passes custom sybil thresholds
  - `passesSybilCheckDefault()` - Check if a subject passes default sybil thresholds
  - `submitScore()` - Submit a score delta (for registered reporters)
- TypeScript type definitions
  - `DidDocument` - DID document structure
  - `Credential` - Verifiable credential structure
  - `CredentialType` - Supported credential types (Kyc, Reputation, Achievement, Custom)
  - `VerifyResult` - Credential verification result with failure reasons
  - `ReputationRecord` - Reputation data structure
  - `ScoreHistoryEntry` - Score history entry structure
  - `SorobanIdentityConfig` - SDK configuration interface
  - `CallOptions` - Per-call configuration options
  - `WriteResult` - Transaction result with fee estimation
- Utility functions
  - `retryWithBackoff()` - Retry failed operations with exponential backoff
  - `validateStellarAddress()` - Validate Stellar address format
- Pre-configured network settings
  - `TESTNET_CONFIG` - Testnet RPC and network passphrase
  - `MAINNET_CONFIG` - Mainnet RPC and network passphrase
- Comprehensive test suite with Vitest
  - Unit tests for IdentityClient
  - Unit tests for CredentialClient
  - Unit tests for ReputationClient
  - Unit tests for utility functions

[unreleased]: https://github.com/El-Chapo-Npm/Soroban-Identity/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/El-Chapo-Npm/Soroban-Identity/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/El-Chapo-Npm/Soroban-Identity/releases/tag/v0.1.0
