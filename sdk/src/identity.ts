import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  Account,
} from "@stellar/stellar-sdk";
import type { CallOptions, DidDocument, IdentityStorageStats, SorobanIdentityConfig, WriteResult } from "./types";
import { retryWithBackoff, validateStellarAddress, pollTransactionStatus } from "./utils";
import { ContractError, SorobanIdentityError } from "./errors";
import { IDENTITY_REGISTRY_ERRORS } from "./error-codes";
import { BaseClient } from "./base-client";

// Dummy address used for lightweight initialization probes
const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

export class IdentityClient extends BaseClient {
  constructor(config: SorobanIdentityConfig) {
    super(config, config.identityRegistryId);
  }

  /**
   * Returns true if the identity-registry contract has been initialized.
   * Uses a lightweight read call; returns false on any contract-level error.
   */
  async isInitialized(): Promise<boolean> {
    try {
      return await this.executeWithFailover(async (server) => {
        const account = new Account(PROBE_ADDRESS, "0");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "has_active_did",
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
   * Create a new DID for the given keypair.
   * Returns the DID string and the estimated transaction fee.
   */
  async createDid(
    keypair: Keypair,
    metadata: Record<string, string> = {},
    options?: CallOptions
  ): Promise<{ did: string } & WriteResult> {
    const account = await this.server.getAccount(keypair.publicKey());

    const metaScVal = nativeToScVal(metadata, { type: "map" });
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "create_did",
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          metaScVal
        )
      )
      .setTimeout(timeout)
      .build();

    const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
    const estimatedFee = parseInt(prepared.fee, 10);
    const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
    prepared.sign(keypair);

    const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    try {
      await pollTransactionStatus(this.server, result.hash, {
        maxAttempts: this.config.pollingRetries,
        intervalMs: this.config.pollingIntervalMs,
        exponentialBackoff: this.config.pollingExponentialBackoff,
      });
      const confirmed = await this.server.getTransaction(result.hash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      const did = scValToNative(confirmed.returnValue!) as string;
      return { did, estimatedFee, estimatedFeeXlm };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID already exists")) {
        throw new SorobanIdentityError(
          `A DID already exists for address ${keypair.publicKey()}. Each address can only have one DID.`,
          "VALIDATION_ERROR"
        );
      }
      throw e;
    }
  }

  /**
   * Update metadata on an existing DID.
   */
  async updateDid(
    keypair: Keypair,
    metadata: Record<string, string>,
    options?: CallOptions
  ): Promise<void> {
    const account = await this.server.getAccount(keypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "update_did",
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(metadata, { type: "map" })
        )
      )
      .setTimeout(timeout)
      .build();

    const prepared = await retryWithBackoff(() => this.server.prepareTransaction(tx));
    prepared.sign(keypair);

    const result = await retryWithBackoff(() => this.server.sendTransaction(prepared));
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    try {
      await pollTransactionStatus(this.server, result.hash, {
        maxAttempts: this.config.pollingRetries,
        intervalMs: this.config.pollingIntervalMs,
        exponentialBackoff: this.config.pollingExponentialBackoff,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID not found")) {
        throw new SorobanIdentityError(
          `No DID found for address ${keypair.publicKey()}. Create one first with createDid.`,
          "NOT_FOUND"
        );
      }
      if (msg.includes("require_auth") || msg.includes("not authorized")) {
        throw new SorobanIdentityError(
          `Address ${keypair.publicKey()} is not the controller of this DID.`,
          "UNAUTHORIZED"
        );
      }
      throw e;
    }
  }

  /**
   * Resolve a DID document by controller address.
   */
  async resolveDid(controllerAddress: string, options?: CallOptions): Promise<DidDocument> {
    validateStellarAddress(controllerAddress);
    const account = new Account(controllerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "resolve_did",
          nativeToScVal(controllerAddress, { type: "address" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      if (errMsg.includes("DidDeactivated")) {
        throw new SorobanIdentityError(`DID for address ${controllerAddress} has been deactivated.`, "VALIDATION_ERROR");
      }
      if (errMsg.includes("DidNotFound")) {
        throw new SorobanIdentityError(`No DID found for address ${controllerAddress}.`, "NOT_FOUND");
      }
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as DidDocument;
  }

  /**
   * Check if an address has an active DID.
   */
  async hasActiveDid(controllerAddress: string, options?: CallOptions): Promise<boolean> {
    validateStellarAddress(controllerAddress);
    const account = new Account(controllerAddress, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "has_active_did",
          nativeToScVal(controllerAddress, { type: "address" })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;
  }

  /**
   * Get the total count of active DIDs.
   */
  async getDidCount(options?: CallOptions): Promise<number> {
    const account = new Account(this.config.identityRegistryId, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call("get_did_count")
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError("Failed to get DID count", "UNKNOWN");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as number;
  }

  /**
   * Deactivate the DID associated with the given keypair.
   * Throws if the DID is not found or is already inactive.
   */
  async deactivateDid(keypair: Keypair): Promise<void> {
    const isActive = await this.hasActiveDid(keypair.publicKey());
    if (!isActive) {
      throw new SorobanIdentityError(
        `DID for ${keypair.publicKey()} is already inactive or does not exist`,
        "VALIDATION_ERROR"
      );
    }

    const account = await this.server.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "deactivate_did",
          nativeToScVal(keypair.publicKey(), { type: "address" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(keypair);

    const result = await this.server.sendTransaction(prepared);
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    await pollTransactionStatus(this.server, result.hash, {
      maxAttempts: this.config.pollingRetries,
      intervalMs: this.config.pollingIntervalMs,
      exponentialBackoff: this.config.pollingExponentialBackoff,
    });
  }

  /** Get storage usage statistics for the identity registry. */
  async getStorageStats(callerAddress: string, options?: CallOptions): Promise<IdentityStorageStats> {
    validateStellarAddress(callerAddress);
    const account = new Account(callerAddress, "0");
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
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, "CONTRACT_ERROR");
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as IdentityStorageStats;
  }
}
