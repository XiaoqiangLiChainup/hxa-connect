import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { checkSandbox } from '../scripts/codex-runner/sandbox-preflight.mjs';
import { SANDBOX_PROBE_PROGRAM } from '../scripts/codex-runner/sandbox-probe-program.mjs';
import { createSandboxProfileName, SANDBOX_CANARY_NAME, SANDBOX_CANARY_VALUE } from '../scripts/codex-runner/sandbox-policy.mjs';

let root: string;
let config: any;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-sandbox-witness-'));
  const stateRoot = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(homeDir, 'codex');
  const credentialDir = path.join(root, 'credentials');
  for (const directory of [stateRoot, homeDir, codexHome, credentialDir]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(credentialDir, SANDBOX_CANARY_NAME), SANDBOX_CANARY_VALUE, { mode: 0o600 });
  config = {
    stateRoot, homeDir, codexHome, credentialDir, tokenFile: path.join(credentialDir, 'unused-token'),
    sandboxProfile: createSandboxProfileName(), codexBin: '/usr/bin/true', childPath: '/usr/bin:/bin',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function temporaryEntries() {
  return [config.stateRoot, config.homeDir, config.codexHome].flatMap(directory =>
    fs.readdirSync(directory).filter(name => name.startsWith('.sandbox-preflight-') || name.startsWith('.hxa-sandbox-probe-')));
}

function successfulEvidence(command: any) {
  const input = JSON.parse(command.args.at(-1));
  for (const filename of ['witness', '.tmp/witness']) fs.writeFileSync(path.join(input.workspace, filename), input.nonce);
  return {
    exitCode: 0, exitSignal: null, code: null, cleanupComplete: true, stderr: '',
    stdout: JSON.stringify({ protocol: 'hxa-sandbox-probe-v1', nonce: input.nonce, workspace_write: true,
      outside_write_denied: true, credential_reads_denied: true, network_restricted: true }),
  };
}

class SocketFixture extends EventEmitter {
  destroyed = false;
  closed = false;
  unreferenced = false;
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => { this.closed = true; this.emit('close'); });
    }
    return this;
  }
  resume() { return this; }
  end() { return this.destroy(); }
  unref() { this.unreferenced = true; return this; }
}

/** Deterministic listener faults only; these fixtures do not claim network isolation. */
function witnessFixture(mode: string, controller = new AbortController()) {
  let client: SocketFixture | undefined;
  const server: any = new EventEmitter();
  server.listening = false;
  server.unref = vi.fn();
  server.address = () => server.listening ? { address: '127.0.0.1', family: 'IPv4', port: 32123 } : null;
  server.listen = vi.fn(() => {
    if (mode === 'bind-timeout') return server;
    queueMicrotask(() => {
      if (mode === 'bind-abort') { controller.abort(); return; }
      if (mode === 'bind-error') { server.emit('error', new Error('witness-private-diagnostic')); return; }
      server.listening = true;
      server.emit('listening');
    });
    return server;
  });
  server.close = vi.fn((callback: (error?: any) => void) => {
    if (mode === 'close-timeout') return server;
    const wasListening = server.listening;
    if (mode === 'close-error') {
      queueMicrotask(() => callback(Object.assign(new Error('witness-private-diagnostic'), { code: 'EIO' })));
      return server;
    }
    server.listening = false;
    queueMicrotask(() => {
      if (mode === 'late-contact') server.emit('connection', new SocketFixture());
      if (mode === 'close-abort') controller.abort();
      callback(wasListening ? undefined : Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    });
    return server;
  });
  vi.spyOn(net, 'createServer').mockImplementation(((listener: any) => {
    server.on('connection', listener);
    return server;
  }) as any);
  vi.spyOn(net, 'connect').mockImplementation((() => {
    client = new SocketFixture();
    if (mode === 'control-timeout') return client;
    queueMicrotask(() => {
      if (mode === 'control-abort') { controller.abort(); return; }
      if (mode === 'control-error') { client!.emit('error', new Error('witness-private-diagnostic')); return; }
      const accepted = new SocketFixture();
      accepted.end = () => {
        queueMicrotask(() => client!.emit('end'));
        return accepted.destroy();
      };
      server.emit('connection', accepted);
    });
    return client;
  }) as any);
  return { controller, server, get client() { return client; } };
}

describe('sandbox witness cancellation and cleanup', () => {
  it.each(['bind', 'control'])('closes the real loopback listener when cancelled at %s startup', async phase => {
    const controller = new AbortController();
    const create = net.createServer;
    let server: net.Server | undefined;
    vi.spyOn(net, 'createServer').mockImplementation(((...args: any[]) => {
      server = (create as any)(...args);
      return server;
    }) as any);
    if (phase === 'bind') {
      const listen = net.Server.prototype.listen;
      vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: any[]) {
        const result = (listen as any).apply(this, args);
        controller.abort();
        return result;
      } as any);
    } else {
      const connect = net.connect;
      vi.spyOn(net, 'connect').mockImplementation(((...args: any[]) => {
        const socket = (connect as any)(...args);
        queueMicrotask(() => controller.abort());
        return socket;
      }) as any);
    }
    const runCommand = vi.fn();
    const report = await checkSandbox(config, { signal: controller.signal, runCommand });
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_ABORTED', temporary_evidence_retained: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(server?.listening).toBe(false);
    expect(temporaryEntries()).toEqual([]);
  });

  it.each(['bind-abort', 'control-abort'])('cleans a %s before launching any sandbox command', async mode => {
    const witness = witnessFixture(mode);
    const runCommand = vi.fn();
    const report = await checkSandbox(config, { runCommand, signal: witness.controller.signal });
    expect(runCommand).not.toHaveBeenCalled();
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_ABORTED', ran: false, temporary_evidence_retained: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_command_startup', passed: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(witness.server.close).toHaveBeenCalledTimes(1);
    expect(witness.server.listening).toBe(false);
    if (witness.client) expect(witness.client.closed).toBe(true);
    expect(temporaryEntries()).toEqual([]);
  });

  it.each(['bind-error', 'control-error', 'bind-timeout', 'control-timeout'])('fails and confirms cleanup for %s', async mode => {
    const witness = witnessFixture(mode);
    const runCommand = vi.fn();
    const report = await checkSandbox(config, { runCommand });
    expect(runCommand).not.toHaveBeenCalled();
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_FAILED', ran: false, temporary_evidence_retained: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(witness.server.close).toHaveBeenCalledTimes(1);
    if (witness.client) expect(witness.client.closed).toBe(true);
    expect(JSON.stringify(report)).not.toContain('witness-private-diagnostic');
    expect(temporaryEntries()).toEqual([]);
  });

  it.each(['close-error', 'close-timeout'])('keeps evidence when listener %s prevents confirmed cleanup', async mode => {
    const witness = witnessFixture(mode);
    const report = await checkSandbox(config, { runCommand: async command => successfulEvidence(command) });
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_CLEANUP_FAILED', temporary_evidence_retained: true });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: false });
    expect(witness.server.unref).toHaveBeenCalledTimes(1);
    expect(temporaryEntries()).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain('witness-private-diagnostic');
  });

  it('revokes network readiness when a connection arrives during listener close', async () => {
    witnessFixture('late-contact');
    const report = await checkSandbox(config, { runCommand: async command => successfulEvidence(command) });
    expect(report.checks).toContainEqual({ name: 'sandbox_network_restricted', passed: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(temporaryEntries()).toEqual([]);
  });

  it.each(['result-abort', 'close-abort'])('revokes local success when %s occurs after command startup', async mode => {
    const witness = witnessFixture(mode);
    const report = await checkSandbox(config, { signal: witness.controller.signal, runCommand: async command => {
      const result = successfulEvidence(command);
      if (mode === 'result-abort') witness.controller.abort();
      return result;
    } });
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_ABORTED', temporary_evidence_retained: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_command_startup', passed: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_network_restricted', passed: false });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(temporaryEntries()).toEqual([]);
  });

  it('treats a probe-program connection timeout as inconclusive failure, not isolation', async () => {
    const socket: any = new EventEmitter();
    socket.destroy = vi.fn();
    socket.setTimeout = (_ms: number, callback: () => void) => queueMicrotask(callback);
    const nonce = 'offline-fixture-nonce';
    let resolve: (value: any) => void;
    const output = new Promise(done => { resolve = done; });
    const fixtureModules: Record<string, any> = {
      'node:fs': {
        writeFileSync() {}, readFileSync: () => nonce,
        appendFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      },
      'node:net': { connect: () => socket },
      'node:path': path,
    };
    vm.runInNewContext(SANDBOX_PROBE_PROGRAM, {
      require: (name: string) => fixtureModules[name],
      process: {
        argv: ['node', JSON.stringify({ nonce, workspace: '/fixture', outside: '/outside', canaries: [], aliases: [], port: 32123 })],
        cwd: () => '/fixture', stdout: { write: (value: string) => resolve(JSON.parse(value)) },
      },
    });
    expect(await output).toMatchObject({ workspace_write: true, network_restricted: false });
    expect(socket.destroy).toHaveBeenCalled();
  });
});
