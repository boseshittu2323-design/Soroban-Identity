import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialClient } from "./credentials";
import type { SorobanIdentityConfig } from "./types";

vi.mock("@stellar/stellar-sdk", () => {
  const mockSimResult = {
    result: {
      retval: true,
    },
  };

  return {
    SorobanRpc: {
      Server: vi.fn().mockImplementation(() => ({
        getAccount: vi.fn().mockResolvedValue({ id: "GABC", sequence: "0" }),
        simulateTransaction: vi.fn().mockResolvedValue(mockSimResult),
        prepareTransaction: vi.fn().mockImplementation((tx) => tx),
        sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "def456" }),
        getTransaction: vi.fn().mockResolvedValue({
          status: "SUCCESS",
          returnValue: new Uint8Array(32),
        }),
      })),
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
        GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" },
      },
    },
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue({}),
    })),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ sign: vi.fn() }),
    })),
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
    },
  };
});

const config: SorobanIdentityConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  identityRegistryId: "CONTRACT_A",
  credentialManagerId: "CONTRACT_B",
  reputationId: "CONTRACT_C",
};

describe("CredentialClient", () => {
  let client: CredentialClient;

  beforeEach(() => {
    client = new CredentialClient(config);
  });

  it("constructs without throwing", () => {
    expect(client).toBeDefined();
  });

  it("verifyCredential — returns { valid: true } for a valid credential", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValue({ result: { retval: true } });

    const result = await client.verifyCredential("GABC", "aabbcc");

    expect(result).toEqual({ valid: true });
  });

  it("verifyCredential — returns { valid: false, reason: 'not_found' } on simulation error with 'credential not found'", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({
      error: "credential not found",
    });

    const result = await client.verifyCredential("GABC", "aabbcc");

    expect(result).toEqual({ valid: false, reason: "not_found" });
  });

  it("verifyCredential — returns { valid: false, reason: 'revoked' } when contract returns false and cred is revoked", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError)
      .mockReturnValueOnce(false)  // verifyCredential sim
      .mockReturnValueOnce(false); // getCredential sim

    const server = (client as any).server;
    server.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: false } })
      .mockResolvedValueOnce({
        result: {
          retval: {
            id: "aabbcc", subject: "GSUBJECT", issuer: "GABC",
            credentialType: "Kyc", claims: {}, signature: "",
            issuedAt: 1000, expiresAt: 0, revoked: true,
          },
        },
      });

    const result = await client.verifyCredential("GABC", "aabbcc");

    expect(result).toEqual({ valid: false, reason: "revoked" });
  });

  it("verifyCredential — returns { valid: false, reason: 'expired' } when cred is past expiry", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const server = (client as any).server;
    server.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: false } })
      .mockResolvedValueOnce({
        result: {
          retval: {
            id: "aabbcc", subject: "GSUBJECT", issuer: "GABC",
            credentialType: "Kyc", claims: {}, signature: "",
            issuedAt: 1000, expiresAt: 1, revoked: false, // expiresAt=1 is in the past
          },
        },
      });

    const result = await client.verifyCredential("GABC", "aabbcc");

    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("verifyCredential — returns { valid: false, reason: 'unknown' } on unrecognised simulation error", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ error: "some other error" });

    const result = await client.verifyCredential("GABC", "aabbcc");

    expect(result).toEqual({ valid: false, reason: "unknown" });
  });

  it("getCredentialsBySubject — returns empty array when subject has no credentials", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({
      result: { retval: [] },
    });

    const result = await client.getCredentialsBySubject("GABC", "GSUBJECT");

    expect(result).toEqual([]);
  });

  it("getCredentialsBySubject — returns Credential[] for each ID", async () => {
    const mockCredential = {
      id: "aabbcc",
      subject: "GSUBJECT",
      issuer: "GABC",
      credentialType: "Kyc",
      claims: {},
      signature: "",
      issuedAt: 1000,
      expiresAt: 0,
      revoked: false,
    };

    const server = (client as any).server;

    // First simulate call returns a list of one ID
    server.simulateTransaction
      .mockResolvedValueOnce({
        result: { retval: [new Uint8Array(32)] },
      })
      // Second simulate call (getCredential) returns the credential
      .mockResolvedValueOnce({
        result: { retval: mockCredential },
      });

    const result = await client.getCredentialsBySubject("GABC", "GSUBJECT");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(mockCredential);
  });

  it("getCredentialsBySubject — returns empty array when subject has no credentials", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({
      result: { retval: [] },
    });

    const result = await client.getCredentialsBySubject("GABC", "GSUBJECT");

    expect(result).toEqual([]);
  });

  it("getCredentialsBySubject — returns Credential[] for each ID", async () => {
    const mockCredential = {
      id: "aabbcc",
      subject: "GSUBJECT",
      issuer: "GABC",
      credentialType: "Kyc",
      claims: {},
      signature: "",
      issuedAt: 1000,
      expiresAt: 0,
      revoked: false,
    };

    const server = (client as any).server;

    // First simulate call returns a list of one ID
    server.simulateTransaction
      .mockResolvedValueOnce({
        result: { retval: [new Uint8Array(32)] },
      })
      // Second simulate call (getCredential) returns the credential
      .mockResolvedValueOnce({
        result: { retval: mockCredential },
      });

    const result = await client.getCredentialsBySubject("GABC", "GSUBJECT");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(mockCredential);
  });

  it("verifyCredentialsBatch — returns results in input order", async () => {
    const server = (client as any).server;
    server.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: true } })
      .mockResolvedValueOnce({ result: { retval: false } })
      .mockResolvedValueOnce({ result: { retval: true } });

    // For the false result, getCredential will also be called
    server.simulateTransaction.mockResolvedValueOnce({
      result: {
        retval: {
          id: "bb", subject: "GSUBJECT", issuer: "GABC",
          credentialType: "Kyc", claims: {}, signature: "",
          issuedAt: 1000, expiresAt: 0, revoked: true,
        },
      },
    });

    const results = await client.verifyCredentialsBatch("GABC", ["aa", "bb", "cc"]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ valid: true });
    expect(results[2]).toEqual({ valid: true });
  });

  it("verifyCredentialsBatch — returns empty array for empty input", async () => {
    const results = await client.verifyCredentialsBatch("GABC", []);
    expect(results).toEqual([]);
  });

  it("verifyCredential — throws InvalidAddress for invalid caller address", async () => {
    await expect(client.verifyCredential("not-valid", "aabbcc")).rejects.toThrow("InvalidAddress");
  });

  it("getCredentialsBySubject — throws InvalidAddress for invalid subject address", async () => {
    await expect(client.getCredentialsBySubject("GABC", "bad-address")).rejects.toThrow("InvalidAddress");
  });

  it("isIssuer — returns true when address is a registered issuer", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({
      result: { retval: true },
    });

    const result = await client.isIssuer("GABC", "GISSUER");

    expect(result).toBe(true);
  });

  it("isIssuer — returns false when address is not a registered issuer", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({
      result: { retval: false },
    });

    const result = await client.isIssuer("GABC", "GNOT_ISSUER");

    expect(result).toBe(false);
  });

  it("isIssuer — throws InvalidAddress for invalid caller address", async () => {
    await expect(client.isIssuer("bad-address", "GISSUER")).rejects.toThrow("InvalidAddress");
  });

  it("isIssuer — throws InvalidAddress for invalid target address", async () => {
    await expect(client.isIssuer("GABC", "bad-address")).rejects.toThrow("InvalidAddress");
  });

  it("isIssuer — throws on simulation error", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({
      error: "contract trap",
    });

    await expect(client.isIssuer("GABC", "GISSUER")).rejects.toThrow("Simulation failed: contract trap");
  });

  it("getCredentialCount — returns count for a subject", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ result: { retval: 3 } });

    const count = await client.getCredentialCount("GABC", "GSUBJECT");

    expect(count).toBe(3);
  });

  it("getCredentialCount — returns 0 when subject has no credentials", async () => {
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ result: { retval: 0 } });

    const count = await client.getCredentialCount("GABC", "GSUBJECT");

    expect(count).toBe(0);
  });

  it("getCredentialCount — throws InvalidAddress for invalid caller", async () => {
    await expect(client.getCredentialCount("bad-address", "GSUBJECT")).rejects.toThrow("InvalidAddress");
  });

  it("getCredentialCount — throws InvalidAddress for invalid subject", async () => {
    await expect(client.getCredentialCount("GABC", "bad-address")).rejects.toThrow("InvalidAddress");
  });

  it("getCredentialCount — throws on simulation error", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ error: "contract trap" });

    await expect(client.getCredentialCount("GABC", "GSUBJECT")).rejects.toThrow("Simulation failed: contract trap");
  });

  it("getCredential — throws CredentialNotFound when credential does not exist", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ error: "CredentialNotFound" });

    await expect(client.getCredential("GABC", "aabbcc")).rejects.toThrow("CredentialNotFound");
  });

  it("getCredential — throws CredentialRevoked when credential has been revoked", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ error: "CredentialRevoked" });

    await expect(client.getCredential("GABC", "aabbcc")).rejects.toThrow("CredentialRevoked");
  });

  it("getCredential — throws CredentialNotFound for error code #3", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ error: "contract error #3" });

    await expect(client.getCredential("GABC", "aabbcc")).rejects.toThrow("CredentialNotFound");
  });

  it("getCredential — throws CredentialRevoked for error code #4", async () => {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValueOnce(true);
    const server = (client as any).server;
    server.simulateTransaction.mockResolvedValueOnce({ error: "contract error #4" });

    await expect(client.getCredential("GABC", "aabbcc")).rejects.toThrow("CredentialRevoked");
  });
});
