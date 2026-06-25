import { describe, it, expect } from "vitest";
import {
  ContractError,
  SorobanIdentityError,
  classifyError,
  wrapError,
} from "./errors";

describe("SorobanIdentityError envelope (#249)", () => {
  it("accepts the legacy positional constructor", () => {
    const err = new SorobanIdentityError("not found", "NOT_FOUND");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("not found");
    expect(err.toEnvelope()).toEqual({ code: "NOT_FOUND", message: "not found" });
  });

  it("accepts the init-object constructor with details", () => {
    const err = new SorobanIdentityError("bad input", {
      code: "INVALID_INPUT",
      details: { field: "issuer" },
      originalError: new Error("inner"),
    });
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.details).toEqual({ field: "issuer" });
    expect(err.toEnvelope()).toEqual({
      code: "INVALID_INPUT",
      message: "bad input",
      details: { field: "issuer" },
    });
    expect((err.originalError as Error).message).toBe("inner");
  });

  it("defaults code to UNKNOWN when nothing is provided", () => {
    const err = new SorobanIdentityError("???");
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("ContractError.toEnvelope", () => {
  it("emits CONTRACT_ERROR with the panic number in details", () => {
    const err = new ContractError(7, { 7: "not authorized" });
    expect(err.code).toBe(7);
    expect(err.message).toBe("not authorized");
    expect(err.toEnvelope()).toEqual({
      code: "CONTRACT_ERROR",
      message: "not authorized",
      details: { contractCode: 7 },
    });
  });

  it("falls back to a generic message for unknown codes", () => {
    const err = new ContractError(99, {});
    expect(err.message).toBe("Contract error code 99");
  });

  it("extracts a code from a #N panic string", () => {
    const extracted = ContractError.extract("HostError: contract #5 failed", { 5: "expired" });
    expect(extracted).toBeInstanceOf(ContractError);
    expect(extracted?.code).toBe(5);
  });

  it("returns null when the panic string has no #N marker", () => {
    expect(ContractError.extract("no marker here", {})).toBeNull();
  });
});

describe("classifyError", () => {
  it.each([
    ["already exists in registry", "ALREADY_EXISTS"],
    ["DID not found for address", "NOT_FOUND"],
    ["Unauthorized: caller is not admin", "UNAUTHORIZED"],
    ["Too many requests — rate limit hit", "RATE_LIMITED"],
    ["invalid claims payload", "INVALID_INPUT"],
    ["fetch failed: ECONNREFUSED", "NETWORK_ERROR"],
    ["HostError: contract #4", "CONTRACT_ERROR"],
    ["something else entirely", "UNKNOWN"],
  ])("classifies %j as %s", (msg, expected) => {
    expect(classifyError(msg)).toBe(expected);
  });
});

describe("wrapError", () => {
  it("returns input unchanged when already a SorobanIdentityError", () => {
    const inner = new SorobanIdentityError("dup", "ALREADY_EXISTS");
    expect(wrapError(inner)).toBe(inner);
  });

  it("wraps a plain Error with a classified code", () => {
    const wrapped = wrapError(new Error("DID not found"));
    expect(wrapped).toBeInstanceOf(SorobanIdentityError);
    expect(wrapped.code).toBe("NOT_FOUND");
    expect(wrapped.originalError).toBeInstanceOf(Error);
  });

  it("wraps a thrown string", () => {
    const wrapped = wrapError("rate limit exceeded");
    expect(wrapped.code).toBe("RATE_LIMITED");
  });

  it("falls back to UNKNOWN for opaque throws", () => {
    const wrapped = wrapError({ weird: true });
    expect(wrapped.code).toBe("UNKNOWN");
    expect(wrapped.message).toBe("unexpected SDK error");
  });
});
