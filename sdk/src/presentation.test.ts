import { describe, it, expect, vi } from "vitest";
import { PresentationClient } from "./presentation";
import { SorobanIdentityError } from "./errors";
import type { Credential } from "./types";

// Use the real stellar-sdk for Ed25519 key ops (no network calls needed)
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    StrKey: actual.StrKey,
    Keypair: actual.Keypair,
  };
});

import { Keypair } from "@stellar/stellar-sdk";

const CREDENTIAL: Credential = {
  id: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  subject: "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJ",
  issuer: "GDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJ",
  credentialType: "Kyc",
  claims: { name: "Alice", country: "US", age: "30" },
  claimsHash: "deadbeef".repeat(8),
  signature: "00".repeat(64),
  issuedAt: 1700000000,
  expiresAt: 0,
  revoked: false,
};

function makePayloadBytes(
  credentialId: string,
  fieldsToDisclose: string[],
  holderAddress: string
): Buffer {
  return Buffer.from(
    JSON.stringify({
      credentialId,
      fieldsToDisclose: [...fieldsToDisclose].sort(),
      holderAddress,
    })
  );
}

describe("PresentationClient.createPresentation", () => {
  const client = new PresentationClient();

  it("returns a VerifiablePresentation without proof when no proofInput provided", async () => {
    const vp = await client.createPresentation(CREDENTIAL, ["name"], "GHOLDER");
    expect(vp.type).toContain("VerifiablePresentation");
    expect(vp.verifiableCredential).toHaveLength(1);
    expect(vp.proof).toBeUndefined();
  });

  it("selectively discloses only requested fields", async () => {
    const vp = await client.createPresentation(CREDENTIAL, ["name"]);
    const subject = vp.verifiableCredential[0]!.credentialSubject;
    expect(subject["name"]).toBe("Alice");
    expect(subject["country"]).toBeUndefined();
  });

  it("attaches the holder DID when holderAddress is provided", async () => {
    const vp = await client.createPresentation(CREDENTIAL, ["name"], "GHOLDER");
    expect(vp.holder).toBe("did:stellar:GHOLDER");
  });

  it("accepts a valid Ed25519 proof and attaches it to the presentation", async () => {
    const holder = Keypair.random();
    const holderAddress = holder.publicKey();

    const payloadBytes = makePayloadBytes(CREDENTIAL.id, ["name", "country"], holderAddress);
    const sigBytes = holder.sign(payloadBytes);
    const jws = Buffer.from(sigBytes).toString("base64url");

    const mockIdentityClient = {
      resolveDid: vi.fn().mockResolvedValue({
        id: `did:stellar:${holderAddress}`,
        controller: holderAddress,
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
        active: true,
        services: [],
      }),
    };

    const vp = await client.createPresentation(
      CREDENTIAL,
      ["name", "country"],
      holderAddress,
      { jws, identityClient: mockIdentityClient }
    );

    expect(vp.proof).toBeDefined();
    expect(vp.proof?.jws).toBe(jws);
    expect(vp.proof?.type).toBe("DataIntegrityProof");
    expect(vp.proof?.proofPurpose).toBe("authentication");
    expect(mockIdentityClient.resolveDid).toHaveBeenCalledWith(holderAddress);
  });

  it("throws INVALID_PROOF when proof.jws is signed with the wrong key", async () => {
    const holder = Keypair.random();
    const attacker = Keypair.random();
    const holderAddress = holder.publicKey();

    const payloadBytes = makePayloadBytes(CREDENTIAL.id, ["name"], holderAddress);
    const tamperedSig = attacker.sign(payloadBytes);
    const jws = Buffer.from(tamperedSig).toString("base64url");

    const mockIdentityClient = {
      resolveDid: vi.fn().mockResolvedValue({
        id: `did:stellar:${holderAddress}`,
        controller: holderAddress,
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
        active: true,
        services: [],
      }),
    };

    let thrownError: unknown;
    try {
      await client.createPresentation(
        CREDENTIAL,
        ["name"],
        holderAddress,
        { jws, identityClient: mockIdentityClient }
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(SorobanIdentityError);
    expect((thrownError as SorobanIdentityError).code).toBe("INVALID_PROOF");
  });

  it("skips proof verification when skipProofVerification is true", async () => {
    const jws = "not-a-real-signature";
    const mockIdentityClient = {
      resolveDid: vi.fn(),
    };

    const vp = await client.createPresentation(
      CREDENTIAL,
      ["name"],
      "GHOLDER",
      { jws, identityClient: mockIdentityClient },
      { skipProofVerification: true }
    );

    expect(vp.proof?.jws).toBe(jws);
    expect(mockIdentityClient.resolveDid).not.toHaveBeenCalled();
  });

  it("throws INVALID_ARGUMENT when proofInput is given without holderAddress", async () => {
    const jws = "dummysig";
    const mockIdentityClient = { resolveDid: vi.fn() };

    let thrownError: unknown;
    try {
      await client.createPresentation(
        CREDENTIAL,
        ["name"],
        undefined,
        { jws, identityClient: mockIdentityClient }
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(SorobanIdentityError);
    expect((thrownError as SorobanIdentityError).code).toBe("INVALID_ARGUMENT");
  });
});
