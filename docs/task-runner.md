# Local task runner (M0)

The runner claims work from the task API, renews its execution lease, invokes an
explicit execution adapter, and submits a result. This increment includes only a
**mock adapter**. It does not install Zylos, sign in to Codex, call a model, run a
command from a task description, fetch user-supplied links, or deploy a preview.

Successful mock output always begins with **模拟执行 / No model invoked.** A mock
success proves the task lifecycle worked; it does not mean the business goal was
implemented. A successful run moves the task to `reviewing`; a person still needs
to accept it.

## Prerequisites

- Node.js 22 or later, including its built-in `fetch`.
- A running M0 Hub with the `/api/tasks` routes.
- The assigned bot's full-scope bearer credential. A browser session cannot claim
  work. `HXA_RUNNER_ID` is an operational label, not an authentication credential.

The runner itself adds no npm dependencies. It uses outbound HTTP(S) requests, so
an employee computer needs access to the Hub but no inbound listener. The computer
must remain awake and online to execute tasks.

## Run against an existing development Hub

Set environment variables through your shell, service manager, or secret manager:

```dotenv
HXA_TASK_URL=https://your-hub.example.com
HXA_TASK_TOKEN=<assigned-bot-full-scope-token>
HXA_RUNNER_ID=developer-laptop-1
```

`HXA_TASK_URL` is the Hub base URL, with an optional deployment prefix. Do not append
`/api/tasks` and do not put credentials in the URL. Use HTTPS for a remote Hub.
Never commit the token or pass it as a command-line argument.

```bash
# Process at most one task; an empty queue also exits successfully.
npm run task:runner -- --mock --once

# Continue polling, one execution at a time.
npm run task:runner -- --mock

# Equivalent direct invocation, without npm.
node scripts/task-runner.mjs --mock --once
```

Omitting `--mock` is an error. There is no implicit successful executor.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `HXA_TASK_URL` | Required | Hub base URL |
| `HXA_TASK_TOKEN` | Required | Assigned bot's full-scope bearer token |
| `HXA_RUNNER_ID` | Hostname and process ID | Runner label, 1–128 safe characters |
| `HXA_TASK_POLL_MS` | `2000` | Delay before the next claim in resident mode |
| `HXA_TASK_HEARTBEAT_MS` | `15000` | Renewal interval; server lease is 60 seconds |
| `HXA_TASK_REQUEST_TIMEOUT_MS` | `10000` | Request timeout, also bounded by the current lease |
| `HXA_TASK_MAX_RETRIES` | `3` | Additional heartbeat/finish attempts after a transient failure |
| `HXA_TASK_RETRY_BASE_MS` | `250` | Initial exponential retry delay |
| `HXA_TASK_RETRY_MAX_MS` | `2000` | Maximum retry delay |
| `HXA_MOCK_DELAY_MS` | `1000` | Time the explicit mock spends waiting |

Use `HXA_MOCK_DELAY_MS=20000` to see a default 15-second heartbeat during a mock.
Keep runner/server clocks synchronized: the runner conservatively uses the Hub's
Unix-millisecond `lease_expires_at` and does not assume a renewal succeeded when
its response was lost.

## Cancellation, retries, and uncertain outcomes

- `SIGINT` and `SIGTERM` abort the current adapter and any request. No further task
  is claimed. The CLI exits with 130 or 143 respectively after cooperative cleanup.
- The runner recognizes `TASK_LEASE_EXPIRED`, `TASK_LEASE_INVALID`,
  `TASK_CANCELLED`, and `TASK_RUN_INACTIVE` on HTTP 403/409 as explicit lease loss.
  Other 403/409 errors stop work as request failures; they are not relabeled as
  lease expiry. Authentication and other permanent rejections are not retried.
  Server-side cancellation is discovered on the next heartbeat or finish request;
  it is not pushed instantly to the runner.
- Heartbeats and result submissions retry network errors and HTTP 408, 429, and
  5xx responses with bounded exponential backoff. The retry budget is finite and
  never runs beyond the last confirmed lease deadline. Exhausting the budget also
  stops work conservatively, even if a small amount of lease time remains.
- A claim is **not automatically retried** after a transport failure. The Hub may
  already have created a run even though its response was lost. Inspect the task
  and let the lease expire before deciding whether to retry it manually.
- A result is serialized once. Every finish retry uses the same task/run IDs,
  lease token, and exact JSON body. The adapter is never invoked again to retry a
  result submission. Heartbeats stop before finish so a completed run cannot race
  a late heartbeat.
- Lease loss or an uncertain finish stops the worker. It does not automatically
  requeue or re-execute work. The Hub keeps the attempt history; a user decides
  whether an explicit task retry is appropriate. External effects are not made
  exactly-once by an execution lease.
- Shutdown does not submit a successful result. A lease that has not already been
  cancelled is left for the Hub to expire; there is no implicit release/requeue.

The default logger emits operational event names and task/run IDs. It does not
print bearer tokens, lease tokens, task descriptions, summaries, request headers,
or raw server/transport error bodies. An adapter must follow the same rules.

Exit status: `0` for a successful/empty one-shot run or normal stop, `1` when a
confirmed adapter result failed, `2` for configuration, lease, or transport errors,
and `130`/`143` for interactive/termination signals.

## Isolated end-to-end demonstration

```bash
npm run build
npm run demo:tasks -- --mock
```

The demo uses the built server modules to bind **127.0.0.1 on an automatically
assigned port**. It creates a new `mkdtemp` directory, an isolated SQLite database,
one organization, an owner bot and a worker bot. Credentials and cookies stay in
memory. It creates a task as the owner, runs the explicit mock with an accelerated
one-second heartbeat, checks `reviewing`, and accepts the result as `completed`.

The demo always shuts down its Hub and removes only the temporary directory it
created. It accepts no external URL or data directory and does not read
`HXA_TASK_URL`, `DATABASE_URL`, or production tokens. It does not write to GitHub
or change your normal Hub's data. A server build and the repository's existing
dependencies are required; the demo does not install them.

## Implementing a real execution adapter later

The independent API is exported from `scripts/task-runner.mjs`:

```javascript
import { runWorker } from './scripts/task-runner.mjs';

await runWorker({
  url: process.env.HXA_TASK_URL,
  token: process.env.HXA_TASK_TOKEN,
  runnerId: 'server-agent-1',
  once: false,
}, {
  signal: shutdownController.signal,
  executeTask: async ({ task, run, signal }) => {
    // Your explicitly configured Zylos/Codex adapter goes here.
    // Honor signal throughout execution and stop child processes/tools on abort.
    const result = await yourExecutor.execute({ task, run, signal });
    return {
      status: 'succeeded', // or 'failed'
      summary: result.summary,
      artifacts: result.links, // [{ title, url }]; metadata only, never fetched here
    };
  },
});
```

An adapter receives the task, run, and an `AbortSignal`; it does not receive the
lease token. It must return an explicit `succeeded` status with a non-empty
`summary`, or a `failed` status with a non-empty `error`. Artifact links are optional.
An exception becomes a failed run only
while the lease is still valid. Missing or malformed result objects become failed
results, not fake successes.

Respect the API limits: summary/error at most 10,000 characters, at most 20
artifacts, titles at most 200 characters, and HTTP(S) URLs at most 2,048 characters
without embedded credentials. For external tools, use the task/run identity for
idempotency, fence writes when possible, and register process cancellation before
starting work. JavaScript cannot forcibly stop an adapter that ignores its abort
signal; the runner will fence its result, but the adapter must stop its own effects.

Real model authentication, quota accounting, workspace isolation, and preview
hosting remain separate integration work. Selecting this adapter does not imply
that a subscription can be shared by a company platform.

## Focused verification

```bash
npx vitest run test/task-runner.test.ts
```

The runner tests use fake HTTP responses and controlled timers, without models or
external network calls. They cover empty queues, heartbeat renewal, transient
errors, lost finish responses, exact finish replay, cancellation/expiry, late
adapter success, permanent rejection, safe logging, and the explicit mock gate.
