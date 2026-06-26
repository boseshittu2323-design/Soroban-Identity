import { describe, it, expect } from "vitest";
import { parseContractError, SorobanIdentityError } from "./errors";

describe("parseContractError", () => {
  it("parses IdentityError variants", () => {
    const raw = new Error("Simulation failed: Error(Contract, #2)");
    const parsed = parseContractError(raw, "identity");
    expect(parsed).toBeInstanceOf(SorobanIdentityError);
    expect(parsed.code).toBe("ALREADY_EXISTS");
    expect(parsed.contractCode).toBe(2);
  });

  it("parses CredentialError variants", () => {
    const raw = new Error("Error(Contract, 5)");
    const parsed = parseContractError(raw, "credential");
    expect(parsed.code).toBe("NOT_AN_ISSUER");
    expect(parsed.contractCode).toBe(5);
  });

  it("parses ReputationError variants", () => {
    const raw = "Host error: contract error #3";
    const parsed = parseContractError(raw, "reputation");
    expect(parsed.code).toBe("NOT_A_REPORTER");
    expect(parsed.contractCode).toBe(3);
  });

  it("returns UNKNOWN for generic errors", () => {
    const parsed = parseContractError(new Error("Network disconnect"), "identity");
    expect(parsed.code).toBe("UNKNOWN");
  });
});
