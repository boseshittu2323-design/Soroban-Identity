import { randomBytes, createHash } from 'node:crypto';
import type { Credential } from './types';

// ── W3C VC Data Model 2.0 types ─────────────────────────────────────────────

/**
 * A selective-disclosure credential envelope embedded in a
 * {@link VerifiablePresentation}. Contains only the claim fields the holder
 * chose to disclose; the `claimsHash` lets verifiers confirm the disclosed
 * claims against the on-chain hash via `verify_claims_hash`.
 */
export interface VerifiableCredentialSubset {
  '@context': string[];
  type: string[];
  /** Hex-encoded credential ID matching the on-chain record. */
  id: string;
  /** Stellar address of the issuer formatted as `did:stellar:<address>`. */
  issuer: string;
  credentialSubject: {
    /** Stellar address of the subject formatted as `did:stellar:<address>`. */
    id: string;
    [claim: string]: string;
  };
  /** Canonical credential type label (`Kyc`, `Reputation`, etc.). */
  credentialType: string;
  /** Hex SHA-256 of the full off-chain claims payload (from the on-chain record). */
  claimsHash: string;
  /** Unix timestamp (seconds) of original issuance. */
  issuedAt: number;
  /** Unix timestamp (seconds) after which the credential is invalid. 0 = no expiry. */
  expiresAt: number;
}

/**
 * Lightweight proof block attached to a {@link VerifiablePresentation}.
 * Follows the W3C Data Integrity Proof structure.
 */
export interface PresentationProof {
  type: 'DataIntegrityProof';
  /** Unix timestamp (ms) when the proof was created. */
  created: number;
  proofPurpose: 'authentication' | 'assertionMethod';
  cryptosuite: string;
  /** `did:stellar:<address>#key-1` of the signing key. */
  verificationMethod?: string;
  /** Base64url-encoded Ed25519 signature over the canonical presentation JSON. */
  jws?: string;
}

/**
 * W3C VC Data Model 2.0 Verifiable Presentation with selective disclosure.
 *
 * Created by {@link PresentationClient.createPresentation}; verified by
 * {@link PresentationClient.verifyPresentation}.
 */
export interface VerifiablePresentation {
  '@context': string[];
  type: string[];
  /** Unique presentation ID (`urn:presentation:<hex>`). */
  id: string;
  /** DID (`did:stellar:<address>`) of the entity presenting the credential. */
  holder?: string;
  verifiableCredential: VerifiableCredentialSubset[];
  proof?: PresentationProof;
  /** Unix timestamp (ms) when the presentation was created. */
  created: number;
}

// ── Verification result ──────────────────────────────────────────────────────

/**
 * Reason a {@link VerifiablePresentation} failed structural verification.
 *
 * - `INVALID_CONTEXT` — the required W3C context URL is absent.
 * - `INVALID_TYPE` — `VerifiablePresentation` is not in the `type` array.
 * - `MISSING_CREDENTIALS` — `verifiableCredential` is empty or absent.
 * - `INCOMPLETE_CREDENTIAL` — a credential subset is missing required fields.
 * - `MISSING_CLAIMS` — a credential subset has no `credentialSubject` claims.
 */
export type PresentationVerifyFailReason =
  | 'INVALID_CONTEXT'
  | 'INVALID_TYPE'
  | 'MISSING_CREDENTIALS'
  | 'INCOMPLETE_CREDENTIAL'
  | 'MISSING_CLAIMS';

/**
 * Result from {@link PresentationClient.verifyPresentation}.
 *
 * `valid` is `true` when the presentation passes all structural checks.
 * `reason` is present when `valid` is `false`.
 */
export type PresentationVerifyResult =
  | { valid: true }
  | { valid: false; reason: PresentationVerifyFailReason };

// ── PresentationClient ───────────────────────────────────────────────────────

const W3C_VC_CONTEXT_V2 = 'https://www.w3.org/ns/credentials/v2';

/**
 * Client for creating and verifying W3C VC Data Model 2.0 Verifiable
 * Presentations with selective disclosure.
 *
 * **Selective disclosure flow:**
 * 1. Holder calls {@link PresentationClient.createPresentation} with the
 *    full credential and the list of claim fields to share.
 * 2. The presentation is sent to a relying party containing only the chosen
 *    claims alongside the on-chain `claimsHash`.
 * 3. Relying party calls {@link PresentationClient.verifyPresentation} for
 *    structural checks, then uses `CredentialClient.verifyCredential` and
 *    the contract's `verify_claims_hash` for on-chain validation.
 *
 * @example
 * ```ts
 * import { PresentationClient } from '@soroban-identity/sdk';
 *
 * const client = new PresentationClient();
 *
 * // Holder creates a presentation disclosing only 'name' and 'country'
 * const vp = client.createPresentation(credential, ['name', 'country'], holderAddress);
 *
 * // Relying party verifies the presentation structure
 * const result = client.verifyPresentation(vp);
 * if (!result.valid) throw new Error(result.reason);
 * ```
 */
export class PresentationClient {
  /**
   * Create a selective-disclosure Verifiable Presentation.
   *
   * Only the claim fields listed in `fieldsToDisclose` are included in the
   * presentation's `credentialSubject`. The `claimsHash` from the on-chain
   * record is always included so relying parties can verify the disclosed
   * claims against the contract via `verify_claims_hash`.
   *
   * Claim fields not present in the credential are silently omitted.
   *
   * @param credential       Full on-chain credential from
   *                         {@link CredentialClient.getCredential}.
   * @param fieldsToDisclose Claim keys to include in the presentation.
   * @param holderAddress    Optional Stellar address of the presenting party;
   *                         becomes `did:stellar:<address>` in the `holder` field.
   * @returns A {@link VerifiablePresentation} conforming to W3C VC DM 2.0.
   *
   * @example
   * ```ts
   * const vp = client.createPresentation(credential, ['name', 'country']);
   * ```
   */
  createPresentation(
    credential: Credential,
    fieldsToDisclose: string[],
    holderAddress?: string
  ): VerifiablePresentation {
    const disclosedClaims: Record<string, string> = {};
    for (const field of fieldsToDisclose) {
      if (Object.prototype.hasOwnProperty.call(credential.claims, field)) {
        disclosedClaims[field] = credential.claims[field]!;
      }
    }

    const presentationId = `urn:presentation:${randomBytes(16).toString('hex')}`;

    const vc: VerifiableCredentialSubset = {
      '@context': [W3C_VC_CONTEXT_V2],
      type: ['VerifiableCredential'],
      id: `urn:credential:${credential.id}`,
      issuer: `did:stellar:${credential.issuer}`,
      credentialSubject: {
        id: `did:stellar:${credential.subject}`,
        ...disclosedClaims,
      },
      credentialType: credential.credentialType,
      claimsHash: credential.claimsHash,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    };

    return {
      '@context': [W3C_VC_CONTEXT_V2],
      type: ['VerifiablePresentation'],
      id: presentationId,
      holder: holderAddress ? `did:stellar:${holderAddress}` : undefined,
      verifiableCredential: [vc],
      created: Date.now(),
    };
  }

  /**
   * Verify the structural integrity of a Verifiable Presentation.
   *
   * Checks that the presentation conforms to W3C VC Data Model 2.0 and that
   * every embedded credential subset contains the required fields for
   * on-chain hash verification.
   *
   * **Note:** This method performs off-chain structural checks only. For full
   * verification also call `CredentialClient.verifyCredential` with the
   * credential ID and use the contract's `verify_claims_hash` entry point to
   * confirm the disclosed claims match the on-chain hash.
   *
   * @param presentation The presentation to verify.
   * @returns `{ valid: true }` when all structural checks pass; otherwise
   *   `{ valid: false, reason }` identifying the first failing check.
   *
   * @example
   * ```ts
   * const result = client.verifyPresentation(vp);
   * if (result.valid) {
   *   // proceed to on-chain checks
   * }
   * ```
   */
  verifyPresentation(presentation: VerifiablePresentation): PresentationVerifyResult {
    if (!Array.isArray(presentation['@context']) || !presentation['@context'].includes(W3C_VC_CONTEXT_V2)) {
      return { valid: false, reason: 'INVALID_CONTEXT' };
    }
    if (!Array.isArray(presentation.type) || !presentation.type.includes('VerifiablePresentation')) {
      return { valid: false, reason: 'INVALID_TYPE' };
    }
    if (!Array.isArray(presentation.verifiableCredential) || presentation.verifiableCredential.length === 0) {
      return { valid: false, reason: 'MISSING_CREDENTIALS' };
    }

    for (const vc of presentation.verifiableCredential) {
      if (!vc.id || !vc.issuer || !vc.claimsHash || !vc.credentialSubject?.id) {
        return { valid: false, reason: 'INCOMPLETE_CREDENTIAL' };
      }
      const { id: _id, ...claims } = vc.credentialSubject;
      if (Object.keys(claims).length === 0) {
        return { valid: false, reason: 'MISSING_CLAIMS' };
      }
    }

    return { valid: true };
  }

  /**
   * Compute the SHA-256 hash of a set of disclosed claims.
   *
   * The hash is computed over the JSON-serialised `claims` object with keys
   * sorted alphabetically. Relying parties can compare this value against the
   * `claimsHash` stored on-chain via the contract's `verify_claims_hash`
   * function to confirm the disclosed payload is genuine.
   *
   * @param disclosedClaims The `string → string` claims map to hash.
   * @returns 64-character hex SHA-256 of the canonical JSON representation.
   *
   * @example
   * ```ts
   * const hash = client.computeDisclosedClaimsHash({ name: 'Alice', country: 'US' });
   * // pass hash to CredentialClient.verifyClaimsHash() for on-chain confirmation
   * ```
   */
  computeDisclosedClaimsHash(disclosedClaims: Record<string, string>): string {
    const sorted = Object.fromEntries(
      Object.entries(disclosedClaims).sort(([a], [b]) => a.localeCompare(b))
    );
    return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
  }
}
