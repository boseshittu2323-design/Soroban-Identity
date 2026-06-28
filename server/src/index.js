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

const connections = new Set();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => {
    connections.delete(socket);
  });
});

server.listen(config.port, () => {
  console.log(`Soroban Identity server listening on :${config.port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Shutting down…');

  if (process.env.DISABLE_EXPIRY_JOB !== 'true') {
    expiryJob.stop();
  }

  const timeoutMs = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '10000', 10);
  const timer = setTimeout(() => {
    console.warn(`Graceful shutdown timed out after ${timeoutMs}ms. Forcing exit.`);
    for (const socket of connections) {
      socket.destroy();
    }
    process.exit(1);
  }, timeoutMs);
  timer.unref();

  server.close(async () => {
    clearTimeout(timer);
    try {
      await soroban.drain();
    } catch (error) {
      console.error('Error during soroban drain:', error);
    }
    console.log('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
