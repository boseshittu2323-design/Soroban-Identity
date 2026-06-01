import { URL } from 'node:url';
import { appendAuditLog, readCredentials } from './storage.js';
import { findExpiringCredentials, paginate } from './expiry.js';
import { notFound, readJson, requireAdmin, sendJson, sendText } from './http-utils.js';

export function createApp({ config, soroban, metrics, metricsAggregator }) {
  return async function app(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        const contracts = await soroban.pingAllContracts();
        const ok = Object.values(contracts).every(Boolean);
        return sendJson(res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', contracts });
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        if (metricsAggregator) await metricsAggregator.refresh().catch((error) => console.error('metrics refresh failed', error));
        return sendText(res, 200, metrics.renderPrometheus());
      }

      if (url.pathname.startsWith('/admin/') && !requireAdmin(req, res, config)) return;

      if (req.method === 'GET' && url.pathname === '/admin/issuers') {
        const issuers = await soroban.getIssuers();
        return sendJson(res, 200, { issuers });
      }

      if (req.method === 'POST' && url.pathname === '/admin/issuers') {
        const body = await readJson(req);
        if (!body.issuer) return sendJson(res, 400, { error: 'issuer_required' });
        await soroban.addIssuer(body.issuer);
        await appendAuditLog(config, { action: 'add_issuer', actor: req.headers['x-actor'] ?? config.adminActor, issuer: body.issuer });
        return sendJson(res, 201, { issuer: body.issuer });
      }

      if (req.method === 'DELETE' && url.pathname === '/admin/issuers') {
        const body = await readJson(req);
        const issuer = body.issuer ?? url.searchParams.get('issuer');
        if (!issuer) return sendJson(res, 400, { error: 'issuer_required' });
        await soroban.removeIssuer(issuer);
        await appendAuditLog(config, { action: 'remove_issuer', actor: req.headers['x-actor'] ?? config.adminActor, issuer });
        return sendJson(res, 200, { issuer });
      }

      if (req.method === 'GET' && url.pathname === '/admin/expiry-report') {
        const windowDays = Number.parseInt(url.searchParams.get('windowDays') ?? '', 10) || config.expiryWarningDays;
        const credentials = await readCredentials(config);
        const expiring = findExpiringCredentials(credentials, { windowDays, includeNotified: true });
        return sendJson(res, 200, paginate(expiring, {
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
        }));
      }

      return notFound(res);
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: 'internal_server_error', message: error.message });
    }
  };
}
