# M1 Isolated Zylos Core Task Runtime

Date: 2026-11-03. This is the deployment and acceptance runbook for the new
**Zylos Core Task extension**, using Codex as its bounded execution engine. Use
the complete release and exact full commit from the final delivery handoff.
Source delivery, target-host readiness, and business acceptance are separate
results; this document does not claim that deployment or the Demo has happened.

This path reuses the existing pilot service, Unix user, member Bot, model login,
and worker directories. It does not create another worker identity. The existing
company Zylos chatbot and `/root/zylos` remain untouched. Historical first-install
and patch instructions in the [Codex runbook](m1-codex-worker.md) explain shared
mechanisms; do not replay their provisioning or substitute their old 16-check
readiness for this runbook's 20 checks.

## 1. What is delivered

The release contains the complete 314-file upstream Zylos Core `v0.5.2` tree from
commit `8ee9bd9007edab46f766f3574e0ad56cf69268c2`, plus a reversible, explicitly
identified extension, `0.5.2+hxa.task.1`. Its native `CodexAdapter.runTask()` owns
isolated context, durable execution intent, correlation, and cancellation. The
existing bounded driver supplies Codex execution and the HXA adapter supplies
leases, artifact delivery, and task settlement.

This is a custom native API added to that fixed Core, **not an API claimed to
exist in official upstream 0.5.2**. The normal shared-session Zylos path still
lacks the required Task contract. Its static inspector remains separate and
does not become a Task executor merely because this extension exists.

| Component | Files / change | Operational effect |
| --- | --- | --- |
| Complete fixed Core | `vendor/zylos-core/`, retaining its MIT license and notices | A separate immutable copy; no modification of the company's installed Zylos |
| Core API integration | `cli/lib/runtime/base.js`, `codex.js`, `instruction-builder.js`, `cli/lib/config.js`, and `skills/zylos-memory/scripts/session-start-inject.js` beneath the vendor root | Explicit Task capability, execution, cancellation, task-only instruction/memory entry points, and imports without inherited `HOME` |
| Extension identity | Vendor `package.json`, `package-lock.json`, and `CHANGELOG.md` | Project-maintained version `0.5.2+hxa.task.1`; unchanged dependencies and install behavior |
| Inactive bundled maintenance code | Vendor `skills/activity-monitor/scripts/{monitor,proc-sampler}.js`, `skills/upgrade-claude/scripts/upgrade.js`, and `skills/web-console/scripts/server.js` | Direct argument-based process probes/delay and accurate HTTP-backend logging address source-package SAST findings; Task mode does not import or start these components, and no installed company service changes |
| Core Task implementation | New `cli/lib/runtime/task-runtime.js`, `task-files.js`, `task-result.js`, `skills/zylos-memory/scripts/memory-snapshot.js`, and `templates/tasks/ZYLOS.md`, `codex-addon.md` | Correlated intent/status ledger and fresh native context for each attempt |
| Reproducible source package | `patches/zylos-core-0.5.2-task-runtime.patch`, `third_party/zylos-core-upstream.json`, `scripts/zylos-runner/source-manifest.json`, and `scripts/build-zylos-task-source.mjs` | Exact upstream/extension hashes, file modes, and reversible patch verification |
| Platform entry and adapter | `scripts/zylos-worker.mjs` and `scripts/zylos-runner/{config,provenance,adapter}.mjs` | Fixed-source verification before import, explicit mode, native proof validation, and token-window gate before every claim |
| Shared bounded engine | Matching `scripts/task-runner/` and `scripts/codex-runner/` modules from the same release | Existing lease/stop/upload safeguards; strict Zylos history-read isolation; validated native instructions actually enter model stdin |
| Deployment configuration | `deploy/systemd/zylos-task-mode.conf` and `zylos-task.env.example` | Additive configuration for the existing service; the supplied mode only checks readiness |

Deploy the entire release, not just the files named in this table. The source
manifest is the exact source-tree inventory; the final handoff provides the
release identity and [validation record](m1-validation.md). No upstream global
installation, npm lifecycle script, Zylos init, PM2, C4, interactive launch, or
shared-session rotation is part of this path.

## 2. Current pilot and approved scope

These are the existing field records, to verify on the target without printing
credentials. They are not observations made by this source-authoring session.

| Item | Reuse / preserve |
| --- | --- |
| Hub | `0893c8a`, including its authenticated-download cache fix; no Hub image, database, uploads, Compose, or TLS change |
| Worker currently reported installed | `1544bd94aaee3505c8d698683042ca3cf2c31688` |
| Earlier staged source | `4c1dfb86a8120910a3a653810689d2f50ed6e6ac`; staging is not activation and this is not the final native Task-extension release |
| Existing service and user | `hxa-codex-worker.service`; Unix user/group and Hub runner label `pilot-real-worker` |
| Dedicated model configuration | Existing login; model `gpt-6.1-sol`, reasoning effort `medium`; no credential copying or new login |
| Model directories | `HOME=/var/lib/hxa-codex-worker`, `CODEX_HOME=/var/lib/hxa-codex-worker/codex` |
| State and binaries | `/data/hxa-agent-m1-worker`; root-managed Node 22 and exact Codex `0.166.0` beneath `/opt/hxa-codex-worker` |
| Hub credential | Existing member Bot's approved full-scope token, loaded from its existing file; no new runner scope or identity |
| Exact token deadline | **2026-11-04T06:38:16.417Z**; no automatic renewal, replacement, or scope extension |
| Existing Demo | Preserve the original failed task/run and its sandbox-startup evidence; retry that task once |
| Browser acceptance | Existing signed-in Mac session at `https://35.73.61.176`; no new tunnel or preview server |
| Company source and services | Preserve `/data/hxa-agent-m0-pilot`, its company-local files, production workloads, and existing Zylos processes/sessions |

The native Task source changes are authorized. The previously reviewed
**exact-helper AppArmor policy**, isolation validation, and **one retry of the
original Demo** are already approved. Do not request those approvals again. If
the policy artifact, permissions, attachment, or transitions materially change,
that changed policy needs separate review. This does not authorize disabling
AppArmor, relaxing the global user-namespace restriction, bypassing the sandbox,
or expanding the service's capabilities or writable paths.

The plan needs no new OS permissions, ports, Bot, model login, or filesystem
ranges. An actually expired/revoked token or invalid login is a specific blocker;
it is not permission to silently replace credentials. Local login status and a
reported expiry do not prove remote model access, available quota, or Hub token
validity. Existing model-provider data flows and account arrangements remain in
effect; local hosting does not imply that model input stays on the server.

## 3. Execution, evidence, and isolation

The Hub retains the authoritative task/run state and human acceptance. Each
claimed attempt enters the verified native Core API with task ID, run ID,
attempt, and a unique execution ID. Core writes exclusive durable intent before
starting the engine. Repeating the same in-process identity and payload joins
the same promise; conflicting payloads fail. A restarted process encountering
the same durable identity requires reconciliation and does not replay it.

Core creates fresh Task templates and native memory for the attempt. The driver
verifies the regular `AGENTS.md` file, its actual bytes/digest, and the correlated
context, then prepends those bytes to model stdin. No production memory is copied
or synchronized. Source provenance, native execution proof, and uploaded audit
metadata come from verified code and the controller, not from a model-authored
claim that it is Zylos.

| Local evidence | Location / purpose |
| --- | --- |
| HXA attempt journal | `state/<task_id>.<run_id>.<attempt_id>.json` under the existing state root; claim, uploads, finish, and uncertainty. The local `attempt_id` is the `attempt-<random>` directory name, not the numeric Hub `run.attempt` |
| Attempt workspace and controls | `runs/<task_id>/<run_id>/attempt-<random>/{workspace,control,logs}` |
| Native instructions | The attempt's `control/zylos/AGENTS.md` |
| Native memory | `control/zylos/memory/{identity.md,state.md,references.md,sessions/current.md}`; fresh for the attempt, without global writeback |
| Core durable ledger | `state/zylos-tasks/<SHA256 identity>/{intent.json,status.json}`; execution identity and native outcome |
| Read-only combined report | `zylos-worker.mjs --report`; HXA state plus sanitized `zylos_tasks` with format `zylos-task-ledger-report-v1` |

Correlated progress is ordered and bounded; it does not complete a task. Native
cancellation requires the exact task/run/attempt/execution identity. Late
progress or results cannot turn a stopped attempt into success. The same service
control group and bounded process-group cleanup apply; never stop the company's
shared Zylos session or kill processes by name or an old PID.

Zylos mode requires `isolateStateReads=true`. Its generated Codex permissions
profile denies sandbox commands access to other worker state, including old
task workspaces, control files, and native context. The current deeper workspace
has write access. The trusted Core/driver can read its own context and send its
validated bytes through stdin. Real model homes and the credential directory
remain denied to sandbox commands. The inherited `/tmp` baseline remains, and
`TMPDIR` is fixed inside the current workspace; this is not a claim that only
one directory on the machine is writable.

The additional history probe uses only a fresh synthetic marker outside the
workspace and a workspace symlink to that marker. Both reads must be denied.
It never reads actual task history. Other sandbox probes similarly use empty
temporary launcher homes and non-secret markers, including the existing unit's
public credential-directory canary:

```ini
SetCredential=hxa_sandbox_probe:non-secret-hxa-sandbox-canary-v1
```

This public value introduces no identity or permission. The **complete** check
still performs local login-status and token-file structure checks; only the
sandbox probes are credential-free. A trusted process under the service UID is
still inside that UID's credential boundary; the sandbox is not a new Unix user.

## 4. One deployment sequence

### 4.1 Check the release, time window, and queue

Use the exact full release SHA and archive checksum in the final handoff. Neither
the old current SHA, the staged SHA, nor a moving branch substitutes for it.
The offline source-package check is:

```bash
/opt/hxa-codex-worker/node/bin/node scripts/build-zylos-task-source.mjs --check
```

Run it from the complete staged release. Require actual JSON with
`verified: true`, `reversible_patch_verified: true`, the fixed upstream commit,
and the expected extension. It creates and removes a temporary source copy to
verify reversal; it starts no runtime and calls no model. Do not regenerate the
patch on the target to make modified source pass. The target readiness check
also enforces root-managed source ownership and trusted paths before import.

Check the target's UTC clock and the issuance record. With a 30-minute task and
the default five-minute stopping reserve, the claim must start strictly before
**2026-11-04T06:03:16.417Z**. The reserve must also cover the configured finite
finish-retry and cleanup budget; increasing that budget may move the last start
earlier. The gate runs before every claim. It does not renew or authenticate the
token, and changing the recorded expiry is not a way to extend it.

Record the original Demo task ID, failed run, current revision, assignment, and
the dedicated Bot's queue. `--once` claims at most one available assigned task;
it has no task-ID selector. Arrange that the approved task is the eligible task,
with no competing Mock, Codex, or Zylos consumer. If another task races into that
queue, do not claim that the flag alone restricts execution to the approved Demo.

### 4.2 Stop, reconcile, and preserve the existing state

Stop only `hxa-codex-worker.service` before switching source or mode. Reconcile
its current Hub runs, local journals, and actual systemd control group. Even a
graceful maintenance stop can leave a claim response uncertain, so an empty
local run list is insufficient to clear `state/worker.lock`.

Before the switch, use the installed worker's supported report. Once the new
release is staged, its combined report needs only the state directory and does
not load model authentication or call the Hub:

```bash
runuser -u pilot-real-worker -- env -i \
  HXA_CODEX_STATE_DIR=/data/hxa-agent-m1-worker \
  /opt/hxa-codex-worker/node/bin/node \
  /opt/hxa-codex-worker/current/scripts/zylos-worker.mjs --report
```

Use the new complete release path instead of `current` until the stopped-worker
switch is complete. The report verifies its fixed native source before reading
the Core ledger. It is read-only, not a repair/resume command. A native terminal
status does not establish that Hub finish or artifact delivery was confirmed.

Take the established restricted backup of the stopped state tree, including both
ledgers and artifact/upload evidence. Record the current release target, effective
unit, non-secret configuration, and the exact mode drop-in being replaced.
Preserve the existing credentials in their established locations; do not copy
authentication from production or into the release. Archive a stale lock only
after explicit Hub/journal reconciliation and confirmation that the service
control group is empty. There is no automatic lock cleanup.

### 4.3 Install the complete release and check-only mode

Stage the verified release below `/opt/hxa-codex-worker/releases/`, using its
exact full SHA as the directory name. Make it root-owned and not writable by the
worker. Preserve source modes `0644`/`0755` and the exact manifest inventory;
normalize archive extraction permissions before readiness if required. Do not
add `node_modules`, generated files, links, or local edits inside the vendor
tree. Retain the old release and switch `current` only with the worker stopped.
Do not modify the company's source checkout or use `git clean` / `git reset
--hard` there.

Keep the existing base unit, dedicated directories, and `codex-worker.env`.
Install the additive [environment template](../deploy/systemd/zylos-task.env.example)
as root-owned mode `0600` at `/etc/hxa-codex-worker/zylos-task.env`. It contains
only the recorded expiry and stopping reserve. The token remains supplied by
`LoadCredential`; the model remains `gpt-6.1-sol` / `medium`. Do not set shared
Zylos path/runtime or permissions-bypass overrides.

Use [the check-only mode template](../deploy/systemd/zylos-task-mode.conf) for
the **same recorded persistent mode override** of `hxa-codex-worker.service`.
Inspect the effective drop-ins before replacing it; do not stack competing
`ExecStart` commands or delete the whole drop-in directory. The template clears
the old Codex precheck and resident start and runs only the new Zylos check.
Preserve all other intentional configuration and restrictions:

- Existing UID, `LoadCredential`, public `SetCredential` marker, and private paths.
- `Restart=no`, `KillMode=control-group`, 40-second stop timeout and 10-second engine TERM grace.
- `NoNewPrivileges`, empty capability sets, `ProtectSystem=strict`, `ProtectHome=true`, and `PrivateTmp`.
- CPU quota 100%, memory maximum 1 GiB, no swap, and task limit 192.

Record `systemctl is-enabled hxa-codex-worker.service`; do not enable or add an
autostart for this pilot. Use a recorded mode file under the service's persistent
`/etc/systemd/system` drop-in directory. If an older `/run` mode override exists,
record and reconcile only that known file so it cannot compete with the intended
mode. A `/run` override disappears on reboot and is not the persistent default.
Run `systemctl daemon-reload` and inspect effective `ExecStartPre`, `ExecStart`,
and drop-in paths before starting. Keep the service stopped until the next step.

### 4.4 Apply the exact approved host prerequisite and require 20 checks

If still pending, load the already-approved exact-helper AppArmor artifact with
its recorded scoped rollback. Match its helper path/hash, profile names,
attachment, transitions, and child capability restriction. Offline parser
success is not kernel-enforcement evidence. If that exact artifact fails, keep
the service stopped or in check mode and report the result; do not broaden it.
The new Task extension uses the same helper path and host capabilities.

Require actual current-path help output:

```bash
/opt/hxa-codex-worker/node/bin/node /opt/hxa-codex-worker/current/scripts/zylos-worker.mjs --help
```

```text
Usage: node scripts/zylos-worker.mjs --check | --report | --zylos [--once]
```

Start the existing service in the installed check-only mode and capture **that
invocation's** readiness JSON under the real UID, credentials, resource limits,
and filesystem restrictions. Require boolean `ready: true`, model
`gpt-6.1-sol`, `codex_version_required: "0.166.0"`, executor `zylos-core-task`,
engine `codex-exec`, API `zylos-task-v1`, and all 20 distinct names with boolean
`passed: true`:

```text
zylos_pinned_task_source
zylos_explicit_task_runtime
linux_non_root_user
node_22_or_later
private_state_directory
dedicated_model_directories
hub_token_file
free_disk_budget
trusted_codex_executable
trusted_child_path
codex_0_166_0
dedicated_chatgpt_login_configured
sandbox_command_startup
sandbox_workspace_write
sandbox_outside_write_denied
sandbox_credential_reads_denied
sandbox_network_restricted
sandbox_task_history_reads_denied
sandbox_probe_cleanup
zylos_execution_window
```

Also require the expected pinned source/extension with `source.root_managed:
true`, `execution_window.window_adequate: true`, and boolean false for
`model_invoked`, `hub_contacted`, and `existing_zylos_session_accessed`. Empty or
malformed output, exit 0 alone, old logs, an incomplete list, string `"true"`, or
a failed check is not accepted. Save a sanitized record with invocation time.
No successful local check proves that the model has quota or that the Demo works.

### 4.5 Run the one approved retry and stop

Once the preceding gates pass, use the existing Task UI to deliberately retry
the original failed Demo, preserving its history. Recheck its assignment, queue,
revision, and token window. Replace the **same recorded persistent mode file**
with:

```ini
[Service]
EnvironmentFile=/etc/hxa-codex-worker/zylos-task.env
ExecStartPre=
ExecStartPre=/opt/hxa-codex-worker/node/bin/node /opt/hxa-codex-worker/current/scripts/zylos-worker.mjs --check
ExecStart=
ExecStart=/opt/hxa-codex-worker/node/bin/node /opt/hxa-codex-worker/current/scripts/zylos-worker.mjs --zylos --once
```

Reload systemd, inspect the effective commands, and start the existing service
once. It repeats readiness and checks the execution window before claiming.
The real-run path also validates the pinned Codex native effective configuration
before execution, using the same generated permissions policy. That preview
belongs to the already-authorized real path and may use the existing login to
resolve managed configuration; it is not part of the model-free local check.

Record the actual claimed task/run/attempt and native execution ID. An empty
queue can produce a clean exit without any model work. On failure or uncertain
completion, preserve evidence and stop; do not automatically retry, claim the
next task, fall back to the independent Codex worker, or switch to shared Zylos.
After the attempt ends or is stopped, leave the service stopped and restore the
**persistent check-only contents of the same mode file**, reload systemd, and
verify effective `ExecStart` is the Zylos `--check`. Leaving `--zylos --once` on
an enabled unit could claim another task after reboot. Restoring check-only mode
authorizes no extra model attempt. **Do not remove the mode drop-in**: the base
unit otherwise selects the old independent Codex resident mode.

## 5. Acceptance and remaining host evidence

The approved Demo retains `HXA_CODEX_PROFILE=feedback-demo` and its original
business requirements. It must return `index.html`, `README.md`, and the generated
`run-metadata.json` audit, with a nonempty summary. Keep the existing bounds:
30-minute task, 5 MiB per artifact, 10 MiB aggregate including metadata, at most
19 user artifacts plus one audit, and a 64 KiB final result.

| Acceptance item | Required evidence |
| --- | --- |
| Genuine native Task path | Audit format `hxa-zylos-run-v1`, executor `zylos-core-task`, backend `codex`, fixed upstream and extension identities, patch/source-manifest digests, `core_task_api_invoked: true`, and correlated execution/instruction/memory/payload digests |
| Clean execution | Actual task/run/attempt/execution identity; OS exit code/signal and complete process/pipe cleanup; matching sanitized Core ledger |
| Hub settlement | Run succeeds and task reaches `reviewing`, with the nonempty summary and authenticated artifact links; Core terminal status alone is insufficient |
| Download | Download the actual files in the existing signed-in Mac HTTPS session; preserve original filenames and verify authenticated access. HTML/Markdown remain attachment downloads, with private/no-store handling, not a hosted preview |
| Business behavior | Open the downloaded self-contained Demo locally; verify feedback creation, list/detail, filtering, status changes, and persistence after reload, as specified by the original task |
| Human acceptance | The task owner inspects the files and explicitly accepts the selected result to reach `completed`; neither exit 0 nor source provenance proves business correctness |
| Unchanged company services | Existing Zylos sessions and production workloads remain running; Hub image/database/HTTPS, identities, credentials, and company-local files remain unchanged |

The audit is uploaded before Hub finish, so its `hub_finish` value can correctly
say `not_yet_confirmed_at_upload`. Use the Hub and local settlement journal to
establish the later outcome; do not rewrite the audit to imply atomic delivery.

Offline fixtures cover identity conflicts, restart/replay refusal, strict
sandbox argument construction and negative controls, cancellation/lease loss,
timeouts, late or malformed progress/results, provenance rejection, and uncertain
claim/upload/finish handling. Exact results belong to the final
[validation record](m1-validation.md). Fixtures do not prove the actual host's
AppArmor enforcement, native helper startup, resource/cgroup behavior, remote
model access, Mac download, or business result. Those require the current 20-check
report and the one approved real attempt's evidence.

Actual host crash, cancellation, lease-loss, and forced-kill scenarios that were
not exercised must remain recorded as **not performed on the host**. This
delivery does not add negative real-model tasks or disrupt unrelated processes
to fill those rows. Any additional real-model fault-injection task is a separate
execution decision, not an implicit part of the already-approved Demo retry.

## 6. Reconciliation, retention, and rollback

An interrupted claim, upload, finish, process cleanup, or native ledger write can
require reconciliation. Keep the service stopped. Compare the combined local
report, the actual Hub run, known uploaded file IDs and unknown-upload intents,
the Core ledger, and the systemd control group. A retained lock is a guard, not
proof of a still-running process. Do not kill by a stale PID or clear the lock
just because no local task entry appears.

Keep **Core intent/status ledgers indefinitely** until an explicit retention
design preserves duplicate/replay protection. The general minimum seven-day
retention for finished workspaces/logs does not authorize pruning
`state/zylos-tasks`. Keep unresolved upload/orphan evidence for at least 30 days
and longer while unresolved. There is no automatic deletion, prune/resume CLI,
or file DELETE API in this delivery.

Rollback begins by stopping only the pilot worker and reconciling it. Preserve
the complete new state evidence before switching `current` back to a retained
compatible release. Record and restore only the known mode/configuration changes;
leave the service stopped or check-only. A code rollback is not a state rollback.
Never restore an older state snapshot over newer Hub/ledger/upload evidence
without reconciling the differences, and never overwrite model authentication
as part of a source rollback.

If the previous release cannot understand the new native ledger, keep it
stopped; do not silently activate its independent Codex execution path. No Hub
image/database/Compose/TLS rollback is needed because none changed. Keep the
approved AppArmor prerequisite separate: use its recorded scoped rollback only
after stopping the affected helper and checking other consumers. Do not unload
unrelated profiles or change global user-namespace settings.

## 7. Final handoff record

Record the exact final release SHA/checksum, source package/patch identities,
previous/new `current` targets, effective mode and unit restrictions, precise
token deadline and claim window, actual 20-check JSON, approved policy/helper
attachment evidence, task/run/attempt/execution IDs, both ledger outcomes, OS
exit/cleanup evidence, uploaded file IDs, Mac download and human acceptance
results, final stopped/check-only state, and unchanged production checks.

Keep credentials, raw model transcripts, customer content, and unredacted
configuration out of that record. Attach only the evidence actually observed;
source tests and read-only reports do not become claims of successful business
execution.

Upstream provenance: [official Zylos Core at the pinned commit](https://github.com/zylos-ai/zylos-core/tree/8ee9bd9007edab46f766f3574e0ad56cf69268c2).
The local patch and source manifests identify the custom Task extension; the
upstream link does not imply upstream endorsement of that extension.
