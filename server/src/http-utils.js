/**
 * Returns true and sends 415 when the request is a non-GET/DELETE method
 * and the Content-Type is not application/json.
 */
export function validateContentType(req, res) {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") return false;
  const ct = req.headers["content-type"] ?? "";
  if (ct.toLowerCase().startsWith("application/json")) return false;
  sendJson(res, 415, { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" });
  return true;
}

export async function readJson(req, config) {
  // Check Content-Length header first
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const length = Number.parseInt(contentLength, 10);
    if (length > config.maxBodyBytes) {
      const remoteIp =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket?.remoteAddress ||
        "unknown";
      console.warn(
        `[readJson] Payload too large from ${remoteIp}: ${length} bytes (limit: ${config.maxBodyBytes})`,
      );
      return { __payloadTooLarge: true };
    }
  }

  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > config.maxBodyBytes) {
      const remoteIp =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket?.remoteAddress ||
        "unknown";
      console.warn(
        `[readJson] Payload too large from ${remoteIp}: exceeded ${config.maxBodyBytes} bytes during streaming`,
      );
      return { __payloadTooLarge: true };
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

export function notFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

export function requireAdmin(req, res, config) {
  if (!config.adminApiKey) {
    sendJson(res, 503, { error: "admin_api_key_not_configured" });
    return false;
  }
  const token =
    req.headers["x-api-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token !== config.adminApiKey) {
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * Determine the allowed origin for CORS based on the request origin
 * and the configured allowed origins list.
 */
export function getAllowedOrigin(requestOrigin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return null;
  }
  if (allowedOrigins.includes("*")) {
    return "*";
  }
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return null;
}

/**
 * Set CORS headers on the response.
 * Handles preflight OPTIONS requests and actual requests.
 */
export function setCorsHeaders(req, res, config) {
  const requestOrigin = req.headers.origin;
  const allowedOrigin = getAllowedOrigin(
    requestOrigin,
    config.corsAllowedOrigins,
  );

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // Add to Access-Control-Expose-Headers
  res.setHeader("Access-Control-Expose-Headers", "X-Request-ID, Content-Type");

  // Handle preflight OPTIONS
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key, X-Request-ID, X-Actor",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
    return true; // Handled, respond with 204
  }

  return false; // Not a preflight, continue with actual request
}
