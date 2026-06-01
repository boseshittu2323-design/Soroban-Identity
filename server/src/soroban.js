import { spawn } from 'node:child_process';

export class SorobanClient {
  constructor(config, metrics) {
    this.config = config;
    this.metrics = metrics;
  }

  async invoke(contractId, method, args = []) {
    if (!contractId) throw new Error('Contract ID is not configured');
    if (!this.config.sourceAccount) throw new Error('STELLAR_SOURCE_ACCOUNT or STELLAR_SECRET_KEY is required');
    const commandArgs = [
      'contract',
      'invoke',
      '--id', contractId,
      '--source', this.config.sourceAccount,
      '--network', this.config.network,
      '--rpc-url', this.config.rpcUrl,
      '--',
      method,
      ...args,
    ];
    const started = performance.now();
    try {
      const output = await runCommand(this.config.stellarCli, commandArgs);
      this.metrics?.observeRpcLatency((performance.now() - started) / 1000);
      return output.trim();
    } catch (error) {
      this.metrics?.observeRpcLatency((performance.now() - started) / 1000);
      throw error;
    }
  }

  async pingAllContracts() {
    const entries = Object.entries(this.config.contracts);
    const results = await Promise.allSettled(entries.map(([name, id]) => this.invoke(id, 'ping').then(() => [name, true])));
    const contracts = Object.fromEntries(entries.map(([name]) => [name, false]));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const [name, ok] = result.value;
        contracts[name] = ok;
      }
    }
    return contracts;
  }

  async getIssuers() {
    const raw = await this.invoke(this.config.contracts.credential, 'get_issuers');
    return parseAddressList(raw);
  }

  async addIssuer(issuer) {
    return this.invoke(this.config.contracts.credential, 'add_issuer', ['--issuer', issuer]);
  }

  async removeIssuer(issuer) {
    return this.invoke(this.config.contracts.credential, 'remove_issuer', ['--issuer', issuer]);
  }

  async getEvents(startLedger) {
    const started = performance.now();
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: {
          startLedger,
          filters: [{ type: 'contract' }],
          limit: 200,
        },
      };
      const response = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`RPC getEvents failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message ?? 'RPC getEvents failed');
      return payload.result?.events ?? [];
    } finally {
      this.metrics?.observeRpcLatency((performance.now() - started) / 1000);
    }
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `${command} exited with ${code}`));
    });
  });
}

function parseAddressList(raw) {
  const matches = raw.match(/G[A-Z0-9]{55}/g);
  return matches ? [...new Set(matches)] : [];
}
