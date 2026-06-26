import fs from 'node:fs/promises';
import path from 'node:path';

export const TTL_MS = Number(process.env.CREDENTIAL_CACHE_TTL_MS ?? 5000);

let _credentialCache = null;
let _cacheTimestamp = 0;

export function clearCredentialCache() {
  _credentialCache = null;
  _cacheTimestamp = 0;
}

export async function ensureDataDir(config) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(path.dirname(config.auditLogPath), { recursive: true });
  await fs.mkdir(path.dirname(config.credentialStorePath), { recursive: true });
}

export async function appendAuditLog(config, entry) {
  await ensureDataDir(config);
  const record = { timestamp: new Date().toISOString(), ...entry };
  await fs.appendFile(config.auditLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function readCredentials(config) {
  const now = Date.now();
  if (_credentialCache !== null && now - _cacheTimestamp < TTL_MS) {
    return _credentialCache;
  }
  try {
    const raw = await fs.readFile(config.credentialStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    const credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    _credentialCache = credentials;
    _cacheTimestamp = now;
    return credentials;
  } catch (error) {
    if (error.code === 'ENOENT') {
      _credentialCache = [];
      _cacheTimestamp = now;
      return _credentialCache;
    }
    throw error;
  }
}

export async function writeCredentials(config, credentials) {
  await ensureDataDir(config);
  await fs.writeFile(config.credentialStorePath, JSON.stringify({ credentials }, null, 2), 'utf8');
  _credentialCache = null;
  _cacheTimestamp = 0;
}

export function upsertCredential(credentials, credential) {
  const index = credentials.findIndex((item) => item.id === credential.id);
  if (index === -1) return [...credentials, credential];
  const next = credentials.slice();
  next[index] = { ...next[index], ...credential };
  return next;
}
