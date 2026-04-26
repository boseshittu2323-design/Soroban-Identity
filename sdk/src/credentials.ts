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

export class CredentialClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.credentialManagerId);
  }

  /**
   * Issue a credential to a subject. Caller must be a registered issuer.
   * @param signatureHex Optional pre-computed 64-byte signature as a 128-char hex string.
   *                     If omitted, the signature is derived from issuerKeypair.
   */
  async issueCredential(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    expiresAt = 0,
    options?: CallOptions,
    signatureHex?: string
  ): Promise<{ credentialId: string } & WriteResult> {
    if (signatureHex !== undefined) {
      if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
        throw new Error(
          "InvalidSignatureFormat: signature must be a 128-character hex string (64 bytes)"
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
    if (result.status !== "PENDING") {
      throw new Error(`Transaction failed: ${result.status}`);
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

    if (SorobanRpc.Api.isSimulationError(result)) {
      const error: string = (result as { error: string }).error ?? "";
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
    if (SorobanRpc.Api.isSimulationError(idsResult)) {
      throw new Error(`Simulation failed: ${idsResult.error}`);
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
    if (SorobanRpc.Api.isSimulationError(result)) {
      const error: string = (result as { error: string }).error ?? "";
      if (error.includes("CredentialNotFound") || error.includes("#3")) {
        throw new Error("CredentialNotFound: credential does not exist");
      }
      if (error.includes("CredentialRevoked") || error.includes("#4")) {
        throw new Error("CredentialRevoked: credential has been revoked");
      }
      throw new Error(`Simulation failed: ${error}`);
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
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
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
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
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
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
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
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as CredentialStorageStats;
  }
}
