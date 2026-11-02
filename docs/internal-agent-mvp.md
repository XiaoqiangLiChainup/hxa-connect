# Internal Agent Platform: First Development Increment

## Objective

Add a runnable task lifecycle to the saved HXA Connect server and dashboard. A
person can describe an arbitrary goal, assign an existing agent, inspect its
execution attempts, and accept its result. The task description is free-form;
there is no mandatory product-to-architect-to-developer workflow.

Baseline: HXA Connect 1.7.5 at
`547eae7453a812efaa51c9091a1ce2bcb82c09df`.

This increment is a development MVP. It uses the existing Bot Owner login and
does not claim to implement independent employee accounts or a production model
integration. A mock runner is explicit and never invokes a model. Actual
Zylos/Codex execution is the next integration milestone.

## Deployment boundary

- One company organization and one Hub process.
- Existing TypeScript/Express server and Next.js static dashboard.
- SQLite persistence, with execution state durable across process restarts.
- Task operations on other database backends return
  `503 TASK_STORAGE_UNSUPPORTED`; the existing Hub can still start. PostgreSQL
  task concurrency and migration are outside this increment.
- Existing HXA branding and license notices retained.
- Runners initiate connections to the server; no inbound connection to an
  employee computer is required for the task API.
- No real model credentials are required for the isolated demonstration.

HXA Connect's modified Apache license has additional multi-tenant and frontend
branding conditions. Refer to the repository's `LICENSE` before changing the
deployment or branding scope.

## Product lifecycle

1. A Bot Owner creates a task and selects an active organization bot. The selected
   bot may be temporarily offline; the task remains queued until claimed.
2. The platform records the task and creates its private collaboration thread.
3. An authenticated runner for the assigned bot claims one queued task.
   Each bot has at most one running task, even if multiple runners use that bot.
   Submitting a result releases this execution slot while review is pending.
4. The runner renews an execution lease while doing work.
5. The runner submits a result summary and optional HTTP(S) artifact links.
6. A successful attempt puts the task into review; the creator or an organization
   admin bot accepts it as completed.
7. Failed or expired attempts retain their history. A user may explicitly retry.
   Cancellation invalidates an active execution's right to submit results.

An expired lease is not automatically executed again: an external action might
already have happened. Operators inspect the previous attempt before retrying.
Database claims and lease fencing prevent simultaneous authoritative attempts;
they do not promise exactly-once effects in external business systems.

## State model

Task states:

| State | Meaning |
| --- | --- |
| `queued` | Persisted, waiting for its assigned bot |
| `running` | Claimed by a runner with an active execution lease |
| `reviewing` | Execution succeeded; result awaits human acceptance |
| `completed` | Accepted by the creator or an organization admin bot |
| `failed` | Execution failed or its lease expired |
| `cancelled` | Cancelled by the creator or an organization admin bot |

Run states: `running`, `succeeded`, `failed`, `expired`, `cancelled`.
Each retry creates a new run and preserves previous attempts.

## API contract

All endpoints are under `/api/tasks`. Existing authentication and organization
checks apply. Read endpoints allow the creator, assigned bot, or an admin bot in
the same organization. Task mutations require the appropriate full-scope bot
credential or Bot Owner session. Runner operations require a full-scope bearer
credential for the assigned bot; browser sessions cannot claim work.

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /agents` | — | `{items: [{id, name, role, online}]}` |
| `GET /` | Optional `status`, bounded `limit` | `{items: Task[], total}` |
| `POST /` | `{title, description, assigned_bot_id}` and `Idempotency-Key` header | `Task` |
| `GET /:id` | — | `{task: Task, runs: Run[]}` |
| `POST /claim` | `{runner_id}` | `{task: null}` or `{task, run, lease_token}` |
| `POST /:id/runs/:runId/heartbeat` | `{lease_token}` | `{lease_expires_at}` |
| `POST /:id/runs/:runId/finish` | `{lease_token, status, summary?, error?, artifacts?}` | `{task, run}` |
| `POST /:id/accept` | `{expected_revision}` | `Task` |
| `POST /:id/retry` | `{expected_revision}` | `Task` |
| `POST /:id/cancel` | `{expected_revision}` | `Task` |

`Task` fields:

```typescript
interface Task {
  id: string;
  org_id: string;
  title: string;
  description: string;
  status: 'queued' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
  created_by: string;
  created_by_name: string | null;
  assigned_bot_id: string;
  thread_id: string;
  created_at: number;
  updated_at: number;
  revision: number;
  latest_run?: Run;
}

interface Run {
  id: string;
  task_id: string;
  runner_id: string;
  attempt: number;
  status: 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
  started_at: number;
  finished_at: number | null;
  lease_expires_at: number;
  summary: string | null;
  error: string | null;
  artifacts: Array<{title: string; url: string}>;
}
```

Dates are Unix milliseconds. The public run representation never contains the
lease token or its hash. A claim returns a randomly generated lease token once;
only a hash is persisted. The lease duration is 60 seconds, and the reference
runner renews every 15 seconds.

For `finish`, `status` is either `succeeded` with a non-empty `summary`, or
`failed` with a non-empty `error`. Empty or malformed results cannot be accepted
as success.

Creation is idempotent within the creator/organization boundary. Repeating a key
with a different payload is rejected. A final result submission can be safely
retried with exactly the same run, lease token, and payload. A conflicting result,
expired lease, cancelled run, or stale task revision is rejected.

Artifact links are validated HTTP(S) URLs without embedded credentials. Storing
a link does not fetch it, deploy an application, or prove its contents.

## Acceptance criteria

- Create a task from the real dashboard and select its assignee.
- Read task details, execution history, result summaries, and artifact links.
- Submit the same creation request twice without creating duplicate work.
- Race two claims and obtain only one authoritative active run per task.
- Race two runners for different tasks assigned to one bot and execute only one.
- Reject another organization, an unassigned runner, and insufficient scopes.
- Renew a lease and fence stale/expired/cancelled attempts from result submission.
- Preserve queued tasks and execution history after server restart.
- Run an explicit mock runner through claim, heartbeat, result, and review.
- Accept, retry, and cancel through the UI with revision checks.
- Build both server and dashboard and keep the existing test suite passing.

## Current retention and identity boundaries

The private thread supplies a place for discussion. Task creation does not send
a chat message that could also trigger an existing agent bridge, and task state
does not overwrite the thread's independent status.

Deleting the associated thread currently cascades to its task and run history.
Treat these records as one retention unit in this development increment. A
separate business-task retention policy is required before adopting independent
chat deletion or long-term audit retention.

Bot Owner display names identify the current login in the UI; they are not
independently verified employee accounts. The first increment intentionally
reuses the Hub's identity model instead of adding a second login system.

## Next integration milestone

Connect a real Zylos/Codex adapter to the execution interface; retain the same
task IDs, lease rules, and result reporting. Then add independent employee
identity, runtime/node lifecycle management, durable HXA message catchup, and
controlled Demo preview deployment. Real model access, account quota behavior,
dependency updates, and production backup/restore require their own validation
before a company deployment.
