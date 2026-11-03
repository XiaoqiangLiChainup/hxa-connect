// Trusted, credential-free command supplied to `codex sandbox -- ...` by the controller.
// Only booleans and a fresh challenge leave this command; never file bytes or environment.
export const SANDBOX_PROBE_PROGRAM = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const input = JSON.parse(process.argv[1]);
function deniedRead(filename) {
  try { fs.readFileSync(filename); return false; }
  catch (error) { return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code); }
}
function deniedWrite(filename) {
  try { fs.appendFileSync(filename, 'unexpected-sandbox-write', { flag: 'a' }); return false; }
  catch (error) { return ['EACCES', 'EPERM', 'EROFS'].includes(error.code); }
}
(async () => {
  const result = { protocol: 'hxa-sandbox-probe-v1', nonce: input.nonce,
    workspace_write: false, outside_write_denied: false,
    credential_reads_denied: false, network_restricted: false };
  try {
    fs.writeFileSync(path.join(input.workspace, 'witness'), input.nonce, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(input.workspace, '.tmp', 'witness'), input.nonce, { flag: 'wx', mode: 0o600 });
    result.workspace_write = process.cwd() === input.workspace
      && fs.readFileSync(path.join(input.workspace, 'witness'), 'utf8') === input.nonce
      && fs.readFileSync(path.join(input.workspace, '.tmp', 'witness'), 'utf8') === input.nonce;
  } catch {}
  result.outside_write_denied = deniedWrite(input.outside);
  result.credential_reads_denied = input.canaries.every(deniedRead) && input.aliases.every(deniedRead);
  if (input.taskHistory !== undefined) {
    const valid = input.taskHistory && typeof input.taskHistory.canary === 'string'
      && typeof input.taskHistory.alias === 'string';
    // Evaluate both paths even if one is readable, so the negative control also
    // exercises the workspace alias. These are controller-created markers only.
    const directDenied = valid ? deniedRead(input.taskHistory.canary) : false;
    const aliasDenied = valid ? deniedRead(input.taskHistory.alias) : false;
    result.task_history_reads_denied = directDenied && aliasDenied;
  }
  result.network_restricted = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: input.port });
    let done = false;
    const finish = denied => { if (!done) { done = true; socket.destroy(); resolve(denied); } };
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(['EACCES', 'EPERM', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)));
    // A timeout is inconclusive, not proof that the sandbox blocked access.
    socket.setTimeout(750, () => finish(false));
  });
  process.stdout.write(JSON.stringify(result) + '\n');
})().catch(() => { process.exitCode = 3; });
`;
