import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';

// Mock minimal config and dependencies
const mockConfig = {
  adminApiKey: 'test-admin-key',
  adminActor: 'admin',
  corsAllowedOrigins: ['*'],
  maxBodyBytes: 64 * 1024,
  credentialStorePath: ':memory:',
  auditLogPath: ':memory:',
};

const mockSoroban = {
  getIssuers: async () => ['GXXXXXX'],
  addIssuer: async () => {},
  removeIssuer: async () => {},
  pingAllContracts: async () => ({ identity: true, credential: true, reputation: true }),
};

const mockMetrics = {
  renderPrometheus: () => '# mock metrics',
};

test('POST /credentials with credentials:write scope succeeds', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key:credentials:write',
      },
      body: JSON.stringify({ id: 'cred-123', subject: 'alice' }),
    });
    
    assert.equal(response.status, 201);
  } finally {
    server.close();
  }
});

test('POST /credentials with credentials:read only scope returns 403', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key:credentials:read',
      },
      body: JSON.stringify({ id: 'cred-123', subject: 'alice' }),
    });
    
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, 'INSUFFICIENT_SCOPE');
    assert.deepEqual(body.requiredScopes, ['credentials:write']);
    assert.deepEqual(body.missingScopes, ['credentials:write']);
  } finally {
    server.close();
  }
});

test('POST /credentials/xxx/verify with credentials:read scope succeeds', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/credentials/test-cred/verify`, {
      method: 'POST',
      headers: {
        'X-API-Key': 'test-admin-key:credentials:read',
      },
    });
    
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.verified, false); // Not found is expected
  } finally {
    server.close();
  }
});

test('GET /admin/issuers with admin:read scope succeeds', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'GET',
      headers: {
        'X-API-Key': 'test-admin-key:admin:read',
      },
    });
    
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.issuers));
  } finally {
    server.close();
  }
});

test('POST /admin/issuers with admin:read only scope returns 403', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key:admin:read',
      },
      body: JSON.stringify({ issuer: 'GXXXXXX' }),
    });
    
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, 'INSUFFICIENT_SCOPE');
    assert.deepEqual(body.requiredScopes, ['admin:write']);
  } finally {
    server.close();
  }
});

test('POST /admin/issuers with admin:write scope succeeds', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key:admin:write',
      },
      body: JSON.stringify({ issuer: 'GXXXXXX' }),
    });
    
    assert.equal(response.status, 201);
  } finally {
    server.close();
  }
});

test('Wildcard scope grants access to all routes', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    // Test credentials:write
    let response = await fetch(`http://localhost:${port}/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key:*',
      },
      body: JSON.stringify({ id: 'cred-wildcard', subject: 'bob' }),
    });
    assert.equal(response.status, 201);
    
    // Test admin:read
    response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'GET',
      headers: {
        'X-API-Key': 'test-admin-key:*',
      },
    });
    assert.equal(response.status, 200);
    
    // Test admin:write
    response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key:*',
      },
      body: JSON.stringify({ issuer: 'GXXXXXX' }),
    });
    assert.equal(response.status, 201);
  } finally {
    server.close();
  }
});

test('Plain admin key without scopes grants full access (backward compatible)', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    // Test all endpoints work with plain key
    let response = await fetch(`http://localhost:${port}/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-admin-key',
      },
      body: JSON.stringify({ id: 'cred-plain', subject: 'charlie' }),
    });
    assert.equal(response.status, 201);
    
    response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'GET',
      headers: {
        'X-API-Key': 'test-admin-key',
      },
    });
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }
});

test('Bearer token format with scopes is supported', async () => {
  const app = createApp({ 
    config: mockConfig, 
    soroban: mockSoroban, 
    metrics: mockMetrics 
  });
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  
  try {
    const response = await fetch(`http://localhost:${port}/admin/issuers`, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer test-admin-key:admin:read',
      },
    });
    
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }
});
