/**
 * Named argument builders for each contract call in the SDK.
 *
 * Instead of building positional `ScVal` arrays inline, every contract method
 * has a dedicated builder function whose parameters are named and typed. This
 * means a parameter reorder in the contract is caught at the call-site (wrong
 * name → TypeScript error) rather than silently producing a bad transaction.
 *
 * Each function returns `xdr.ScVal[]` ready to spread into `contract.call()`.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { CredentialType } from './types';

// ── identity-registry ────────────────────────────────────────────────────────

/**
 * Build args for `create_did(controller, metadata)`.
 *
 * @param params.controller Stellar address that will control the new DID.
 * @param params.metadata   Arbitrary `string → string` map to embed.
 * @returns ScVal array ready for `contract.call('create_did', ...)`.
 */
export function buildCreateDidArgs(params: {
  controller: string;
  metadata: Record<string, string>;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.controller, { type: 'address' }),
    nativeToScVal(params.metadata, { type: 'map' }),
  ];
}

/**
 * Build args for `update_did(controller, metadata)`.
 *
 * @param params.controller Stellar address of the DID controller (must sign).
 * @param params.metadata   Replacement `string → string` metadata map.
 * @returns ScVal array ready for `contract.call('update_did', ...)`.
 */
export function buildUpdateDidArgs(params: {
  controller: string;
  metadata: Record<string, string>;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.controller, { type: 'address' }),
    nativeToScVal(params.metadata, { type: 'map' }),
  ];
}

/**
 * Build args for `resolve_did(controller)`.
 *
 * @param params.controller Stellar address whose DID document to retrieve.
 * @returns ScVal array ready for `contract.call('resolve_did', ...)`.
 */
export function buildResolveDidArgs(params: {
  controller: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.controller, { type: 'address' })];
}

/**
 * Build args for `has_active_did(controller)`.
 *
 * @param params.controller Stellar address to check for an active DID.
 * @returns ScVal array ready for `contract.call('has_active_did', ...)`.
 */
export function buildHasActiveDidArgs(params: {
  controller: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.controller, { type: 'address' })];
}

/**
 * Build args for `deactivate_did(controller)`.
 *
 * @param params.controller Stellar address of the DID controller (must sign).
 * @returns ScVal array ready for `contract.call('deactivate_did', ...)`.
 */
export function buildDeactivateDidArgs(params: {
  controller: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.controller, { type: 'address' })];
}

// ── credential-manager ───────────────────────────────────────────────────────

/**
 * Build args for `issue_credential(issuer, subject, credential_type, claims,
 * claims_hash, signature, expires_at)`.
 *
 * @param params.issuer         Registered issuer address (must sign the tx).
 * @param params.subject        Subject receiving the credential.
 * @param params.credentialType Credential category — see {@link CredentialType}.
 * @param params.claims         Arbitrary `string → string` claims map.
 * @param params.claimsHash     32-byte SHA-256 of the off-chain claims payload.
 * @param params.signature      64-byte issuer Ed25519 signature.
 * @param params.expiresAt      Unix timestamp (seconds); `0` for no expiry.
 * @returns ScVal array ready for `contract.call('issue_credential', ...)`.
 */
export function buildIssueCredentialArgs(params: {
  issuer: string;
  subject: string;
  credentialType: CredentialType;
  claims: Record<string, string>;
  claimsHash: Buffer;
  signature: Buffer;
  expiresAt: number;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.issuer, { type: 'address' }),
    nativeToScVal(params.subject, { type: 'address' }),
    nativeToScVal(params.credentialType, { type: 'symbol' }),
    nativeToScVal(params.claims, { type: 'map' }),
    nativeToScVal(params.claimsHash, { type: 'bytes' }),
    nativeToScVal(params.signature, { type: 'bytes' }),
    nativeToScVal(params.expiresAt, { type: 'u64' }),
  ];
}

/**
 * Build args for `verify_credential(credential_id)`.
 *
 * @param params.credentialId 32-byte credential ID buffer.
 * @returns ScVal array ready for `contract.call('verify_credential', ...)`.
 */
export function buildVerifyCredentialArgs(params: {
  credentialId: Buffer;
}): xdr.ScVal[] {
  return [nativeToScVal(params.credentialId, { type: 'bytes' })];
}

/**
 * Build args for `get_credential(credential_id)`.
 *
 * @param params.credentialId 32-byte credential ID buffer.
 * @returns ScVal array ready for `contract.call('get_credential', ...)`.
 */
export function buildGetCredentialArgs(params: {
  credentialId: Buffer;
}): xdr.ScVal[] {
  return [nativeToScVal(params.credentialId, { type: 'bytes' })];
}

/**
 * Build args for `get_subject_credentials(subject)`.
 *
 * @param params.subject Stellar address of the credential subject.
 * @returns ScVal array ready for `contract.call('get_subject_credentials', ...)`.
 */
export function buildGetSubjectCredentialsArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

/**
 * Build args for `is_issuer(address)`.
 *
 * @param params.address Stellar address to check for issuer membership.
 * @returns ScVal array ready for `contract.call('is_issuer', ...)`.
 */
export function buildIsIssuerArgs(params: {
  address: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.address, { type: 'address' })];
}

/**
 * Build args for `get_credential_count(subject)`.
 *
 * @param params.subject Stellar address whose credential count to retrieve.
 * @returns ScVal array ready for `contract.call('get_credential_count', ...)`.
 */
export function buildGetCredentialCountArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

/**
 * Build args for `list_subject_credentials(subject, cursor, limit, credential_type)`.
 *
 * @param params.subject  Stellar address of the credential subject.
 * @param params.cursor   Pre-encoded `Option<u64>` ScVal for the resume cursor.
 * @param params.limit    Maximum items per page; `0` uses the contract's cap.
 * @param params.filter   Pre-encoded `Option<CredentialType>` ScVal filter.
 * @returns ScVal array ready for `contract.call('list_subject_credentials', ...)`.
 */
export function buildListSubjectCredentialsArgs(params: {
  subject: string;
  cursor: xdr.ScVal;
  limit: number;
  filter: xdr.ScVal;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.subject, { type: 'address' }),
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
    params.filter,
  ];
}

/**
 * Build args for `list_issuers(cursor, limit)`.
 *
 * @param params.cursor Pre-encoded `Option<u64>` ScVal for the resume cursor.
 * @param params.limit  Maximum items per page; `0` uses the contract's cap.
 * @returns ScVal array ready for `contract.call('list_issuers', ...)`.
 */
export function buildListIssuersArgs(params: {
  cursor: xdr.ScVal;
  limit: number;
}): xdr.ScVal[] {
  return [
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}

/**
 * Build args for `get_issuer_credentials(issuer)`.
 *
 * @param params.issuer Stellar address of the issuer.
 * @returns ScVal array ready for `contract.call('get_issuer_credentials', ...)`.
 */
export function buildGetIssuerCredentialsArgs(params: {
  issuer: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.issuer, { type: 'address' })];
}

/**
 * Build args for `list_issuer_credentials(issuer, cursor, limit)`.
 *
 * @param params.issuer  Stellar address of the issuer.
 * @param params.cursor  Pre-encoded `Option<u64>` ScVal for the resume cursor.
 * @param params.limit   Maximum items per page; `0` uses the contract's cap.
 * @returns ScVal array ready for `contract.call('list_issuer_credentials', ...)`.
 */
export function buildListIssuerCredentialsArgs(params: {
  issuer: string;
  cursor: xdr.ScVal;
  limit: number;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.issuer, { type: 'address' }),
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}

// ── reputation ───────────────────────────────────────────────────────────────

/**
 * Build args for `get_reputation(subject)`.
 *
 * @param params.subject Stellar address whose reputation record to retrieve.
 * @returns ScVal array ready for `contract.call('get_reputation', ...)`.
 */
export function buildGetReputationArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

/**
 * Build args for `get_history(subject, reporter, offset, limit)`.
 *
 * @param params.subject   Stellar address of the credential subject.
 * @param params.reporter  Registered reporter address.
 * @param params.offset    Number of entries to skip (offset-based pagination).
 * @param params.limit     Maximum entries to return.
 * @returns ScVal array ready for `contract.call('get_history', ...)`.
 */
export function buildGetHistoryArgs(params: {
  subject: string;
  reporter: string;
  offset: number;
  limit: number;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.subject, { type: 'address' }),
    nativeToScVal(params.reporter, { type: 'address' }),
    nativeToScVal(params.offset, { type: 'u32' }),
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}

/**
 * Build args for `passes_sybil_check_default(subject)`.
 *
 * @param params.subject Stellar address to evaluate against stored thresholds.
 * @returns ScVal array ready for `contract.call('passes_sybil_check_default', ...)`.
 */
export function buildPassesSybilCheckDefaultArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

/**
 * Build args for `passes_sybil_check(subject, min_score, min_reporters)`.
 *
 * @param params.subject       Stellar address to evaluate.
 * @param params.minScore      Minimum accumulated score required to pass.
 * @param params.minReporters  Minimum distinct active reporters required.
 * @returns ScVal array ready for `contract.call('passes_sybil_check', ...)`.
 */
export function buildPassesSybilCheckArgs(params: {
  subject: string;
  minScore: number;
  minReporters: number;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.subject, { type: 'address' }),
    nativeToScVal(params.minScore, { type: 'i64' }),
    nativeToScVal(params.minReporters, { type: 'u32' }),
  ];
}

/**
 * Build args for `submit_score(reporter, subject, delta, reason)`.
 *
 * @param params.reporter Registered reporter address (must sign the tx).
 * @param params.subject  Subject receiving the score delta.
 * @param params.delta    Signed score change (positive or negative).
 * @param params.reason   Human-readable reason string; length-capped on-chain.
 * @returns ScVal array ready for `contract.call('submit_score', ...)`.
 */
export function buildSubmitScoreArgs(params: {
  reporter: string;
  subject: string;
  delta: number;
  reason: string;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.reporter, { type: 'address' }),
    nativeToScVal(params.subject, { type: 'address' }),
    nativeToScVal(params.delta, { type: 'i64' }),
    nativeToScVal(params.reason, { type: 'string' }),
  ];
}

/**
 * Build args for `list_reporters(cursor, limit)`.
 *
 * @param params.cursor Pre-encoded `Option<u64>` ScVal for the resume cursor.
 * @param params.limit  Maximum items per page; `0` uses the contract's cap.
 * @returns ScVal array ready for `contract.call('list_reporters', ...)`.
 */
export function buildListReportersArgs(params: {
  cursor: xdr.ScVal;
  limit: number;
}): xdr.ScVal[] {
  return [
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}

/**
 * Build args for `list_history(subject, reporter, cursor, limit)`.
 *
 * @param params.subject   Stellar address of the credential subject.
 * @param params.reporter  Registered reporter address.
 * @param params.cursor    Pre-encoded `Option<u64>` ScVal for the resume cursor.
 * @param params.limit     Maximum items per page; `0` uses the contract's cap.
 * @returns ScVal array ready for `contract.call('list_history', ...)`.
 */
export function buildListHistoryArgs(params: {
  subject: string;
  reporter: string;
  cursor: xdr.ScVal;
  limit: number;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.subject, { type: 'address' }),
    nativeToScVal(params.reporter, { type: 'address' }),
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}
