import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import http from 'node:http';

function startServer(envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/index.js'], {
      env: {
        ...process.env,
        PORT: '0',
        DISABLE_EXPIRY_JOB: 'true',
        DATA_DIR: 'data/test-shutdown',
        ...envOverrides,
      },
    });

    let stdout = '';
    let stderr = '';
    let portResolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on :(\d+)/);
      if (match && !portResolved) {
        portResolved = true;
        resolve({ child, port: parseInt(match[1], 10), getLogs: () => ({ stdout, stderr }) });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (!portResolved) reject(err);
    });
  });
}

test('Graceful shutdown: in-flight request completes normally, returns 200, exits 0', async () => {
  let resolveRpcReceived;
  const rpcReceivedPromise = new Promise((resolve) => { resolveRpcReceived = resolve; });

  const mockRpcServer = http.createServer((req, res) => {
    resolveRpcReceived();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { events: [] } }));
    }, 1000);
  });

  const rpcPort = await new Promise((resolve) => {
    mockRpcServer.listen(0, () => resolve(mockRpcServer.address().port));
  });

  const { child, port, getLogs } = await startServer({
    STELLAR_RPC_URL: `http://localhost:${rpcPort}`,
  });

  // Start the HTTP request to the main server
  const reqPromise = new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/metrics`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    }).on('error', reject);
  });

  // Wait for the main server to forward request to the mock RPC server
  await rpcReceivedPromise;

  // Send SIGTERM mid-request
  child.kill('SIGTERM');

  // Verify that client request completes normally
  const response = await reqPromise;
  assert.equal(response.statusCode, 200);

  // Wait for child process to exit
  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  assert.equal(exitCode, 0);

  const logs = getLogs();
  assert.ok(logs.stdout.includes('Shutting down…'), 'Should print Shutting down…');
  assert.ok(logs.stdout.includes('Shutdown complete'), 'Should print Shutdown complete');

  // Close mock RPC server
  await new Promise((r) => mockRpcServer.close(r));
});

test('New requests are rejected/refused after SIGTERM', async () => {
  let resolveRpcReceived;
  const rpcReceivedPromise = new Promise((resolve) => { resolveRpcReceived = resolve; });

  const mockRpcServer = http.createServer((req, res) => {
    resolveRpcReceived();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { events: [] } }));
    }, 1000);
  });

  const rpcPort = await new Promise((resolve) => {
    mockRpcServer.listen(0, () => resolve(mockRpcServer.address().port));
  });

  const { child, port } = await startServer({
    STELLAR_RPC_URL: `http://localhost:${rpcPort}`,
  });

  // Start first request to put connection in-flight
  http.get(`http://localhost:${port}/metrics`, () => {}).on('error', () => {});

  await rpcReceivedPromise;

  // Send SIGTERM
  child.kill('SIGTERM');

  // Wait a small bit to ensure server has processed SIGTERM and closed listener
  await new Promise((r) => setTimeout(r, 100));

  // Try to send a new request
  await new Promise((resolve) => {
    http.get(`http://localhost:${port}/metrics`, (res) => {
      assert.fail('Should not receive response');
    }).on('error', (err) => {
      // Should fail with ECONNREFUSED or similar connection error
      assert.ok(err);
      resolve();
    });
  });

  // Wait for child to exit
  await new Promise((resolve) => child.on('close', resolve));
  await new Promise((r) => mockRpcServer.close(r));
});

test('Timeout and force exit with code 1', async () => {
  let resolveRpcReceived;
  const rpcReceivedPromise = new Promise((resolve) => { resolveRpcReceived = resolve; });

  const mockRpcServer = http.createServer((req, res) => {
    resolveRpcReceived();
    // Very long delay
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { events: [] } }));
    }, 5000);
  });

  const rpcPort = await new Promise((resolve) => {
    mockRpcServer.listen(0, () => resolve(mockRpcServer.address().port));
  });

  const { child, port, getLogs } = await startServer({
    STELLAR_RPC_URL: `http://localhost:${rpcPort}`,
    SHUTDOWN_TIMEOUT_MS: '200', // 200 ms timeout
  });

  // Start request
  http.get(`http://localhost:${port}/metrics`, () => {}).on('error', () => {});

  await rpcReceivedPromise;

  // Send SIGTERM
  child.kill('SIGTERM');

  // Wait for child to exit
  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  // Must exit with code 1 due to timeout
  assert.equal(exitCode, 1);

  const logs = getLogs();
  assert.ok(logs.stdout.includes('Shutting down…'), 'Should print Shutting down…');
  const allLogs = logs.stdout + '\n' + logs.stderr;
  assert.ok(allLogs.includes('Graceful shutdown timed out'), 'Should print timeout warning');

  await new Promise((r) => mockRpcServer.close(r));
});
