import { URL } from "node:url";
import crypto from "node:crypto";
import { appendAuditLog, readCredentials } from "./storage.js";
import { findExpiringCredentials, paginate } from "./expiry.js";
import {
  notFound,
  readJson,
  requireAdmin,
  sendJson,
  sendText,
  setCorsHeaders,
} from "./http-utils.js";
import { requestContextStore } from "./request-context.js";

export function createApp({ config, soroban, metrics, metricsAggregator }) {
  return function app(req, res) {
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();
    res.setHeader("X-Request-ID", requestId);

    // Apply CORS headers
    if (setCorsHeaders(req, res, config)) {
      // Preflight OPTIONS request
      return res.writeHead(204).end();
    }

    return requestContextStore.run({ requestId }, async () => {
      try {
        const url = new URL(
          req.url,
          `http://${req.headers.host ?? "localhost"}`,
        );

        if (req.method === "GET" && url.pathname === "/health") {
          const contracts = await soroban.pingAllContracts();
          const ok = Object.values(contracts).every(Boolean);
          return sendJson(res, ok ? 200 : 503, {
            status: ok ? "ok" : "degraded",
            contracts,
            circuitBreaker: soroban.circuitBreaker.toHealthInfo(),
          });
        }

        if (req.method === "GET" && url.pathname === "/metrics") {
          if (metricsAggregator)
            await metricsAggregator
              .refresh()
              .catch((error) => console.error("metrics refresh failed", error));
          return sendText(res, 200, metrics.renderPrometheus());
        }

        if (
          url.pathname.startsWith("/admin/") &&
          !requireAdmin(req, res, config)
        )
          return;

        if (req.method === "GET" && url.pathname === "/admin/issuers") {
          const issuers = await soroban.getIssuers();
          return sendJson(res, 200, { issuers });
        }

        if (req.method === "POST" && url.pathname === "/admin/issuers") {
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { error: "payload_too_large" });
          if (!body.issuer)
            return sendJson(res, 400, { error: "issuer_required" });
          await soroban.addIssuer(body.issuer);
          await appendAuditLog(config, {
            action: "add_issuer",
            actor: req.headers["x-actor"] ?? config.adminActor,
            issuer: body.issuer,
          });
          return sendJson(res, 201, { issuer: body.issuer });
        }

        if (req.method === "DELETE" && url.pathname === "/admin/issuers") {
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { error: "payload_too_large" });
          const issuer = body.issuer ?? url.searchParams.get("issuer");
          if (!issuer) return sendJson(res, 400, { error: "issuer_required" });
          await soroban.removeIssuer(issuer);
          await appendAuditLog(config, {
            action: "remove_issuer",
            actor: req.headers["x-actor"] ?? config.adminActor,
            issuer,
          });
          return sendJson(res, 200, { issuer });
        }

        if (req.method === "GET" && url.pathname === "/admin/expiry-report") {
          const windowDays =
            Number.parseInt(url.searchParams.get("windowDays") ?? "", 10) ||
            config.expiryWarningDays;
          const credentials = await readCredentials(config);
          const expiring = findExpiringCredentials(credentials, {
            windowDays,
            includeNotified: true,
          });
          return sendJson(
            res,
            200,
            paginate(expiring, {
              page: url.searchParams.get("page"),
              pageSize: url.searchParams.get("pageSize"),
            }),
          );
        }

        return notFound(res);
      } catch (error) {
        if (error.name === "SorobanError") {
          console.error(error.internalDetail);
          return sendJson(res, 500, {
            error: error.category,
            message: error.publicMessage,
          });
        }
        console.error(error);
        return sendJson(res, 500, {
          error: "internal_server_error",
          message: error.message,
        });
      }
    });
  };
}
