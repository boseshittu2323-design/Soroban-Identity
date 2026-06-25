import { describe, it, expect } from "vitest";
import { validateConfig } from "./types";
import type { SorobanIdentityConfig } from "./types";

const VALID_IDENTITY_ID = "CBBNTYLY7WH6O3IGUI6BKUYLB5UQOOCNDYW5EL7BY4DJKPZ7SGIRWCSL";
const VALID_CREDENTIAL_ID = "CD5MO3M3LYM5JLYXD27ARVECRKQXLJJSNBWMAUJ6ST3F4FXBGGXTJA7T";
const VALID_REPUTATION_ID = "CBXM5TFFI4DWZ2OQSR37KHVO6OEKTJQTGOQMFTIDFTFUP32COAGW4OPK";

const baseConfig: SorobanIdentityConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  identityRegistryId: VALID_IDENTITY_ID,
  credentialManagerId: VALID_CREDENTIAL_ID,
  reputationId: VALID_REPUTATION_ID,
};

describe("validateConfig", () => {
  it("accepts a valid config for each contract client field", () => {
    expect(() =>
      validateConfig(baseConfig, { contractIdField: "identityRegistryId" })
    ).not.toThrow();
    expect(() =>
      validateConfig(baseConfig, { contractIdField: "credentialManagerId" })
    ).not.toThrow();
    expect(() =>
      validateConfig(baseConfig, { contractIdField: "reputationId" })
    ).not.toThrow();
  });

  it("throws when rpcUrl is missing", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, rpcUrl: "" },
        { contractIdField: "identityRegistryId" }
      )
    ).toThrow("rpcUrl is required");
  });

  it("throws when rpcUrl array is empty", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, rpcUrl: [] },
        { contractIdField: "identityRegistryId" }
      )
    ).toThrow("rpcUrl is required");
  });

  it("throws when rpcUrl array contains blank entries", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, rpcUrl: ["https://example.com", "  "] },
        { contractIdField: "identityRegistryId" }
      )
    ).toThrow("rpcUrl is required");
  });

  it("throws when networkPassphrase is missing", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, networkPassphrase: "" },
        { contractIdField: "identityRegistryId" }
      )
    ).toThrow("networkPassphrase is required");
  });

  it("throws when the client contract ID field is missing", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, identityRegistryId: "" },
        { contractIdField: "identityRegistryId" }
      )
    ).toThrow("identityRegistryId is required");
  });

  it("throws when the client contract ID is invalid", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, credentialManagerId: "not-a-contract" },
        { contractIdField: "credentialManagerId" }
      )
    ).toThrow("credentialManagerId is not a valid contract ID");
  });

  it("throws when reputationId is missing for ReputationClient validation", () => {
    expect(() =>
      validateConfig(
        { ...baseConfig, reputationId: "" },
        { contractIdField: "reputationId" }
      )
    ).toThrow("reputationId is required");
  });
});
