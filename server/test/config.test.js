import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { validateConfig } from '../src/config.js';

test('validateConfig directly: empty env returns validation errors', () => {
  const result = validateConfig({});
  assert.equal(result.isValid, false);
  assert.ok(result.missing.some(e => e.includes('STELLAR_SECRET_KEY')));
  assert.ok(result.missing.some(e => e.includes('CREDENTIAL_CONTRACT_ID')));
});

test('validateConfig directly: valid required env passes', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  });
  assert.equal(result.isValid, true);
});

test('validateConfig directly: invalid formats trigger invalid errors', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'not-a-secret-key',
    CREDENTIAL_CONTRACT_ID: 'not-a-contract-address',
    PORT: 'abc',
    STELLAR_RPC_URL: 'not-a-url',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some(e => e.includes('STELLAR_SECRET_KEY')));
  assert.ok(result.invalid.some(e => e.includes('CREDENTIAL_CONTRACT_ID')));
  assert.ok(result.invalid.some(e => e.includes('PORT')));
  assert.ok(result.invalid.some(e => e.includes('STELLAR_RPC_URL')));
});

// Helper to spawn index.js with specific environment overrides
function runServer(envOverrides) {
  return new Promise((resolve) => {
    // Strip process.env credentials to ensure clean testing environment
    const baseEnv = { ...process.env };
    delete baseEnv.STELLAR_SECRET_KEY;
    delete baseEnv.STELLAR_SOURCE_ACCOUNT;
    delete baseEnv.CREDENTIAL_CONTRACT_ID;
    delete baseEnv.CREDENTIAL_MANAGER_ID;

    const child = spawn('node', ['src/index.js'], {
      env: {
        ...baseEnv,
        PORT: '0',
        DISABLE_EXPIRY_JOB: 'true',
        DATA_DIR: 'data/test-config',
        ...envOverrides,
      },
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('listening on :') && !resolved) {
        resolved = true;
        child.kill();
        resolve({ code: null, stdout, stderr });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (!resolved) {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

test('Integration: starting with no env vars prints missing required variables and exits 1', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: '',
    STELLAR_SOURCE_ACCOUNT: '',
    CREDENTIAL_CONTRACT_ID: '',
    CREDENTIAL_MANAGER_ID: '',
  });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('[config] Missing required environment variables:'));
  assert.ok(result.stderr.includes('STELLAR_SECRET_KEY: Stellar account secret key (S…)'));
  assert.ok(result.stderr.includes('CREDENTIAL_CONTRACT_ID: deployed credential contract address'));
});

test('Integration: starting with all required vars binds the port normally', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  });

  assert.ok(result.stdout.includes('listening on :') || result.code === 0 || result.code === null);
});

test('Integration: invalid URL for RPC_URL triggers a validation error and exits 1', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    STELLAR_RPC_URL: 'invalid-url',
  });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('STELLAR_RPC_URL: must be a valid URL'));
});

test('validateConfig directly: invalid SOROBAN_INVOKE_TIMEOUT_MS triggers validation error', () => {
  const result = validateConfig({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    SOROBAN_INVOKE_TIMEOUT_MS: 'not-a-number',
  });
  assert.equal(result.isValid, false);
  assert.ok(result.invalid.some(e => e.includes('SOROBAN_INVOKE_TIMEOUT_MS')));
});

test('Integration: invalid SOROBAN_INVOKE_TIMEOUT_MS value exits 1', async () => {
  const result = await runServer({
    STELLAR_SECRET_KEY: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CREDENTIAL_CONTRACT_ID: 'CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    SOROBAN_INVOKE_TIMEOUT_MS: 'invalid',
  });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('SOROBAN_INVOKE_TIMEOUT_MS'));
});
