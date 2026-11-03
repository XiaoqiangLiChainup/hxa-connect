/** Native memory section composition shared by interactive and isolated task modes. */
import fs from 'node:fs';
import path from 'node:path';

export const CORE_MEMORY_FILES = Object.freeze([
  Object.freeze({ name: 'identity.md', label: 'BOT IDENTITY', maximum: 4096 }),
  Object.freeze({ name: 'state.md', label: 'ACTIVE STATE', maximum: 4096 }),
  Object.freeze({ name: 'references.md', label: 'REFERENCES', maximum: 2048 }),
]);

function invalid() {
  const error = new Error('The isolated Zylos memory snapshot is invalid.');
  error.code = 'ZYLOS_TASK_MEMORY_INVALID';
  throw error;
}

function readStrict(filename, maximum) {
  const first = fs.lstatSync(filename);
  if (!first.isFile() || first.isSymbolicLink() || first.nlink !== 1 || first.size > maximum
    || (first.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && first.uid !== process.getuid())) invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum
      || before.ino !== first.ino || before.dev !== first.dev) invalid();
    const bytes = Buffer.alloc(before.size + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filename);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || current.ino !== before.ino
      || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs) invalid();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    if (text.includes('\0')) invalid();
    return text;
  } finally { fs.closeSync(fd); }
}

/** Explicit memory directory; importing this module performs no IO or environment access. */
export function buildMemorySnapshot(memoryDirectory, { strict = false } = {}) {
  if (typeof memoryDirectory !== 'string' || !path.isAbsolute(memoryDirectory)) invalid();
  if (strict) {
    const stat = fs.lstatSync(memoryDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(memoryDirectory) !== memoryDirectory
      || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) invalid();
  }
  return CORE_MEMORY_FILES.map(({ name, label, maximum }) => {
    const filename = path.join(memoryDirectory, name);
    if (strict) {
      const text = readStrict(filename, maximum).trim();
      return `=== ${label} ===\n${text || '(empty)'}`;
    }
    // Preserve the original interactive hook's missing/empty/error presentation.
    try {
      if (!fs.existsSync(filename)) return `=== ${label} ===\n(missing)`;
      const text = fs.readFileSync(filename, 'utf8').trim();
      return `=== ${label} ===\n${text || '(empty)'}`;
    } catch (error) { return `=== ${label} ===\n(read error: ${error.message})`; }
  }).join('\n\n') + '\n';
}
