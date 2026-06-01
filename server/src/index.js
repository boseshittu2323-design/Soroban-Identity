import http from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { ensureDataDir } from './storage.js';
import { ExpiryNotificationJob } from './expiry.js';
import { MetricsAggregator, MetricsService } from './metrics.js';
import { SorobanClient } from './soroban.js';

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

process.on('SIGTERM', () => {
  expiryJob.stop();
  server.close(() => process.exit(0));
});
