#!/usr/bin/env node
// oxlint-disable curly -- compact input validation keeps the acceptance helper auditable.

// Resolve one exact revo-tui producer run and download one exact artifact.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const WORKFLOW_PATH = '.github/workflows/package-artifacts.yml';
const ARTIFACT_NAME = 'revo-tui-verified-package';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const REPOSITORY = /^revisium\/revo-tui$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DECIMAL = /^[0-9]+$/u;

const fail = (message) => {
  throw new Error(`producer artifact: ${message}`);
};

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

async function api(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

async function downloadArtifact(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status < 300 || response.status >= 400) {
    fail(`artifact endpoint returned HTTP ${response.status} instead of a redirect`);
  }
  const location = response.headers.get('location');
  if (!location) fail('artifact endpoint did not provide a signed download location');
  const redirected = await fetch(location, {
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!redirected.ok) fail(`signed artifact download returned HTTP ${redirected.status}`);
  const length = redirected.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_DOWNLOAD_BYTES)) {
    fail('signed artifact exceeds the size limit');
  }
  if (redirected.body === null) fail('signed artifact response has no body');
  const bytes = [];
  let total = 0;
  for await (const chunk of redirected.body) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) fail('signed artifact exceeds the size limit');
    bytes.push(value);
  }
  if (length !== null && total !== Number(length))
    fail('signed artifact length changed while downloading');
  return Buffer.concat(bytes, total);
}

function assertSuccessJobs(jobs) {
  const requiredJobs = new Set([
    'native (linux-x64-glibc)',
    'native (linux-arm64-glibc)',
    'native (darwin-x64)',
    'native (darwin-arm64)',
    'assemble',
    'verify-handoff',
  ]);
  const successful = new Set(
    jobs
      .filter((job) => job.status === 'completed' && job.conclusion === 'success')
      .map((job) => job.name),
  );
  for (const name of requiredJobs)
    if (!successful.has(name)) fail(`producer job did not pass: ${name}`);
}

async function main() {
  const token = required('GITHUB_TOKEN');
  const repository = required('TUI_REPOSITORY');
  const revision = required('TUI_REVISION');
  const runId = required('TUI_RUN_ID');
  const runAttempt = required('TUI_RUN_ATTEMPT');
  const artifactId = required('TUI_ARTIFACT_ID');
  const output = resolve(required('OUTPUT'));
  if (!REPOSITORY.test(repository)) fail('TUI_REPOSITORY is not allowlisted');
  if (!SHA.test(revision)) fail('TUI_REVISION must be a full commit SHA');
  if (!DECIMAL.test(runId) || !DECIMAL.test(runAttempt) || !DECIMAL.test(artifactId)) {
    fail('run and artifact identifiers must be decimal');
  }
  const base = `https://api.github.com/repos/${repository}`;
  const run = await api(`${base}/actions/runs/${runId}/attempts/${runAttempt}`, token);
  if (
    run.path !== WORKFLOW_PATH ||
    run.head_sha !== revision ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    String(run.run_attempt) !== runAttempt
  ) {
    fail('producer run identity or conclusion is invalid');
  }
  const jobs = await api(
    `${base}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    token,
  );
  if (!Array.isArray(jobs.jobs)) fail('producer jobs response is invalid');
  assertSuccessJobs(jobs.jobs);

  const artifact = await api(`${base}/actions/artifacts/${artifactId}`, token);
  if (
    artifact.id !== Number(artifactId) ||
    artifact.name !== ARTIFACT_NAME ||
    artifact.expired === true ||
    artifact.workflow_run?.id !== Number(runId) ||
    artifact.workflow_run?.head_sha !== revision ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
  ) {
    fail('artifact identity, retention, or digest is invalid');
  }
  const bytes = await downloadArtifact(`${base}/actions/artifacts/${artifactId}/zip`, token);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.digest.slice('sha256:'.length))
    fail('downloaded artifact digest mismatch');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, bytes, { mode: 0o600 });
  const metadata = {
    schemaVersion: 1,
    repository,
    workflowPath: WORKFLOW_PATH,
    revision,
    runId: Number(runId),
    runAttempt: Number(runAttempt),
    artifactId: Number(artifactId),
    artifactName: artifact.name,
    artifactDigest: artifact.digest,
    zipSha256: actual,
    artifactExpiresAt: artifact.expires_at,
  };
  await writeFile(`${output}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(metadata));
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
