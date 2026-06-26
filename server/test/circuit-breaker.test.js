import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, SorobanUnavailableError } from '../src/circuit-breaker.js';

const ok = () => Promise.resolve('ok');
const fail = () => Promise.reject(new Error('rpc error'));

test('CLOSED → OPEN after failureThreshold consecutive failures', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openDurationMs: 60_000 });
  assert.equal(cb.state, 'CLOSED');

  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cb.call(fail));
  }

  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.failures, 3);
});

test('OPEN state fails fast without calling fn', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 2, openDurationMs: 60_000 });
  await assert.rejects(() => cb.call(fail));
  assert.equal(cb.state, 'OPEN');

  let called = false;
  await assert.rejects(
    () => cb.call(() => { called = true; return Promise.resolve(); }),
    SorobanUnavailableError
  );
  assert.equal(called, false, 'fn must not be called in OPEN state');
});

test('OPEN → HALF_OPEN after openDurationMs elapses', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 2, openDurationMs: 0 });
  await assert.rejects(() => cb.call(fail));
  assert.equal(cb.state, 'OPEN');

  // openDurationMs = 0 so the next call immediately transitions to HALF_OPEN
  await cb.call(ok);
  assert.equal(cb.state, 'HALF_OPEN');
});

test('HALF_OPEN → CLOSED after successThreshold successes', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 2, openDurationMs: 0 });
  await assert.rejects(() => cb.call(fail));

  // Transition to HALF_OPEN via first probe call
  await cb.call(ok); // success #1 in HALF_OPEN
  assert.equal(cb.state, 'HALF_OPEN');

  await cb.call(ok); // success #2 → should close
  assert.equal(cb.state, 'CLOSED');
});

test('HALF_OPEN → OPEN on failure', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 2, openDurationMs: 0 });
  await assert.rejects(() => cb.call(fail));

  // Enter HALF_OPEN
  await assert.rejects(() => cb.call(fail)); // fail in HALF_OPEN → reopen
  assert.equal(cb.state, 'OPEN');
});

test('success in CLOSED state resets failure counter', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 5, successThreshold: 2, openDurationMs: 60_000 });
  await assert.rejects(() => cb.call(fail));
  await assert.rejects(() => cb.call(fail));
  assert.equal(cb.failures, 2);

  await cb.call(ok);
  assert.equal(cb.failures, 0);
  assert.equal(cb.state, 'CLOSED');
});

test('toHealthInfo returns state, failures and lastStateChange', () => {
  const cb = new CircuitBreaker();
  const info = cb.toHealthInfo();
  assert.equal(typeof info.state, 'string');
  assert.equal(typeof info.failures, 'number');
  assert.equal(typeof info.lastStateChange, 'string');
});
