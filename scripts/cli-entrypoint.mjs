import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Identify the calling module, including a release reached through a symlink. */
export function isMainModule(meta, { argv = process.argv, execArgv = process.execArgv } = {}) {
  // Native false is authoritative too: an eval argument can name an imported module.
  if (typeof meta.main === 'boolean') return meta.main;

  // Compatibility for Node versions without import.meta.main. Eval/stdin arguments
  // are user data, not script entrypoints, even when they name an existing file.
  const entryPath = argv[1];
  if (!entryPath || entryPath === '-' || execArgv.some(arg => /^(?:--(?:eval|print|input-type)(?:=|$)|-[ep])/.test(arg))) return false;
  try {
    const moduleUrl = new URL(meta.url);
    if (moduleUrl.protocol !== 'file:' || moduleUrl.search || moduleUrl.hash) return false;
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}
