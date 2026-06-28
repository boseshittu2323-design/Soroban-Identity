/**
 * Long-lived worker process for SubprocessPool.
 *
 * Reads newline-delimited JSON commands from stdin; each command has the shape:
 *   { stellarCli: string, args: string[] }
 *
 * Writes a newline-delimited JSON response to stdout for each command:
 *   { ok: true,  output: string }
 *   { ok: false, error: string }
 *
 * The process stays alive between commands, amortising startup cost and
 * allowing the OS to reuse TCP connections to the Soroban RPC node.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    reply({ ok: false, error: 'invalid JSON command' });
    return;
  }

  try {
    const output = await runCommand(msg.stellarCli, msg.args);
    reply({ ok: true, output: output.trim() });
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `${command} exited with ${code}`));
    });
  });
}
