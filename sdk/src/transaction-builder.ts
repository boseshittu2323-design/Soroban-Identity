import {
  Contract,
  TransactionBuilder,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { SorobanIdentityConfig } from './types';
import type { Account } from '@stellar/stellar-sdk';

/**
 * Builder class for constructing Soroban transactions.
 * Separates transaction construction from submission for better testability.
 */
export class SorobanTransactionBuilder {
  private operations: xdr.Operation[] = [];
  private account: Account;
  private config: SorobanIdentityConfig;
  private fee: number;

  constructor(account: Account, config: SorobanIdentityConfig) {
    this.account = account;
    this.config = config;
    this.fee = 100; // BASE_FEE in stroops
  }

  /**
   * Add a contract call operation to the transaction.
   * @param contractId - The contract ID
   * @param method - The contract method name
   * @param args - The contract arguments
   * @returns this for method chaining
   */
  addContractCall(
    contractId: string,
    method: string,
    ...args: xdr.ScVal[]
  ): this {
    const contract = new Contract(contractId);
    this.operations.push(contract.call(method, ...args));
    return this;
  }

  /**
   * Add a raw operation to the transaction.
   * @param operation - The operation to add
   * @returns this for method chaining
   */
  addOperation(operation: xdr.Operation): this {
    this.operations.push(operation);
    return this;
  }

  /**
   * Set a custom fee for the transaction.
   * @param fee - The fee in stroops
   * @returns this for method chaining
   */
  setFee(fee: number): this {
    this.fee = fee;
    return this;
  }

  /**
   * Build the transaction with all added operations.
   * @param timeout - Transaction timeout in seconds (default: 30)
   * @returns The built Transaction
   */
  build(timeout: number = 30): any {
    const builder = new TransactionBuilder(this.account, {
      fee: this.fee.toString(),
      networkPassphrase: this.config.networkPassphrase,
    });
    for (const op of this.operations) {
      builder.addOperation(op);
    }
    builder.setTimeout(timeout);
    return builder.build();
  }

  /**
   * Get the list of operations (for testing).
   * @returns Array of operations
   */
  getOperations(): xdr.Operation[] {
    return this.operations;
  }

  /**
   * Get the account (for testing).
   * @returns The account
   */
  getAccount(): Account {
    return this.account;
  }

  /**
   * Get the config (for testing).
   * @returns The config
   */
  getConfig(): SorobanIdentityConfig {
    return this.config;
  }
}
