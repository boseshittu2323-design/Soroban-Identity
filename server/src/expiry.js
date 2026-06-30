import { readCredentials, upsertCredential, writeCredentials } from './storage.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let _indexedCredentials = null;
let _expiryIndex = null;

import { logger } from './logger.js';

/**
 * Build a sorted index of credentials that have an `expires_at` value, ordered
 * ascending by expiry time. Pass this to `findExpiringCredentials` to avoid
 * O(n) scans on every call.
 *
 * @param {Array} credentials - Full credentials array.
 * @returns {Array} Sorted array of credentials with `expires_at > 0`.
 */
export function buildExpiryIndex(credentials) {
  return credentials
    .filter((c) => Number(c.expires_at) > 0)
    .sort((a, b) => Number(a.expires_at) - Number(b.expires_at));
}

function lowerBound(index, nowMs) {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(index[mid].expires_at) * 1000 < nowMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(index, upper) {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(index[mid].expires_at) * 1000 <= upper) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function findExpiringCredentials(credentials, { windowDays, now = new Date(), includeNotified = false } = {}) {
  if (_indexedCredentials !== credentials) {
    _expiryIndex = buildExpiryIndex(credentials);
    _indexedCredentials = credentials;
  }

  const nowMs = now.getTime();
  const upper = nowMs + windowDays * DAY_MS;

  const lo = lowerBound(_expiryIndex, nowMs);
  const hi = upperBound(_expiryIndex, upper);

  return _expiryIndex
    .slice(lo, hi)
    .filter((c) => includeNotified || !c.expiry_notified_at);
}

/**
 * Cursor-based pagination over an array sorted by `id`.
 * The cursor is the last-seen `id`; pass null/undefined for the first page.
 */
export function paginateCursor(items, { limit = 50, cursor = null } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  const startIndex = cursor
    ? items.findIndex((item) => item.id === cursor) + 1
    : 0;
  const page = items.slice(startIndex, startIndex + safeLimit);
  const nextCursor = page.length === safeLimit && startIndex + safeLimit < items.length
    ? page[page.length - 1].id
    : null;
  return { items: page, nextCursor };
}

export function paginate(items, { page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(200, Math.max(1, Number.parseInt(pageSize, 10) || 50));
  const start = (safePage - 1) * safePageSize;
  return {
    page: safePage,
    pageSize: safePageSize,
    total: items.length,
    items: items.slice(start, start + safePageSize),
  };
}

export class ExpiryNotificationJob {
  constructor(config, soroban = null) {
    this.config = config;
    this.soroban = soroban;
    this.timer = null;
    this.nextLedger = Number.parseInt(process.env.EXPIRY_EVENTS_START_LEDGER ?? '0', 10);
  }

  start() {
    if (this.timer) return;
    this.runOnce().catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Expiry job failed'));
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => logger.error({ error: error.message, stack: error.stack }, 'Expiry job failed'));
    }, this.config.expiryJobIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    let credentials = await readCredentials(this.config);
    credentials = await this.indexCredentialEvents(credentials);
    const expiring = findExpiringCredentials(credentials, { windowDays: this.config.expiryWarningDays });
    for (const credential of expiring) {
      await this.dispatch(credential);
      credentials = upsertCredential(credentials, { ...credential, expiry_notified_at: new Date().toISOString() });
    }
    await writeCredentials(this.config, credentials);
    return expiring.length;
  }

  async indexCredentialEvents(credentials) {
    if (!this.soroban) return credentials;
    const events = await this.soroban.getEvents(this.nextLedger);
    let next = credentials;
    for (const event of events) {
      const credential = credentialFromEvent(event);
      if (credential) next = upsertCredential(next, credential);
    }
    const newest = events.map((event) => Number(event.ledger ?? 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (newest) this.nextLedger = newest + 1;
    return next;
  }

  async dispatch(credential) {
    const target = this.config.subjectNotificationWebhooks[credential.subject] ?? this.config.notificationWebhookUrl;
    if (!target) return;
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'credential.expiring',
        credential_id: credential.id,
        subject: credential.subject,
        issuer: credential.issuer,
        expires_at: credential.expires_at,
        warning_window_days: this.config.expiryWarningDays,
      }),
    });
    if (!response.ok) throw new Error(`notification dispatch failed with HTTP ${response.status}`);
  }
}

export function credentialFromEvent(event) {
  const text = JSON.stringify(event).toLowerCase();
  if (!text.includes('cred') || !text.includes('issued')) return null;
  const value = event.value ?? event.data ?? event;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = value.id ?? value.credential_id;
    const subject = value.subject;
    const issuer = value.issuer;
    const expires_at = Number(value.expires_at);
    if (id && subject && issuer && expires_at) return { id, subject, issuer, expires_at, source: 'event' };
  }
  return null;
}
