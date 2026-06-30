import { readCredentials, upsertCredential, writeCredentials } from './storage.js';
import { logger } from './logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let _indexedCredentials = null;
let _expiryIndex = null;

/**
 * Create a bounded concurrency limiter that processes tasks with a maximum
 * number of concurrent executions.
 * 
 * @param {number} concurrency - Maximum number of concurrent tasks
 * @returns {Function} Async function that wraps a task with concurrency control
 */
function createConcurrencyPool(concurrency) {
  let running = 0;
  const queue = [];
  
  async function run(fn) {
    while (running >= concurrency) {
      await new Promise(resolve => queue.push(resolve));
    }
    
    running++;
    try {
      return await fn();
    } finally {
      running--;
      const next = queue.shift();
      if (next) next();
    }
  }
  
  return run;
}

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
    this.concurrency = Number.parseInt(process.env.EXPIRY_CONCURRENCY ?? '8', 10);
    
    // Ensure concurrency is at least 1
    if (this.concurrency < 1) {
      logger.warn({ original: this.concurrency, clamped: 1 }, 'EXPIRY_CONCURRENCY too low, clamping to 1');
      this.concurrency = 1;
    }
    
    logger.info({ concurrency: this.concurrency }, 'Expiry notification job concurrency configured');
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
    
    if (expiring.length === 0) return 0;
    
    logger.info({ count: expiring.length, concurrency: this.concurrency }, 'Processing expiring credentials');
    
    // Create bounded concurrency pool
    const pool = createConcurrencyPool(this.concurrency);
    
    // Process credentials concurrently with bounded parallelism
    const results = await Promise.allSettled(
      expiring.map(credential => 
        pool(async () => {
          try {
            await this.dispatch(credential);
            return { credential, success: true };
          } catch (error) {
            logger.error({ 
              credentialId: credential.id,
              error: error.message,
              stack: error.stack 
            }, 'Failed to dispatch expiry notification');
            return { credential, success: false, error };
          }
        })
      )
    );
    
    // Update credentials with notification timestamps for successful dispatches
    let updated = credentials;
    let successCount = 0;
    let failureCount = 0;
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        const { credential } = result.value;
        updated = upsertCredential(updated, { 
          ...credential, 
          expiry_notified_at: new Date().toISOString() 
        });
        successCount++;
      } else {
        failureCount++;
      }
    }
    
    await writeCredentials(this.config, updated);
    
    logger.info({ 
      total: expiring.length,
      success: successCount,
      failed: failureCount 
    }, 'Completed expiry notification processing');
    
    return successCount;
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
