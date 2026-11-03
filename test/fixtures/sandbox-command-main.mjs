import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [mode, ...args] = process.argv.slice(2);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = name => fs.writeFileSync(name, JSON.stringify({ pid: process.pid }));
if (mode === 'success') {
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
} else if (mode === 'nonzero') {
  process.stderr.write('fixture-private-diagnostic');
  process.exitCode = 7;
} else if (mode === 'output') {
  process.stdout.write('x'.repeat(65_536));
  setInterval(() => {}, 1_000);
} else if (mode === 'stderr-output') {
  process.stderr.write('fixture-private-diagnostic'.repeat(4_000));
  setInterval(() => {}, 1_000);
} else if (mode === 'invalid-utf8') {
  process.stdout.write(Buffer.from([0xc3, 0x28]));
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'child') {
  process.on('SIGTERM', () => {});
  ready(args[0]);
  setInterval(() => {}, 1_000);
} else if (mode === 'wait' || mode === 'ignore-term') {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  ready('ready.json');
  setInterval(() => {}, 1_000);
} else if (['descendant', 'detached-descendant', 'exit-with-descendant', 'gated-descendant'].includes(mode)) {
  process.on('SIGTERM', () => {});
  ready('ready.json');
  if (mode === 'gated-descendant') {
    while (!fs.existsSync('spawn-child')) await wait(5);
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', path.resolve('child-ready.json')], {
    detached: mode !== 'descendant', env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', () => process.exit(77));
  while (!fs.existsSync('child-ready.json')) await wait(5);
  // Give the controller a deterministic observation window before orphaning.
  await wait(120);
  if (mode === 'exit-with-descendant') process.exit(0);
  setInterval(() => {}, 1_000);
}
