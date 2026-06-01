import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type {
  CallOptions,
  Credential,
  CredentialListOptions,
  CredentialStorageStats,
  CredentialType,
  Page,
  PaginationOptions,
  SorobanIdentityConfig,
  VerifyResult,
  WriteResult,
} from "./types";
import { retryWithBackoff, validateStellarAddress, pollTransactionStatus } from "./utils";
import { ContractError, SorobanIdentityError } from "./errors";
import { CREDENTIAL_MANAGER_ERRORS } from "./error-codes";
import { BaseClient } from "./base-client";

const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const CREDENTIAL_VERIFY_NOT_FOUND_CODE = 2;
const CREDENTIAL_NOT_FOUND_CODE = 3;
const CREDENTIAL_REVOKED_CODE = 4;

/**
 * Client for the credential-manager contract.
 *
 * Issues, revokes, verifies, and lists verifiable credentials. Use the
 * paginated `list*` variants ({@link CredentialClient.listCredentialsBySubject},
 * {@link CredentialClient.listIssuers}) for production read flows; the
 * unbounded `get*` variants are kept for small registries and tests.
 *
 * @example
 * ```ts
 * import { CredentialClient, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const credentials = new CredentialClient({ ...TESTNET_CONFIG, credentialManagerId: '...' });
 * const page = await credentials.listCredentialsBySubject(caller, subject, {
 *   credentialType: 'Kyc',
 *   limit: 50,
 * });
 * ```
 */
export class CredentialClient extends BaseClient {
  /**
   * @param config SDK config including the deployed credential-manager contract ID.
   */
  constructor(config: SorobanIdentityConfig) {
    super(config, config.credentialManagerId);
  }

  /** Returns true if the credential-manager contract has been initialized. */
  async isInitialized(): Promise<boolean> {
    try {
      return await this.executeWithFailover(async (server) => {
        const account = await server.getAccount(PROBE_ADDRESS);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "is_issuer",
            nativeToScVal(PROBE_ADDRESS, { type: "address" })
          )
        )
        .setTimeout(10)
        .build();
        const result = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(result)) {
          const err: string = (result as { error: string }).error ?? "";
          if (err.includes("not initialized") || err.includes("NotInitialized") || err.includes("#0")) {
            return false;
          }
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Issue a credential to a subject. Caller must be a registered issuer.
   *
   * Builds, signs, and submits an `issue_credential` call to the
   * credential-manager. The contract's deterministic ID derivation means the
   * same `(issuer, subject, credentialType)` triple cannot be issued twice
   * unless the prior one is revoked.
   *
   * @param issuerKeypair   The registered issuer signing the transaction.
   * @param subjectAddress  The Stellar address receiving the credential.
   * @param credentialType  Credential category — see {@link CredentialType}.
   * @param claims          Arbitrary `string → string` claims to embed.
   * @param claimsHashHex   64-char hex (32 bytes) SHA-256 of the off-chain
   *                        claims payload.
   * @param expiresAt       Unix timestamp (seconds) after which the credential
   *                        is invalid. Pass `0` for no expiry.
   * @param options         Per-call overrides (currently `timeoutSeconds`).
   * @param signatureHex    Optional pre-computed 64-byte issuer signature as a
   *                        128-char hex string. If omitted, the SDK signs over
   *                        `JSON.stringify({ subjectAddress, claims })`.
   * @returns The newly assigned credential ID (hex-encoded 32 bytes) and the
   *          estimated transaction fee.
   * @throws {SorobanIdentityError} with code `VALIDATION_ERROR` if
   *   `claimsHashHex` or `signatureHex` are malformed, or `CONTRACT_ERROR` on
   *   submission failure (including the `UnauthorizedIssuer` and
   *   `CredentialAlreadyExists` contract errors).
   */
  async issueCredential(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    claimsHashHex: string,
    expiresAt = 0,
    options?: CallOptions,
    signatureHex?: string
  ): Promise<{ credentialId: string } & WriteResult> {
    if (!/^[0-9a-fA-F]{64}$/.test(claimsHashHex)) {
      throw new SorobanIdentityError(
        "InvalidClaimsHashFormat: claimsHash must be a 64-character hex string (32 bytes)",
        "VALIDATION_ERROR"
      );
    }

    if (signatureHex !== undefined) {
      if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
        throw new SorobanIdentityError(
          "InvalidSignatureFormat: signature must be a 128-character hex string (64 bytes)",
          "VALIDATION_ERROR"
        );
      }
    }

    const account = await this.server.getAccount(issuerKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    // Signature is over SHA256(issuer + subject + claims) — simplified here
    const signature = signatureHex
      ? Buffer.from(signatureHex, "hex")
      : issuerKeypair.sign(
          Buffer.from(JSON.stringify({ subjectAddress, claims }))
        );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "issue_credential",
          nativeToScVal(issuerKeypair.publicKey(), { type: "address" }),
          nativeToScVal(subjectAddress, { type: "address" }),
          nativeToScVal(credentialType, { type: "symbol" }),
          nativeToScVal(claims, { type: "map" }),
          nativeToScVal(Buffer.from(claimsHashHex, "hex"), { type: "bytes" }),
          nativeToScVal(signature, { type: "bytes" }),
          nativeToScVal(expiresAt, { type: "u64" })
        )
      )
      .setTimeout(timeout)
      .build();

    const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
    const estimatedFee = parseInt(prepared.fee, 10);
    const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
    prepared.sign(issuerKeypair);

    const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
    this.debug('sdk.submission_outcome', { operation: 'credentials.sendTransaction', status: result.status });
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    await pollTransactionStatus(this.server, result.hash, {
      maxAttempts: this.config.pollingRetries,
      intervalMs: this.config.pollingIntervalMs,
      exponentialBackoff: this.config.pollingExponentialBackoff,
    });
    const confirmed = await this.server.getTransaction(result.hash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
    // Returns BytesN<32> — encode as hex
    const raw = scValToNative(confirmed.returnValue!) as Uint8Array;
    const credentialId = Buffer.from(raw).toString("hex");
    return { credentialId, estimatedFee, estimatedFeeXlm };
  }

  /**
   * Verify a credential is valid (not revoked, not expired).
   *
   * Read-only simulation. Returns a discriminated {@link VerifyResult} so
   * callers can branch on the failure reason without parsing error strings.
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param credentialId  Hex-encoded credential ID (32 bytes).
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns `{ valid: true }` when the credential is active and unexpired;
   *   otherwise `{ valid: false, reason }` where reason is one of
   *   `not_found`, `revoked`, `expired`, or `unknown`.
   * @throws {SorobanIdentityError} on simulation failure unrelated to a
   *   verification result (network errors, malformed `callerAddress`).
   */
  async verifyCredential(
    callerAddress: string,
    credentialId: string,
    options?: CallOptions
  ): Promise<VerifyResult> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "verify_credential",
          nativeToScVal(idBytes, { type: "bytes" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });

    if (isSimulationError) {
      const error: string = (result as { error: string }).error ?? "";
      const contractErr = ContractError.extract(error, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr?.code === CREDENTIAL_VERIFY_NOT_FOUND_CODE) return { valid: false, reason: "not_found" };
      if (contractErr?.code === CREDENTIAL_REVOKED_CODE) return { valid: false, reason: "revoked" };
      if (contractErr?.code === 5) return { valid: false, reason: "expired" };
      if (error.includes("credential not found")) {
        return { valid: false, reason: "not_found" };
      }
      return { valid: false, reason: "unknown" };
    }

    const valid = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;

    if (valid) return { valid: true };

    // Contract returned false — fetch the credential to determine why
    try {
      const cred = await this.getCredential(callerAddress, credentialId);
      if (cred.revoked) return { valid: false, reason: "revoked" };
      if (cred.expiresAt > 0 && Date.now() / 1000 > cred.expiresAt) {
        return { valid: false, reason: "expired" };
      }
    } catch {
      // getCredential failed — credential likely doesn't exist
      return { valid: false, reason: "not_found" };
    }

    return { valid: false, reason: "unknown" };
  }

  /**
   * Get all credentials issued to a subject address.
   *
   * Returns full credential records (resolved via {@link CredentialClient.getCredential}
   * for each ID). Includes revoked credentials — callers can drop them by
   * inspecting `revoked`.
   *
   * **Note:** This method fetches the entire list in one call and is suitable
   * for subjects with a bounded number of credentials. For large subjects use
   * the paginated, optionally filtered {@link CredentialClient.listCredentialsBySubject}
   * (see issue #248).
   *
   * @param callerAddress  Stellar address used to build the read simulation.
   * @param subjectAddress The address whose credentials to retrieve.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns Array of {@link Credential} records.
   * @throws {SorobanIdentityError} on simulation failure.
   */
  async getCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<Credential[]> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const idsTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_subject_credentials",
          nativeToScVal(subjectAddress, { type: "address" })
        )
      )
      .setTimeout(timeout)
      .build();

    const idsResult = await retryWithBackoff(() => this.server.simulateTransaction(idsTx));
    const idsSimulationError = SorobanRpc.Api.isSimulationError(idsResult);
    this.debug('sdk.simulation_result', { operation: 'credentials.getCredentialsBySubject.ids', success: !idsSimulationError });
    if (idsSimulationError) {
      const errMsg = idsResult.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    const ids = scValToNative(
      (idsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Uint8Array[];

    if (!ids || ids.length === 0) return [];

    return Promise.all(
      ids.map((raw) =>
        this.getCredential(callerAddress, Buffer.from(raw).toString("hex"), options)
      )
    );
  }

  /**
   * Get a credential by ID.
   *
   * Read-only simulation. Use {@link CredentialClient.verifyCredential} if you
   * want a typed verification result instead of throwing on revoked/expired
   * records.
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param credentialId  Hex-encoded credential ID (32 bytes).
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns The {@link Credential} record.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` when the ID was never
   *   issued, `VALIDATION_ERROR` when the credential has been revoked, or
   *   `CONTRACT_ERROR` on simulation failure.
   */
  async getCredential(
    callerAddress: string,
    credentialId: string,
    options?: CallOptions
  ): Promise<Credential> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_credential",
          nativeToScVal(idBytes, { type: "bytes" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const error: string = (result as { error: string }).error ?? "";
      const contractErr = ContractError.extract(error, CREDENTIAL_MANAGER_ERRORS);
      if (!contractErr) {
        throw new SorobanIdentityError(`Simulation failed: ${error}`, "CONTRACT_ERROR");
      }
      if (contractErr.code === CREDENTIAL_NOT_FOUND_CODE) {
        throw new SorobanIdentityError("CredentialNotFound: credential does not exist", "NOT_FOUND");
      }
      if (contractErr.code === CREDENTIAL_REVOKED_CODE) {
        throw new SorobanIdentityError("CredentialRevoked: credential has been revoked", "VALIDATION_ERROR");
      }
      throw contractErr;
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Credential;
  }

  /**
   * Check if an address is a registered issuer.
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param targetAddress The address to test for issuer membership.
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns `true` if `targetAddress` is currently registered as an issuer.
   * @throws {SorobanIdentityError} on simulation failure.
   */
  async isIssuer(
    callerAddress: string,
    targetAddress: string,
    options?: CallOptions
  ): Promise<boolean> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(targetAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "is_issuer",
          nativeToScVal(targetAddress, { type: "address" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;
  }

  /**
   * Verify multiple credentials in parallel.
   *
   * Convenience wrapper around {@link CredentialClient.verifyCredential} that
   * issues all simulations concurrently.
   *
   * @param callerAddress Stellar address used to build the read simulations.
   * @param credentialIds Hex-encoded credential IDs (32 bytes each).
   * @param options       Per-call overrides (applied to each underlying call).
   * @returns Array of {@link VerifyResult} in the same order as `credentialIds`.
   * @throws {SorobanIdentityError} if any individual simulation fails
   *   irrecoverably (network errors); per-credential validity failures are
   *   represented in the returned array.
   */
  async verifyCredentialsBatch(
    callerAddress: string,
    credentialIds: string[],
    options?: CallOptions
  ): Promise<VerifyResult[]> {
    validateStellarAddress(callerAddress);
    return Promise.all(
      credentialIds.map((id) => this.verifyCredential(callerAddress, id, options))
    );
  }

  /**
   * Get the total number of credentials issued to a subject.
   *
   * Counter is incremented on each successful issue; it is NOT decremented on
   * revoke. Use {@link CredentialClient.listCredentialsBySubject} with `revoked`
   * filtering if you need active counts.
   *
   * @param callerAddress  Stellar address used to build the read simulation.
   * @param subjectAddress The subject whose count to retrieve.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns Number of credentials ever issued to `subjectAddress`.
   * @throws {SorobanIdentityError} on simulation failure.
   */
  async getCredentialCount(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<number> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_credential_count",
          nativeToScVal(subjectAddress, { type: "address" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as number;
  }

  /**
   * Get the list of all registered issuers.
   *
   * Returns the entire roster in one call. For large registries use the
   * paginated {@link CredentialClient.listIssuers} (see issue #248).
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns Array of issuer Stellar addresses.
   * @throws {SorobanIdentityError} on simulation failure.
   */
  async getIssuers(callerAddress: string, options?: CallOptions): Promise<string[]> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("get_issuers"))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    const issuers = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as string[];

    return issuers;
  }

  /**
   * Get storage usage statistics for the credential manager.
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns Current {@link CredentialStorageStats}.
   * @throws {SorobanIdentityError} on simulation failure.
   */
  async getStorageStats(callerAddress: string, options?: CallOptions): Promise<CredentialStorageStats> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("get_storage_stats"))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'credentials.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as CredentialStorageStats;
  }

  /**
   * Cursor-paginated, optionally type-filtered variant of
   * {@link CredentialClient.getCredentialsBySubject}.
   *
   * Combines [issue #248](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/248)
   * (pagination) and [issue #251](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/251)
   * (type filter). Each call returns one page of credential IDs;
   * `options.credentialType` filters to a single
   * {@link CredentialType}, and `nextCursor` is `null` once the iterator is exhausted.
   *
   * Filtering is applied AFTER the cursor advances, so a page may return fewer
   * items than `limit` (or zero) without implying the end of the list. Always
   * advance while `nextCursor !== null`, not on `items.length`.
   *
   * Unlike `getCredentialsBySubject`, this method returns IDs only — fetch the
   * full credentials with {@link CredentialClient.getCredential} as needed.
   *
   * @param callerAddress   Stellar address used to build the read-only simulation.
   * @param subjectAddress  The subject whose credential IDs to retrieve.
   * @param options         Pagination + filter + per-call overrides.
   * @returns Page of credential IDs (hex-encoded) with the next resume cursor.
   * @throws {SorobanIdentityError} on simulation failure.
   *
   * @example
   * ```ts
   * let cursor: number | undefined;
   * const ids: string[] = [];
   * do {
   *   const page = await credentials.listCredentialsBySubject(caller, subject, {
   *     cursor,
   *     limit: 50,
   *     credentialType: 'Kyc',
   *   });
   *   ids.push(...page.items);
   *   cursor = page.nextCursor ?? undefined;
   * } while (cursor !== undefined);
   * ```
   */
  async listCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string,
    options?: CredentialListOptions
  ): Promise<Page<string>> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const cursorArg = options?.cursor === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.cursor }, {
          type: { Some: ['u64'] } as never,
        });
    const filterArg = options?.credentialType === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.credentialType }, {
          type: { Some: ['symbol'] } as never,
        });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'list_subject_credentials',
          nativeToScVal(subjectAddress, { type: 'address' }),
          cursorArg,
          nativeToScVal(options?.limit ?? 0, { type: 'u32' }),
          filterArg
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: Uint8Array[]; next_cursor: number | null };

    return {
      items: raw.items.map((b) => Buffer.from(b).toString('hex')),
      nextCursor: raw.next_cursor ?? null,
    };
  }

  /**
   * Cursor-paginated variant of {@link CredentialClient.getIssuers}.
   *
   * See [issue #248](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/248).
   *
   * @param callerAddress  Stellar address used to build the read-only simulation.
   * @param options        Pagination + per-call overrides.
   * @returns Page of issuer addresses with the next resume cursor.
   * @throws {SorobanIdentityError} on simulation failure.
   */
  async listIssuers(
    callerAddress: string,
    options?: PaginationOptions
  ): Promise<Page<string>> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const cursorArg = options?.cursor === undefined
      ? nativeToScVal(null, { type: 'option' })
      : nativeToScVal({ Some: options.cursor }, {
          type: { Some: ['u64'] } as never,
        });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'list_issuers',
          cursorArg,
          nativeToScVal(options?.limit ?? 0, { type: 'u32' })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, CREDENTIAL_MANAGER_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: string[]; next_cursor: number | null };

    return { items: raw.items, nextCursor: raw.next_cursor ?? null };
  }
}
