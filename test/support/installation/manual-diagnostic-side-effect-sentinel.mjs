import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

import { afterAll } from 'vitest';

if (process.env.REVO_MANUAL_DIAGNOSTIC_GUARD === '1') {
  const state = {
    armed: true,
    fetchCalls: 0,
    networkCalls: 0,
    taskSpawns: 0,
    fixtureCreates: 0,
  };
  const denied =
    (field) =>
    (..._args) => {
      state[field] += 1;
      throw new Error('manual diagnostic side effect denied');
    };
  globalThis.fetch = denied('fetchCalls');
  for (const name of [
    'spawn',
    'spawnSync',
    'fork',
    'exec',
    'execFile',
    'execSync',
    'execFileSync',
  ]) {
    childProcess[name] = denied('taskSpawns');
  }
  for (const name of ['connect', 'createConnection']) {
    net[name] = denied('networkCalls');
  }
  tls.connect = denied('networkCalls');
  http.request = denied('networkCalls');
  https.request = denied('networkCalls');
  fsPromises.mkdtemp = denied('fixtureCreates');
  syncBuiltinESMExports();

  const markerPath = process.env.REVO_MANUAL_DIAGNOSTIC_GUARD_MARKER;
  if (typeof markerPath === 'string' && markerPath.startsWith('/')) {
    appendFileSync(markerPath, `${JSON.stringify({ ...state, phase: 'armed' })}\n`, {
      mode: 0o600,
    });
    afterAll(() => {
      appendFileSync(markerPath, `${JSON.stringify({ ...state, phase: 'complete' })}\n`, {
        mode: 0o600,
      });
    });
    process.on('exit', () => {
      appendFileSync(markerPath, `${JSON.stringify({ ...state, phase: 'exit' })}\n`, {
        mode: 0o600,
      });
    });
  }
}
