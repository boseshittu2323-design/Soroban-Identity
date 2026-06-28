import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { appendAuditLog, ensureDataDir } from '../src/storage.js';

// Simple date mock
const OriginalDate = global.Date;
class MockDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0 && MockDate.mockTime !== null) {
      super(MockDate.mockTime);
    } else {
      super(...args);
    }
  }
}
MockDate.mockTime = null;
global.Date = MockDate;

const testDataDir = path.resolve(process.cwd(), 'test-data-storage');
const baseLogPath = path.join(testDataDir, 'audit');

const config = {
  dataDir: testDataDir,
  auditLogPath: baseLogPath,
  credentialStorePath: path.join(testDataDir, 'credentials.json'),
  auditLogRetentionDays: 3
};

test.after(async () => {
  // Restore Date
  global.Date = OriginalDate;
  // Cleanup test files
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
});

test('appendAuditLog creates dated log file and handles rotation on date change', async () => {
  // Ensure fresh folder
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await ensureDataDir(config);

  // Day 1
  MockDate.mockTime = new Date('2026-06-01T12:00:00Z').getTime();
  await appendAuditLog(config, { action: 'test-day-1' });

  const pathDay1 = `${baseLogPath}-2026-06-01.ndjson`;
  assert.ok(fs.existsSync(pathDay1), 'Day 1 log file should exist');

  const contentDay1 = await fsPromises.readFile(pathDay1, 'utf8');
  assert.match(contentDay1, /"action":"test-day-1"/);

  // Day 2 (rotation)
  MockDate.mockTime = new Date('2026-06-02T08:00:00Z').getTime();
  await appendAuditLog(config, { action: 'test-day-2' });

  const pathDay2 = `${baseLogPath}-2026-06-02.ndjson`;
  assert.ok(fs.existsSync(pathDay2), 'Day 2 log file should exist');

  const contentDay2 = await fsPromises.readFile(pathDay2, 'utf8');
  assert.match(contentDay2, /"action":"test-day-2"/);
});

test('ensureDataDir deletes audit files older than retention days', async () => {
  if (fs.existsSync(testDataDir)) {
    await fsPromises.rm(testDataDir, { recursive: true, force: true });
  }
  await ensureDataDir(config);

  // Today is 2026-06-05
  MockDate.mockTime = new Date('2026-06-05T12:00:00Z').getTime();

  // Active: 1 day old (2026-06-04)
  const pathActive = `${baseLogPath}-2026-06-04.ndjson`;
  // Active: 3 days old (2026-06-02)
  const pathActiveLimit = `${baseLogPath}-2026-06-02.ndjson`;
  // Expired: 4 days old (2026-06-01)
  const pathExpired = `${baseLogPath}-2026-06-01.ndjson`;
  // Expired: 10 days old (2026-05-26)
  const pathExpiredOlder = `${baseLogPath}-2026-05-26.ndjson`;

  await fsPromises.writeFile(pathActive, '{"action":"active"}');
  await fsPromises.writeFile(pathActiveLimit, '{"action":"active-limit"}');
  await fsPromises.writeFile(pathExpired, '{"action":"expired"}');
  await fsPromises.writeFile(pathExpiredOlder, '{"action":"expired-older"}');

  // Trigger cleanup via ensureDataDir
  await ensureDataDir(config);

  // Verify
  assert.ok(fs.existsSync(pathActive), 'Active file should NOT be deleted');
  assert.ok(fs.existsSync(pathActiveLimit), 'File at exact limit age should NOT be deleted');
  assert.ok(!fs.existsSync(pathExpired), 'Expired file should be deleted');
  assert.ok(!fs.existsSync(pathExpiredOlder), 'Very old expired file should be deleted');
});
