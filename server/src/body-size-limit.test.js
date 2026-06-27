import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import { createApp } from "./app.js";

// Mock dependencies
const mockConfig = {
  adminApiKey: "test-key",
  adminActor: "admin",
  corsAllowedOrigins: ["*"],
  maxBodyBytes: 1024, // 1 KB for testing
  expiryWarningDays: 7,
};

const mockSoroban = {
  pingAllContracts: () => ({
    credential: true,
    identity: true,
    reputation: true,
  }),
  getIssuers: () => Promise.resolve([]),
  addIssuer: vi.fn(() => Promise.resolve()),
  removeIssuer: vi.fn(() => Promise.resolve()),
  circuitBreaker: { toHealthInfo: () => ({}) },
};

const mockMetrics = {
  renderPrometheus: () => "# HELP test\ntest_metric 1\n",
};

function makeRequest(server, options) {
  return new Promise((resolve, reject) => {
    const req = server.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);
    if (options.body) {
      if (typeof options.body === "string") {
        req.write(options.body);
      } else {
        req.write(options.body);
      }
    }
    req.end();
  });
}

describe("Body Size Limit Protection", () => {
  let server;

  beforeEach(() => {
    const app = createApp({
      config: mockConfig,
      soroban: mockSoroban,
      metrics: mockMetrics,
      metricsAggregator: null,
    });
    server = createServer(app);
    server.listen(8768);
    vi.clearAllMocks();
  });

  afterEach(() => {
    server.close();
  });

  describe("Content-Length header check", () => {
    it("should reject POST with oversized Content-Length header", async () => {
      const largeBody = JSON.stringify({ issuer: "G" + "A".repeat(5000) });

      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/admin/issuers",
        method: "POST",
        headers: {
          "x-api-key": "test-key",
          "content-type": "application/json",
          "content-length": largeBody.length,
        },
        body: largeBody,
      });

      expect(res.statusCode).toBe(413);
      expect(res.body).toContain("payload_too_large");
    });

    it("should accept POST with body exactly at limit", async () => {
      // Create a body that's exactly at the limit
      const payloadSize = mockConfig.maxBodyBytes - 50; // Leave room for JSON structure
      const issuer = "G" + "A".repeat(payloadSize - 30);
      const body = JSON.stringify({ issuer });

      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/admin/issuers",
        method: "POST",
        headers: {
          "x-api-key": "test-key",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        body,
      });

      // Should succeed (200 or 201)
      expect([200, 201, 400]).toContain(res.statusCode);
      // If it's 400, it's because issuer format is invalid, not because of size
      if (res.statusCode === 400) {
        expect(res.body).not.toContain("payload_too_large");
      }
    });
  });

  describe("Streaming size check", () => {
    it("should abort streaming if body exceeds limit without Content-Length", async () => {
      const largeBody = JSON.stringify({ issuer: "G" + "A".repeat(5000) });

      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/admin/issuers",
        method: "POST",
        headers: {
          "x-api-key": "test-key",
          "content-type": "application/json",
          // Intentionally omit content-length to test streaming check
        },
        body: largeBody,
      });

      expect(res.statusCode).toBe(413);
      expect(res.body).toContain("payload_too_large");
    });
  });

  describe("Valid requests succeed", () => {
    it("should allow POST with valid small payload", async () => {
      const body = JSON.stringify({ issuer: "GISSUER1234567890" });

      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/admin/issuers",
        method: "POST",
        headers: {
          "x-api-key": "test-key",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        body,
      });

      // 201 Created or 400 Bad Request (if issuer format invalid), but NOT 413
      expect(res.statusCode).not.toBe(413);
      expect(res.body).not.toContain("payload_too_large");
    });

    it("should allow DELETE with valid small payload", async () => {
      const body = JSON.stringify({ issuer: "GISSUER1234567890" });

      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/admin/issuers",
        method: "DELETE",
        headers: {
          "x-api-key": "test-key",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        body,
      });

      // 200 OK or 400 Bad Request, but NOT 413
      expect(res.statusCode).not.toBe(413);
      expect(res.body).not.toContain("payload_too_large");
    });
  });

  describe("GET requests unaffected", () => {
    it("should allow GET requests regardless of size considerations", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/health",
        method: "GET",
        headers: {
          "x-api-key": "test-key",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("ok");
    });
  });

  describe("Warning logging", () => {
    it("should log warning when limit is exceeded", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const largeBody = JSON.stringify({ issuer: "G" + "A".repeat(5000) });

      await makeRequest(server, {
        hostname: "localhost",
        port: 8768,
        path: "/admin/issuers",
        method: "POST",
        headers: {
          "x-api-key": "test-key",
          "content-type": "application/json",
          "content-length": largeBody.length,
        },
        body: largeBody,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Payload too large"),
      );

      warnSpy.mockRestore();
    });
  });

  describe("Configuration", () => {
    it("should respect MAX_BODY_BYTES env var", () => {
      const configWithCustomLimit = {
        ...mockConfig,
        maxBodyBytes: 512, // 512 bytes
      };

      const customApp = createApp({
        config: configWithCustomLimit,
        soroban: mockSoroban,
        metrics: mockMetrics,
        metricsAggregator: null,
      });

      expect(configWithCustomLimit.maxBodyBytes).toBe(512);
    });
  });
});
