/** The only model-authored result accepted by the Codex execution adapter. */
export const RESULT_LIMITS = Object.freeze({
  summary: 8_000,
  artifacts: 19,
  artifactPath: 512,
  artifactTitle: 200,
  checks: 30,
  checkName: 120,
  checkDetails: 2_000,
});

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'artifacts', 'checks'],
  properties: {
    status: { type: 'string', enum: ['succeeded', 'failed'] },
    summary: { type: 'string', minLength: 1, maxLength: RESULT_LIMITS.summary },
    artifacts: {
      type: 'array', maxItems: RESULT_LIMITS.artifacts,
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'title'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: RESULT_LIMITS.artifactPath },
          title: { type: 'string', minLength: 1, maxLength: RESULT_LIMITS.artifactTitle },
        },
      },
    },
    checks: {
      type: 'array', maxItems: RESULT_LIMITS.checks,
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'passed', 'details'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: RESULT_LIMITS.checkName },
          passed: { type: 'boolean' },
          details: { type: 'string', maxLength: RESULT_LIMITS.checkDetails },
        },
      },
    },
  },
};

export class CodexResultValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexResultValidationError';
    this.code = 'CODEX_RESULT_INVALID';
  }
}

function invalid(message) { throw new CodexResultValidationError(message); }

function objectWithKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key))) {
    invalid(`${label} must contain exactly the documented fields.`);
  }
}

function text(value, limit, label, nonblank = true) {
  if (typeof value !== 'string' || value.length > limit || (nonblank && !value.trim())
    || /[\u0000]/u.test(value)) invalid(`${label} is invalid or exceeds its size limit.`);
  return value;
}

/** Filesystem ownership/type/size checks remain the artifact collector's job. */
export function validateCodexResult(value) {
  objectWithKeys(value, ['status', 'summary', 'artifacts', 'checks'], 'Result');
  if (!['succeeded', 'failed'].includes(value.status)) invalid('Result status is invalid.');
  const summary = text(value.summary, RESULT_LIMITS.summary, 'Result summary');
  if (!Array.isArray(value.artifacts) || value.artifacts.length > RESULT_LIMITS.artifacts) {
    invalid('Result artifacts exceed the item limit or are not an array.');
  }
  const artifactPaths = new Set();
  const artifacts = value.artifacts.map(artifact => {
    objectWithKeys(artifact, ['path', 'title'], 'Artifact');
    const artifactPath = text(artifact.path, RESULT_LIMITS.artifactPath, 'Artifact path');
    const parts = artifactPath.split('/');
    if (/[\\\u0000-\u001f\u007f]/u.test(artifactPath)
      || parts.some(part => !part || part === '.' || part === '..')
      || parts[0] === '.tmp' || artifactPaths.has(artifactPath)) {
      invalid('Artifact paths must be unique, normalized workspace-relative file paths.');
    }
    artifactPaths.add(artifactPath);
    return { path: artifactPath, title: text(artifact.title, RESULT_LIMITS.artifactTitle, 'Artifact title') };
  });
  if (!Array.isArray(value.checks) || value.checks.length > RESULT_LIMITS.checks) {
    invalid('Result checks exceed the item limit or are not an array.');
  }
  const checkNames = new Set();
  const checks = value.checks.map(check => {
    objectWithKeys(check, ['name', 'passed', 'details'], 'Check');
    const name = text(check.name, RESULT_LIMITS.checkName, 'Check name');
    if (typeof check.passed !== 'boolean' || checkNames.has(name)) {
      invalid('Check names must be unique and passed must be a boolean.');
    }
    checkNames.add(name);
    return { name, passed: check.passed, details: text(check.details, RESULT_LIMITS.checkDetails, 'Check details', false) };
  });
  if (value.status === 'succeeded' && (!checks.length || checks.some(check => !check.passed))) {
    invalid('Successful results require at least one check and all checks must pass.');
  }
  return { status: value.status, summary, artifacts, checks };
}
