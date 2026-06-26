import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function makeConfig(dir) {
  return {
    dataDir: dir,
    auditLogPath: path.join(dir, 'audit.log'),
    credentialStorePath: path.join(dir, 'credentials.json'),
  };
}

async function freshModule() {
  // Re-import the module so each test starts with a clean module-level cache.
  // Node's module cache would keep the old state, so we use a cache-busted URL.
  const { readCredentials, writeCredentials, clearCredentialCache, TTL_MS } = await import(
    `../src/storage.js?bust=${Date.now()}`
  );
  return { readCredentials, writeCredentials, clearCredentialCache, TTL_MS };
}

test('readCredentials — cache hit skips disk after first read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  const config = await makeConfig(dir);
  const creds = [{ id: 'a' }, { id: 'b' }];
  await fs.writeFile(config.credentialStorePath, JSON.stringify({ credentials: creds }), 'utf8');

  const { readCredentials } = await freshModule();

  let readCount = 0;
  const origReadFile = fs.readFile;
  fs.readFile = async (...args) => { readCount++; return origReadFile(...args); };

  try {
    for (let i = 0; i < 10; i++) {
      await readCredentials(config);
    }
    assert.equal(readCount, 1, 'expected exactly one disk read for 10 consecutive calls');
  } finally {
    fs.readFile = origReadFile;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials — returns empty array when file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  const config = await makeConfig(dir);
  const { readCredentials } = await freshModule();

  try {
    const result = await readCredentials(config);
    assert.deepEqual(result, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeCredentials — invalidates cache so next read hits disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  const config = await makeConfig(dir);
  const initial = [{ id: 'x' }];
  await fs.writeFile(config.credentialStorePath, JSON.stringify({ credentials: initial }), 'utf8');

  const { readCredentials, writeCredentials } = await freshModule();

  const first = await readCredentials(config);
  assert.deepEqual(first, initial);

  const updated = [{ id: 'x' }, { id: 'y' }];
  await writeCredentials(config, updated);

  const second = await readCredentials(config);
  assert.deepEqual(second, updated, 'expected updated credentials after cache invalidation');

  await fs.rm(dir, { recursive: true, force: true });
});

test('clearCredentialCache — forces next read to hit disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  const config = await makeConfig(dir);
  const creds = [{ id: 'c' }];
  await fs.writeFile(config.credentialStorePath, JSON.stringify({ credentials: creds }), 'utf8');

  const { readCredentials, clearCredentialCache } = await freshModule();

  await readCredentials(config);
  clearCredentialCache();

  let readCount = 0;
  const origReadFile = fs.readFile;
  fs.readFile = async (...args) => { readCount++; return origReadFile(...args); };

  try {
    await readCredentials(config);
    assert.equal(readCount, 1, 'expected disk read after clearCredentialCache');
  } finally {
    fs.readFile = origReadFile;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
