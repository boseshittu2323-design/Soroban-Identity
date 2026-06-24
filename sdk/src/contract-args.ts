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

export function buildCreateDidArgs(params: {
  controller: string;
  metadata: Record<string, string>;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.controller, { type: 'address' }),
    nativeToScVal(params.metadata, { type: 'map' }),
  ];
}

export function buildUpdateDidArgs(params: {
  controller: string;
  metadata: Record<string, string>;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.controller, { type: 'address' }),
    nativeToScVal(params.metadata, { type: 'map' }),
  ];
}

export function buildResolveDidArgs(params: {
  controller: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.controller, { type: 'address' })];
}

export function buildHasActiveDidArgs(params: {
  controller: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.controller, { type: 'address' })];
}

export function buildDeactivateDidArgs(params: {
  controller: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.controller, { type: 'address' })];
}

// ── credential-manager ───────────────────────────────────────────────────────

export function buildIssueCredentialArgs(params: {
  issuer: string;
  subject: string;
  credentialType: CredentialType;
  claims: Record<string, string>;
  claimsHash: Buffer;
  signature: Buffer;
  expiresAt: bigint;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.issuer, { type: 'address' }),
    nativeToScVal(params.subject, { type: 'address' }),
    nativeToScVal(params.credentialType, { type: 'symbol' }),
    nativeToScVal(params.claims, { type: 'map' }),
    nativeToScVal(params.claimsHash, { type: 'bytes' }),
    nativeToScVal(params.signature, { type: 'bytes' }),
    xdr.ScVal.scvU64(xdr.Uint64.fromString(params.expiresAt.toString())),
  ];
}

export function buildVerifyCredentialArgs(params: {
  credentialId: Buffer;
}): xdr.ScVal[] {
  return [nativeToScVal(params.credentialId, { type: 'bytes' })];
}

export function buildGetCredentialArgs(params: {
  credentialId: Buffer;
}): xdr.ScVal[] {
  return [nativeToScVal(params.credentialId, { type: 'bytes' })];
}

export function buildGetSubjectCredentialsArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

export function buildIsIssuerArgs(params: {
  address: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.address, { type: 'address' })];
}

export function buildGetCredentialCountArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

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

export function buildListIssuersArgs(params: {
  cursor: xdr.ScVal;
  limit: number;
}): xdr.ScVal[] {
  return [
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}

// ── reputation ───────────────────────────────────────────────────────────────

export function buildGetReputationArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

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

export function buildPassesSybilCheckDefaultArgs(params: {
  subject: string;
}): xdr.ScVal[] {
  return [nativeToScVal(params.subject, { type: 'address' })];
}

export function buildPassesSybilCheckArgs(params: {
  subject: string;
  minScore: bigint;
  minReporters: number;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.subject, { type: 'address' }),
    xdr.ScVal.scvI64(xdr.Int64.fromString(params.minScore.toString())),
    nativeToScVal(params.minReporters, { type: 'u32' }),
  ];
}

export function buildSubmitScoreArgs(params: {
  reporter: string;
  subject: string;
  delta: bigint;
  reason: string;
}): xdr.ScVal[] {
  return [
    nativeToScVal(params.reporter, { type: 'address' }),
    nativeToScVal(params.subject, { type: 'address' }),
    xdr.ScVal.scvI64(xdr.Int64.fromString(params.delta.toString())),
    nativeToScVal(params.reason, { type: 'string' }),
  ];
}

export function buildListReportersArgs(params: {
  cursor: xdr.ScVal;
  limit: number;
}): xdr.ScVal[] {
  return [
    params.cursor,
    nativeToScVal(params.limit, { type: 'u32' }),
  ];
}

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
