import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialClient } from "./credentials";
import { clearServerCache } from "./base-client";
import type { SorobanIdentityConfig } from "./types";

const mockGetHealth = vi.fn().mockResolvedValue({ status: "healthy" });

vi.mock("@stellar/stellar-sdk", () => ({
  SorobanRpc: {
    Server: vi.fn().mockImplementation(function () {
      return {
        getHealth: mockGetHealth,
        getAccount: vi.fn().mockResolvedValue({ id: "GABC", sequence: "0" }),
        simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: true } }),
        prepareTransaction: vi.fn().mockImplementation((tx) => tx),
        sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "abc123" }),
        getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", returnValue: new Uint8Array(32) }),
      };
    }),
    Api: {
      isSimulationError: vi.fn().mockReturnValue(false),
      GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" },
    },
  },
  Contract: vi.fn().mockImplementation(function () {
    return { call: vi.fn().mockReturnValue({}) };
  }),
  TransactionBuilder: vi.fn().mockImplementation(function () {
    return {
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ sign: vi.fn() }),
    };
  }),
  BASE_FEE: "100",
  Keypair: {
    fromSecret: vi.fn().mockReturnValue({
      publicKey: () => "GABC",
      sign: vi.fn().mockReturnValue(new Uint8Array(64)),
    }),
  },
  nativeToScVal: vi.fn().mockReturnValue({}),
  scValToNative: vi.fn().mockImplementation((v) => v),
  StrKey: {
    isValidEd25519PublicKey: (addr: string) => typeof addr === "string" && addr.startsWith("G"),
    isValidContract: (id: string) => typeof id === "string" && id.startsWith("C") && id.length === 56,
  },
}));

const config: SorobanIdentityConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  identityRegistryId: "CBBNTYLY7WH6O3IGUI6BKUYLB5UQOOCNDYW5EL7BY4DJKPZ7SGIRWCSL",
  credentialManagerId: "CD5MO3M3LYM5JLYXD27ARVECRKQXLJJSNBWMAUJ6ST3F4FXBGGXTJA7T",
  reputationId: "CBXM5TFFI4DWZ2OQSR37KHVO6OEKTJQTGOQMFTIDFTFUP32COAGW4OPK",
};

describe("BaseClient.ready (#357)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearServerCache();
    mockGetHealth.mockResolvedValue({ status: "healthy" });
  });

  it("resolves when the RPC node is healthy", async () => {
    const client = new CredentialClient(config);
    await expect(client.ready).resolves.toBeUndefined();
  });

  it("rejects with CLIENT_NOT_READY when the RPC node is unreachable", async () => {
    mockGetHealth.mockRejectedValue(new Error("ECONNREFUSED connect"));

    const client = new CredentialClient(config);
    await expect(client.ready).rejects.toMatchObject({
      code: "CLIENT_NOT_READY",
    });
  });

  it("does not throw synchronously during construction", () => {
    expect(() => new CredentialClient(config)).not.toThrow();
  });

  it("exposes ready as a Promise", () => {
    const client = new CredentialClient(config);
    expect(client.ready).toBeInstanceOf(Promise);
  });
});
