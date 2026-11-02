# Internal Agent Platform M0: Validation Record

Validation date: 2026-11-02.

Baseline: HXA Connect 1.7.5, commit
`547eae7453a812efaa51c9091a1ce2bcb82c09df`.

Development branch: `feat/internal-agent-tasks`.

## Deployment preparation follow-up

The `feat/internal-agent-deployment` follow-up includes runner scripts in the
runtime image, native SQLite build fallback, a Hub health check, a separate
one-shot mock Compose overlay, HTTPS proxy templates, and company-side deployment
instructions. The application and frontend source are unchanged from the tested
M0 commit `8104e839764c317b70a5ef5b6c62d7ee2ddc06cc`.

Both Compose YAML files, their service/environment separation, referenced runner
paths, the preflight shell syntax, and whitespace checks passed. This is static
configuration validation: Docker/Compose, Nginx, and Caddy executables are not
installed in the preparation environment, so no image build, proxy configuration
test, or company/Aliyun server deployment is claimed. The test totals below are
the M0 application validation record.

## Result

The server and dashboard build successfully. The complete automated suite reports
**547 tests: 540 passed, 0 failed, 7 skipped**. The skipped tests are the existing
Redis session-store contract tests; no Redis instance was configured.

This record covers one Hub process using SQLite and an explicitly selected mock
executor. No paid model, production service, real customer data, or employee
computer was used.

| Check | Result |
| --- | --- |
| Server TypeScript build | Passed |
| Next.js production build, static export, and type checking | Passed |
| Complete Vitest regression suite | 540 passed, 7 Redis tests skipped |
| New platform integration/isolation tests | 18 passed, included above |
| New runner unit tests | 17 passed, included above |
| Isolated local HTTP mock demonstration | Passed |
| Real browser smoke checks against the built server/dashboard | 17 passed |
| Browser JavaScript exceptions during smoke checks | 0 |
| HTTP 5xx responses during browser smoke checks | 0 |

## Reproducible build and test commands

Use Node.js 22 consistently for the main process and child processes. Validation
used Node.js 22.23.4. Do not reuse native `node_modules` across Node major versions.

```bash
npm ci
npm run build
npm test

cd web-next
npm ci
NEXT_TELEMETRY_DISABLED=1 npm run build
cd ..

npm run demo:tasks -- --mock
```

The environment used for validation restricts local listeners by default, so the
HTTP tests ran with permission to bind temporary loopback ports. File-permission
tests ran without root DAC-override capabilities so their read-only-directory
assertions remained meaningful. These are test-host conditions, not application
configuration requirements. Initial migration CLI failures from a Node 24 child
process were resolved by using Node 22 throughout; the final complete run passed.

## Behavior checked

- Concurrent creation with the same idempotency key produces one task and one
  private thread. Failed creation rolls both back.
- Concurrent claims produce one active run. Multiple runners cannot execute two
  tasks simultaneously under the same bot identity.
- Heartbeat renewal, expiry, result replay, cancellation races, explicit retry,
  old-run fencing, and revision conflicts preserve consistent state.
- Cross-organization access, insufficient scopes, and inappropriate browser or
  administrative sessions are rejected.
- SQLite restart preserves queued work, results, execution history, and a valid
  in-flight lease. Unrelated session writes do not join another request's
  transaction.
- Sequential nested SQLite transactions work. Concurrent nested access is
  rejected, including parent SQL while a child savepoint is open.
- A non-SQLite task store does not initialize tables or timers and rejects task
  operations with `503 TASK_STORAGE_UNSUPPORTED` without accessing the database.
- The runner handles transient failures, lost finish responses, lease loss,
  cancellation, late adapter success, and shutdown without pretending uncertain
  work succeeded or silently executing it again.

## Browser verification

A temporary Playwright harness used real local HTTP requests, the built dashboard,
and the actual mock runner. It created an isolated organization and two test bots;
all credentials remained in memory. External browser requests were blocked.

The browser flow covered login, task creation and assignment, running status,
result inspection, acceptance, collaboration-thread navigation, dismissing and
confirming cancellation, failure/retry with two retained attempts, and status
filtering. It also checked navigation and logout controls at 320 px and 390 px,
the mobile page width, browser exceptions, and server errors. Desktop and mobile
screenshots were visually inspected after providing a Chinese font in the test
browser. The harness and browser binary are not added as product dependencies.

## Boundaries of this result

- Mock success validates orchestration; it does not produce a real Demo or query
  production logs.
- Zylos/Codex authentication, subscription quota accounting, tool execution,
  workspace isolation, and local-device onboarding still require integration.
- No Docker image build, company-server deployment, long-duration soak test,
  dependency remediation campaign, or backup/restore exercise was performed.
- PostgreSQL task concurrency and migration are intentionally unavailable in M0.
- Existing thread deletion cascades to associated tasks and run history; business
  retention needs a separate product decision before production adoption.
- The GitHub connection could read the saved fork, but its write attempt returned
  `403 Resource not accessible by integration`. No remote development branch or
  pull request was created during this validation.
