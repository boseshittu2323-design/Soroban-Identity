import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { requestContextStore } from '../src/request-context.js';

test('Logger emits valid JSON on single line', async () => {
  const result = await new Promise((resolve) => {
    const child = spawn('node', ['-e', `
      import { logger } from './src/logger.js';
      logger.info({ test: 'value' }, 'test message');
    `], {
      cwd: process.cwd(),
      env: { ...process.env, LOG_LEVEL: 'info' }
    });
    
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => resolve(stdout));
  });
  
  const lines = result.trim().split('\n');
  assert.equal(lines.length, 1, 'Log should be on single line');
  
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.level, 'Should have level field');
  assert.ok(parsed.time, 'Should have time field');
  assert.equal(parsed.msg, 'test message', 'Should have message');
  assert.equal(parsed.test, 'value', 'Should have custom field');
});

test('Logger includes requestId from context', async () => {
  const { logger } = await import('../src/logger.js');
  
  const logs = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  
  try {
    await requestContextStore.run({ requestId: 'test-req-123' }, () => {
      logger.info('test message with context');
    });
    
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.requestId, 'test-req-123', 'Should include requestId from context');
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('Logger does not include requestId when no context', async () => {
  const { logger } = await import('../src/logger.js');
  
  const logs = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  
  try {
    logger.info('test message without context');
    
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.requestId, undefined, 'Should not include requestId when no context');
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('LOG_LEVEL env var controls verbosity', async () => {
  // Test that debug logs are hidden at info level
  const result = await new Promise((resolve) => {
    const child = spawn('node', ['-e', `
      import { logger } from './src/logger.js';
      logger.debug('debug message');
      logger.info('info message');
    `], {
      cwd: process.cwd(),
      env: { ...process.env, LOG_LEVEL: 'info' }
    });
    
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => resolve(stdout));
  });
  
  const lines = result.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'Should only show info level and above');
  
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.msg, 'info message', 'Should be info message');
});

test('LOG_LEVEL debug shows debug messages', async () => {
  const result = await new Promise((resolve) => {
    const child = spawn('node', ['-e', `
      import { logger } from './src/logger.js';
      logger.debug('debug message');
      logger.info('info message');
    `], {
      cwd: process.cwd(),
      env: { ...process.env, LOG_LEVEL: 'debug' }
    });
    
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => resolve(stdout));
  });
  
  const lines = result.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'Should show both debug and info');
});

test('Logger includes timestamp in ISO format', async () => {
  const { logger } = await import('../src/logger.js');
  
  const logs = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  
  try {
    logger.info('test message');
    
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.ok(parsed.time, 'Should have time field');
    
    // Verify ISO 8601 format
    const date = new Date(parsed.time);
    assert.ok(!isNaN(date.getTime()), 'Timestamp should be valid ISO 8601');
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('Logger supports structured context fields', async () => {
  const { logger } = await import('../src/logger.js');
  
  const logs = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  
  try {
    logger.info({ userId: 'alice', action: 'login', duration: 123 }, 'User logged in');
    
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.msg, 'User logged in');
    assert.equal(parsed.userId, 'alice');
    assert.equal(parsed.action, 'login');
    assert.equal(parsed.duration, 123);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('Logger handles errors with stack traces', async () => {
  const { logger } = await import('../src/logger.js');
  
  const logs = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  
  try {
    const error = new Error('Test error');
    logger.error({ error: error.message, stack: error.stack }, 'An error occurred');
    
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.msg, 'An error occurred');
    assert.equal(parsed.error, 'Test error');
    assert.ok(parsed.stack.includes('Error: Test error'));
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('Different log levels produce correct output', async () => {
  const { logger } = await import('../src/logger.js');
  
  const logs = [];
  const originalWrite = process.stdout.write;
  const originalWriteErr = process.stderr.write;
  
  process.stdout.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  process.stderr.write = function(chunk) {
    logs.push(chunk.toString());
    return true;
  };
  
  try {
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');
    
    assert.equal(logs.length, 3);
    
    const info = JSON.parse(logs[0]);
    assert.equal(info.level, 'info');
    assert.equal(info.msg, 'info message');
    
    const warn = JSON.parse(logs[1]);
    assert.equal(warn.level, 'warn');
    assert.equal(warn.msg, 'warn message');
    
    const error = JSON.parse(logs[2]);
    assert.equal(error.level, 'error');
    assert.equal(error.msg, 'error message');
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalWriteErr;
  }
});
