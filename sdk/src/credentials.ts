import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Credential, CredentialType, SorobanIdentityConfig } from "./types";

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
   * Register a trusted issuer and their Ed25519 public key (admin only).
   */
  async addIssuer(
    adminKeypair: Keypair,
    issuerAddress: string,
    issuerPublicKeyBytes: Buffer | Uint8Array
  ): Promise<void> {
    const account = await this.server.getAccount(adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "add_issuer",
          nativeToScVal(issuerAddress, { type: "address" }),
          nativeToScVal(Buffer.from(issuerPublicKeyBytes), { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(adminKeypair);

    const result = await this.server.sendTransaction(prepared);
    if (result.status !== "PENDING") {
      throw new Error(`Transaction failed: ${result.status}`);
    }
    await this.waitForConfirmation(result.hash);
  }

  /**
   * Issue a credential to a subject. Caller must be a registered issuer.
   */
  async issueCredential(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    expiresAt = 0
  ): Promise<string> {
    const account = await this.server.getAccount(issuerKeypair.publicKey());

    // Build canonical signed message matching on-chain build_signed_message
    let msgBuf = Buffer.concat([
      Buffer.from(issuerKeypair.publicKey(), "utf8"),
      Buffer.from(subjectAddress, "utf8"),
    ]);
    const sortedKeys = Object.keys(claims).sort();
    for (const k of sortedKeys) {
      msgBuf = Buffer.concat([
        msgBuf,
        Buffer.from(k, "utf8"),
        Buffer.from(claims[k], "utf8"),
      ]);
    }

    const signature = issuerKeypair.sign(msgBuf);

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
          nativeToScVal(Buffer.from(signature), { type: "bytes" }),
          nativeToScVal(expiresAt, { type: "u64" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(issuerKeypair);

    const result = await this.server.sendTransaction(prepared);
    if (result.status !== "PENDING") {
      throw new Error(`Transaction failed: ${result.status}`);
    }

    const confirmed = await this.waitForConfirmation(result.hash);
    // Returns BytesN<32> — encode as hex
    const raw = scValToNative(confirmed.returnValue!) as Uint8Array;
    return Buffer.from(raw).toString("hex");
  }

  /**
   * Verify a credential is valid (not revoked, not expired).
   */
  async verifyCredential(
    callerAddress: string,
    credentialId: string
  ): Promise<boolean> {
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");

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
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;
  }

  /**
   * Get a credential by ID.
   */
  async getCredential(
    callerAddress: string,
    credentialId: string
  ): Promise<Credential> {
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");

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
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Credential;
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
