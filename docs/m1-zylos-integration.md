# M1: existing Zylos integration boundary

## Delivery status

**This release must not claim that it provides a deployable task executor for the
existing shared Zylos instance.** The supported M1 execution implementation is the
separate Codex worker described in [m1-codex-worker.md](m1-codex-worker.md). It is a
Codex execution backend, not a renamed Zylos adapter.

For an existing Zylos installation, this release provides source inspection and
a static eligibility decision that always reports execution as unsupported.
It is not an active Hub or Codex-worker authorization gate; no Zylos Task
consumer or C4 dispatch path is shipped or registered. It never claims a Hub
task, sends a C4 message, or injects input into a runtime session. This decision
does not add a new Hub authorization endpoint. A healthy or reachable Zylos
process does not satisfy the missing task-execution contract.

The existing company installation has been described as Zylos `0.5.2`, using
Codex CLI `0.166.0`, with a shared interactive agent rooted at `/root/zylos`.
Those are deployment reports, not observations made by this repository's tests.
No company server, live conversation, authentication file, or model invocation
was accessed during the source audit.

See [the consolidated handoff](m1-consolidated-delivery.md) for the current direct-SSH
deployment assistant's procedure. Zylos has handed off deployment; this delivery
does not require sending it a message. Acting as an installation assistant and
being the platform's task execution backend are different capabilities.

## Source and version examined

The audit uses the official repository
[`zylos-ai/zylos-core`](https://github.com/zylos-ai/zylos-core), tag
[`v0.5.2`](https://github.com/zylos-ai/zylos-core/tree/v0.5.2), resolved to commit:

```text
8ee9bd9007edab46f766f3574e0ad56cf69268c2
```

All source links below are pinned to that commit. They are not claims about the
current default branch or an uninspected company fork. Package version alone
does not prove that deployed source files match the release.

The audit establishes the Zylos-side contract. It does not certify every
interaction between this older Zylos release and Codex CLI `0.166.0`. The Zylos
adapter selects `CODEX_BIN` or `codex`; its launch implementation does not perform
the M1 worker's pinned-version and execution-policy checks.
([Source: runtime/codex.js, lines 44–49 and 292–345](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L44-L49))

## What the official 0.5.2 runtime actually exposes

| Capability | Source-backed behavior | M1 implication |
| --- | --- | --- |
| Runtime lifecycle | `RuntimeAdapter` defines instruction generation, `launch()`, `stop()`, `isRunning()`, `sendMessage(text)`, authentication, heartbeat and context-monitor access. `launch()` and `sendMessage()` return `Promise<void>`. | This is an agent lifecycle interface. It is not a job API with a task ID, run ID, terminal result and scoped cancellation. |
| Codex session selection | `SESSION` and `sessionName` are fixed to `codex-main`. | Supplying a platform task ID does not create or select a separate Codex session. |
| Working directory | `launch()` starts in `ZYLOS_DIR`; both the existing-session shell command and the new launch specification use that root. | No per-task `cwd` option is exposed by this adapter. Asking the agent to use another directory is an instruction, not a verified execution boundary. |
| Context on startup | The bootstrap asks the agent to load persistent memory and C4 checkpoint/recent-conversation context. | A fresh runtime process is not a clean, isolated context for a platform task. |
| Message injection | `sendMessage(text)` creates a temporary buffer, pastes it into the fixed tmux session, and sends Enter. | Successful return proves that the injection calls completed, not that the requested task completed. |
| Stop | `stop()` calls `tmuxKillSession(SESSION)`. | Stopping this adapter targets the whole shared runtime session, including unrelated work. |
| Session rotation | The `new-session` skill uses Codex `/exit`, after a handoff; its instructions explicitly say Codex background tasks terminate on exit. | Rotation is not task-scoped cancellation or an independent task-session factory. |
| Runtime process exit | `tmux-launcher.js` forwards signals to its direct child and records the runtime process exit code. | A runtime exit log is not a terminal result for a particular C4 request or Hub run. |
| Context/health monitoring | Codex context monitoring selects the latest updated non-archived thread, or most recently modified rollout under the same home. Heartbeat uses C4 control acknowledgements. | These signals must not be interpreted as a particular task's progress or completion. Sharing that home with an additional Codex process can also affect which rollout the monitor selects. |

Primary evidence:

- [RuntimeAdapter method contract, lines 23–113](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/base.js#L23-L113).
- [Fixed Codex session, lines 44–49 and 113–116](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L44-L49);
  [stop and sendMessage, lines 212–241](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L212-L241);
  [launch and fixed cwd, lines 268–345](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L268-L345).
- [Startup memory and C4 context, lines 72–105](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L72-L105).
- [ZYLOS_DIR selection, lines 8–16](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/config.js#L8-L16).
- [Tmux paste/Enter and whole-session kill, lines 51–88](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/tmux-helpers.js#L51-L88).
- [Launcher spawn, signal forwarding and runtime exit, lines 38–65](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/tmux-launcher.js#L38-L65).
- [New-session behavior, lines 23–36 and 66–87](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/new-session/SKILL.md#L23-L36).
- [Latest-thread context lookup, lines 127–143](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex-context-monitor.js#L127-L143);
  [filesystem fallback, lines 146–178](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex-context-monitor.js#L146-L178);
  [heartbeat ACK contract, lines 8–26](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/heartbeat/codex-probe.js#L8-L26).

This behavior is consistent with the release's stated design: a unified
conversation and memory across channels, explicitly distinguished from routing
conversations to isolated workspaces.
([README, line 257](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/README.md#L257);
[architecture note, line 319](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/README.md#L319))

The command registry also contains no documented task start/wait/cancel command.
Do not invent commands such as `zylos task run` or methods such as
`executeTask({ sessionId, cwd })` and describe them as official 0.5.2 interfaces.
([CLI registry, lines 26–50](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/zylos.js#L26-L50))

## C4 values are delivery evidence, not task completion

C4 is a real integration mechanism, but its values must retain their original
meaning. A C4 conversation/control identifier is not automatically a Hub
`task_id` or `run_id`.

| C4 observation | What it establishes | What it does not establish |
| --- | --- | --- |
| Receive returns JSON or a queue identifier | The message intake path returned a receipt. | The agent accepted an isolated task, produced artifacts, or finished successfully. |
| Conversation changes from `pending` to `running` | The dispatcher claimed a conversation for delivery. | A dedicated model process or isolated workspace has started for that task. |
| `delivered` | A delivery/status bookkeeping value whose meaning depends on the producer and handling path. The dispatcher's path uses tmux delivery heuristics; some receive-side paths record it without dispatching the request to the model. | In all paths, business completion, successful checks, or a validated final result. In the receive-side paths, even model intake is not established. |
| Delivery retries or `failed` | Delivery confirmation did not meet the dispatcher's criteria. | The agent performed no work; automatic re-dispatch can still duplicate effects. |
| A control ACK or a keystroke ACK | A control protocol action was acknowledged. | Cancellation or successful completion of a specific platform run. |
| Instance idle/healthy | A whole-agent status condition. | A specific request has reached its correct terminal state. |

The pinned receive code distinguishes its receipt and queue handling:
[c4-receive.js, lines 225–246](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-receive.js#L225-L246)
and [lines 380–423](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-receive.js#L380-L423).
In particular, the unhealthy-agent handling path selects `delivered` for a
non-recovered message at line 382 and can return that action for `--no-reply`
at lines 407–409. This is not evidence that the model received the request.
The database transition and delivery mark are in
[c4-db.js, lines 246–275](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-db.js#L246-L275).

The dispatcher uses Enter/input-box heuristics for verification, retries strict
verification failures, and records delivery before subsequent idle waiting:
[c4-dispatcher.js, lines 389–419](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-dispatcher.js#L389-L419),
[lines 453–457](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-dispatcher.js#L453-L457),
[lines 507–531](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-dispatcher.js#L507-L531),
and [lines 702–719](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-dispatcher.js#L702-L719).
This explains why delivery status cannot safely be promoted into task status; it
does not diagnose the cause of any particular incident on the company server.

Raw keystroke controls address the global tmux session and acknowledge the
control immediately. They cannot be used as a task-scoped cancellation API.
([Dispatcher, lines 673–683](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-dispatcher.js#L673-L683);
[session configuration, lines 34–47](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-config.js#L34-L47))

Even a command called `get` is not necessarily a static inspection operation:
the control CLI's get path performs timeout maintenance. The source inspector
must not execute it.
([c4-control.js, lines 109–129](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/skills/comm-bridge/scripts/c4-control.js#L109-L129))

## Why existing Zylos execution is blocked for strict M1

The audited core does not provide the combination required by this repository's
M1 contract:

1. A run-correlated execution handle, separate from message-delivery IDs.
2. A controlled per-attempt workspace and independently selected task context.
3. A terminal result tied to that handle, including the required summary,
   artifacts and checks, with bounded output and validation.
4. A cancellation/timeout operation that terminates only that task and confirms
   cleanup without interrupting shared conversations.
5. Recovery rules that preserve unknown outcomes and prevent an old or cancelled
   run from publishing a late result or silently being dispatched again.

These are missing integration contracts, not evidence that Zylos cannot do useful
work. A serial, cooperative protocol could be engineered around its main agent,
but it would have weaker context, execution and cancellation boundaries. That is
a separate scope decision and is not silently substituted for strict M1.

The default permissions are another material distinction: this Zylos version
defaults to `--dangerously-bypass-approvals-and-sandbox`. Setting
`CODEX_BYPASS_PERMISSIONS=false` only omits that flag; it does not install the M1
worker's validated policy or reconfigure an existing conversation. Do not change
the live instance's settings as part of the static inspection.
([Codex defaults, lines 44–49](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L44-L49);
[launch flags, lines 268–294 and 321–324](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L268-L294))

## Compare the three paths honestly

| Path | What is available in this release | Boundary and next requirement |
| --- | --- | --- |
| Existing shared `/root/zylos` | Static source evidence and an unsupported-eligibility report; no claim/send path is provided. | No dispatch, no live-session attachment, no claim that a genuine Zylos task executor has been delivered. A cooperative mode requires a separate decision and implementation. |
| Independent Codex worker | The explicit Codex backend, with its own worker identity, workspace, policy checks and task-result contract. | This is not Zylos. Host/model acceptance is still required; the current exact AppArmor change and one conditional Demo retry are already approved. Do not reuse production Zylos home/authentication. |
| Future independent complete Zylos instance | A possible future engineering route, not part of this delivery. | A separate user/home/process namespace can isolate the instance, but installing another copy of 0.5.2 does not create a task lifecycle API. It still needs a documented, supported start/result/cancel/recovery contract and tests. |

`ZYLOS_DIR` selects the installation's root, but the audited adapter still uses
fixed tmux session names and home-scoped Codex monitoring. Changing that variable
alone is not sufficient evidence of complete instance isolation. A future design
must account for the runtime session, service manager, memory, channels, home and
credential ownership together.

Do not copy `/root/.codex` or other authentication into a new worker. Do not point
a new worker at the production Zylos home, change an existing bridge or Hub
connection, rotate/reset the shared conversation, send Ctrl-C, or kill its tmux
session to satisfy an M1 timeout. The current static inspection performs none of
those actions.

## Static source inspection

The delivered inspector belongs to **this repository**, not to the official
Zylos CLI. Run it with the absolute path of the installed launcher:

```text
node <release>/scripts/zylos-task-check.mjs --root /root/zylos --launcher <absolute-zylos-launcher>
```

Alternatively, supply the absolute installed package directory:

```text
node <release>/scripts/zylos-task-check.mjs --root /root/zylos --package-root <absolute-installed-package>
```

`--launcher` and `--package-root` are mutually exclusive. Replace the placeholders
with the release and installation paths; these are not commands to install or
start Zylos. `--help` prints usage and exits with code `0`.

`--launcher` supplies a filesystem path to inspect, not an executable to run.
The inspector resolves symlinks to an expected `cli/zylos.js` location, reads
package identity, and hashes its fixed 12-file source allowlist. It does not
execute an arbitrary wrapper to locate the package; if the package cannot be
resolved, that evidence remains incomplete. It must not run `zylos`, Codex,
bridge scripts, health probes, or `checkAuth()`. In particular, the official
`CodexAdapter.checkAuth()` reads the real authentication store and can issue an
HTTP request for API-key authentication; it is not an acceptable implementation
of this static check.
([Auth check, lines 145–191](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js#L145-L191))

The inspector must not read databases, runtime configuration, authentication, `.env`,
message content, transcripts, pane captures, process command lines or process
environments. A source report therefore cannot prove which runtime is active,
whether a model is authenticated, whether the live agent is idle, or whether
quota remains. Those are intentionally not prerequisites for determining that
this audited source lacks the strict task interface.

The minimum useful evidence is:

- The supplied and resolved launcher/root paths, plus whether the inspected
  objects are the expected ordinary files/directories.
- The package version and fixed source paths actually inspected.
- Their hashes, the official reference commit, and any mismatches or unreadable
  files. Unknown or modified sources remain unverified.
- The execution decision and its reason: the existing shared-session path is
  blocked before task claim and before any C4/runtime send.

Do not add live UID/cwd/tmux inspection merely to turn the source report into a
larger health check. The missing interface is sufficient to block this path.
An operator may separately record such non-content metadata if needed to resolve
a deployment question, but it cannot change the capability decision.

A successful inspection is not execution readiness. Unrecognized versions,
modified source, incomplete evidence, or unavailable files must never enable
dispatch, trigger an upgrade, repair the installation, or switch automatically to
the independent Codex backend. The chosen executor must remain explicit.

The JSON report has `format: "hxa-zylos-source-evidence-v1"` and
`scope: "static-source-only"`. Read these fields separately:

| Report field | Meaning |
| --- | --- |
| `inspection_complete` | Whether the allowlisted source files and package identity could be inspected. This is not a runtime or execution check. |
| `source_review` | `matches_reviewed_upstream`, `different_source_requires_review`, or `incomplete_source_evidence`. Only the first identifies a full match with the reviewed source snapshot. |
| `capability.ready` and `capability.claim_allowed` | Always `false`, including when source inspection is complete and every hash matches. |
| `capability.code` | `ZYLOS_M1_TASK_INTERFACE_UNSUPPORTED`. |
| `runtime_verified`, `auth_inspected`, `c4_dispatched`, `hub_contacted` | Always `false`; none of these operations is performed by the source inspector. |

Exit code **`2` is the expected blocked result**, including for a complete,
matching source report. Invalid arguments or unreadable evidence can also exit
with `2`, so inspect the report or diagnostic instead of interpreting the exit
code as proof that inspection succeeded. There is no `--execute`, `--force`,
`--accept-risk`, credential option, or capability override. The report never
grants execution readiness.

## Audited file checksums

These SHA-256 values describe the official source bytes at the pinned commit.
Matching them verifies the inspected source snapshot, not deployed runtime
behavior or authentication. The inspector's source-file allowlist and output
schema are defined by its implementation; this list is an audit reference.

```text
f10f86fa4dc2a90a61f7f5dd8fe0bacd58e047a908c52d9f663d7b45d62a534e  package.json
aead3893b809d8860140cd831194067c6151075f38c3a74cd18eba70cd9552ce  cli/zylos.js
04a3a070d8a8750d375d750fa73b291800671416e2e680099945cf78ac7e9e85  cli/lib/runtime/base.js
b51e00cbbf3fc805b07103ab1c9a4147ff265da72ffa3bec55a43e1df882f219  cli/lib/runtime/codex.js
b250bf10ede0aa41c378d9018dab8be81c16b1f9e25e60f050d81398e7de101c  cli/lib/runtime/codex-context-monitor.js
66a94d5fdf1a65e702357eca3afd29be0037ee168679be8a04f503a7fb83204c  skills/comm-bridge/scripts/c4-receive.js
79181aab729f70a841a244cb2883e2863568472ed2a6d86940c98333e2ebdc56  skills/comm-bridge/scripts/c4-dispatcher.js
a524f42479fc13c7c880434736b709da36b3e8ff0d5f9ee0838d78e7bb50f159  skills/comm-bridge/scripts/c4-db.js
4ba1bff6db41eab4cc10cc109d25cf6b331c920460e640e7232a4d89e4b1f37e  skills/comm-bridge/scripts/c4-config.js
185629286e0bfce17e82d2a1ff3433982abfe5ba82a5d77c2eb339216636bbde  skills/comm-bridge/scripts/c4-control.js
8cac7842ff062beb643b7fcfab3737bd320677db0f3ffb7bd2cf8b7c44980585  skills/comm-bridge/scripts/c4-send.js
54faef85854a67d9ed04bf932f0383f30ba8feb467e597c7d1bbf82ead3b1f8e  skills/comm-bridge/init-db.sql
```

The audit involved source inspection only. It did not send a C4 message, invoke
a runtime, test a company credential, change production files, or retry a model
task. Any future real execution must follow the separately approved deployment
and acceptance procedure.
