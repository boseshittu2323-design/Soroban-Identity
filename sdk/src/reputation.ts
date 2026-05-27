import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import type {
  CallOptions,
  ReputationStorageStats,
  SorobanIdentityConfig,
  WriteResult,
} from './types';
import {
  retryWithBackoff,
  validateStellarAddress,
  pollTransactionStatus,
} from './utils';
import { SorobanTransactionBuilder } from './transaction-builder';

export interface ReputationRecord {
  subject: string;
  score: number;
  reporterCount: number;
  updatedAt: number;
}

export interface ScoreHistoryEntry {
  reporter: string;
  delta: number;
  reason: string;
  submittedAt: number;
}

export class ReputationClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.reputationId);
  }

  /** Get the list of all registered reporters. */
  async getReporters(
    callerAddress: string,
    options?: CallOptions
  ): Promise<string[]> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call('get_reporters_list'))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as string[];
  }

  /** Get the reputation record for a subject. Returns a zero record if the subject has no history. */
  async getReputation(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<ReputationRecord> {
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
          'get_reputation',
          nativeToScVal(subjectAddress, { type: 'address' })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg: string = (result as { error: string }).error ?? '';
      // Contract returns a default record for unknown subjects — a simulation error here
      // means the subject truly has no record. Return the zero default instead of throwing.
      if (
        errMsg.includes('not found') ||
        errMsg.includes('no record') ||
        errMsg.includes('MissingValue') ||
        errMsg.includes('KeyNotFound')
      ) {
        return {
          subject: subjectAddress,
          score: 0,
          reporterCount: 0,
          updatedAt: 0,
        };
      }
      throw new Error(`Simulation failed: ${errMsg}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ReputationRecord;
  }

  /**
   * Get score submission history for a subject from a specific reporter.
   *
   * @param callerAddress   - Stellar address used to build the transaction.
   * @param subjectAddress  - The subject whose history is being queried.
   * @param reporterAddress - The reporter whose submissions to retrieve.
   * @param offset          - Number of entries to skip (default: 0).
   * @param limit           - Maximum entries to return (default: 20, contract cap: 100).
   */
  async getScoreHistory(
    callerAddress: string,
    subjectAddress: string,
    reporterAddress: string,
    offset = 0,
    limit = 20,
    options?: CallOptions
  ): Promise<ScoreHistoryEntry[]> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    validateStellarAddress(reporterAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'get_history',
          nativeToScVal(subjectAddress, { type: 'address' }),
          nativeToScVal(reporterAddress, { type: 'address' }),
          nativeToScVal(offset, { type: 'u32' }),
          nativeToScVal(limit, { type: 'u32' })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ScoreHistoryEntry[];
  }

  /** Check if a subject passes the sybil threshold using the contract's stored default. */
  async passesSybilCheckDefault(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<boolean> {
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
          'passes_sybil_check_default',
          nativeToScVal(subjectAddress, { type: 'address' })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as boolean;
  }

  /** Check if a subject passes the sybil threshold. */
  async passesSybilCheck(
    callerAddress: string,
    subjectAddress: string,
    minScore: number,
    minReporters: number,
    options?: CallOptions
  ): Promise<boolean> {
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
          'passes_sybil_check',
          nativeToScVal(subjectAddress, { type: 'address' }),
          nativeToScVal(minScore, { type: 'i64' }),
          nativeToScVal(minReporters, { type: 'u32' })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as boolean;
  }

  /** Submit a score delta. Caller must be a registered reporter. */
  async submitScore(
    reporterKeypair: Keypair,
    subjectAddress: string,
    delta: number,
    reason: string,
    options?: CallOptions
  ): Promise<WriteResult> {
    const account = await this.server.getAccount(reporterKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    // Use the transaction builder for construction
    const builder = new SorobanTransactionBuilder(account, this.config);
    builder.addContractCall(
      this.config.reputationId,
      'submit_score',
      nativeToScVal(reporterKeypair.publicKey(), { type: 'address' }),
      nativeToScVal(subjectAddress, { type: 'address' }),
      nativeToScVal(delta, { type: 'i64' }),
      nativeToScVal(reason, { type: 'string' })
    );

    const tx = builder.build(timeout);
    const prepared = await retryWithBackoff(() =>
      this.server.prepareTransaction(tx)
    );
    const estimatedFee = parseInt(prepared.fee, 10);
    const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
    prepared.sign(reporterKeypair);

    const result = await retryWithBackoff(() =>
      this.server.sendTransaction(prepared)
    );
    if (result.status !== 'PENDING') {
      throw new Error(`Transaction failed: ${result.status}`);
    }

    await pollTransactionStatus(this.server, result.hash);
    return { estimatedFee, estimatedFeeXlm };
  }

  /** Get storage usage statistics for the reputation contract. */
  async getStorageStats(
    callerAddress: string,
    options?: CallOptions
  ): Promise<ReputationStorageStats> {
    validateStellarAddress(callerAddress);
    const account = await this.server.getAccount(callerAddress);
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call('get_storage_stats'))
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ReputationStorageStats;
  }
}
