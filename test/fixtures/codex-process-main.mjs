import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This executable is an offline process fixture, never a Codex/model invocation.
const args = process.argv.slice(2);
if (args.includes('app-server') && args.includes('--print-startup-config')) {
  // Model-free fixture for the native managed-policy preview before exec.
  const markerFile = path.join(process.cwd(), '.fixture-policy-preview');
  const mode = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : 'allowed';
  fs.writeFileSync(path.join(process.cwd(), 'policy-preview-observed.json'), JSON.stringify({ argv: args }));
  if (mode === 'malformed') process.stdout.write('{');
  else process.stdout.write(JSON.stringify({ appServerVersion: '0.166.0', configRequirements: {
    supportsIndependentSpeedModes: true,
    requirements: mode === 'rejected' ? {
      allowedPermissionProfiles: { ':workspace': true }, defaultPermissions: ':workspace', allowedSandboxModes: null,
    } : null,
  } }) + '\n');
  process.exit(0);
}
const outputFile = args[args.indexOf('--output-last-message') + 1];
const schemaFile = args[args.indexOf('--output-schema') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
const marker = 'BEGIN UNTRUSTED TASK JSON\n';
const taskText = prompt.slice(prompt.indexOf(marker) + marker.length).split('\nEND UNTRUSTED TASK JSON')[0];
const task = JSON.parse(taskText);
const mode = task.description.startsWith('fixture:') ? task.description.slice('fixture:'.length).split('\n')[0] : 'success';
const secret = 'raw-model-output-credential-sentinel';
const result = {
  status: 'succeeded', summary: 'Offline fixture completed; no model invoked.',
  artifacts: [{ path: 'index.html', title: 'Offline fixture artifact' }],
  checks: [{ name: 'fixture check', passed: true, details: 'Executed by a local Node fixture.' }],
};
const event = value => process.stdout.write(JSON.stringify(value) + '\n');
const complete = () => event({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
const writeResult = value => fs.writeFileSync(outputFile, JSON.stringify(value));
fs.writeFileSync('index.html', '<!doctype html><title>Offline fixture</title>');
fs.writeFileSync('observed.json', JSON.stringify({
  argv: args, cwd: process.cwd(), env: process.env, prompt,
  schema: JSON.parse(fs.readFileSync(schemaFile, 'utf8')),
}));
event({ type: 'thread.started', thread_id: secret });
event({ type: 'turn.started' });

if (['wait', 'ignore-term', 'timeout'].includes(mode)) {
  if (mode !== 'wait') process.on('SIGTERM', () => {});
  fs.writeFileSync('ready.json', JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1_000);
} else if (mode === 'descendant') {
  const childReady = path.join(process.cwd(), 'child-ready.json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./codex-process-child.mjs', import.meta.url)), childReady], {
    env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', () => process.exit(77));
  for (let count = 0; !fs.existsSync(childReady); count++) {
    if (count > 200) process.exit(78);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  writeResult(result);
  complete();
  process.exit(0); // Descendant intentionally keeps stdout/stderr pipes open.
} else if (mode === 'stdout-cap') {
  event({ type: 'item.completed', output: secret.repeat(20_000) });
  writeResult(result);
  complete();
} else if (mode === 'stderr-cap') {
  process.stderr.write(secret.repeat(20_000));
  writeResult(result);
  complete();
} else if (mode === 'malformed-jsonl') {
  process.stdout.write('{invalid JSON}\n');
  writeResult(result);
  complete();
} else if (mode === 'truncated-jsonl') {
  process.stdout.write('{"type":"turn.completed"');
  writeResult(result);
} else if (mode === 'invalid-utf8') {
  process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
  writeResult(result);
} else if (mode === 'truncated-utf8') {
  process.stdout.write(Buffer.from([0xe2, 0x82]));
  writeResult(result);
} else if (mode === 'terminal-failed') {
  writeResult(result);
  event({ type: 'turn.failed', error: { message: secret } });
} else if (mode === 'terminal-tail') {
  writeResult(result);
  complete();
  event({ type: 'item.started', item: { command: secret } });
} else if (mode === 'no-terminal') {
  writeResult(result);
} else if (mode === 'nonzero') {
  writeResult(result);
  complete();
  process.exitCode = 7;
} else if (mode === 'signal') {
  writeResult(result);
  complete();
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'invalid-result') {
  fs.writeFileSync(outputFile, '{not-json');
  complete();
} else if (mode === 'invalid-result-utf8') {
  fs.writeFileSync(outputFile, Buffer.from([0xe2, 0x82]));
  complete();
} else if (mode === 'extra-field') {
  writeResult({ ...result, unwanted: secret });
  complete();
} else if (mode === 'failed-check') {
  result.checks[0].passed = false;
  writeResult(result);
  complete();
} else if (mode === 'no-checks') {
  result.checks = [];
  writeResult(result);
  complete();
} else if (mode === 'blank-summary') {
  result.summary = '   ';
  writeResult(result);
  complete();
} else if (mode === 'symlink-result') {
  fs.writeFileSync('linked-result.json', JSON.stringify(result));
  fs.symlinkSync(path.join(process.cwd(), 'linked-result.json'), outputFile);
  complete();
} else if (mode === 'hardlink-result') {
  fs.writeFileSync('linked-result.json', JSON.stringify(result));
  fs.linkSync(path.join(process.cwd(), 'linked-result.json'), outputFile);
  complete();
} else if (mode === 'result-cap') {
  fs.writeFileSync(outputFile, 'x'.repeat(70_000));
  complete();
} else if (mode === 'missing-result') {
  complete();
} else {
  if (mode === 'declared-failure') {
    result.status = 'failed';
    result.summary = 'The offline fixture deliberately reports failure.';
    result.checks[0].passed = false;
  }
  if (mode === 'sensitive-output') {
    event({ type: 'item.completed', item: { command: secret, text: secret, output: secret } });
    event({ type: secret, data: secret });
    process.stderr.write(secret + '\n');
  }
  writeResult(result);
  complete();
}
