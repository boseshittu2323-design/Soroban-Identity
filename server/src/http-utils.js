export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', ...headers });
  res.end(body);
}

export function notFound(res) {
  sendJson(res, 404, { error: 'not_found' });
}

export function requireAdmin(req, res, config) {
  if (!config.adminApiKey) {
    sendJson(res, 503, { error: 'admin_api_key_not_configured' });
    return false;
  }
  const token = req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token !== config.adminApiKey) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}
