const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class MetricsService {
  constructor() {
    this.counters = {
      dids_created_total: 0,
      credentials_issued_total: 0,
      credentials_revoked_total: 0,
      reputation_scores_submitted_total: 0,
    };
    this.rpcLatencies = [];
  }

  observeRpcLatency(seconds) {
    this.rpcLatencies.push(seconds);
    if (this.rpcLatencies.length > 10_000) this.rpcLatencies.shift();
  }

  applyEvents(events) {
    for (const event of events) {
      const text = JSON.stringify(event).toLowerCase();
      if (text.includes('did') && (text.includes('create') || text.includes('created'))) this.counters.dids_created_total += 1;
      if (text.includes('credential') && (text.includes('issue') || text.includes('issued'))) this.counters.credentials_issued_total += 1;
      if (text.includes('credential') && (text.includes('revoke') || text.includes('revoked'))) this.counters.credentials_revoked_total += 1;
      if (text.includes('score') && (text.includes('submit') || text.includes('submitted'))) this.counters.reputation_scores_submitted_total += 1;
    }
  }

  renderPrometheus() {
    const lines = [];
    for (const [name, value] of Object.entries(this.counters)) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    lines.push('# TYPE soroban_rpc_call_latency_seconds histogram');
    let cumulative = 0;
    for (const bucket of HISTOGRAM_BUCKETS) {
      cumulative = this.rpcLatencies.filter((value) => value <= bucket).length;
      lines.push(`soroban_rpc_call_latency_seconds_bucket{le="${bucket}"} ${cumulative}`);
    }
    lines.push(`soroban_rpc_call_latency_seconds_bucket{le="+Inf"} ${this.rpcLatencies.length}`);
    lines.push(`soroban_rpc_call_latency_seconds_sum ${this.rpcLatencies.reduce((sum, value) => sum + value, 0)}`);
    lines.push(`soroban_rpc_call_latency_seconds_count ${this.rpcLatencies.length}`);
    return `${lines.join('\n')}\n`;
  }
}

export class MetricsAggregator {
  constructor(soroban, metrics, { startLedger = 0 } = {}) {
    this.soroban = soroban;
    this.metrics = metrics;
    this.nextLedger = startLedger;
  }

  async refresh() {
    const events = await this.soroban.getEvents(this.nextLedger);
    this.metrics.applyEvents(events);
    const newest = events.map((event) => Number(event.ledger ?? event.ledgerClosedAt ?? 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (newest) this.nextLedger = newest + 1;
    return events.length;
  }
}
