import assert from 'node:assert/strict';
import test from 'node:test';
import { findExpiringCredentials, paginate } from '../src/expiry.js';

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
