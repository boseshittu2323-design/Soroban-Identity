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

/**
 * Client for the identity-registry contract.
 *
 * Manages decentralised identifiers (DIDs) on Soroban: creation, metadata
 * updates, resolution, and deactivation. All methods accept an optional
 * {@link CallOptions} for per-call overrides (e.g. transaction timeout).
 *
 * @example
 * ```ts
 * import { IdentityClient, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const identity = new IdentityClient({ ...TESTNET_CONFIG, identityRegistryId: '...' });
 * const { did } = await identity.createDid(keypair, { email: 'a@b.c' });
 * ```
 */
export class IdentityClient extends BaseClient {
  /**
   * @param config SDK config including the deployed identity-registry contract ID.
   */
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
   *
   * Submits a `create_did` call to the identity-registry contract, signed by
   * `keypair`, and polls until the transaction is final. The on-chain ID is
   * derived from the keypair's public key.
   *
   * @param keypair  The Stellar keypair whose public key will own the DID.
   *                 Must be funded on the active network.
   * @param metadata Arbitrary `string → string` map embedded in the DID document.
   *                 Defaults to `{}`.
   * @param options  Per-call overrides (currently `timeoutSeconds`).
   * @returns The resolved DID and the estimated transaction fee.
   * @throws {SorobanIdentityError} with code `VALIDATION_ERROR` if a DID already
   *   exists for this address, or `CONTRACT_ERROR` for any other submission failure.
   *
   * @example
   * ```ts
   * const { did, estimatedFeeXlm } = await identity.createDid(keypair, { email: 'a@b.c' });
   * console.log(`Issued ${did} for ~${estimatedFeeXlm} XLM`);
   * ```
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
    this.debug('sdk.submission_outcome', { operation: 'identity.sendTransaction', status: result.status });
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
   *
   * Replaces the DID document's metadata map. The caller must control the DID
   * being modified — the contract calls `require_auth` on the keypair's address.
   *
   * @param keypair  Controller of the DID being updated. Must sign the transaction.
   * @param metadata Replacement metadata map.
   * @param options  Per-call overrides (currently `timeoutSeconds`).
   * @returns Resolves once the transaction is final on-chain.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` if no DID exists for
   *   `keypair`, `UNAUTHORIZED` if `keypair` is not the DID controller, or
   *   `CONTRACT_ERROR` for any other submission failure.
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
    this.debug('sdk.submission_outcome', { operation: 'identity.sendTransaction', status: result.status });
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
   *
   * Read-only simulation; no transaction is submitted.
   *
   * @param controllerAddress The Stellar address that controls the DID.
   * @param options           Per-call overrides (currently `timeoutSeconds`).
   * @returns The {@link DidDocument} for `controllerAddress`.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` if no DID exists or
   *   `CONTRACT_ERROR` on simulation failure.
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
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
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
   * Check if an address has an active (non-deactivated) DID.
   *
   * @param controllerAddress The Stellar address to check.
   * @param options           Per-call overrides (currently `timeoutSeconds`).
   * @returns `true` if a non-deactivated DID exists, `false` otherwise.
   * @throws {SorobanIdentityError} on simulation failure.
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
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;
  }

  /**
   * Get the total count of active DIDs registered.
   *
   * Uses {@link PROBE_ADDRESS} for the read simulation so no specific caller
   * account is required.
   *
   * @param options Per-call overrides (currently `timeoutSeconds`).
   * @returns Total active DIDs across the registry.
   * @throws {SorobanIdentityError} on simulation failure.
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
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
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
   * Deactivate the DID owned by `keypair`.
   *
   * Marks the DID inactive on-chain; subsequent `hasActiveDid` returns `false`.
   * Deactivation is irreversible.
   *
   * @param keypair Controller of the DID being deactivated.
   * @returns Resolves once the transaction is final on-chain.
   * @throws {SorobanIdentityError} with code `NOT_FOUND` if the DID does not
   *   exist or is already inactive, or `CONTRACT_ERROR` for other submission
   *   failures.
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
    this.debug('sdk.submission_outcome', { operation: 'identity.deactivateDid.sendTransaction', status: result.status });
    if (result.status !== "PENDING") {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, "CONTRACT_ERROR");
    }

    await pollTransactionStatus(this.server, result.hash, {
      maxAttempts: this.config.pollingRetries,
      intervalMs: this.config.pollingIntervalMs,
      exponentialBackoff: this.config.pollingExponentialBackoff,
    });
  }

  /**
   * Get storage usage statistics for the identity registry.
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns The current {@link IdentityStorageStats}.
   * @throws {SorobanIdentityError} on simulation failure.
   */
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
    const isSimulationError = SorobanRpc.Api.isSimulationError(result);
    this.debug('sdk.simulation_result', { operation: 'identity.simulateTransaction', success: !isSimulationError });
    if (isSimulationError) {
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
