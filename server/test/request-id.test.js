import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { requestContextStore } from '../src/request-context.js';

const testDir = path.join(process.cwd(), 'data', 'test-request-id');
const config = {
  dataDir: testDir,
  auditLogPath: path.join(testDir, 'audit.ndjson'),
  credentialStorePath: path.join(testDir, 'credentials.json'),
  adminApiKey: 'test-api-key',
  adminActor: 'test-admin',
};

const soroban = {
  pingAllContracts: async () => ({ contract1: true }),
  circuitBreaker: {
    toHealthInfo: () => ({ state: 'CLOSED', failures: 0, lastStateChange: '' }),
  },
  getIssuers: async () => [],
  addIssuer: async () => {},
};

const metrics = {
  renderPrometheus: () => 'metrics',
};

class MockResponse {
  constructor() {
    this.headers = {};
    this.statusCode = null;
    this.body = null;
    this.finished = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = value;
      }
    }
  }

  end(body) {
    this.body = body;
    this._resolve();
  }
}

before(async () => {
  await fs.mkdir(testDir, { recursive: true }).catch(() => {});
});

after(async () => {
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

test('should generate a new request ID if none is provided in headers', async () => {
  const app = createApp({ config, soroban, metrics });
  const req = {
    method: 'GET',
    url: '/health',
    headers: { host: 'localhost' },
  };
  const res = new MockResponse();
  await app(req, res);
  await res.finished;

  const reqId = res.headers['x-request-id'];
  assert.ok(reqId, 'request ID should exist');
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reqId),
    'request ID should be a valid UUID'
  );
});

test('should echo back the provided X-Request-ID', async () => {
  const app = createApp({ config, soroban, metrics });
  const customId = 'my-custom-request-id-12345';
  const req = {
    method: 'GET',
    url: '/health',
    headers: { host: 'localhost', 'x-request-id': customId },
  };
  const res = new MockResponse();
  await app(req, res);
  await res.finished;

  assert.equal(res.headers['x-request-id'], customId);
});

test('should prepend request ID to console logs during request', async () => {
  let stderrLogs = [];
  const originalErrWrite = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => {
    stderrLogs.push(chunk.toString());
    return originalErrWrite.call(process.stderr, chunk, encoding, callback);
  };

  try {
    const customSoroban = {
      ...soroban,
      pingAllContracts: async () => {
        console.error('Inside request execution log');
        return { contract1: true };
      },
    };
    const app = createApp({ config, soroban: customSoroban, metrics });
    const customId = 'log-test-id-999';
    const req = {
      method: 'GET',
      url: '/health',
      headers: { host: 'localhost', 'x-request-id': customId },
    };
    const res = new MockResponse();
    await app(req, res);
    await res.finished;

    const matchingLog = stderrLogs.find((log) => log.includes('Inside request execution log'));
    assert.ok(matchingLog, 'Log should be captured');
    assert.ok(matchingLog.includes(`[${customId}] Inside request execution log`), `Log should contain prefix, got: ${matchingLog}`);
  } finally {
    process.stderr.write = originalErrWrite;
  }
});

test('should include requestId in audit logs generated during request', async () => {
  await fs.rm(config.auditLogPath, { force: true });

  const app = createApp({ config, soroban, metrics });
  const customId = 'audit-test-id-555';
  const req = {
    method: 'POST',
    url: '/admin/issuers',
    headers: {
      host: 'localhost',
      'x-api-key': 'test-api-key',
      'x-request-id': customId,
    },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ issuer: 'GDID...' }));
    },
  };
  const res = new MockResponse();
  await app(req, res);
  await res.finished;

  assert.equal(res.statusCode, 201);

  const logContent = await fs.readFile(config.auditLogPath, 'utf8');
  const lines = logContent.trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.requestId, customId);
  assert.equal(entry.action, 'add_issuer');
});
