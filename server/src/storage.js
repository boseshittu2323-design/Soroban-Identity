import fs from 'node:fs/promises';
import path from 'node:path';
import { requestContextStore } from './request-context.js';

let lastCheckedDate = null;

export async function cleanOldAuditLogs(config) {
  const dir = path.dirname(config.auditLogPath);
  const baseName = path.basename(config.auditLogPath);
  const escapedBaseName = baseName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`^${escapedBaseName}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`);

  try {
    const files = await fs.readdir(dir);
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    for (const file of files) {
      const match = file.match(regex);
      if (!match) continue;

      const dateStr = match[1];
      const parts = dateStr.split('-');
      const fileYear = parseInt(parts[0], 10);
      const fileMonth = parseInt(parts[1], 10) - 1;
      const fileDay = parseInt(parts[2], 10);
      const fileUtc = Date.UTC(fileYear, fileMonth, fileDay);

      const ageInMs = todayUtc - fileUtc;
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);

      if (ageInDays > config.auditLogRetentionDays) {
        await fs.unlink(path.join(dir, file));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to clean old audit logs:', error);
    }
  }
}

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
  await cleanOldAuditLogs(config);
}

export async function appendAuditLog(config, entry) {
  const dateString = new Date().toISOString().split('T')[0];
  const currentLogPath = `${config.auditLogPath}-${dateString}.ndjson`;

  if (lastCheckedDate !== dateString) {
    await fs.mkdir(path.dirname(currentLogPath), { recursive: true });
    lastCheckedDate = dateString;
  }

  const record = { timestamp: new Date().toISOString(), ...entry };
  await fs.appendFile(currentLogPath, `${JSON.stringify(record)}\n`, 'utf8');
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

export class DuplicateCredentialError extends Error {
  constructor(id) {
    super(`Credential with ID "${id}" already exists`);
    this.name = 'DuplicateCredentialError';
    this.id = id;
  }
}

export function createCredential(credentials, credential) {
  if (credentials.some((item) => item.id === credential.id)) {
    throw new DuplicateCredentialError(credential.id);
  }
  return [...credentials, credential];
}
