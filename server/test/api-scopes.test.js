import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireAuth } from '../src/http-utils.js';

test('requireAuth with admin key and no scopes grants full access', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'test-key-123' } };
  let response = null;
  const res = {
    writeHead: () => res,
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, true);
  assert.deepEqual(req.apiKeyScopes, ['*']);
  assert.equal(response, null);
});

test('requireAuth with scoped key matching requirements grants access', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'test-key-123:credentials:write,credentials:read' } };
  let response = null;
  const res = {
    writeHead: () => res,
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, true);
  assert.deepEqual(req.apiKeyScopes, ['credentials:write', 'credentials:read']);
  assert.equal(response, null);
});

test('requireAuth with scoped key missing required scope returns 403', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'test-key-123:credentials:read' } };
  let statusCode = null;
  let response = null;
  const res = {
    writeHead: (code, headers) => { statusCode = code; return res; },
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, false);
  assert.equal(statusCode, 403);
  assert.equal(response.code, 'INSUFFICIENT_SCOPE');
  assert.equal(response.error, 'forbidden');
  assert.deepEqual(response.requiredScopes, ['credentials:write']);
  assert.deepEqual(response.missingScopes, ['credentials:write']);
});

test('requireAuth with wildcard scope grants access to any requirement', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'test-key-123:*' } };
  let response = null;
  const res = {
    writeHead: () => res,
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write', 'admin:write']);
  assert.equal(result, true);
  assert.deepEqual(req.apiKeyScopes, ['*']);
  assert.equal(response, null);
});

test('requireAuth with multiple required scopes checks all', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'test-key-123:credentials:write,admin:read' } };
  let statusCode = null;
  let response = null;
  const res = {
    writeHead: (code, headers) => { statusCode = code; return res; },
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write', 'admin:write']);
  assert.equal(result, false);
  assert.equal(statusCode, 403);
  assert.equal(response.code, 'INSUFFICIENT_SCOPE');
  assert.deepEqual(response.missingScopes, ['admin:write']);
});

test('requireAuth with no required scopes succeeds for any valid key', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'test-key-123:credentials:read' } };
  let response = null;
  const res = {
    writeHead: () => res,
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, []);
  assert.equal(result, true);
  assert.equal(response, null);
});

test('requireAuth with invalid key returns 401', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { 'x-api-key': 'wrong-key' } };
  let statusCode = null;
  let response = null;
  const res = {
    writeHead: (code, headers) => { statusCode = code; return res; },
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, false);
  assert.equal(statusCode, 401);
  assert.equal(response.code, 'UNAUTHORIZED');
  assert.equal(response.error, 'unauthorized');
});

test('requireAuth with missing API key returns 401', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: {} };
  let statusCode = null;
  let response = null;
  const res = {
    writeHead: (code, headers) => { statusCode = code; return res; },
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, false);
  assert.equal(statusCode, 401);
  assert.equal(response.code, 'UNAUTHORIZED');
});

test('requireAuth accepts Authorization header with Bearer token', () => {
  const config = { adminApiKey: 'test-key-123' };
  const req = { headers: { authorization: 'Bearer test-key-123:credentials:write' } };
  let response = null;
  const res = {
    writeHead: () => res,
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, true);
  assert.deepEqual(req.apiKeyScopes, ['credentials:write']);
});

test('requireAuth with unconfigured admin key returns 503', () => {
  const config = { adminApiKey: '' };
  const req = { headers: { 'x-api-key': 'test-key-123' } };
  let statusCode = null;
  let response = null;
  const res = {
    writeHead: (code, headers) => { statusCode = code; return res; },
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:write']);
  assert.equal(result, false);
  assert.equal(statusCode, 503);
  assert.equal(response.code, 'SERVICE_UNAVAILABLE');
});

test('scoped key format supports multiple scopes', () => {
  const config = { adminApiKey: 'key' };
  const req = { headers: { 'x-api-key': 'key:credentials:read,credentials:write,admin:read,reputation:read' } };
  let response = null;
  const res = {
    writeHead: () => res,
    end: (body) => { response = JSON.parse(body); },
  };
  
  const result = requireAuth(req, res, config, ['credentials:read', 'reputation:read']);
  assert.equal(result, true);
  assert.deepEqual(req.apiKeyScopes, ['credentials:read', 'credentials:write', 'admin:read', 'reputation:read']);
});
