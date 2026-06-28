import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type {
  DidDocument,
  Credential,
  ReputationRecord,
  ScoreHistoryEntry,
} from "./types";

export function encodeAddress(address: string): xdr.ScVal {
  if (!address) throw new Error("encodeAddress: address must be non-empty");
  return nativeToScVal(address, { type: "address" });
}

export function encodeMap(map: Record<string, string>): xdr.ScVal {
  if (map == null || typeof map !== "object") {
    throw new Error("encodeMap: expected a non-null object");
  }
  return nativeToScVal(map, { type: "map" });
}

export function encodeBytes(data: Buffer): xdr.ScVal {
  if (!Buffer.isBuffer(data)) throw new Error("encodeBytes: expected a Buffer");
  return nativeToScVal(data, { type: "bytes" });
}

export function encodeSymbol(value: string): xdr.ScVal {
  if (!value) throw new Error("encodeSymbol: value must be non-empty");
  return nativeToScVal(value, { type: "symbol" });
}

export function encodeU32(value: number): xdr.ScVal {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("encodeU32: expected a non-negative integer");
  }
  return nativeToScVal(value, { type: "u32" });
}

export function encodeU64(value: number): xdr.ScVal {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("encodeU64: expected a non-negative integer");
  }
  return nativeToScVal(value, { type: "u64" });
}

export function encodeI64(value: number): xdr.ScVal {
  if (!Number.isInteger(value)) {
    throw new Error("encodeI64: expected an integer");
  }
  return nativeToScVal(value, { type: "i64" });
}

export function encodeString(value: string): xdr.ScVal {
  if (typeof value !== "string") {
    throw new Error("encodeString: expected a string");
  }
  return nativeToScVal(value, { type: "string" });
}

export function decodeDidDocument(val: xdr.ScVal): DidDocument {
  const result = scValToNative(val);
  if (result == null || typeof result !== "object") {
    throw new Error("decodeDidDocument: malformed ScVal");
  }
  return result as DidDocument;
}

export function decodeCredential(val: xdr.ScVal): Credential {
  const result = scValToNative(val);
  if (result == null || typeof result !== "object") {
    throw new Error("decodeCredential: malformed ScVal");
  }
  return result as Credential;
}

export function decodeReputationRecord(val: xdr.ScVal): ReputationRecord {
  const result = scValToNative(val);
  if (result == null || typeof result !== "object") {
    throw new Error("decodeReputationRecord: malformed ScVal");
  }
  return result as ReputationRecord;
}

export function decodeScoreHistory(val: xdr.ScVal): ScoreHistoryEntry[] {
  const result = scValToNative(val);
  if (!Array.isArray(result)) {
    throw new Error("decodeScoreHistory: expected an array");
  }
  return result as ScoreHistoryEntry[];
}

export function decodeString(val: xdr.ScVal): string {
  const result = scValToNative(val);
  if (typeof result !== "string") {
    throw new Error("decodeString: expected a string");
  }
  return result;
}

export function decodeBoolean(val: xdr.ScVal): boolean {
  const result = scValToNative(val);
  if (typeof result !== "boolean") {
    throw new Error("decodeBoolean: expected a boolean");
  }
  return result;
}

export function decodeCredentialId(val: xdr.ScVal): Uint8Array {
  const result = scValToNative(val);
  if (!(result instanceof Uint8Array)) {
    throw new Error("decodeCredentialId: expected Uint8Array");
  }
  return result;
}

export function decodeCredentialIdList(val: xdr.ScVal): Uint8Array[] {
  const result = scValToNative(val);
  if (!Array.isArray(result)) {
    throw new Error("decodeCredentialIdList: expected an array");
  }
  return result as Uint8Array[];
}
