#!/usr/bin/env node
// Serves docs/openapi.yaml at GET /openapi.yaml on localhost for #247.
//
// Usage: node scripts/serve-openapi.mjs [port]
// Default port: 3030. Also exposes GET /health returning { status: 'ok' }.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SPEC_PATH = resolve(__dirname, '..', 'docs', 'openapi.yaml');

const port = Number(process.argv[2] ?? process.env.PORT ?? 3030);

let spec;
try {
  spec = readFileSync(SPEC_PATH, 'utf8');
} catch (err) {
  console.error(`Failed to read ${SPEC_PATH}: ${err.message}`);
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === '/openapi.yaml' || req.url === '/openapi.yml') {
    res.writeHead(200, {
      'content-type': 'application/yaml; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(spec);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', code: 'NOT_FOUND' }));
});

server.listen(port, () => {
  console.log(`OpenAPI spec served at http://localhost:${port}/openapi.yaml`);
  console.log(`Health probe at http://localhost:${port}/health`);
});
