import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { runSandboxCommand } from './sandbox-command.mjs';
import { SANDBOX_CANARY_NAME, SANDBOX_CANARY_VALUE, sandboxPolicyArguments } from './sandbox-policy.mjs';
import { SANDBOX_PROBE_PROGRAM } from './sandbox-probe-program.mjs';

export const SANDBOX_CHECK_NAMES = Object.freeze([
  'sandbox_command_startup', 'sandbox_workspace_write', 'sandbox_outside_write_denied',
  'sandbox_credential_reads_denied', 'sandbox_network_restricted', 'sandbox_probe_cleanup',
]);
const GUIDANCE = Object.freeze({
  SANDBOX_PREREQUISITES_NOT_MET: 'Resolve the failed local identity, directory, executable, or version checks before sandbox verification.',
  SANDBOX_CANARY_INVALID: 'Install the documented non-secret SetCredential canary beside the task credential; never substitute the task token or authentication files.',
  SANDBOX_USER_CONFIG_PRESENT: 'The dedicated Codex home has a user config. Review this unsupported policy-source difference before running; do not delete configuration or bypass managed policy automatically.',
  SANDBOX_HOST_PREREQUISITE: 'Sandbox initialization was denied. Check the bundled helper, host user-namespace/AppArmor audit evidence and existing unit restrictions. Host permission changes need separate approval; no automatic repair or sandbox fallback is permitted.',
  SANDBOX_CLI_CONTRACT: 'The pinned sandbox CLI did not accept the explicit permission-profile command. Verify the complete Codex 0.166.0 installation; do not substitute sandbox linux or another execution mode.',
  SANDBOX_PROBE_TIMEOUT: 'The local sandbox probe exceeded its time limit. Inspect host prerequisites under the same unit; no model or task was started.',
  SANDBOX_PROBE_ABORTED: 'The local sandbox probe was interrupted; do not treat this invocation as ready.',
  SANDBOX_PROBE_OUTPUT_LIMIT: 'The local sandbox probe exceeded its bounded output limit; raw output was discarded.',
  SANDBOX_PROBE_SPAWN_FAILED: 'The local sandbox command could not be started; verify the pinned installation and unit access.',
  SANDBOX_PROBE_CLEANUP_FAILED: 'Probe cleanup could not be confirmed. Stop and inspect only this worker control group and retained probe directories before another start.',
  SANDBOX_PROBE_FAILED: 'The sandbox did not produce valid successful local probe evidence. Inspect the host prerequisites; no raw subprocess output is published.',
  SANDBOX_BOUNDARY_FAILED: 'A required sandbox filesystem or network boundary failed. Keep the worker stopped; do not relax the policy or use a less restricted execution mode.',
});

export function sandboxNotRun(code = 'SANDBOX_PREREQUISITES_NOT_MET', config) {
  return { checks: SANDBOX_CHECK_NAMES.map(name => ({ name, passed: false })),
    sandbox: { scope: 'model-free-local-probe', profile: config?.sandboxProfile ?? null, ran: false, code, guidance: GUIDANCE[code] } };
}

function ordinaryBytes(filename, maximum = 128) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error('Invalid probe marker');
    const buffer = Buffer.alloc(maximum + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== info.size || count > maximum) throw new Error('Invalid probe marker');
    return buffer.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function realDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Invalid probe directory');
}

function markerEquals(filename, expected) {
  try { return ordinaryBytes(filename) === expected; } catch { return false; }
}

function createWitness() {
  let connections = 0;
  let baseline = null, port = null, client, activeFailure, closePromise;
  let closing = false, serverFailed = false;
  const sockets = new Set();
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
    else socket.end();
  });
  // Keep an error listener for the entire lifetime, including after startup.
  server.on('error', () => { serverFailed = true; activeFailure?.(); });

  const step = (signal, action) => new Promise((resolve, reject) => {
    let done = false;
    const cleanups = [];
    const finish = success => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      if (activeFailure === fail) activeFailure = undefined;
      for (const cleanup of cleanups) cleanup();
      if (success) resolve();
      else reject(new Error('Probe listener unavailable'));
    };
    const fail = () => finish(false);
    const timer = setTimeout(fail, 1000);
    activeFailure = fail;
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted || closing || serverFailed) { fail(); return; }
    try {
      action(finish, cleanup => { if (done) cleanup(); else cleanups.push(cleanup); });
    } catch { fail(); }
  });

  return {
    get port() { return port; },
    contacted: () => serverFailed || (baseline !== null && connections !== baseline),
    // The caller owns this controller before either asynchronous phase starts.
    // No external address, DNS, model, or Hub request is used.
    async start(signal) {
      await step(signal, (finish, cleanup) => {
        const listening = () => finish(true);
        server.once('listening', listening);
        cleanup(() => server.removeListener('listening', listening));
        server.listen(0, '127.0.0.1');
      });
      const address = server.address();
      if (!address || typeof address !== 'object' || !Number.isInteger(address.port) || signal?.aborted) {
        throw new Error('Probe listener unavailable');
      }
      port = address.port;
      await step(signal, (finish, cleanup) => {
        client = net.connect({ host: '127.0.0.1', port });
        // Wait for end so the server has counted the positive-control connection
        // before recording its baseline. Abort and deadline cover this phase too.
        const end = () => finish(true);
        const error = () => finish(false);
        client.on('error', () => {});
        client.once('end', end);
        client.once('error', error);
        cleanup(() => {
          client.removeListener('end', end);
          client.removeListener('error', error);
          client.destroy();
        });
        client.resume();
      });
      if (signal?.aborted || serverFailed || closing || connections < 1) throw new Error('Probe listener unavailable');
      baseline = connections;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      activeFailure?.();
      closePromise = (async () => {
        let timer, confirmed = false;
        const pending = [];
        const ownedSockets = new Set([...sockets, ...(client ? [client] : [])]);
        for (const socket of ownedSockets) {
          if (!socket.closed) pending.push(new Promise(resolve => socket.once('close', resolve)));
          socket.destroy();
        }
        pending.push(new Promise((resolve, reject) => {
          const done = error => {
            if ((error && error.code !== 'ERR_SERVER_NOT_RUNNING') || server.listening) {
              reject(new Error('Probe listener cleanup failed'));
            } else resolve();
          };
          try { server.close(done); } catch (error) { done(error); }
        }));
        try {
          await Promise.race([
            Promise.all(pending),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Probe listener cleanup failed')), 1000); }),
          ]);
          confirmed = true;
        } finally {
          clearTimeout(timer);
          // Cleanup uncertainty is reported and evidence retained. It must not
          // make the local check hang indefinitely on a broken handle.
          if (!confirmed) {
            server.unref();
            for (const socket of ownedSockets) socket.unref();
          }
        }
      })();
      return closePromise;
    },
  };
}

function classify(result) {
  if (result.code && Object.hasOwn(GUIDANCE, result.code)) return result.code;
  if (/Failed RTM_NEWADDR|unprivileged_userns|bwrap:[^\n]*(?:Operation not permitted|Permission denied)|(?:user namespace|userns)[^\n]*(?:not permitted|denied)/iu.test(result.stderr ?? '')) return 'SANDBOX_HOST_PREREQUISITE';
  if (/unexpected argument|unrecognized (?:subcommand|option)|invalid value[^\n]*permission/iu.test(result.stderr ?? '')) return 'SANDBOX_CLI_CONTRACT';
  return 'SANDBOX_PROBE_FAILED';
}

/** New probes never open the real task token or auth files and never submit inference. */
export async function checkSandbox(config, { runCommand = runSandboxCommand, signal } = {}) {
  const report = sandboxNotRun(undefined, config);
  const set = (name, passed) => { report.checks.find(check => check.name === name).passed = passed === true; };
  const directories = [];
  let root, witness, processResult, code = 'SANDBOX_PROBE_FAILED', cleanupSafe = true;
  try {
    if (signal?.aborted) { code = 'SANDBOX_PROBE_ABORTED'; return report; }
    for (const directory of [config.stateRoot, config.homeDir, config.codexHome, config.credentialDir]) realDirectory(directory);
    const policy = sandboxPolicyArguments(config);
    // The real-run policy preview cannot ignore user config while exec does.
    // Inspect presence only, never read a config/auth file or remove it.
    try {
      fs.lstatSync(path.join(config.codexHome, 'config.toml'));
      code = 'SANDBOX_USER_CONFIG_PRESENT';
      return report;
    } catch (error) { if (error?.code !== 'ENOENT') { code = 'SANDBOX_USER_CONFIG_PRESENT'; return report; } }
    const credentialCanary = path.join(config.credentialDir, SANDBOX_CANARY_NAME);
    // This reserved non-secret sibling is the only pre-existing credential-dir file read here.
    if (credentialCanary === config.tokenFile) { code = 'SANDBOX_CANARY_INVALID'; return report; }
    try {
      if (ordinaryBytes(credentialCanary) !== SANDBOX_CANARY_VALUE) throw new Error();
    } catch { code = 'SANDBOX_CANARY_INVALID'; return report; }
    root = fs.mkdtempSync(path.join(config.stateRoot, '.sandbox-preflight-'));
    directories.push(root);
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'launcher-home');
    const codexHome = path.join(home, 'codex');
    for (const directory of [workspace, path.join(workspace, '.tmp'), home, codexHome]) fs.mkdirSync(directory, { mode: 0o700 });
    const nonce = randomBytes(24).toString('hex');
    const outside = path.join(root, 'outside-canary');
    fs.writeFileSync(outside, nonce, { flag: 'wx', mode: 0o600 });
    const canaries = [credentialCanary];
    for (const parent of new Set([config.homeDir, config.codexHome])) {
      const directory = fs.mkdtempSync(path.join(parent, '.hxa-sandbox-probe-'));
      directories.push(directory);
      const filename = path.join(directory, 'canary');
      fs.writeFileSync(filename, nonce, { flag: 'wx', mode: 0o600 });
      canaries.push(filename);
    }
    const aliases = canaries.map((filename, i) => {
      const alias = path.join(workspace, `canary-link-${i}`);
      fs.symlinkSync(filename, alias);
      return alias;
    });
    witness = createWitness();
    await witness.start(signal);
    if (signal?.aborted) { code = 'SANDBOX_PROBE_ABORTED'; return report; }
    const input = { nonce, workspace, outside, canaries, aliases, port: witness.port };
    report.sandbox.ran = true;
    cleanupSafe = false;
    processResult = await runCommand({
      executable: config.codexBin,
      args: ['--no-daemon', ...policy, 'sandbox', '--permission-profile', config.sandboxProfile, '--cd', workspace,
        '--', fs.realpathSync(process.execPath), '--input-type=commonjs', '-e', SANDBOX_PROBE_PROGRAM, JSON.stringify(input)],
      cwd: workspace,
      env: { HOME: home, CODEX_HOME: codexHome, PATH: config.childPath, TMPDIR: path.join(workspace, '.tmp'),
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' },
      signal, timeoutMs: 10_000, termGraceMs: 1_000, maxOutputBytes: 32_768,
    });
    cleanupSafe = processResult.cleanupComplete === true;
    report.sandbox.execution = { exit_code: Number.isInteger(processResult.exitCode) ? processResult.exitCode : null,
      exit_signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSEGV', 'SIGABRT'].includes(processResult.exitSignal) ? processResult.exitSignal : null,
      cleanup_complete: cleanupSafe };
    if (!cleanupSafe) { code = 'SANDBOX_PROBE_CLEANUP_FAILED'; return report; }
    if (processResult.code || processResult.exitCode !== 0 || processResult.exitSignal) { code = classify(processResult); return report; }
    let evidence;
    try { evidence = JSON.parse(processResult.stdout); } catch { return report; }
    const keys = ['protocol', 'nonce', 'workspace_write', 'outside_write_denied', 'credential_reads_denied', 'network_restricted'];
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).length !== keys.length || keys.some(key => !Object.hasOwn(evidence, key))
      || evidence.protocol !== 'hxa-sandbox-probe-v1' || evidence.nonce !== nonce
      || keys.slice(2).some(key => typeof evidence[key] !== 'boolean')) return report;
    set('sandbox_command_startup', true);
    set('sandbox_workspace_write', evidence.workspace_write
      && markerEquals(path.join(workspace, 'witness'), nonce)
      && markerEquals(path.join(workspace, '.tmp/witness'), nonce));
    set('sandbox_outside_write_denied', evidence.outside_write_denied && markerEquals(outside, nonce));
    set('sandbox_credential_reads_denied', evidence.credential_reads_denied
      && canaries.every((filename, i) => markerEquals(filename, i === 0 ? SANDBOX_CANARY_VALUE : nonce)));
    set('sandbox_network_restricted', evidence.network_restricted && !witness.contacted());
    code = report.checks.slice(0, -1).every(check => check.passed) ? null : 'SANDBOX_BOUNDARY_FAILED';
  } catch {
    if (signal?.aborted) code = 'SANDBOX_PROBE_ABORTED';
  } finally {
    try { await witness?.close(); } catch { cleanupSafe = false; }
    // A connection callback can arrive while close is being awaited. Recheck
    // after closing rather than accepting the earlier snapshot as final proof.
    if (witness?.contacted()) {
      set('sandbox_network_restricted', false);
      if (code === null) code = 'SANDBOX_BOUNDARY_FAILED';
    }
    if (signal?.aborted) {
      set('sandbox_command_startup', false);
      set('sandbox_network_restricted', false);
      code = 'SANDBOX_PROBE_ABORTED';
    }
    // Retain only our temporary evidence if a live process may still reference it.
    if (cleanupSafe) {
      for (const directory of directories.reverse()) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { cleanupSafe = false; }
      }
    }
    set('sandbox_probe_cleanup', cleanupSafe);
    if (!cleanupSafe) code = 'SANDBOX_PROBE_CLEANUP_FAILED';
    report.sandbox.code = code;
    if (code) report.sandbox.guidance = GUIDANCE[code];
    else delete report.sandbox.guidance;
    report.sandbox.temporary_evidence_retained = !cleanupSafe && directories.length > 0;
  }
  return report;
}
