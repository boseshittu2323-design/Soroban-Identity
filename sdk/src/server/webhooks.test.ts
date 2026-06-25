import { describe, it, expect, vi } from "vitest";
import {
  InMemoryWebhookStore,
  WebhookDispatcher,
  WEBHOOK_HEADERS,
  registerWebhook,
  signPayload,
  verifySignature,
  type FetchLike,
} from "./webhooks";

describe("registerWebhook (#252)", () => {
  it("creates a registration when the input is valid", async () => {
    const store = new InMemoryWebhookStore();
    const reg = await registerWebhook(
      store,
      { url: "https://hook.test/path", secret: "0123456789abcdef", events: ["credential.issued"] },
      { idFn: () => "w1", now: () => 5 },
    );
    expect(reg).toMatchObject({ id: "w1", createdAt: 5, events: ["credential.issued"] });
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects non-http URLs as INVALID_INPUT", async () => {
    const store = new InMemoryWebhookStore();
    await expect(
      registerWebhook(store, { url: "ftp://no", secret: "0123456789abcdef", events: ["credential.issued"] }),
    ).rejects.toThrow(/http\(s\)/);
  });

  it("rejects short secrets", async () => {
    const store = new InMemoryWebhookStore();
    await expect(
      registerWebhook(store, { url: "https://hook.test", secret: "too-short", events: ["credential.issued"] }),
    ).rejects.toThrow(/at least 16/);
  });

  it("rejects empty or unknown events", async () => {
    const store = new InMemoryWebhookStore();
    await expect(
      registerWebhook(store, { url: "https://hook.test", secret: "0123456789abcdef", events: [] }),
    ).rejects.toThrow(/non-empty subset/);
    await expect(
      registerWebhook(store, {
        url: "https://hook.test",
        secret: "0123456789abcdef",
        events: ["unknown" as any],
      }),
    ).rejects.toThrow(/non-empty subset/);
  });

  it("forEvent returns only matching registrations", async () => {
    const store = new InMemoryWebhookStore();
    await registerWebhook(
      store,
      { url: "https://h1", secret: "0123456789abcdef", events: ["credential.issued"] },
      { idFn: () => "w1" },
    );
    await registerWebhook(
      store,
      { url: "https://h2", secret: "0123456789abcdef", events: ["credential.revoked"] },
      { idFn: () => "w2" },
    );
    const issued = await store.forEvent("credential.issued");
    expect(issued.map((r) => r.id)).toEqual(["w1"]);
  });
});

describe("signPayload / verifySignature", () => {
  it("round-trips a signed body", () => {
    const body = '{"hello":"world"}';
    const sig = signPayload("topsecret-but-long-enough", body);
    expect(verifySignature("topsecret-but-long-enough", body, sig)).toBe(true);
  });

  it("rejects forged signatures", () => {
    const body = '{"hello":"world"}';
    const sig = signPayload("a", body);
    expect(verifySignature("b", body, sig)).toBe(false);
  });

  it("rejects malformed signatures", () => {
    expect(verifySignature("a", '{"x":1}', "not-hex-at-all")).toBe(false);
    expect(verifySignature("a", '{"x":1}', "")).toBe(false);
  });
});

describe("WebhookDispatcher", () => {
  it("posts a signed payload and the X-SorobanIdentity-* headers", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fetcher: FetchLike = async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return { ok: true, status: 200 };
    };
    const dispatcher = new WebhookDispatcher({ fetcher });
    const result = await dispatcher.deliver(
      { id: "w1", url: "https://hook.test", secret: "0123456789abcdef", events: ["credential.issued"], createdAt: 0 },
      "credential.issued",
      { credentialId: "abc" },
      "del-1",
    );
    expect(result.ok).toBe(true);
    expect(seen?.headers[WEBHOOK_HEADERS.event]).toBe("credential.issued");
    expect(seen?.headers[WEBHOOK_HEADERS.id]).toBe("del-1");
    const sig = seen?.headers[WEBHOOK_HEADERS.signature]!;
    expect(verifySignature("0123456789abcdef", seen!.body, sig)).toBe(true);
  });

  it("retries on 5xx then succeeds within maxAttempts", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      return attempts < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    };
    const sleep = vi.fn(async () => {});
    const dispatcher = new WebhookDispatcher({ fetcher, sleep, maxAttempts: 5, baseDelayMs: 10 });
    const result = await dispatcher.deliver(
      { id: "w1", url: "https://hook.test", secret: "0123456789abcdef", events: ["credential.issued"], createdAt: 0 },
      "credential.issued",
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fast-fails on 4xx (except 429)", async () => {
    const fetcher = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(async () => ({ ok: false, status: 400 }));
    const dispatcher = new WebhookDispatcher({
      fetcher: fetcher as unknown as FetchLike,
      sleep: async () => {},
      maxAttempts: 5,
    });
    const result = await dispatcher.deliver(
      { id: "w1", url: "https://hook.test", secret: "0123456789abcdef", events: ["credential.issued"], createdAt: 0 },
      "credential.issued",
      {},
    );
    expect(result.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("DOES retry on 429", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      return { ok: false, status: 429 };
    };
    const dispatcher = new WebhookDispatcher({ fetcher, sleep: async () => {}, maxAttempts: 4 });
    const result = await dispatcher.deliver(
      { id: "w1", url: "https://hook.test", secret: "0123456789abcdef", events: ["credential.issued"], createdAt: 0 },
      "credential.issued",
      {},
    );
    expect(attempts).toBe(4);
    expect(result.ok).toBe(false);
  });

  it("retries on transport errors and records them", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200 };
    };
    const dispatcher = new WebhookDispatcher({ fetcher, sleep: async () => {}, maxAttempts: 3 });
    const result = await dispatcher.deliver(
      { id: "w1", url: "https://hook.test", secret: "0123456789abcdef", events: ["credential.issued"], createdAt: 0 },
      "credential.issued",
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.attempts[0].error).toMatch(/ECONNREFUSED/);
  });
});
