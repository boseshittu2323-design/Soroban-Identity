import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsService } from '../src/metrics.js';

test('metrics service renders Prometheus counters and latency histogram', () => {
  const metrics = new MetricsService();
  metrics.applyEvents([
    { topic: ['DID', 'created'] },
    { topic: ['CRED', 'issued credential'] },
    { topic: ['CRED', 'revoked credential'] },
    { topic: ['SCORE', 'submitted'] },
  ]);
  metrics.observeRpcLatency(0.2);
  const rendered = metrics.renderPrometheus();

  assert.match(rendered, /dids_created_total 1/);
  assert.match(rendered, /credentials_issued_total 1/);
  assert.match(rendered, /credentials_revoked_total 1/);
  assert.match(rendered, /reputation_scores_submitted_total 1/);
  assert.match(rendered, /soroban_rpc_call_latency_seconds_count 1/);
});
