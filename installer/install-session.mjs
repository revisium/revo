import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { runPackageProcess } from '../src/installation/package-process.js';
import { PackageProgressRenderer } from '../src/installation/package-progress-renderer.js';
import { createPnpmProgressSink } from '../src/installation/pnpm-progress.js';
import { parseProgressEvent, ProgressOperation, ProgressRenderer } from '../src/progress/index.js';
import { sanitizeProbeDiagnostic } from './probe-diagnostic.mjs';

const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const safePath = (value) =>
  typeof value === 'string' && value.startsWith('/') && !hasUnsafeCharacters(value);

const hasUnsafeCharacters = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
};
const safeDiagnostic = (value) => sanitizeProbeDiagnostic(value);
const stages = new Map([
  ['validate', 'runtime-validate'],
  ['download', 'runtime-download'],
  ['verify', 'runtime-verify'],
  ['extract', 'runtime-extract'],
  ['probe', 'runtime-probe'],
  ['reuse', 'runtime-reuse'],
  ['publish', 'runtime-publish'],
  ['dependencies', 'dependencies-install'],
  ['activation', 'installation-activate'],
  ['server', 'server-start'],
  ['package-prepare', 'package-prepare'],
  ['package-download', 'package-download'],
  ['package-verify', 'package-verify'],
  ['package-extract', 'package-extract'],
  ['package-reuse', 'package-reuse'],
]);
const OUTPUT_TIMEOUT_MS = 10_000;

export function installEnvironment(nodeExecutable, channel, ambient = process.env) {
  const names = [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'REVO_CONFIG',
    'REVO_DATABASE_URL',
    'REVO_DATA_DIR',
    'REVO_HOST',
    'REVO_LOG_DIR',
    'REVO_PORT',
    'REVO_PUBLIC_URL',
    'REVO_STARTUP_TIMEOUT',
  ];
  return {
    ...Object.fromEntries(
      names.filter((name) => ambient[name] !== undefined).map((name) => [name, ambient[name]]),
    ),
    PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
    NODE_PATH: '',
    REVO_CHANNEL: channel,
  };
}

/** Accepts only one ordered startup operation; ready stays private until the CLI exits zero. */
export class StartupLines {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.buffer = '';
    this.sequence = 0;
    this.elapsed = 0;
    this.bytes = 0;
    this.invalid = false;
  }

  feed(chunk) {
    if (this.invalid) {
      return;
    }
    this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.bytes > 256 * 1024) {
      this.invalid = true;
      return;
    }
    try {
      this.buffer +=
        typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    } catch {
      this.invalid = true;
      return;
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    lines.forEach((line) => this.line(line));
  }

  line(line) {
    if (this.invalid) {
      return;
    }
    try {
      const event = parseProgressEvent(JSON.parse(line));
      if (
        !event ||
        this.terminal ||
        event.sequence <= this.sequence ||
        event.elapsedMs < this.elapsed ||
        (this.operationId !== undefined && event.operationId !== this.operationId)
      ) {
        this.invalid = true;
        return;
      }
      this.operationId = event.operationId;
      this.sequence = event.sequence;
      this.elapsed = event.elapsedMs;
      this.terminal = event.status === 'failed' || event.status === 'ready';
      if (event.status === 'ready') {
        this.ready = event;
      } else {
        this.onEvent(event);
      }
    } catch {
      this.invalid = true;
    }
  }

  finish() {
    try {
      this.buffer += this.decoder.decode();
    } catch {
      this.invalid = true;
    }
    // CLI JSONL requires a newline; truncated final records must never confirm readiness.
    if (this.buffer || this.invalid || !this.ready) {
      throw new Error('START_PROGRESS_INVALID');
    }
    return this.ready;
  }
}

export class InstallSession {
  constructor({
    stdout = process.stdout,
    stderr = process.stderr,
    isTty = process.stderr.isTTY,
    run = runPackageProcess,
    outputTimeoutMs = OUTPUT_TIMEOUT_MS,
  } = {}) {
    this.outputTimeoutMs = outputTimeoutMs;
    this.stdoutState = { bytes: 0, failed: false, pending: new Set(), queue: [], writing: false };
    this.stderrState = { bytes: 0, failed: false, pending: new Set(), queue: [], writing: false };
    this.stdout = (text) => this.write(this.stdoutState, stdout, text);
    this.stderr = (text) => this.write(this.stderrState, stderr, text);
    this.run = run;
    this.operation = new ProgressOperation({
      operationId: randomBytes(16).toString('hex'),
      now: Date.now,
    });
    this.renderer = new ProgressRenderer({
      format: 'human',
      isTty: false,
      stdout: this.stdout,
      stderr: this.stderr,
    });
    this.packages = new PackageProgressRenderer({ isTty, write: this.stderr });
    this.packageProgress = createPnpmProgressSink({
      onEvent: (event) => this.packages.render(event),
    });
  }

  get outputFailed() {
    return this.stdoutState.failed || this.stderrState.failed;
  }

  markOutputFailed(channel) {
    this.failOutput(this[`${channel}State`]);
  }

  failOutput(state) {
    state.failed = true;
    state.queue.splice(0).forEach((queued) => {
      state.pending.delete(queued.pending);
      queued.complete();
    });
  }

  write(state, sink, text) {
    if (state.failed) {
      return;
    }
    state.bytes += Buffer.byteLength(text);
    if (state.bytes > 512 * 1024) {
      this.failOutput(state);
      return;
    }
    try {
      if (typeof sink === 'function') {
        sink(text);
        return;
      }
      if (typeof sink?.write !== 'function') {
        this.failOutput(state);
        return;
      }
      let complete;
      const pending = new Promise((done) => {
        complete = done;
      });
      state.pending.add(pending);
      state.queue.push({ text, complete, pending });
      this.pump(state, sink);
    } catch {
      this.failOutput(state);
    }
  }

  pump(state, sink) {
    if (state.writing || state.failed) {
      return;
    }
    const item = state.queue.shift();
    if (item === undefined) {
      return;
    }
    state.writing = true;
    let settled = false;
    let callbackDone = false;
    let drained = false;
    let needsDrain = false;
    let writeReturned = false;
    let timer;
    const settle = (failed = false) => {
      if (settled || (!failed && (!writeReturned || !callbackDone || (needsDrain && !drained)))) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sink.off?.('drain', onDrain);
      sink.off?.('error', onError);
      state.pending.delete(item.pending);
      item.complete();
      if (failed) {
        this.failOutput(state);
      } else {
        state.writing = false;
        this.pump(state, sink);
      }
    };
    const onDrain = () => {
      drained = true;
      settle();
    };
    const onError = () => settle(true);
    timer = setTimeout(() => {
      settle(true);
    }, this.outputTimeoutMs);
    sink.once?.('drain', onDrain);
    sink.once?.('error', onError);
    try {
      const accepted = sink.write(item.text, (error) => {
        callbackDone = true;
        settle(error !== undefined && error !== null);
      });
      needsDrain = !accepted;
      drained = accepted;
      writeReturned = true;
      settle();
    } catch {
      settle(true);
    }
  }

  async flushOutput() {
    await Promise.all([...this.stdoutState.pending, ...this.stderrState.pending]);
    if (this.outputFailed) {
      throw new Error('INSTALL_PROGRESS_OUTPUT_FAILED');
    }
  }

  async finish() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.packages.finish();
    if (this.phase && this.phase !== 'server-start') {
      this.renderer.render(this.operation.complete(this.phase));
    }
    this.renderer.finish();
    await this.flushOutput();
  }

  stage = (stage) => {
    if (this.finished) {
      return;
    }
    const phase = stages.get(stage);
    if (!phase || this.phase === phase) {
      return;
    }
    if (this.phase === 'dependencies-install') {
      this.packages.finish();
    }
    if (this.phase) {
      this.renderer.render(this.operation.complete(this.phase));
    }
    this.phase = phase;
    this.renderer.render(this.operation.start(phase));
  };

  start = async ({ activation, packageResult, nodeExecutable, channelRoot, scratch, signal }) => {
    if (
      !activation ||
      !['activated', 'unchanged'].includes(activation.status) ||
      !/^[a-f0-9]{64}$/u.test(activation.generationId)
    ) {
      throw new Error('ACTIVATION_UNCONFIRMED');
    }
    const channel = packageResult.plan.release.channel;
    if (!safePath(channelRoot) || !['stable', 'alpha'].includes(channel)) {
      throw new Error('INSTALL_PATH_UNSAFE');
    }
    const launcher = join(channelRoot, 'activations', activation.generationId, 'revo');
    const diagnosticPath = join(scratch, 'server-start.log');
    this.diagnosticPath = diagnosticPath;
    const startup = new ProgressRenderer({
      format: 'human',
      isTty: false,
      stdout: this.stdout,
      stderr: this.stderr,
    });
    const lines = new StartupLines((event) => startup.render(event));
    this.renderer.finish();
    try {
      const result = await this.run({
        executable: launcher,
        args: ['server', 'start', '--progress=jsonl', '--channel', channel],
        cwd: packageResult.directory,
        env: installEnvironment(nodeExecutable, channel),
        diagnosticPath,
        onStdout: (chunk) => lines.feed(chunk),
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.exitCode !== 0 || result.signal !== null) {
        throw new Error('SERVER_START_FAILED');
      }
      const ready = lines.finish();
      await this.flushOutput();
      startup.render(ready);
      this.instructions(channelRoot, channel);
      await this.flushOutput();
      return ready;
    } finally {
      startup.finish();
    }
  };

  instructions(channelRoot, channel) {
    if (!safePath(channelRoot)) {
      throw new Error('INSTALL_PATH_UNSAFE');
    }
    const directory = join(channelRoot, 'current');
    this.stdout(`Command now: REVO_CHANNEL=${quote(channel)} ${quote(join(directory, 'revo'))}\n`);
    if (directory.includes(':')) {
      this.stdout("This directory contains ':', so use the absolute command instead of PATH.\n");
      return;
    }
    this.stdout(`For this POSIX shell: export PATH="\${PATH:+$PATH:}"${quote(directory)}\n`);
    this.stdout('For future POSIX shells, add that export to your chosen profile yourself.\n');
    this.stdout(
      'Existing revo commands keep priority. Choose one channel for PATH; use the absolute command to select this channel.\n',
    );
  }

  async fail(scratch, error) {
    this.finished = true;
    this.packages.finish();
    this.renderer.finish();
    const phase = this.phase ?? 'runtime-prepare';
    const known = new Set([
      'ACTIVATION_UNCONFIRMED',
      'SERVER_START_FAILED',
      'START_PROGRESS_INVALID',
      'INSTALL_PATH_UNSAFE',
      'INSTALL_PROGRESS_OUTPUT_FAILED',
    ]);
    const probeFailure = error?.diagnosticCode === 'PNPM_PROBE_FAILED';
    const code = probeFailure
      ? error.diagnosticCode
      : known.has(error?.message)
        ? error.message
        : 'INSTALL_SESSION_FAILED';
    const probeDetail = probeFailure ? safeDiagnostic(error?.diagnosticDetail) : '';
    const diagnostic = `Installation did not complete during ${phase} [${code}]. Activation may already be committed; no application or database rollback was performed.\n`;
    let suffix = '';
    if (safePath(scratch)) {
      const path = join(scratch, 'install-session.log');
      await writeFile(
        path,
        `${diagnostic}${probeDetail === '' ? '' : `Probe detail: ${probeDetail}\n`}`,
        {
          mode: 0o600,
          flag: 'wx',
        },
      ).then(
        () => {
          suffix = `Diagnostics: ${quote(path)}\n`;
        },
        () => undefined,
      );
      const processLogPath =
        this.diagnosticPath ?? error?.diagnosticPath ?? error?.result?.diagnosticPath;
      if (safePath(processLogPath) && resolve(processLogPath).startsWith(`${resolve(scratch)}/`)) {
        suffix += `Process log: ${quote(processLogPath)}\n`;
      }
    }
    this.stderr(diagnostic + suffix);
    await this.flushOutput().catch(() => undefined);
  }
}
