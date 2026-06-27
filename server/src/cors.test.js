import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Mock dependencies
const mockConfig = {
  adminApiKey: "test-key",
  adminActor: "admin",
  corsAllowedOrigins: ["https://app.example.com", "http://localhost:5173"],
  expiryWarningDays: 7,
};

const mockSoroban = {
  pingAllContracts: () => ({
    credential: true,
    identity: true,
    reputation: true,
  }),
  getIssuers: () => Promise.resolve([]),
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
      req.write(options.body);
    }
    req.end();
  });
}

describe("CORS Integration Tests", () => {
  let server;
  const baseUrl = "http://localhost:8765";

  beforeEach(() => {
    const app = createApp({
      config: mockConfig,
      soroban: mockSoroban,
      metrics: mockMetrics,
      metricsAggregator: null,
    });
    server = createServer(app);
    server.listen(8765);
  });

  afterEach(() => {
    server.close();
  });

  describe("Preflight OPTIONS requests", () => {
    it("should respond to OPTIONS with 204 and correct CORS headers", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://app.example.com",
      );
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
      expect(res.headers["access-control-allow-headers"]).toContain(
        "Content-Type",
      );
      expect(res.headers["access-control-allow-headers"]).toContain(
        "Authorization",
      );
      expect(res.headers["access-control-max-age"]).toBe("86400");
    });

    it("should set Access-Control-Max-Age to 86400 seconds", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
        },
      });

      expect(res.headers["access-control-max-age"]).toBe("86400");
    });
  });

  describe("Allowed origins", () => {
    it("should allow requests from configured origin", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "GET",
        headers: {
          origin: "https://app.example.com",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://app.example.com",
      );
    });

    it("should allow requests from second configured origin", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "GET",
        headers: {
          origin: "http://localhost:5173",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
    });

    it("should not set Access-Control-Allow-Origin for blocked origins", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "GET",
        headers: {
          origin: "https://evil.example.com",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("X-Request-ID exposure", () => {
    it("should expose X-Request-ID header", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "GET",
        headers: {
          origin: "https://app.example.com",
        },
      });

      expect(res.headers["access-control-expose-headers"]).toContain(
        "X-Request-ID",
      );
      expect(res.headers["x-request-id"]).toBeDefined();
    });
  });

  describe("Wildcard CORS configuration", () => {
    it("should allow all origins when CORS_ALLOWED_ORIGINS=*", async () => {
      const appWithWildcard = createApp({
        config: {
          ...mockConfig,
          corsAllowedOrigins: ["*"],
        },
        soroban: mockSoroban,
        metrics: mockMetrics,
        metricsAggregator: null,
      });
      const wildcardServer = createServer(appWithWildcard);
      wildcardServer.listen(8766);

      try {
        const res = await makeRequest(wildcardServer, {
          hostname: "localhost",
          port: 8766,
          path: "/health",
          method: "GET",
          headers: {
            origin: "https://any-origin.com",
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe("*");
      } finally {
        wildcardServer.close();
      }
    });
  });

  describe("All route types support CORS", () => {
    it("should set CORS headers on GET endpoints", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/health",
        method: "GET",
        headers: {
          origin: "https://app.example.com",
        },
      });

      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://app.example.com",
      );
    });

    it("should set CORS headers on metrics endpoint", async () => {
      const res = await makeRequest(server, {
        hostname: "localhost",
        port: 8765,
        path: "/metrics",
        method: "GET",
        headers: {
          origin: "https://app.example.com",
        },
      });

      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://app.example.com",
      );
    });
  });

  describe("No CORS when disabled", () => {
    it("should not set CORS headers when corsAllowedOrigins is empty", async () => {
      const appNoCors = createApp({
        config: {
          ...mockConfig,
          corsAllowedOrigins: [],
        },
        soroban: mockSoroban,
        metrics: mockMetrics,
        metricsAggregator: null,
      });
      const noCorsServer = createServer(appNoCors);
      noCorsServer.listen(8767);

      try {
        const res = await makeRequest(noCorsServer, {
          hostname: "localhost",
          port: 8767,
          path: "/health",
          method: "GET",
          headers: {
            origin: "https://app.example.com",
          },
        });

        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        noCorsServer.close();
      }
    });
  });
});
