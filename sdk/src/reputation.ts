import {
  Account,
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
  Page,
  PaginationOptions,
  ReputationStorageStats,
  SorobanIdentityConfig,
  SorobanResponse,
  WriteResult,
} from './types';
import { validateConfig } from './types';
import {
  retryWithBackoff,
  validateStellarAddress,
  pollTransactionStatus,
  runConcurrent,
} from './utils';
import { SorobanTransactionBuilder } from './transaction-builder';
import { ContractError, SorobanIdentityError } from "./errors";
import { REPUTATION_ERRORS } from './error-codes';
import { BaseClient } from './base-client';
import {
  buildGetReputationArgs,
  buildGetHistoryArgs,
  buildPassesSybilCheckDefaultArgs,
  buildPassesSybilCheckArgs,
  buildSubmitScoreArgs,
  buildListReportersArgs,
  buildListHistoryArgs,
} from './contract-args';

const PROBE_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

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

/**
 * Client for the reputation contract.
 *
 * Records score submissions from trusted reporters and answers anti-sybil
 * threshold questions. Use {@link ReputationClient.listScoreHistory} and
 * {@link ReputationClient.listReporters} for cursor-paginated reads (see
 * issue #248).
 *
 * @example
 * ```ts
 * import { ReputationClient, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const reputation = new ReputationClient({ ...TESTNET_CONFIG, reputationId: '...' });
 * const ok = await reputation.passesSybilCheckDefault(caller, subject);
 * ```
 */
export class ReputationClient extends BaseClient {
  /**
   * @param config SDK config including the deployed reputation contract ID.
   */
  constructor(config: SorobanIdentityConfig) {
    validateConfig(config, { contractIdField: 'reputationId' });
    super(config, config.reputationId);
  }

  /** Returns true if the reputation contract has been initialized. */
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
              'passes_sybil_check_default',
              ...buildPassesSybilCheckDefaultArgs({ subject: PROBE_ADDRESS })
            )
          )
          .setTimeout(10)
          .build();

        const result = await server.simulateTransaction(tx);
        this.debug('sdk.simulation_result', {
          operation: 'reputation.isInitialized',
          success: !SorobanRpc.Api.isSimulationError(result),
        });

        if (SorobanRpc.Api.isSimulationError(result)) {
          const err: string = (result as { error: string }).error ?? '';
          if (
            err.includes('not initialized') ||
            err.includes('NotInitialized') ||
            err.includes('#0')
          ) {
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
   * Get the list of all registered reporters.
   *
   * Returns the entire roster in one call. For large registries use the
   * paginated {@link ReputationClient.listReporters} (see issue #248).
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns Array of reporter Stellar addresses.
   * @throws {SorobanIdentityError} on simulation failure.
   */
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
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as string[];
  }

  /**
   * Get the aggregate reputation record for a subject.
   *
   * @param callerAddress  Stellar address used to build the read simulation.
   * @param subjectAddress The subject whose record to retrieve.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns The {@link ReputationRecord}. If no record exists yet, returns a
   *   zero record (`score: 0`, `reporterCount: 0`, `updatedAt: 0`).
   * @throws {SorobanIdentityError} on simulation failure unrelated to a
   *   missing record.
   */
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
          ...buildGetReputationArgs({ subject: subjectAddress })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg: string = (result as { error: string }).error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr?.code === 2) {
        return { subject: subjectAddress, score: 0, reporterCount: 0, updatedAt: 0 };
      }
      if (contractErr) throw contractErr;
      // Fallback text checks for non-numeric error formats
      if (
        errMsg.includes('not found') ||
        errMsg.includes('no record') ||
        errMsg.includes('MissingValue') ||
        errMsg.includes('KeyNotFound')
      ) {
        return { subject: subjectAddress, score: 0, reporterCount: 0, updatedAt: 0 };
      }
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ReputationRecord;
  }

  /**
   * Get score submission history for a subject from a specific reporter
   * (offset-based).
   *
   * Returns a raw entry slice. Prefer the cursor-based
   * {@link ReputationClient.listScoreHistory} for new code — it returns a
   * `nextCursor` instead of forcing callers to track offsets.
   *
   * @param callerAddress   Stellar address used to build the read simulation.
   * @param subjectAddress  The subject whose history is being queried.
   * @param reporterAddress The reporter whose submissions to retrieve.
   * @param offset          Number of entries to skip. Defaults to `0`.
   * @param limit           Maximum entries to return. Defaults to `20`,
   *                        clamped to `100` server-side.
   * @param options         Per-call overrides (currently `timeoutSeconds`).
   * @returns Array of {@link ScoreHistoryEntry}.
   * @throws {SorobanIdentityError} on simulation failure (including
   *   `ReporterNotFound` when the reporter is not registered).
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
          ...buildGetHistoryArgs({
            subject: subjectAddress,
            reporter: reporterAddress,
            offset,
            limit,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() =>
      this.server.simulateTransaction(tx)
    );
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ScoreHistoryEntry[];
  }

  /**
   * Check if a subject passes the sybil threshold using the contract's stored
   * default (set via the admin-only `set_default_threshold`).
   *
   * @param callerAddress  Stellar address used to build the read simulation.
   * @param subjectAddress The subject to evaluate.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns `true` if the subject's record meets the stored default thresholds.
   *   `false` if the subject has no record yet or fails either threshold.
   * @throws {SorobanIdentityError} with code `CONTRACT_ERROR` when the contract
   *   has not been initialized, or on simulation failure.
   */
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
          ...buildPassesSybilCheckDefaultArgs({ subject: subjectAddress })
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

  /**
   * Check if a subject passes a caller-supplied sybil threshold.
   *
   * Passes only when the subject's accumulated score is ≥ `minScore` AND at
   * least `minReporters` currently-registered reporters have submitted for them.
   * Removed reporters don't count toward the active-reporter tally.
   *
   * @param callerAddress  Stellar address used to build the read simulation.
   * @param subjectAddress The subject to evaluate.
   * @param minScore       Minimum accumulated score required to pass.
   * @param minReporters   Minimum number of distinct active reporters required.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns `true` if both thresholds are met.
   * @throws {SorobanIdentityError} on simulation failure.
   */
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
          ...buildPassesSybilCheckArgs({ subject: subjectAddress, minScore: BigInt(minScore), minReporters })
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

  /**
   * Submit a score delta for a subject. Caller must be a registered reporter.
   *
   * Builds, signs, and submits a `submit_score` transaction. The contract
   * enforces a minimum-interval rate limit per `(reporter, subject)` pair.
   *
   * @param reporterKeypair Registered reporter signing the transaction.
   * @param subjectAddress  The subject receiving the score delta.
   * @param delta           Signed score change (positive or negative).
   * @param reason          Human-readable reason string. Length-capped on chain.
   * @param options         Per-call overrides (currently `timeoutSeconds`).
   * @returns The estimated transaction fee.
   * @throws {SorobanIdentityError} with code `CONTRACT_ERROR` when the reporter
   *   is unregistered, rate-limited, or the reason is too long; or for any
   *   other submission failure.
   */
  async submitScore(
    reporterKeypair: Keypair,
    subjectAddress: string,
    delta: number,
    reason: string,
    options?: CallOptions
  ): Promise<SorobanResponse<WriteResult>> {
    const account = await this.server.getAccount(reporterKeypair.publicKey());
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;

    // Use the transaction builder for construction
    const builder = new SorobanTransactionBuilder(account, this.config);
    builder.addContractCall(
      this.config.reputationId,
      'submit_score',
      ...buildSubmitScoreArgs({
        reporter: reporterKeypair.publicKey(),
        subject: subjectAddress,
        delta: BigInt(delta),
        reason,
      })
    );

    const tx = builder.build(timeout);
    const prepared = await retryWithBackoff(() =>
      this.server.prepareTransaction(tx)
    );
    this.debug('sdk.simulation_result', { operation: 'reputation.submitScore.prepare', success: true });
    const estimatedFee = parseInt(prepared.fee, 10);
    const estimatedFeeXlm = (estimatedFee / 10_000_000).toFixed(7);
    prepared.sign(reporterKeypair);

    const result = await retryWithBackoff(() =>
      this.server.sendTransaction(prepared)
    );
    this.debug('sdk.submission_outcome', { operation: 'reputation.submitScore.send', status: result.status });
    if (result.status !== 'PENDING') {
      throw new SorobanIdentityError(`Transaction failed: ${result.status}`, 'CONTRACT_ERROR');
    }

    const txHash = result.hash;
    await pollTransactionStatus(this.server, txHash, {
      maxAttempts: this.config.pollingRetries,
      intervalMs: this.config.pollingIntervalMs,
      exponentialBackoff: this.config.pollingExponentialBackoff,
    });
    return { data: { estimatedFee, estimatedFeeXlm }, txHash };
  }

  /**
   * Fetch reputation records for multiple addresses in parallel.
   *
   * Useful for leaderboard views that need scores for N subjects without N
   * sequential round-trips. Runs up to `concurrency`
   * (default: `config.maxConcurrentRequests ?? 5`) simulate calls at a time.
   * Results are returned in the same order as `addresses`.
   *
   * @param callerAddress Stellar address used to build the read simulations.
   * @param addresses     Subject addresses to look up.
   * @param options       Per-call overrides; `concurrency` caps parallel RPC calls.
   * @returns Array of {@link ReputationRecord} in input order. Addresses with no
   *          record return a zero record (`score: 0, reporterCount: 0, updatedAt: 0`).
   */
  async getScores(
    callerAddress: string,
    addresses: string[],
    options?: CallOptions & { concurrency?: number }
  ): Promise<ReputationRecord[]> {
    validateStellarAddress(callerAddress);
    const concurrency = options?.concurrency ?? this.config.maxConcurrentRequests ?? 5;
    return runConcurrent(
      addresses,
      (address) => this.getReputation(callerAddress, address, options),
      concurrency
    );
  }

  /**
   * Get storage usage statistics for the reputation contract.
   *
   * @param callerAddress Stellar address used to build the read simulation.
   * @param options       Per-call overrides (currently `timeoutSeconds`).
   * @returns Current {@link ReputationStorageStats}.
   * @throws {SorobanIdentityError} on simulation failure.
   */
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
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!
        .retval
    ) as ReputationStorageStats;
  }

  /**
   * Get one page of registered reporter addresses.
   *
   * Cursor-paginated equivalent of {@link ReputationClient.getReporters}.
   * See [issue #248](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/248).
   *
   * @param callerAddress  Stellar address used to build the read-only simulation.
   * @param options        Pagination + per-call overrides.
   *                       `cursor` resumes from a prior page's `nextCursor`;
   *                       `limit` is clamped to 100 server-side.
   * @returns A page of reporter addresses with the next resume cursor (or `null`
   *          when the list is exhausted).
   * @throws {SorobanIdentityError} on simulation failure (network or contract error).
   *
   * @example
   * ```ts
   * let cursor: number | undefined;
   * do {
   *   const page = await reputation.listReporters(caller, { cursor, limit: 25 });
   *   handle(page.items);
   *   cursor = page.nextCursor ?? undefined;
   * } while (cursor !== undefined);
   * ```
   */
  async listReporters(
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
          'list_reporters',
          ...buildListReportersArgs({ cursor: cursorArg, limit: options?.limit ?? 0 })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: string[]; next_cursor: number | null };

    return { items: raw.items, nextCursor: raw.next_cursor ?? null };
  }

  /**
   * Cursor-paginated variant of {@link ReputationClient.getScoreHistory}.
   *
   * See [issue #248](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/248).
   *
   * @param callerAddress   Stellar address used to build the read-only simulation.
   * @param subjectAddress  Subject whose history is being queried.
   * @param reporterAddress Reporter whose submissions to include.
   * @param options         Pagination + per-call overrides.
   * @returns A page of {@link ScoreHistoryEntry} with the next resume cursor.
   * @throws {SorobanIdentityError} on simulation failure (network or contract error,
   *         including `ReporterNotFound` when the reporter is not registered).
   */
  /**
   * Get the current numeric score for a subject.
   *
   * Convenience wrapper around {@link ReputationClient.getReputation} that
   * returns only the score field. Use this when you only need the number and
   * don't want to carry the full record.
   *
   * @param callerAddress  Stellar address used to build the read simulation.
   * @param subjectAddress The subject whose score to retrieve.
   * @param options        Per-call overrides (currently `timeoutSeconds`).
   * @returns The subject's current accumulated score (0 when no record exists).
   * @throws {SorobanIdentityError} on simulation failure unrelated to a
   *   missing record.
   */
  async getScore(
    callerAddress: string,
    subjectAddress: string,
    options?: CallOptions
  ): Promise<number> {
    const record = await this.getReputation(callerAddress, subjectAddress, options);
    return record.score;
  }

  async listScoreHistory(
    callerAddress: string,
    subjectAddress: string,
    reporterAddress: string,
    options?: PaginationOptions
  ): Promise<Page<ScoreHistoryEntry>> {
    validateStellarAddress(callerAddress);
    validateStellarAddress(subjectAddress);
    validateStellarAddress(reporterAddress);
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
          'list_history',
          ...buildListHistoryArgs({
            subject: subjectAddress,
            reporter: reporterAddress,
            cursor: cursorArg,
            limit: options?.limit ?? 0,
          })
        )
      )
      .setTimeout(timeout)
      .build();

    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      const errMsg = result.error ?? '';
      const contractErr = ContractError.extract(errMsg, REPUTATION_ERRORS);
      if (contractErr) throw contractErr;
      throw new SorobanIdentityError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
    }

    const raw = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as { items: ScoreHistoryEntry[]; next_cursor: number | null };

    return { items: raw.items, nextCursor: raw.next_cursor ?? null };
  }

  /**
   * Liveness probe — calls the on-chain `ping()` function.
   *
   * Returns the contract's `CONTRACT_VERSION` constant. Throws if the contract
   * is not deployed or not responding.
   *
   * @param options Per-call overrides (currently `timeoutSeconds`).
   * @returns The contract version number (currently `1`).
   * @throws {SorobanIdentityError} with code `CONTRACT_ERROR` if the contract
   *   does not respond.
   */
  async ping(options?: CallOptions): Promise<number> {
    const account = new Account(PROBE_ADDRESS, "0");
    const timeout = options?.timeoutSeconds ?? this.config.txTimeout ?? 30;
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("ping"))
      .setTimeout(timeout)
      .build();
    const result = await retryWithBackoff(() => this.server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new SorobanIdentityError(
        "Health check failed: reputation contract not responding",
        "CONTRACT_ERROR"
      );
    }
    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    ) as number;
  }
}
