#!/usr/bin/env node
import { isMainModule } from './cli-entrypoint.mjs';
import { inspectZylosSource, ZylosInspectionError } from './zylos-task/inspect.mjs';

const HELP = `Usage: node scripts/zylos-task-check.mjs --root <absolute-zylos-home> --launcher <absolute-zylos-launcher>
       node scripts/zylos-task-check.mjs --root <absolute-zylos-home> --package-root <absolute-installed-package>

Static source evidence and M1 execution eligibility only. No Zylos/C4 code is executed.
Reads only allowlisted public source files; no auth, config, database, messages, or environment dump.
Never claims tasks, sends messages, contacts a model/Hub, stops a session, or changes permissions.
The reviewed Zylos 0.5.2 shared runtime lacks the required per-task lifecycle; eligibility stays false.
Exit 2 means execution is blocked even when source inspection is complete. Inspect the JSON fields.
No --execute, --force, --accept-risk, credential, or capability-override option exists.
See docs/m1-zylos-integration.md and docs/m1-consolidated-delivery.md.`;

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(HELP); return 0; }
  const options = {};
  const names = { '--root': 'root', '--launcher': 'launcher', '--package-root': 'packageRoot' };
  for (let index = 0; index < args.length; index += 2) {
    if (!Object.hasOwn(names, args[index])) throw new ZylosInspectionError();
    const key = names[args[index]];
    if (!key || options[key] !== undefined || typeof args[index + 1] !== 'string') throw new ZylosInspectionError();
    options[key] = args[index + 1];
  }
  console.log(JSON.stringify(inspectZylosSource(options), null, 2));
  // No source fingerprint or caller-supplied boolean can activate a task executor.
  return 2;
}

if (isMainModule(import.meta)) {
  try { process.exitCode = main(); }
  catch {
    console.error('Zylos task check: invalid arguments or unreadable source evidence; no task was claimed. Use --help.');
    process.exitCode = 2;
  }
}
