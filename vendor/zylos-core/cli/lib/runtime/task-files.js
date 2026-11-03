/** Private, explicit-path storage for the custom task runtime. No environment defaults. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function invalid(code = 'ZYLOS_TASK_PATH_INVALID') {
  const error = new Error('The isolated Zylos task storage could not be verified.');
  error.code = code;
  throw error;
}

export function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function privateDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(value) || path.resolve(value) !== value || value === '/') invalid();
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value) !== value
    || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) invalid();
  return value;
}

export function syncDirectory(directory) {
  const fd = fs.openSync(privateDirectory(directory), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function privateChild(parent, name, exclusive = false) {
  privateDirectory(parent);
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) invalid();
  const destination = path.join(parent, name);
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
    syncDirectory(parent);
  } catch (error) {
    if (error.code !== 'EEXIST' || exclusive) throw error;
  }
  return privateDirectory(destination);
}

function ordinaryFile(stat, maximum) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum
    && (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

export function readPrivateText(filename, maximum = 65_536) {
  privateDirectory(path.dirname(filename));
  const first = fs.lstatSync(filename);
  if (!ordinaryFile(first, maximum) || fs.realpathSync(filename) !== filename) invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!ordinaryFile(before, maximum) || before.ino !== first.ino || before.dev !== first.dev) invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, total);
      if (!count) break;
      total += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filename);
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || current.ino !== before.ino
      || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs) invalid();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
  } finally { fs.closeSync(fd); }
}

export function writePrivateExclusive(filename, text, maximum = 65_536) {
  privateDirectory(path.dirname(filename));
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) invalid('ZYLOS_TASK_STORAGE_LIMIT');
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(filename));
}

export function atomicPrivateJson(filename, value) {
  const directory = privateDirectory(path.dirname(filename));
  try {
    const stat = fs.lstatSync(filename);
    if (!ordinaryFile(stat, 65_536)) invalid();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.task-${randomUUID()}.tmp`);
  try {
    writePrivateExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, filename);
    syncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
