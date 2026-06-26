import { describe, it, expect, vi } from "vitest";
import { validateStellarAddress, checkConnection } from "./utils";
import { SorobanIdentityError } from "./errors";

vi.mock("@stellar/stellar-sdk", () => ({
  StrKey: {
    // Accept any string starting with G and at least 10 chars as "valid" in tests
    isValidEd25519PublicKey: (addr: string) => typeof addr === "string" && addr.startsWith("G") && addr.length >= 10,
  },
}));

const VALID_ADDRESS = "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJ";

describe("validateStellarAddress", () => {
  it("does not throw for a valid Stellar address", () => {
    expect(() => validateStellarAddress(VALID_ADDRESS)).not.toThrow();
  });

  it("throws InvalidAddress for an empty string", () => {
    expect(() => validateStellarAddress("")).toThrow("InvalidAddress");
  });

  it("throws InvalidAddress for a random string", () => {
    expect(() => validateStellarAddress("not-an-address")).toThrow("InvalidAddress");
  });

  it("throws InvalidAddress for an Ethereum-style address", () => {
    expect(() => validateStellarAddress("0xdeadbeef")).toThrow("InvalidAddress");
  });

  it("error message includes the invalid address", () => {
    expect(() => validateStellarAddress("bad")).toThrow('"bad"');
  });

  it("throws SorobanIdentityError with code INVALID_ADDRESS for wrong length address", () => {
    try {
      // Short G-prefixed string fails the length check in the mock
      validateStellarAddress("GABCDE");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SorobanIdentityError);
      expect((err as SorobanIdentityError).code).toBe("INVALID_ADDRESS");
    }
  });

  it("throws SorobanIdentityError with code INVALID_ADDRESS for non-G prefix address", () => {
    try {
      // Does not start with 'G' — fails the mock's prefix check
      validateStellarAddress("XABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQRSTU");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SorobanIdentityError);
      expect((err as SorobanIdentityError).code).toBe("INVALID_ADDRESS");
    }
  });
});

describe("checkConnection", () => {
  it("returns true when getLatestLedger succeeds", async () => {
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ ledger_sequence: 123 }),
    };
    const result = await checkConnection(mockServer as any);
    expect(result).toBe(true);
  });

  it("returns false when getLatestLedger throws an error", async () => {
    const mockServer = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    const result = await checkConnection(mockServer as any);
    expect(result).toBe(false);
  });

  it("does not throw on network error", async () => {
    const mockServer = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error("Connection timeout")),
    };
    await expect(checkConnection(mockServer as any)).resolves.toBe(false);
  });
});
