import http from 'node:http';
import { loadConfig, validateConfig, logDefaultValues } from './config.js';
import { createApp } from './app.js';
import { ensureDataDir } from './storage.js';
import { ExpiryNotificationJob } from './expiry.js';
import { MetricsAggregator, MetricsService } from './metrics.js';
import { SorobanClient } from './soroban.js';

const validationResult = validateConfig();
if (!validationResult.isValid) {
  if (validationResult.missing.length > 0) {
    console.error('[config] Missing required environment variables:');
    for (const err of validationResult.missing) {
      console.error(`  - ${err}`);
    }
  }
  if (validationResult.invalid.length > 0) {
    console.error('[config] Invalid environment variables:');
    for (const err of validationResult.invalid) {
      console.error(`  - ${err}`);
    }
  }
  process.exit(1);
}

logDefaultValues();

const config = loadConfig();
await ensureDataDir(config);
const metrics = new MetricsService();
const soroban = new SorobanClient(config, metrics);
const metricsAggregator = new MetricsAggregator(soroban, metrics, { startLedger: Number.parseInt(process.env.METRICS_START_LEDGER ?? '0', 10) });
const expiryJob = new ExpiryNotificationJob(config, soroban);

if (process.env.DISABLE_EXPIRY_JOB !== 'true') expiryJob.start();

const server = http.createServer(createApp({ config, soroban, metrics, metricsAggregator }));
server.listen(config.port, () => {
  console.log(`Soroban Identity server listening on :${config.port}`);
});

process.on('SIGTERM', async () => {
  expiryJob.stop();
  server.close(async () => {
    await soroban.drain();
    process.exit(0);
  });
});
