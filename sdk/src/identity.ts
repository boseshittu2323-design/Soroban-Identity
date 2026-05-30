import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { CallOptions, DidDocument, IdentityStorageStats, SorobanIdentityConfig, WriteResult } from "./types";
import { retryWithBackoff, validateStellarAddress, pollTransactionStatus } from "./utils";
import { ContractError } from "./errors";
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
        const account = await server.getAccount(PROBE_ADDRESS);
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
      throw new Error(`Transaction failed: ${result.status}`);
    }

    try {
      await pollTransactionStatus(this.server, result.hash);
      const confirmed = await this.server.getTransaction(result.hash) as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      const did = scValToNative(confirmed.returnValue!) as string;
      return { did, estimatedFee, estimatedFeeXlm };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID already exists")) {
        throw new Error(
          `A DID already exists for address ${keypair.publicKey()}. Each address can only have one DID.`
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
      throw new Error(`Transaction failed: ${result.status}`);
    }

    try {
      await pollTransactionStatus(this.server, result.hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID not found")) {
        throw new Error(
          `No DID found for address ${keypair.publicKey()}. Create one first with createDid.`
        );
      }
      if (msg.includes("require_auth") || msg.includes("not authorized")) {
        throw new Error(
          `Address ${keypair.publicKey()} is not the controller of this DID.`
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
    const account = await this.server.getAccount(controllerAddress);
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
        throw new Error(`DID for address ${controllerAddress} has been deactivated.`);
      }
      if (errMsg.includes("DidNotFound")) {
        throw new Error(`No DID found for address ${controllerAddress}.`);
      }
      throw new Error(`Simulation failed: ${errMsg}`);
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
    const account = await this.server.getAccount(controllerAddress);
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
    const account = await this.server.getAccount(this.config.identityRegistryId);
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
      throw new Error("Failed to get DID count");
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
      throw new Error(
        `DID for ${keypair.publicKey()} is already inactive or does not exist`
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
      throw new Error(`Transaction failed: ${result.status}`);
    }

    await pollTransactionStatus(this.server, result.hash);
  }

  /** Get storage usage statistics for the identity registry. */
  async getStorageStats(callerAddress: string, options?: CallOptions): Promise<IdentityStorageStats> {
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
      const errMsg = result.error ?? "";
      const contractErr = ContractError.extract(errMsg, IDENTITY_REGISTRY_ERRORS);
      if (contractErr) throw contractErr;
      throw new Error(`Simulation failed: ${errMsg}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as IdentityStorageStats;
  }
}
