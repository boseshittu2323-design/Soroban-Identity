require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('redis');
const {
  SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} = require('@stellar/stellar-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const config = {
  port: Number(process.env.PORT || 3001),
  rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    process.env.SOROBAN_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  identityRegistryId: process.env.IDENTITY_REGISTRY_CONTRACT_ID || '',
  credentialManagerId: process.env.CREDENTIAL_MANAGER_CONTRACT_ID || '',
  reputationId: process.env.REPUTATION_CONTRACT_ID || '',
  eventPollIntervalMs: Number(process.env.EVENT_POLL_INTERVAL_MS || 3000),
  didCacheTtlSeconds: Number(process.env.DID_CACHE_TTL_SECONDS || 60),
  cacheControlMaxAgeSeconds: Number(process.env.CACHE_CONTROL_MAX_AGE_SECONDS || 60),
  didResolutionRateLimitWindowMs: Number(process.env.DID_RESOLUTION_RATE_LIMIT_WINDOW_MS || 60000),
  didResolutionRateLimitMaxRequests: Number(process.env.DID_RESOLUTION_RATE_LIMIT_MAX_REQUESTS || 60),
  redisUrl: process.env.REDIS_URL,
};

const rpcServer = new SorobanRpc.Server(config.rpcUrl);
const identityContract = config.identityRegistryId
  ? new Contract(config.identityRegistryId)
  : null;

const sseClients = new Map();
let pollInFlight = false;
let lastLedger = 0;
let redisClient = null;

function log(level, message, fields = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

app.use((req, res, next) => {
  const requestId = req.header('X-Request-ID') || uuidv4();
  const start = Date.now();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    log('info', 'request.complete', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
});

function parseDid(did) {
  const match = /^did:stellar:(G[A-Z2-7]{55})$/i.exec(did);
  if (!match) return null;
  return match[1].toUpperCase();
}

function normalizeTopic(topicVal) {
  try {
    return String(scValToNative(topicVal));
  } catch {
    return String(topicVal);
  }
}

function normalizeEvent(event, index) {
  const topic = Array.isArray(event.topic) ? event.topic.map(normalizeTopic) : [];
  let value = null;

  try {
    value = event.value ? scValToNative(event.value) : null;
  } catch {
    value = null;
  }

  return {
    id: `${event.ledger}-${event.txHash}-${index}`,
    type: event.type,
    contractId:
      typeof event.contractId === 'string'
        ? event.contractId
        : event.contractId?.contractId?.() || '',
    topic,
    value,
    ledger: event.ledger,
    txHash: event.txHash,
    txHashHex: event.txHash,
    timestamp: event.ledgerClosedAt || new Date().toISOString(),
  };
}

function parseEventFilter(req) {
  const contractId = typeof req.query.contractId === 'string' ? req.query.contractId : undefined;

  let topic;
  if (Array.isArray(req.query.topic)) {
    topic = req.query.topic.map((v) => String(v));
  } else if (typeof req.query.topic === 'string' && req.query.topic.trim().length > 0) {
    topic = req.query.topic.split(',').map((t) => t.trim()).filter(Boolean);
  }

  return { contractId, topic };
}

function matchesFilter(event, filter) {
  if (filter.contractId && event.contractId !== filter.contractId) {
    return false;
  }

  if (filter.topic && filter.topic.length > 0) {
    return filter.topic.every((part, idx) => event.topic[idx] === part);
  }

  return true;
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getControllerFromEventValue(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0];
  }
  if (typeof value === 'object' && typeof value.controller === 'string') {
    return value.controller;
  }
  return null;
}

async function invalidateDidCacheFromEvent(event) {
  if (!redisClient || !event || event.topic.length < 2) return;
  const [domain, action] = event.topic;

  if (domain !== 'IDENTITY') return;
  if (!['updated', 'deact', 'deactivated'].includes(action)) return;

  const controller = getControllerFromEventValue(event.value);
  if (!controller) return;

  const key = `did:${controller}`;
  try {
    await redisClient.del(key);
    log('debug', 'cache.invalidate', {
      requestId: 'event-poller',
      cacheKey: key,
      ledger: event.ledger,
      txHash: event.txHash,
    });
  } catch (error) {
    log('error', 'cache.invalidate_failed', {
      requestId: 'event-poller',
      cacheKey: key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveDidDocument(controllerAddress, requestId) {
  if (!identityContract) {
    throw new Error('Identity registry contract is not configured');
  }

  const account = await rpcServer.getAccount(controllerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      identityContract.call(
        'resolve_did',
        nativeToScVal(controllerAddress, { type: 'address' })
      )
    )
    .setTimeout(30)
    .build();

  const simulation = await rpcServer.simulateTransaction(tx);
  log('debug', 'sdk.simulation_result', {
    requestId,
    operation: 'resolve_did',
    success: !SorobanRpc.Api.isSimulationError(simulation),
  });

  if (SorobanRpc.Api.isSimulationError(simulation)) {
    const errorText = simulation.error || '';
    if (errorText.includes('DidNotFound')) {
      return { didDocument: null, error: 'notFound' };
    }
    if (errorText.includes('DidDeactivated')) {
      return { didDocument: null, error: 'notFound' };
    }
    throw new Error(errorText || 'Failed to resolve DID');
  }

  const didDocument = scValToNative(simulation.result.retval);
  return { didDocument, error: null };
}


const didResolutionLimiter = rateLimit({
  windowMs: config.didResolutionRateLimitWindowMs,
  max: config.didResolutionRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      didDocument: null,
      didResolutionMetadata: {
        error: 'rateLimited',
      },
      didDocumentMetadata: {},
    });
  },
});

function buildDidResolutionResponse(did, didDocument, error) {
  const now = new Date().toISOString();

  if (error || !didDocument) {
    return {
      didDocument: null,
      didResolutionMetadata: {
        contentType: 'application/did+ld+json',
        error: 'notFound',
      },
      didDocumentMetadata: {
        deactivated: true,
        updated: now,
      },
    };
  }

  return {
    didDocument,
    didResolutionMetadata: {
      contentType: 'application/did+ld+json',
    },
    didDocumentMetadata: {
      deactivated: didDocument.active === false,
      updated: didDocument.updatedAt
        ? new Date(didDocument.updatedAt * 1000).toISOString()
        : now,
      created: didDocument.createdAt
        ? new Date(didDocument.createdAt * 1000).toISOString()
        : undefined,
    },
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/events', (req, res) => {
  const filter = parseEventFilter(req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const clientId = uuidv4();
  sseClients.set(clientId, { res, filter });

  writeSse(res, 'connected', {
    clientId,
    requestId: req.requestId,
    filter,
  });

  req.on('close', () => {
    sseClients.delete(clientId);
  });
});

app.get('/1.0/identifiers/:did', didResolutionLimiter, async (req, res) => {
  const did = req.params.did;
  const controllerAddress = parseDid(did);

  if (!controllerAddress) {
    return res.status(400).json({
      didDocument: null,
      didResolutionMetadata: {
        error: 'invalidDid',
        message: 'Expected did:stellar:<address>',
      },
      didDocumentMetadata: {},
    });
  }

  res.setHeader(
    'Cache-Control',
    `public, max-age=${config.cacheControlMaxAgeSeconds}, s-maxage=${config.cacheControlMaxAgeSeconds}`
  );

  const cacheKey = `did:${controllerAddress}`;
  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        log('debug', 'cache.hit', {
          requestId: req.requestId,
          cacheKey,
        });
        return res.json(JSON.parse(cached));
      }
      log('debug', 'cache.miss', {
        requestId: req.requestId,
        cacheKey,
      });
    } catch (error) {
      log('error', 'cache.read_failed', {
        requestId: req.requestId,
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const { didDocument, error } = await resolveDidDocument(controllerAddress, req.requestId);
    const payload = buildDidResolutionResponse(did, didDocument, error);

    if (redisClient && didDocument) {
      await redisClient.set(cacheKey, JSON.stringify(payload), 'EX', config.didCacheTtlSeconds);
    }

    return res.json(payload);
  } catch (error) {
    log('error', 'did.resolve_failed', {
      requestId: req.requestId,
      did,
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(502).json({
      didDocument: null,
      didResolutionMetadata: {
        error: 'internalError',
      },
      didDocumentMetadata: {},
    });
  }
});

app.use((error, req, res, _next) => {
  log('error', 'request.unhandled_error', {
    requestId: req.requestId,
    error: error instanceof Error ? error.message : String(error),
  });

  res.status(500).json({ error: 'Internal server error' });
});

async function pollContractEvents() {
  if (pollInFlight) {
    log('debug', 'events.poll_skipped', { requestId: 'event-poller' });
    return;
  }

  const contractIds = [
    config.identityRegistryId,
    config.credentialManagerId,
    config.reputationId,
  ].filter(Boolean);

  if (contractIds.length === 0) {
    return;
  }

  pollInFlight = true;
  try {
    const response = await rpcServer.getEvents({
      startLedger: lastLedger || undefined,
      filters: [
        {
          type: 'contract',
          contractIds,
        },
      ],
      limit: 100,
    });

    const rawEvents = response.events || [];
    if (rawEvents.length === 0) return;

    const normalized = rawEvents.map(normalizeEvent);
    const ledgers = normalized.map((e) => e.ledger).filter((v) => Number.isFinite(v));
    if (ledgers.length > 0) {
      lastLedger = Math.max(...ledgers) + 1;
    }

    for (const event of normalized) {
      await invalidateDidCacheFromEvent(event);

      for (const { res, filter } of sseClients.values()) {
        if (!matchesFilter(event, filter)) continue;
        writeSse(res, 'contract-event', event);
      }
    }
  } catch (error) {
    log('error', 'events.poll_failed', {
      requestId: 'event-poller',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    pollInFlight = false;
  }
}

async function connectRedis() {
  if (!config.redisUrl) {
    log('info', 'cache.disabled', { reason: 'REDIS_URL not set' });
    return;
  }

  const client = createClient({ url: config.redisUrl });
  client.on('error', (error) => {
    log('error', 'cache.redis_error', {
      requestId: 'startup',
      error: error instanceof Error ? error.message : String(error),
    });
  });

  try {
    await client.connect();
    redisClient = client;
    log('info', 'cache.enabled', { redisUrl: config.redisUrl });
  } catch (error) {
    log('error', 'cache.connect_failed', {
      requestId: 'startup',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function start() {
  await connectRedis();

  setInterval(() => {
    for (const { res } of sseClients.values()) {
      writeSse(res, 'heartbeat', { timestamp: new Date().toISOString() });
    }
  }, 30000);

  setInterval(pollContractEvents, config.eventPollIntervalMs);

  app.listen(config.port, () => {
    log('info', 'server.started', {
      port: config.port,
      rpcUrl: config.rpcUrl,
      eventPollIntervalMs: config.eventPollIntervalMs,
      didCacheTtlSeconds: config.didCacheTtlSeconds,
    });
  });
}

start().catch((error) => {
  log('error', 'server.start_failed', {
    requestId: 'startup',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
