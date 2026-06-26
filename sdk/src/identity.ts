import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { DidDocument, SorobanIdentityConfig } from "./types";

export class IdentityClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.identityRegistryId);
  }

  /**
   * Create a new DID for the given keypair.
   */
  async createDid(
    keypair: Keypair,
    metadata: Record<string, string> = {}
  ): Promise<string> {
    const account = await this.server.getAccount(keypair.publicKey());

    const metaScVal = nativeToScVal(metadata, { type: "map" });

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
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(keypair);

    const result = await this.server.sendTransaction(prepared);
    if (result.status !== "PENDING") {
      throw new Error(`Transaction failed: ${result.status}`);
    }

    const confirmed = await this.waitForConfirmation(result.hash);
    return scValToNative(confirmed.returnValue!) as string;
  }

  /**
   * Resolve a DID document by controller address.
   */
  async resolveDid(controllerAddress: string): Promise<DidDocument> {
    const account = await this.server.getAccount(controllerAddress);

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
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as DidDocument;
  }

  /**
   * Check if an address has an active DID.
   */
  async hasActiveDid(controllerAddress: string): Promise<boolean> {
    const account = await this.server.getAccount(controllerAddress);

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
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    const native = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    );
    return typeof native === "boolean" ? native : Boolean(native);
  }

  private async waitForConfirmation(
    hash: string,
    retries = 10
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error("Transaction failed on-chain");
      }
    }
    throw new Error("Transaction confirmation timeout");
  }
}
