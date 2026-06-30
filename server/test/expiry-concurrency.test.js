import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExpiryNotificationJob } from '../src/expiry.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('ExpiryNotificationJob respects EXPIRY_CONCURRENCY', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-test-'));
  const credentialStorePath = path.join(tmpDir, 'credentials.json');
  
  // Create credentials that will expire
  const now = Math.floor(Date.now() / 1000);
  const credentials = Array.from({ length: 20 }, (_, i) => ({
    id: `cred-${i}`,
    subject: `user-${i}`,
    issuer: 'issuer-1',
    expires_at: now + 86400, // Expires in 1 day
  }));
  
  await fs.writeFile(credentialStorePath, JSON.stringify(credentials));
  
  const config = {
    expiryWarningDays: 7,
    credentialStorePath,
    auditLogPath: path.join(tmpDir, 'audit.ndjson'),
    notificationWebhookUrl: '',
    subjectNotificationWebhooks: {},
  };
  
  // Track concurrent executions
  let maxConcurrent = 0;
  let currentConcurrent = 0;
  const dispatches = [];
  
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  process.env.EXPIRY_CONCURRENCY = '4';
  
  try {
    const job = new ExpiryNotificationJob(config);
    assert.equal(job.concurrency, 4, 'Should use EXPIRY_CONCURRENCY from env');
    
    // Override dispatch to track concurrency
    job.dispatch = async (credential) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      dispatches.push(credential.id);
      
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10));
      
      currentConcurrent--;
    };
    
    await job.runOnce();
    
    assert.ok(maxConcurrent <= 4, `Max concurrent should be <= 4, got ${maxConcurrent}`);
    assert.ok(maxConcurrent >= 2, 'Should have some concurrency');
    assert.equal(dispatches.length, 20, 'Should dispatch all credentials');
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ExpiryNotificationJob handles partial failures', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-test-'));
  const credentialStorePath = path.join(tmpDir, 'credentials.json');
  
  const now = Math.floor(Date.now() / 1000);
  const credentials = [
    { id: 'cred-1', subject: 'user-1', issuer: 'issuer-1', expires_at: now + 86400 },
    { id: 'cred-2', subject: 'user-2', issuer: 'issuer-1', expires_at: now + 86400 },
    { id: 'cred-3', subject: 'user-3', issuer: 'issuer-1', expires_at: now + 86400 },
    { id: 'cred-4', subject: 'user-4', issuer: 'issuer-1', expires_at: now + 86400 },
  ];
  
  await fs.writeFile(credentialStorePath, JSON.stringify(credentials));
  
  const config = {
    expiryWarningDays: 7,
    credentialStorePath,
    auditLogPath: path.join(tmpDir, 'audit.ndjson'),
    notificationWebhookUrl: '',
    subjectNotificationWebhooks: {},
  };
  
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  process.env.EXPIRY_CONCURRENCY = '2';
  
  try {
    const job = new ExpiryNotificationJob(config);
    
    const dispatched = [];
    const failed = [];
    
    // Make cred-2 and cred-4 fail
    job.dispatch = async (credential) => {
      if (credential.id === 'cred-2' || credential.id === 'cred-4') {
        failed.push(credential.id);
        throw new Error(`Failed to dispatch ${credential.id}`);
      }
      dispatched.push(credential.id);
    };
    
    const result = await job.runOnce();
    
    // Should return count of successful dispatches
    assert.equal(result, 2, 'Should return count of successful dispatches');
    assert.deepEqual(dispatched.sort(), ['cred-1', 'cred-3'], 'Should dispatch successful ones');
    assert.deepEqual(failed.sort(), ['cred-2', 'cred-4'], 'Should fail expected ones');
    
    // Read updated credentials
    const updated = JSON.parse(await fs.readFile(credentialStorePath, 'utf8'));
    
    // Successful dispatches should be marked as notified
    const notified = updated.filter(c => c.expiry_notified_at).map(c => c.id).sort();
    assert.deepEqual(notified, ['cred-1', 'cred-3'], 'Only successful dispatches should be marked');
    
    // Failed dispatches should not be marked
    const notNotified = updated.filter(c => !c.expiry_notified_at).map(c => c.id).sort();
    assert.deepEqual(notNotified, ['cred-2', 'cred-4'], 'Failed dispatches should not be marked');
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ExpiryNotificationJob with concurrency=1 processes sequentially', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-test-'));
  const credentialStorePath = path.join(tmpDir, 'credentials.json');
  
  const now = Math.floor(Date.now() / 1000);
  const credentials = Array.from({ length: 5 }, (_, i) => ({
    id: `cred-${i}`,
    subject: `user-${i}`,
    issuer: 'issuer-1',
    expires_at: now + 86400,
  }));
  
  await fs.writeFile(credentialStorePath, JSON.stringify(credentials));
  
  const config = {
    expiryWarningDays: 7,
    credentialStorePath,
    auditLogPath: path.join(tmpDir, 'audit.ndjson'),
    notificationWebhookUrl: '',
    subjectNotificationWebhooks: {},
  };
  
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  process.env.EXPIRY_CONCURRENCY = '1';
  
  try {
    const job = new ExpiryNotificationJob(config);
    assert.equal(job.concurrency, 1, 'Should use concurrency=1');
    
    let currentConcurrent = 0;
    let maxConcurrent = 0;
    
    job.dispatch = async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 5));
      currentConcurrent--;
    };
    
    await job.runOnce();
    
    assert.equal(maxConcurrent, 1, 'Should never exceed concurrency of 1');
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ExpiryNotificationJob handles pool exhaustion gracefully', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-test-'));
  const credentialStorePath = path.join(tmpDir, 'credentials.json');
  
  const now = Math.floor(Date.now() / 1000);
  const credentials = Array.from({ length: 50 }, (_, i) => ({
    id: `cred-${i}`,
    subject: `user-${i}`,
    issuer: 'issuer-1',
    expires_at: now + 86400,
  }));
  
  await fs.writeFile(credentialStorePath, JSON.stringify(credentials));
  
  const config = {
    expiryWarningDays: 7,
    credentialStorePath,
    auditLogPath: path.join(tmpDir, 'audit.ndjson'),
    notificationWebhookUrl: '',
    subjectNotificationWebhooks: {},
  };
  
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  process.env.EXPIRY_CONCURRENCY = '3';
  
  try {
    const job = new ExpiryNotificationJob(config);
    
    const dispatches = [];
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    
    job.dispatch = async (credential) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      dispatches.push(credential.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      currentConcurrent--;
    };
    
    const result = await job.runOnce();
    
    assert.equal(result, 50, 'Should process all 50 credentials');
    assert.equal(dispatches.length, 50, 'Should dispatch all credentials');
    assert.ok(maxConcurrent <= 3, `Max concurrent should be <= 3, got ${maxConcurrent}`);
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ExpiryNotificationJob clamps invalid concurrency values', async () => {
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  
  try {
    // Test negative value
    process.env.EXPIRY_CONCURRENCY = '-5';
    let job = new ExpiryNotificationJob({});
    assert.equal(job.concurrency, 1, 'Should clamp negative to 1');
    
    // Test zero
    process.env.EXPIRY_CONCURRENCY = '0';
    job = new ExpiryNotificationJob({});
    assert.equal(job.concurrency, 1, 'Should clamp zero to 1');
    
    // Test valid value
    process.env.EXPIRY_CONCURRENCY = '16';
    job = new ExpiryNotificationJob({});
    assert.equal(job.concurrency, 16, 'Should use valid value');
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
  }
});

test('ExpiryNotificationJob default concurrency is 8', async () => {
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  delete process.env.EXPIRY_CONCURRENCY;
  
  try {
    const job = new ExpiryNotificationJob({});
    assert.equal(job.concurrency, 8, 'Should default to 8');
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
  }
});

test('Concurrent processing does not block event loop', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expiry-test-'));
  const credentialStorePath = path.join(tmpDir, 'credentials.json');
  
  const now = Math.floor(Date.now() / 1000);
  const credentials = Array.from({ length: 30 }, (_, i) => ({
    id: `cred-${i}`,
    subject: `user-${i}`,
    issuer: 'issuer-1',
    expires_at: now + 86400,
  }));
  
  await fs.writeFile(credentialStorePath, JSON.stringify(credentials));
  
  const config = {
    expiryWarningDays: 7,
    credentialStorePath,
    auditLogPath: path.join(tmpDir, 'audit.ndjson'),
    notificationWebhookUrl: '',
    subjectNotificationWebhooks: {},
  };
  
  const oldEnv = process.env.EXPIRY_CONCURRENCY;
  process.env.EXPIRY_CONCURRENCY = '5';
  
  try {
    const job = new ExpiryNotificationJob(config);
    
    job.dispatch = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    };
    
    // Track if event loop is responsive during processing
    let tickCount = 0;
    const tickInterval = setInterval(() => {
      tickCount++;
    }, 10);
    
    await job.runOnce();
    
    clearInterval(tickInterval);
    
    // If event loop was not blocked, we should have many ticks
    // With 30 credentials * 20ms = 600ms total, at 10ms intervals we expect ~60 ticks
    // With concurrency=5, actual time is ~120ms, so expect ~12 ticks
    assert.ok(tickCount >= 5, `Event loop should remain responsive, got ${tickCount} ticks`);
  } finally {
    process.env.EXPIRY_CONCURRENCY = oldEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
