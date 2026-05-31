import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { CallOptions, Credential, CredentialStorageStats, CredentialType, SorobanIdentityConfig, VerifyResult, WriteResult } from "./types";
import { retryWithBackoff, validateStellarAddress, pollTransactionStatus } from "./utils";
import { ContractError, SorobanIdentityError } from "./errors";
import { CREDENTIAL_MANAGER_ERRORS } from "./error-codes";
import { BaseClient } from "./base-client";

const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const CREDENTIAL_VERIFY_NOT_FOUND_CODE = 2;
const CREDENTIAL_NOT_FOUND_CODE = 3;
const CREDENTIAL_REVOKED_CODE = 4;

export class CredentialClient extends BaseClient {
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
   * @param claimsHashHex 64-char hex string (32 bytes) — SHA-256 hash of the off-chain claims payload.
   * @param signatureHex Optional pre-computed 64-byte signature as a 128-char hex string.
   *                     If omitted, the signature is derived from issuerKeypair.
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

    await pollTransactionStatus(this.server, result.hash);
    const confirmed = await this.server.getTransaction(result.hash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
    // Returns BytesN<32> — encode as hex
    const raw = scValToNative(confirmed.returnValue!) as Uint8Array;
    const credentialId = Buffer.from(raw).toString("hex");
    return { credentialId, estimatedFee, estimatedFeeXlm };
  }

  /**
   * Verify a credential is valid (not revoked, not expired).
   * Returns a typed result so callers can distinguish failure reasons.
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
   * Throws "CredentialNotFound" if the ID was never issued.
   * Throws "CredentialRevoked" if the credential was issued but later revoked.
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
   * Returns an array of VerifyResult in the same order as the input credentialIds.
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
   * Get the total number of credentials issued to a subject (decremented on revoke).
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
   * Get the list of all registered issuers. No auth required — read-only.
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

  /** Get storage usage statistics for the credential manager. */
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
}
