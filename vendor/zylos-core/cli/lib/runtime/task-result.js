/** Validate the structured task result independently of model-authored identity fields. */
function invalid() {
  const error = new Error('The isolated Zylos task result is invalid.');
  error.code = 'ZYLOS_TASK_RESULT_INVALID';
  throw error;
}

function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}

function text(value, maximum, nonblank = true) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')
    || (nonblank && !value.trim())) invalid();
  return value;
}

export function validateTaskResult(value) {
  shape(value, ['status', 'summary', 'artifacts', 'checks']);
  if (!['succeeded', 'failed'].includes(value.status)) invalid();
  const summary = text(value.summary, 8000);
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 19
    || !Array.isArray(value.checks) || value.checks.length > 30) invalid();
  const paths = new Set();
  const artifacts = value.artifacts.map(item => {
    shape(item, ['path', 'title']);
    const file = text(item.path, 512);
    if (/[\\\u0000-\u001f\u007f]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')
      || file.split('/')[0] === '.tmp' || paths.has(file)) invalid();
    paths.add(file);
    return { path: file, title: text(item.title, 200) };
  });
  const names = new Set();
  const checks = value.checks.map(item => {
    shape(item, ['name', 'passed', 'details']);
    const name = text(item.name, 120);
    if (names.has(name) || typeof item.passed !== 'boolean') invalid();
    names.add(name);
    return { name, passed: item.passed, details: text(item.details, 2000, false) };
  });
  if (value.status === 'succeeded' && (!checks.length || checks.some(check => !check.passed))) invalid();
  const result = { status: value.status, summary, artifacts, checks };
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) invalid();
  return result;
}
