import assert from 'node:assert/strict';
import test from 'node:test';
import { findExpiringCredentials, paginate, buildExpiryIndex } from '../src/expiry.js';

test('findExpiringCredentials returns credentials inside the warning window', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const credentials = [
    { id: 'expired', expires_at: 1_767_225_599 },
    { id: 'soon', expires_at: 1_767_398_400 },
    { id: 'later', expires_at: 1_768_003_200 },
    { id: 'never', expires_at: 0 },
  ];

  assert.deepEqual(findExpiringCredentials(credentials, { windowDays: 7, now }).map((item) => item.id), ['soon']);
});

test('paginate caps page size and reports total', () => {
  const page = paginate([1, 2, 3, 4], { page: 2, pageSize: 2 });
  assert.deepEqual(page, { page: 2, pageSize: 2, total: 4, items: [3, 4] });
});

test('buildExpiryIndex — excludes credentials with no expiresAt and sorts by expires_at', () => {
  const creds = [
    { id: 'c', expires_at: 300 },
    { id: 'a', expires_at: 100 },
    { id: 'never', expires_at: 0 },
    { id: 'b', expires_at: 200 },
  ];
  const index = buildExpiryIndex(creds);
  assert.deepEqual(index.map((c) => c.id), ['a', 'b', 'c']);
});

test('findExpiringCredentials — empty credential store returns empty array', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.deepEqual(findExpiringCredentials([], { windowDays: 7, now }), []);
});

test('findExpiringCredentials — all credentials expiring returns all within window', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const credentials = [
    { id: 'a', expires_at: nowSec + 100 },
    { id: 'b', expires_at: nowSec + 200 },
  ];
  const result = findExpiringCredentials(credentials, { windowDays: 1, now });
  assert.equal(result.length, 2);
});

test('findExpiringCredentials — none expiring within window returns empty array', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const credentials = [{ id: 'far', expires_at: nowSec + 999_999 }];
  const result = findExpiringCredentials(credentials, { windowDays: 1, now });
  assert.deepEqual(result, []);
});

test('findExpiringCredentials — reuses index when credentials reference is unchanged', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const credentials = [{ id: 'soon', expires_at: nowSec + 100 }];

  // Both calls use the same reference — index should be built once and reused.
  const r1 = findExpiringCredentials(credentials, { windowDays: 1, now });
  const r2 = findExpiringCredentials(credentials, { windowDays: 1, now });
  assert.deepEqual(r1, r2);
});

test('findExpiringCredentials — rebuilds index when credentials reference changes', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const nowSec = Math.floor(now.getTime() / 1000);
  const first = [{ id: 'a', expires_at: nowSec + 100 }];
  const second = [...first, { id: 'b', expires_at: nowSec + 200 }];

  const r1 = findExpiringCredentials(first, { windowDays: 1, now });
  assert.equal(r1.length, 1);

  const r2 = findExpiringCredentials(second, { windowDays: 1, now });
  assert.equal(r2.length, 2);
});
