import { URL } from "node:url";
import crypto from "node:crypto";
import { appendAuditLog, readCredentials, writeCredentials, createCredential, DuplicateCredentialError } from "./storage.js";
import { findExpiringCredentials, paginate, paginateCursor } from "./expiry.js";
import {
  notFound,
  readJson,
  requireAdmin,
  requireAuth,
  sendJson,
  sendText,
  setCorsHeaders,
  validateContentType,
} from "./http-utils.js";
import { requestContextStore } from "./request-context.js";
import { logger } from "./logger.js";
const SERVER_VERSION = "0.1.0";
const MIN_SDK_VERSION = "0.1.0";
const SERVER_FEATURES = ["webhook_delivery", "batch_issuance", "event_polling"];

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

        if (req.method === "GET" && url.pathname === "/info") {
          return sendJson(res, 200, {
            version: SERVER_VERSION,
            features: SERVER_FEATURES,
            minSdkVersion: MIN_SDK_VERSION,
          });
        }

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
              .catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Metrics refresh failed'));
          return sendText(res, 200, metrics.renderPrometheus());
        }

        // #390: paginated credential list
        if (req.method === "GET" && url.pathname === "/credentials") {
          const limitParam = url.searchParams.get("limit") ?? "50";
          const limitNum = Number.parseInt(limitParam, 10) || 50;
          if (limitNum > 200) {
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "limit must not exceed 200" });
          }
          const credentials = await readCredentials(config);
          const { items, nextCursor } = paginateCursor(credentials, {
            limit: limitNum,
            cursor: url.searchParams.get("cursor"),
          });
          return sendJson(res, 200, { items, nextCursor });
        }

        // Single-item GET /credentials/:id
        const credentialIdMatch = url.pathname.match(/^\/credentials\/([^/]+)$/);
        if (req.method === "GET" && credentialIdMatch) {
          const credentialId = decodeURIComponent(credentialIdMatch[1]);
          const credentials = await readCredentials(config);
          const credential = credentials.find((c) => c.id === credentialId);
          if (!credential) return notFound(res);
          return sendJson(res, 200, credential);
        }

        const verifyMatch = url.pathname.match(/^\/credentials\/([^/]+)\/verify$/);
        if (req.method === "POST" && verifyMatch) {
          // Verify endpoint requires credentials:read scope
          if (!requireAuth(req, res, config, ['credentials:read'])) return;
          
          const credentialId = decodeURIComponent(verifyMatch[1]);
          const credentials = await readCredentials(config);
          const credential = credentials.find((c) => c.id === credentialId);
          if (!credential) {
            return sendJson(res, 200, { verified: false, reason: "not_found" });
          }
          if (credential.revoked) {
            return sendJson(res, 200, { verified: false, reason: "revoked" });
          }
          const now = Math.floor(Date.now() / 1000);
          if (credential.expiresAt > 0 && credential.expiresAt < now) {
            return sendJson(res, 200, { verified: false, reason: "expired" });
          }
          return sendJson(res, 200, { verified: true, credential });
        }

        if (
          url.pathname.startsWith("/admin/") &&
          !requireAdmin(req, res, config)
        )
          return;

        if (req.method === "POST" && url.pathname === "/credentials") {
          if (validateContentType(req, res)) return;
          const body = await readJson(req, config);
          if (body.__payloadTooLarge)
            return sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." });
          if (!body.id)
            return sendJson(res, 400, { code: "INVALID_REQUEST", message: "Request body must include a credential id." });
          try {
            const credentials = await readCredentials(config);
            const updated = createCredential(credentials, body);
            await writeCredentials(config, updated);
            await appendAuditLog(config, { action: "issue_credential", credentialId: body.id });
            return sendJson(res, 201, body);
          } catch (err) {
            if (err instanceof DuplicateCredentialError) {
              return sendJson(res, 409, {
                code: "CREDENTIAL_ALREADY_EXISTS",
                message: err.message,
                details: [{ field: "id", value: err.id }],
              });
            }
            throw err;
          }
        }

        if (req.method === "GET" && url.pathname === "/admin/issuers") {
          // Reading issuers requires admin:read or wildcard scope
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          
          const issuers = await soroban.getIssuers();
          return sendJson(res, 200, { issuers });
        }

        if (req.method === "POST" && url.pathname === "/admin/issuers") {
          if (validateContentType(req, res)) return;
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
          // Removing issuers requires admin:write scope
          if (!requireAuth(req, res, config, ['admin:write'])) return;
          
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
          // Reading expiry reports requires admin:read scope
          if (!requireAuth(req, res, config, ['admin:read'])) return;
          
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
          logger.error({ 
            error: error.category, 
            message: error.publicMessage,
            internalDetail: error.internalDetail 
          }, 'Soroban error occurred');
          return sendJson(res, 500, {
            error: error.category,
            message: error.publicMessage,
          });
        }
        logger.error({ error: error.message, stack: error.stack }, 'Internal server error');
        return sendJson(res, 500, {
          error: "internal_server_error",
          message: error.message,
        });
      }
    });
  };
}
