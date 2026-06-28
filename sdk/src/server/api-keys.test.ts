import { describe, it, expect } from "vitest";
import {
  InMemoryApiKeyStore,
  createApiKeyAuthMiddleware,
  hashApiKey,
  issueApiKey,
  parseAuthorizationHeader,
} from "./api-keys";

function captureRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
    setHeader: () => {},
  };
  return { res, out };
}

describe("issueApiKey + InMemoryApiKeyStore (#253)", () => {
  it("returns the raw key once and stores only the hash", async () => {
    const store = new InMemoryApiKeyStore();
    const result = await issueApiKey(store, {
      owner: "user-1",
      scopes: ["read", "write"],
      idFn: () => "key-1",
      randomFn: () => Buffer.alloc(32, 7),
    });
    expect(result.rawKey).toMatch(/^sk_/);
    expect(result.metadata.id).toBe("key-1");
    expect(result.metadata.scopes).toEqual(["read", "write"]);
    const listed = await store.list();
    expect(listed[0]).toMatchObject({ id: "key-1", owner: "user-1" });
    // Lookup by hash succeeds; raw key never surfaces from the store.
    const found = await store.findByHashedKey(hashApiKey(result.rawKey));
    expect(found?.id).toBe("key-1");
  });

  it("rejects duplicate ids with an ALREADY_EXISTS envelope", async () => {
    const store = new InMemoryApiKeyStore();
    await issueApiKey(store, { owner: "u", idFn: () => "k1", randomFn: () => Buffer.alloc(32, 1) });
    await expect(
      issueApiKey(store, { owner: "u", idFn: () => "k1", randomFn: () => Buffer.alloc(32, 2) }),
    ).rejects.toThrow(/already exists/);
  });

  it("remove() returns true on success, false on missing", async () => {
    const store = new InMemoryApiKeyStore();
    await issueApiKey(store, { owner: "u", idFn: () => "k1", randomFn: () => Buffer.alloc(32, 1) });
    expect(await store.remove("k1")).toBe(true);
    expect(await store.remove("k1")).toBe(false);
  });
});

describe("parseAuthorizationHeader", () => {
  it("extracts a Bearer token", () => {
    expect(parseAuthorizationHeader("Bearer sk_abc")).toBe("sk_abc");
    expect(parseAuthorizationHeader("bearer sk_abc")).toBe("sk_abc");
  });

  it("returns undefined for non-bearer schemes or empty headers", () => {
    expect(parseAuthorizationHeader(undefined)).toBeUndefined();
    expect(parseAuthorizationHeader("Basic foo")).toBeUndefined();
    expect(parseAuthorizationHeader("Bearer ")).toBeUndefined();
  });
});

describe("createApiKeyAuthMiddleware", () => {
  it("attaches req.auth when the header matches a stored key", async () => {
    const store = new InMemoryApiKeyStore();
    const { rawKey } = await issueApiKey(store, {
      owner: "alice",
      scopes: ["read"],
      idFn: () => "k-alice",
      randomFn: () => Buffer.alloc(32, 9),
    });
    const middleware = createApiKeyAuthMiddleware({ store, now: () => 12345 });
    const req: any = { headers: { authorization: `Bearer ${rawKey}` } };
    const { res, out } = captureRes();
    let called = false;
    await middleware(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.auth.apiKey).toMatchObject({ id: "k-alice", owner: "alice", lastUsedAt: 12345 });
    expect(out.status).toBeUndefined();
  });

  it("rejects with 401 UNAUTHORIZED envelope when header is missing", async () => {
    const store = new InMemoryApiKeyStore();
    const middleware = createApiKeyAuthMiddleware({ store });
    const req: any = { headers: {} };
    const { res, out } = captureRes();
    await middleware(req, res, () => {});
    expect(out.status).toBe(401);
    expect((out.body as any).error.code).toBe("UNAUTHORIZED");
  });

  it("rejects with 401 when the key is not in the store", async () => {
    const store = new InMemoryApiKeyStore();
    const middleware = createApiKeyAuthMiddleware({ store });
    const req: any = { headers: { authorization: "Bearer sk_unknown" } };
    const { res, out } = captureRes();
    await middleware(req, res, () => {});
    expect(out.status).toBe(401);
    expect((out.body as any).error.code).toBe("UNAUTHORIZED");
  });

  it("rejects when requireScope is not granted", async () => {
    const store = new InMemoryApiKeyStore();
    const { rawKey } = await issueApiKey(store, {
      owner: "u",
      scopes: ["read"],
      idFn: () => "k1",
      randomFn: () => Buffer.alloc(32, 1),
    });
    const middleware = createApiKeyAuthMiddleware({ store, requireScope: "admin" });
    const req: any = { headers: { authorization: `Bearer ${rawKey}` } };
    const { res, out } = captureRes();
    await middleware(req, res, () => {});
    expect(out.status).toBe(401);
    expect((out.body as any).error.message).toMatch(/scope admin/);
  });
});
