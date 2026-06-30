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

/**
 * Authenticate and authorize a request with optional scope requirements.
 * 
 * @param {object} req - HTTP request object
 * @param {object} res - HTTP response object
 * @param {object} config - Server configuration
 * @param {string[]} requiredScopes - Array of required scopes (e.g., ['credentials:write'])
 * @returns {boolean} True if authenticated and authorized, false otherwise
 */
export function requireAuth(req, res, config, requiredScopes = []) {
  if (!config.adminApiKey) {
    sendJson(res, 503, { 
      error: "admin_api_key_not_configured",
      code: "SERVICE_UNAVAILABLE",
      message: "API key authentication is not configured"
    });
    return false;
  }
  
  const token =
    req.headers["x-api-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");
    
  if (!token) {
    sendJson(res, 401, { 
      error: "unauthorized",
      code: "UNAUTHORIZED",
      message: "Missing API key"
    });
    return false;
  }
  
  // Parse API key record if it contains scope information
  // Format: apiKey:scope1,scope2,scope3 or just apiKey for full access
  const [keyPart, scopesPart] = token.split(':');
  const keyScopes = scopesPart ? scopesPart.split(',') : [];
  
  // Simple comparison for the admin key (backward compatible)
  if (keyPart !== config.adminApiKey) {
    sendJson(res, 401, { 
      error: "unauthorized",
      code: "UNAUTHORIZED",
      message: "Invalid API key"
    });
    return false;
  }
  
  // If this is the admin key without scopes, grant full access
  if (!scopesPart) {
    req.apiKeyScopes = ['*'];
    return true;
  }
  
  // Check if required scopes are present
  if (requiredScopes.length > 0) {
    const hasWildcard = keyScopes.includes('*');
    const hasAllScopes = requiredScopes.every(required => 
      hasWildcard || keyScopes.includes(required)
    );
    
    if (!hasAllScopes) {
      const missingScopes = requiredScopes.filter(s => !keyScopes.includes(s));
      sendJson(res, 403, { 
        error: "forbidden",
        code: "INSUFFICIENT_SCOPE",
        message: "API key does not have required permissions",
        requiredScopes,
        missingScopes
      });
      return false;
    }
  }
  
  req.apiKeyScopes = keyScopes;
  return true;
}

/**
 * Legacy admin check - maintains backward compatibility
 */
export function requireAdmin(req, res, config) {
  return requireAuth(req, res, config, []);
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
