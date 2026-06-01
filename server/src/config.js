import path from 'node:path';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON configuration: ${error.message}`);
  }
}

export function loadConfig(env = process.env) {
  return {
    port: parseInteger(env.PORT, 3001),
    adminApiKey: env.ADMIN_API_KEY ?? '',
    adminActor: env.ADMIN_ACTOR ?? 'admin',
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : DEFAULT_DATA_DIR,
    auditLogPath: env.AUDIT_LOG_PATH ? path.resolve(env.AUDIT_LOG_PATH) : path.join(DEFAULT_DATA_DIR, 'issuer-audit.jsonl'),
    credentialStorePath: env.CREDENTIAL_STORE_PATH ? path.resolve(env.CREDENTIAL_STORE_PATH) : path.join(DEFAULT_DATA_DIR, 'credentials.json'),
    expiryWarningDays: parseInteger(env.EXPIRY_WARNING_DAYS, 7),
    expiryJobIntervalMs: parseInteger(env.EXPIRY_JOB_INTERVAL_MS, 60 * 60 * 1000),
    notificationWebhookUrl: env.NOTIFICATION_WEBHOOK_URL ?? '',
    subjectNotificationWebhooks: parseJson(env.SUBJECT_NOTIFICATION_WEBHOOKS, {}),
    stellarCli: env.STELLAR_CLI ?? 'stellar',
    sourceAccount: env.STELLAR_SOURCE_ACCOUNT ?? env.STELLAR_SECRET_KEY ?? '',
    network: env.STELLAR_NETWORK ?? 'testnet',
    rpcUrl: env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    contracts: {
      identity: env.IDENTITY_REGISTRY_ID ?? '',
      credential: env.CREDENTIAL_MANAGER_ID ?? '',
      reputation: env.REPUTATION_ID ?? '',
    },
  };
}
