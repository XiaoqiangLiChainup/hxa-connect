import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const POLL_MS = 20;
const KILL_WAIT_MS = 2_000;
const PIPE_WAIT_MS = 1_000;
const DEAD_STATES = new Set(['Z', 'X', 'x']);
const DISAPPEARED = new Set(['ENOENT', 'ESRCH']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, milliseconds) {
  let timer;
  try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function stat(procPid) {
  try {
    const text = fs.readFileSync(`/proc/${procPid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u);
    if (!/^\d+$/u.test(fields[19] ?? '')) return null;
    return {
      procPid: Number(procPid), state: fields[0], parent: Number(fields[1]),
      group: Number(fields[2]), session: Number(fields[3]), start: fields[19],
    };
  } catch (error) {
    if (DISAPPEARED.has(error?.code)) return null;
    throw error;
  }
}

function namespaceIds(status, name) {
  const match = status.match(new RegExp(`^${name}:\\s+([0-9 \\t]+)$`, 'mu'));
  return match ? match[1].trim().split(/\s+/u).map(Number) : [];
}

function identity(procPid, namespaceIndex) {
  const before = stat(procPid);
  if (!before) return null;
  try {
    const status = fs.readFileSync(`/proc/${procPid}/status`, 'utf8');
    const ids = namespaceIds(status, 'NSpid');
    const groupIds = namespaceIds(status, 'NSpgid');
    const sessionIds = namespaceIds(status, 'NSsid');
    const namespace = fs.readlinkSync(`/proc/${procPid}/ns/pid`);
    const uid = fs.statSync(`/proc/${procPid}`).uid;
    const after = stat(procPid);
    if (!after || after.start !== before.start) return null;
    const pid = ids[namespaceIndex];
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    return { ...after, pid, localGroup: groupIds[namespaceIndex], localSession: sessionIds[namespaceIndex], namespace, uid };
  } catch (error) {
    if (DISAPPEARED.has(error?.code)) return null;
    throw error;
  }
}

function sameProcess(left, right) {
  return left && right && left.procPid === right.procPid && left.pid === right.pid
    && left.start === right.start && left.namespace === right.namespace && left.uid === right.uid;
}

/**
 * Track only this spawn's identity, its verified process group, and descendants
 * observed through a verified parent chain. A nested PID namespace has different
 * innermost IDs; signals always use IDs at the controller's namespace depth.
 * This is not a substitute for a cgroup against unobserved daemon escapes.
 */
function tracker(pid) {
  const selfStatus = fs.readFileSync('/proc/self/status', 'utf8');
  const namespaceIndex = namespaceIds(selfStatus, 'NSpid').length - 1;
  const ownNamespace = fs.readlinkSync('/proc/self/ns/pid');
  if (namespaceIndex < 0) throw new Error('Identity unavailable');
  const entries = () => fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name));
  let leader;
  for (const name of entries()) {
    let candidate;
    try { candidate = identity(Number(name), namespaceIndex); } catch (error) {
      if (['EACCES', 'EPERM'].includes(error?.code)) continue;
      throw error;
    }
    if (candidate?.pid === pid && candidate.namespace === ownNamespace) { leader = candidate; break; }
  }
  if (!leader || leader.localGroup !== pid || leader.localSession !== pid) throw new Error('Identity unavailable');
  const known = new Map([[leader.procPid, leader]]);
  let unsafe = false;

  const refresh = () => {
    if (unsafe) return { safe: false, live: [] };
    try {
      const all = new Map();
      for (const name of entries()) {
        let item;
        try { item = stat(Number(name)); } catch (error) {
          if (['EACCES', 'EPERM'].includes(error?.code)) {
            try { if (fs.statSync(`/proc/${name}`).uid !== leader.uid) continue; }
            catch (other) { if (DISAPPEARED.has(other?.code)) continue; }
          }
          throw error;
        }
        if (item && !DEAD_STATES.has(item.state)) all.set(item.procPid, item);
      }
      const live = new Map();
      for (const [procPid, previous] of known) {
        if (!all.has(procPid)) continue;
        const current = identity(procPid, namespaceIndex);
        if (!current) continue;
        if (!sameProcess(current, previous)) throw new Error('Identity changed');
        live.set(procPid, current);
      }
      // The leader or a previously observed group member keeps the original
      // group/session identity allocated. Do not identify a group by number alone.
      const groupAnchor = [...live.values()].find(item => item.group === leader.group && item.session === leader.session);
      let added;
      do {
        added = false;
        for (const item of all.values()) {
          if (live.has(item.procPid) || known.has(item.procPid)) continue;
          const parent = live.get(item.parent);
          const inAnchoredGroup = groupAnchor && item.group === leader.group && item.session === leader.session;
          if (!parent && !inAnchoredGroup) continue;
          const anchor = parent || groupAnchor;
          if (!sameProcess(identity(anchor.procPid, namespaceIndex), anchor)) continue;
          const child = identity(item.procPid, namespaceIndex);
          if (!child) continue;
          if (child.uid !== leader.uid || BigInt(child.start) < BigInt(anchor.start)
            || (parent ? child.parent !== parent.procPid : child.group !== leader.group || child.session !== leader.session)) {
            throw new Error('Unverified descendant');
          }
          known.set(child.procPid, child);
          live.set(child.procPid, child);
          added = true;
        }
      } while (added);
      // If the leader disappeared before a group member could be observed, its
      // numeric PGID alone is not sufficient authority to signal that member.
      // Do not mistake this uncertainty for successful cleanup either.
      if (!groupAnchor && [...all.values()].some(item => item.group === leader.group
        && item.session === leader.session && !live.has(item.procPid))) {
        throw new Error('Unanchored group remains');
      }
      return { safe: true, live: [...live.values()] };
    } catch {
      unsafe = true;
      return { safe: false, live: [] };
    }
  };

  const send = (signal, state) => {
    if (!state.safe) return false;
    // Check every exact identity again immediately before its positive-PID
    // signal. This also reaches observed --new-session / --unshare-pid children.
    try {
      const anchor = state.live.find(item => item.group === leader.group && item.session === leader.session);
      if (anchor) {
        const current = identity(anchor.procPid, namespaceIndex);
        if (current && !sameProcess(current, anchor)) return false;
        if (current && current.group === leader.group && current.session === leader.session) {
          try { process.kill(-leader.pid, signal); } catch (error) { if (error?.code !== 'ESRCH') return false; }
        }
      }
      for (const item of state.live) {
        const current = identity(item.procPid, namespaceIndex);
        if (!current || DEAD_STATES.has(current.state)) continue;
        if (!sameProcess(current, item)) return false;
        try { process.kill(current.pid, signal); } catch (error) { if (error?.code !== 'ESRCH') return false; }
      }
      return true;
    } catch { return false; }
  };

  return { refresh, send };
}

function configuration({ executable, args, cwd, env, timeoutMs, termGraceMs, maxOutputBytes }) {
  if (process.platform !== 'linux' || !path.isAbsolute(executable || '') || !path.isAbsolute(cwd || '')
    || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || !env || typeof env !== 'object' || Array.isArray(env)) return false;
  if ([executable, cwd].some(value => /[\u0000\r\n]/u.test(value))) return false;
  if (Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0'))) return false;
  return [timeoutMs, termGraceMs, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647);
}

/** Run a local, operator-selected sandbox probe. This function never logs output. */
export async function runSandboxCommand({
  executable, args, cwd, env, signal, timeoutMs = 10_000, termGraceMs = 1_000, maxOutputBytes = 32_768,
}) {
  const result = { exitCode: null, exitSignal: null, stdout: '', stderr: '', code: null, cleanupComplete: false };
  if (!configuration({ executable, args, cwd, env, timeoutMs, termGraceMs, maxOutputBytes })) {
    return { ...result, code: 'SANDBOX_PROBE_CONFIG_INVALID', cleanupComplete: true };
  }
  if (signal?.aborted) return { ...result, code: 'SANDBOX_PROBE_ABORTED', cleanupComplete: true };
  const ended = deferred();
  const closed = deferred();
  const stopped = deferred();
  let child, processes, timer, polling, isClosed = false, spawned = false, identityFailed = false;
  let storedBytes = 0;
  const output = { stdout: [], stderr: [] };
  const stop = code => { if (!result.code) { result.code = code; stopped.resolve(); } };
  const abort = () => stop('SANDBOX_PROBE_ABORTED');
  const collect = (stream, buffer) => {
    const remaining = Math.max(0, maxOutputBytes - storedBytes);
    if (remaining) {
      const kept = Buffer.from(buffer.subarray(0, remaining));
      output[stream].push(kept);
      storedBytes += kept.length;
    }
    if (buffer.length > remaining) stop('SANDBOX_PROBE_OUTPUT_LIMIT');
  };
  try {
    // Only explicitly supplied values; never inherit the controller environment.
    const childEnv = Object.fromEntries(Object.entries(env));
    child = spawn(executable, args, { cwd, env: childEnv, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', () => { stop('SANDBOX_PROBE_SPAWN_FAILED'); ended.resolve(); });
    child.once('exit', (code, signalName) => { result.exitCode = code; result.exitSignal = signalName; ended.resolve(); });
    child.once('close', () => { isClosed = true; closed.resolve(); });
    child.stdout.on('data', buffer => collect('stdout', buffer));
    child.stderr.on('data', buffer => collect('stderr', buffer));
    child.stdout.on('error', () => stop('SANDBOX_PROBE_STREAM_FAILED'));
    child.stderr.on('error', () => stop('SANDBOX_PROBE_STREAM_FAILED'));
    spawned = Boolean(child.pid);
    if (spawned) {
      try { processes = tracker(child.pid); }
      catch { identityFailed = true; stop('SANDBOX_PROBE_IDENTITY_FAILED'); }
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop('SANDBOX_PROBE_TIMEOUT'), timeoutMs);
    if (processes) {
      const observe = () => { if (!processes.refresh().safe) stop('SANDBOX_PROBE_IDENTITY_FAILED'); };
      observe();
      polling = setInterval(observe, POLL_MS);
    }
    await Promise.race([ended.promise, stopped.promise]);
  } catch { stop('SANDBOX_PROBE_CONTROL_FAILED'); }
  finally {
    clearTimeout(timer);
    clearInterval(polling);
    signal?.removeEventListener('abort', abort);
    let clean = !spawned;
    if (processes) {
      try {
        let state = processes.refresh();
        const termDeadline = performance.now() + termGraceMs;
        while (state.safe && state.live.length && performance.now() < termDeadline) {
          if (!processes.send('SIGTERM', state)) { state = { safe: false, live: [] }; break; }
          await delay(POLL_MS);
          state = processes.refresh();
        }
        const killDeadline = performance.now() + KILL_WAIT_MS;
        while (state.safe && state.live.length && performance.now() < killDeadline) {
          if (!processes.send('SIGKILL', state)) { state = { safe: false, live: [] }; break; }
          await delay(POLL_MS);
          state = processes.refresh();
        }
        clean = state.safe && state.live.length === 0;
      } catch { clean = false; }
    }
    if (child) await bounded(closed.promise, PIPE_WAIT_MS);
    result.cleanupComplete = clean && !identityFailed && (!child || isClosed);
    if (!result.cleanupComplete) result.code = 'SANDBOX_PROBE_CLEANUP_FAILED';
    if (child && !isClosed) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      result.stdout = decoder.decode(Buffer.concat(output.stdout));
      result.stderr = decoder.decode(Buffer.concat(output.stderr));
    } catch {
      result.stdout = '';
      result.stderr = '';
      if (!result.code) result.code = 'SANDBOX_PROBE_OUTPUT_INVALID';
    }
  }
  return result;
}
