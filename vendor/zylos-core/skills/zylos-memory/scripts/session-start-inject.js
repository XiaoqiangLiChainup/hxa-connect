#!/usr/bin/env node
/**
 * Session Start Injection
 *
 * Reads core memory files and prints plain text sections for hook injection.
 */

import { fileURLToPath } from 'url';
import { MEMORY_DIR } from './shared.js';
import { buildMemorySnapshot } from './memory-snapshot.js';

const startMs = Date.now();
let diagnosticModule;
let diagnosticLoadAttempted = false;

async function getDiagnosticModule() {
  if (!diagnosticLoadAttempted) {
    diagnosticLoadAttempted = true;
    try {
      diagnosticModule = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    } catch {
      diagnosticModule = null;
    }
  }
  return diagnosticModule;
}

async function logHookTimingSafe(name, durationMs) {
  const module = await getDiagnosticModule();
  if (module?.logHookTiming) {
    module.logHookTiming(name, durationMs);
  }
}

function main() {
  process.stdout.write(buildMemorySnapshot(MEMORY_DIR));
}

async function runCli() {
  try {
    main();
  } catch (err) {
    console.error(`session-start-inject error: ${err.message}`);
  } finally {
    await logHookTimingSafe('session-start-inject', Date.now() - startMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    // Best-effort.
  });
}
