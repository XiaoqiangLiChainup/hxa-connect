# M1 Consolidated Delivery at `4c1dfb86` (Historical Record)

Date: 2026-11-03. This records the earlier consolidated source delivery on Draft PR #3.
Use the full commit and archive checksum in its latest release handoff; the Git
commit containing this document is the document's version, not a moving branch
name. Target-host installation and business acceptance are recorded separately.

**The user subsequently selected implementation of the missing Zylos task API.**
The current design, complete source extension, 20-check readiness and unified
deployment are in [the Zylos Task runtime runbook](m1-zylos-task-runtime.md).
The remainder of this file preserves the `4c1dfb86` assessment and Codex-only
plan as history; it is not the procedure for the selected Zylos execution route.

This was the execution plan for the **existing company pilot**. It combined
the worker changes into one release and one target-host sequence. Use it instead
of replaying the historical patch instructions or first-install provisioning in
the supporting runbooks. The detailed mechanisms remain in
[the Codex worker runbook](m1-codex-worker.md),
[the operator handoff](m1-zylos-handoff.md), and
[the validation record](m1-validation.md).

## 1. What this delivery provides

The deployable execution path is one dedicated **Codex worker** connected to the
pilot Hub's Task API. It can claim one assigned task at a time, run the pinned
Codex CLI in a bounded workspace, return validated downloadable files, and leave
business acceptance to the task owner. It has explicit cancellation, lease
handling, process cleanup, and conservative recovery for uncertain outcomes.

The company's existing **Zylos instances remain separate**. This release does not
turn a shared Zylos chat session into an isolated Task executor. The Zylos work
in this delivery is a static, read-only source inspector and an eligibility
decision that reports execution as unsupported. No claim/send path is provided;
this is not an active Hub or Codex-worker authorization gate. It does not dispatch tasks to Zylos,
send messages, start or stop its runtime, or call a model. Do not label the
dedicated Codex worker as a real Zylos executor.

The initial acceptance is the already-approved **single retry of the existing
feedback Demo**, after the approved exact-helper AppArmor change and successful
isolation checks. This document does not add further model-based fault-injection
tasks, indefinite retries, automatic credential renewal, or continuous execution
as a side effect of that one-shot acceptance.

## 2. Existing field state and authorization

The entries below come from the deployment report. Verify the current target
state without printing credentials; they are not claims that this authoring
environment performed the deployment.

| Item | Current field record / required treatment |
| --- | --- |
| Pilot Hub | `0893c8a`, with the authenticated-file cache fix; keep this Hub image, database, uploads, and HTTPS configuration unchanged |
| Worker baseline | `1544bd94aaee3505c8d698683042ca3cf2c31688`; stage the final consolidated release in a new immutable directory |
| Company source checkout | `/data/hxa-agent-m0-pilot` was originally reported detached at `99169add`, with nine company-local untracked files; verify its current HEAD and preserve the checkout and all local files |
| Dedicated Unix identity | `pilot-real-worker`; already provisioned, without sudo or Docker privileges |
| Dedicated Hub identity | Existing pilot member Bot; preserve its identity and approved full token scope |
| Dedicated model login | Existing fresh ChatGPT login in the dedicated Codex home; do not copy authentication from production or another Zylos instance |
| Model and effort | `gpt-6.1-sol` / `medium`; retain the approved explicit pair |
| Hub token expiry | **2026-11-04T06:38:16Z**; no automatic renewal, replacement, or scope extension |
| First Demo | The original task/run correctly failed during sandbox startup; retain its history and evidence |
| Host prerequisite | Reported Ubuntu 24.04 / AppArmor 4.0 user-namespace restriction; the bundled helper reproduced the loopback `RTM_NEWADDR EPERM` failure |
| AppArmor policy | The deployment assistant's previously reviewed exact-helper policy and scoped rollback are approved; apply that exact artifact, not a newly broadened policy |
| Real retry | One Demo retry is already approved after successful isolation checks; do not request that approval again |
| Browser path | Existing signed-in Mac browser at `https://35.73.61.176`; use it for result download and acceptance |
| Existing Zylos | Preserve its runtime, shared sessions, identities, working directories, and model credentials |

The approval covers the recorded policy artifact, isolation validation, and one
Demo retry. If the proposed policy's permissions, attachment, transitions, or
other substantive content changes, that change falls outside the recorded
approval and must be reviewed on its own merits. Do not disable AppArmor, relax
the global user-namespace restriction, switch off sandboxing, or expand the
worker's systemd permissions to obtain a passing result.

No identity creation, fresh login, token renewal, Hub image update, database
migration, new TLS setup, or SSH tunnel is required by this consolidated worker
delivery. An actual expired token or invalid login is a specific blocker; it is
not permission to replace credentials automatically.

## 3. Release manifest and delivery completeness

Freeze one final source identity after integration. Deploy that complete release
once; do not copy individual scripts from different commits into a running
release. The audited integration starting point was
`73ffe0ef257e528035e3da613ad2951f85374afb`; it is **not** a placeholder for the
final consolidated release SHA.

| Release evidence | Value to complete before deployment |
| --- | --- |
| Final full source SHA and source/archive location | Latest consolidated handoff on [Draft PR #3](https://github.com/XiaoqiangLiChainup/hxa-connect/pull/3); verify the exact full SHA before extraction/switching |
| Archive checksum and independently verified contents | Use the source-archive SHA-256 in that handoff, or record the checksum of the operator's exact-commit export; do not compare differently generated archive formats |
| Final local tests and build results | [M1 validation record](m1-validation.md); preserve baseline and current evidence separately |
| Remote checks for that exact SHA | CI Quality Gate/Dashboard Build and SAST Semgrep/Gitleaks; the final handoff records their actual URLs and results |
| Root-managed Node and Codex distributions | Node 22 and Codex `0.166.0`; record actual binary identities on the host |
| Token window and queue | Run `scripts/m1-window-check.mjs` immediately before the one-shot as below; separately verify the intended Bot queue. No atomic task-ID selector or token renewal has been added |
| Zylos static inspector and expected blocked result | `scripts/zylos-task-check.mjs` as in section 7; expected exit 2 with `capability.ready: false` and `claim_allowed: false` |
| Approved AppArmor artifact | Record the already-reviewed file/hash, matching helper path/hash, profile names, and scoped rollback |
| Current and replacement worker releases | Record the actual symlink targets and retained rollback release |
| Target task and token window | Record the approved Demo task ID, prior failed run ID, current revision, host UTC time, and the fixed token expiry above |

The complete release includes the worker entrypoint, shared
`scripts/cli-entrypoint.mjs`, all imported task-runner and codex-runner modules,
the matching unit and non-secret environment template, the window check and source inspector,
and the matching documents. Do not use an upstream installer or a moving
`latest` version to fill a missing part.

The pre-integration baseline had **870 passing tests and seven Redis-dependent
skips**. Current full-suite and new M1 test results are in the validation record;
remote CI must be tied to the full release SHA. No fixture or source inspection
is a claim that the existing company Zylos executed a platform task.

## 4. Completion matrix

Keep this matrix as the single completion record. A source test, a host readiness
pass, and a successful business task are different evidence. Record actual
results rather than marking an entire row complete from one of those sources.

| Capability | Code / offline evidence | Target-host evidence still required | Delivery state / owner |
| --- | --- | --- | --- |
| Complete worker release and CLI entry | Symlink/realpath entry tests and existing worker suites | Final SHA/checksum, complete files, actual `current` target, actual Usage | Final manifest: release owner; target installation: deployment assistant |
| Existing Hub and identities | Existing Task/file API and configuration checks | Hub stays `0893c8a`; established user/Bot/login/model unchanged; valid execution window | Reuse existing pilot; deployment assistant |
| Sandbox startup and boundaries | Original ten checks plus six probe checks; negative-control and lifecycle fixtures | Exact approved AppArmor attachment and fresh all-16 readiness under the real unit | Host validation pending; deployment assistant |
| Native runtime policy and model | Offline native-preview rejection tests and process-controller fixtures | Real attempt's startup-config guard, pinned CLI/model, actual command/file execution | Proven only by the approved real attempt |
| Task lifecycle | Temporary Hub claim, heartbeat, queue, finish, review, and acceptance coverage | Correct Demo task/run/attempt; no concurrent consumer; result reaches `reviewing` | One approved retry; deployment assistant and task owner |
| Artifacts and download | Bounded snapshots, uploads, authenticated hash read-back, original filenames and browser-session tests | Real files at the existing HTTPS base; Mac download and actual Demo interactions | Business acceptance pending; task owner |
| Cancellation and uncertain recovery | Fixture process cleanup, lease loss, uncertain claim/upload/finish, retained locks | Effective unit/cgroup and actual run exit/journal evidence; no automatic replay | Existing offline evidence retained; no additional real negative-model task added |
| Token expiry and intended task | Read-only reported-window check; claim/heartbeat HTTP 401 fixtures stop without replay | Correct host clock, recorded token expiry, configured time budget and reserve; operator verifies the dedicated queue | Implemented checks; deployment assistant owns the live window/queue evidence |
| Zylos eligibility and C4 evidence | Static source inspector, hard-false capability decision, strict nonterminal receipt classification | One source report from the existing instance; no C4 invocation or Task consumer is installed | Offline verified; no real Zylos executor is activated |
| Existing Zylos Task execution | Official `v0.5.2` source assessment identifies shared-session limitations | Inspector may confirm source facts only; it cannot prove an isolated executor exists | **Blocked / not delivered as a real executor** |
| Original company workloads | Separate pilot paths, identity and service design | Existing Zylos sessions, Hub health, company-local files, and unrelated processes remain unchanged | Record before/after evidence; deployment assistant |

## 5. One target-host sequence

### Step 1: verify the handoff and the bounded execution window

Use the operator's existing direct SSH access and the final release manifest.
Identify only the pilot worker's service and paths. Inspect the current Hub
health, worker status, the dedicated Bot's tasks, and the previous failed attempt.
Keep the existing company Zylos sessions running.

Compare the host's UTC clock with **2026-11-04T06:38:16Z**. The remaining token
window must cover the configured complete task budget plus stopping and final
result-confirmation time. The pilot task budget is 30 minutes by default; do not
start near expiry on the assumption that the model will finish quickly. A local
readiness pass does not authenticate the token against the Hub or establish its
remaining lifetime. The worker does not renew it.

The window check in step 6 makes that calculation explicit after the release is
staged. It does not read/authenticate a token or validate the source of the
reported expiry. Check the host clock and use the expiry from the existing
credential issuance record; do not invent a later deadline to obtain a pass.

### Step 2: reconcile and stop only the dedicated worker

Use the existing `hxa-codex-worker.service` lifecycle. If it is active, stop it
before changing its release, unit, or mode. Inspect the systemd control group,
current Hub runs, and the read-only local `--report`. A stopped or crashed worker
may retain `state/worker.lock` even when its local run list is empty: a claim
could have reached the Hub before its response arrived.

Preserve the original failed Demo and all journals. Archive only a specifically
identified stale lock after completing the documented reconciliation. Do not
clear locks automatically, kill processes by an old PID, or use `pkill codex` or
Zylos's whole-session stop operation.

### Step 3: stage one complete worker release and matching unit

Stage the final verified source below
`/opt/hxa-codex-worker/releases/<full-SHA>` as a root-managed immutable release.
Retain the prior release. Use the existing stop-before-switch procedure to update
`/opt/hxa-codex-worker/current`; preserve the existing model settings, login,
state, and token file. Do not run `git clean`, `git reset --hard`, or an installer
inside `/data/hxa-agent-m0-pilot`.

Update the matching worker unit while preserving its restrictions and intentional
mode override. It includes the public test value:

```ini
SetCredential=hxa_sandbox_probe:non-secret-hxa-sandbox-canary-v1
```

This is a static canary beside the loaded credential, not a new token or an
additional host permission. Retain the dedicated UID, `LoadCredential`,
`Restart=no`, `KillMode=control-group`, no capabilities, `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome=true`, and the existing private/writable
paths. Retain CPU quota 100%, memory maximum 1 GiB, no swap, and task limit 192.
Do not broaden those settings to work around a probe failure.

Keep the unit in local-check mode until the remaining prerequisites pass. Reload
and inspect the effective `ExecStart`, `ExecStartPre`, and only the recorded mode
drop-in. Removing a temporary override must not accidentally start resident
polling. No Hub Compose action is part of this worker update. If another approved
operation needs the existing Hub's Compose invocation, it must still preserve
all three company files, their order, project, environment, and data volume.

### Step 4: apply the already-approved exact AppArmor prerequisite

Match the prepared policy artifact and helper path/hash against the existing
approval. Preserve its unique parent/child names, transitions, includes, and
child capability restriction. Check for a conflicting existing attachment before
loading. Apply the recorded artifact with its scoped rollback; this approval
does not require a second confirmation just because the code is now delivered
as one release.

Capture actual loaded policy and attachment evidence. Offline parsing alone does
not prove kernel enforcement. If the approved artifact does not solve the
prerequisite, report the specific result and preserve the worker's stopped/check
state. Do not automatically modify the policy, use an unconfined fallback, or
replace a failed result with a manually written success report.

### Step 5: obtain actual Usage and fresh 16-check readiness

Run the final worker through the `current` path using the documented check-only
unit mode, with the same UID, credential paths, resource limits, and filesystem
restrictions that will apply to real execution. Require actual Usage output:

```text
Usage: node scripts/codex-worker.mjs --check | --report | --codex [--once]
```

The current invocation must emit valid readiness JSON with boolean `ready: true`,
`codex_version_required: "0.166.0"`, model `gpt-6.1-sol`, and all of these checks
present with boolean `passed: true`:

```text
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
sandbox_probe_cleanup
```

Empty output, exit 0 alone, old logs, ten old passing checks, malformed JSON, or
string `"true"` are insufficient. Save the sanitized actual output and invocation
time. The six sandbox checks use empty temporary launcher homes and non-secret
canaries; the complete check still performs the original local login-status and
token-file metadata checks. Neither the local checks nor the sandbox probe calls
a model or claims a task.

Probe and execution use the same generated `hxa_m1_<24 random hex characters>`
profile within each worker invocation. It denies sandboxed command access to
the real model homes and credential directory, makes other worker state read-only,
and allows the deeper current workspace. The inherited `/tmp` and `TMPDIR`
baseline remains; `TMPDIR` is fixed inside the workspace. The probe checks direct
and workspace-symlink reads of protected markers, an external canary write,
workspace writes, a temporary local loopback witness, and cleanup. This is
specific observed isolation evidence, not proof of every possible security
property or remote model availability.

### Step 6: identify the one approved Demo and run it once

Record the approved Demo's task ID, prior failed run ID, current revision,
assignment, and unchanged business requirements. Perform the deliberate retry
through the existing Task workflow only after the preceding checks pass. Keep
the original failure in history; do not create a replacement task that hides it.

The existing claim endpoint selects the oldest queued task for the authenticated
Bot; `--once` by itself means at most one claim, not selection of a task ID.
Confirm that the approved Demo is the task the dedicated Bot will receive and
that no other worker or Mock runner consumes this Bot's queue. A different
`runner_id` using the same Bot is not independent queue isolation. Do not
automatically cancel, reassign, or reorder unrelated work. If the intended task
cannot be selected safely, leave execution stopped and report the queue conflict.

With `HXA_M1_RELEASE_DIR` set to the verified new release directory, run the
following immediately before the one-shot. The task budget must equal the actual
`HXA_CODEX_TASK_TIMEOUT_MS` in the retained environment file; the shown value is
the unchanged 30-minute pilot default. Five minutes of stopping/finish reserve
is the minimum; increase it for a separately configured longer request/retry
budget, and recheck if deployment is delayed.

```bash
/opt/hxa-codex-worker/node/bin/node \
  "$HXA_M1_RELEASE_DIR/scripts/m1-window-check.mjs" \
  --expires-at 2026-11-04T06:38:16Z \
  --task-timeout-ms 1800000 --reserve-ms 300000
```

Require actual JSON with `window_adequate: true` and the expected expiry/budget,
plus exit 0. Expired or insufficient windows return exit 2. This is a read-only
time-window calculation, not a credential verifier or an atomic queue selector;
`token_auth_verified` and `task_selected` deliberately remain false. A revoked
token can still be refused by the Hub; existing claim/heartbeat handling stops
without automatic renewal or model replay. Do not proceed if the window is
insufficient, and do not print token contents to inspect expiry.

Switch only the recorded mode override to the documented `--codex --once`
invocation and start the dedicated service. This one retry is already approved;
do not ask the user to authorize the same action again. Do not enable indefinite
polling or configure automatic retries as part of this step.

Before `codex exec` submits its prompt, the worker's native startup-config preview
checks for incompatible managed permission-profile requirements. This real-run
step may use the existing Codex identity to fetch managed configuration. It is
not part of the local check and does not itself invoke a model. An existing
dedicated `CODEX_HOME/config.toml`, malformed/unreadable policy, timeout, or
incompatible requirement stops execution before inference. Do not remove company
policy or change login/model to make it pass. The preview and exec are separate
snapshots; keep configuration stable during the attempt.

Confirm the actual claimed task/run/attempt. An empty queue with exit 0 is not
business acceptance. If this attempt fails or becomes uncertain, stop and report
the evidence; the approval does not authorize an automatic second retry.

## 6. Demo result and human acceptance

Use the existing task's approved description as the business acceptance source.
The `feedback-demo` artifact contract requires `index.html` and `README.md`;
the controller adds `run-metadata.json`. User files are limited to 19 plus one
controller artifact, 5 MiB per file and 10 MiB total including metadata. HTML,
Markdown, and text are authenticated plain-text attachments, not a Hub-hosted
preview application.

| Acceptance check | Evidence to record |
| --- | --- |
| Correct execution | Approved task ID and a new attempt/run, Codex `0.166.0`, `gpt-6.1-sol` / `medium`, actual start/end and OS exit metadata |
| Hub result | Run succeeds and task reaches `reviewing`; nonempty summary and actual artifact links are present |
| Files | Downloadable `index.html`, `README.md`, and controller `run-metadata.json`; actual names and bytes, not logs describing intended files |
| Browser session | The task owner downloads through the already-working Mac HTTPS session without putting a bearer token in a URL |
| Response behavior | Fresh responses retain `private, no-store`, `Vary` including Cookie and Authorization, expected filenames, and attachment handling |
| Feedback interactions | Open the downloaded Demo as its README directs; create a record, find it in the list, inspect its details, update its status, and verify filtering |
| Persistence | Reload the same local Demo context and verify the test record/status persists as the approved requirements specify |
| Business review | Record the observed result for each approved requirement; structural validation or a model-authored check does not substitute for this |
| Final acceptance | The task owner explicitly accepts the selected result, producing `completed` |
| Operational result | One-shot process ended; control group and local journal agree with the Hub; original Zylos and company workloads remain intact |

Record failures honestly and leave the result unaccepted when the business checks
do not pass. Do not introduce a new TLS path, preview service, or tunnel to change
the acceptance scenario. The file validator checks structure, bounds, and declared
formats; it does not establish that the JavaScript interactions work.

The audit artifact intentionally says
`hub_finish: "not_yet_confirmed_at_upload"`: it was uploaded before the final Hub
finish request and is not subsequently rewritten. Determine final completion
from the Hub task/run and the local `finish_confirmed` journal, rather than
treating that upload-time field as a current failure or final confirmation.

Existing offline tests cover queueing, cancellation, lease loss, uncertain
uploads/finish, and process cleanup. Preserve that evidence separately. This
delivery does not add extra real model tasks merely to repeat those negative
tests. A host behavior that was not exercised must remain recorded as untested.

## 7. Existing Zylos: inspect, report the gap, do not claim execution

The reviewed official Zylos Core `v0.5.2` source is pinned to
`8ee9bd9007edab46f766f3574e0ad56cf69268c2`. Its
[Codex runtime implementation](https://github.com/zylos-ai/zylos-core/blob/8ee9bd9007edab46f766f3574e0ad56cf69268c2/cli/lib/runtime/codex.js)
uses the fixed `codex-main` tmux session. `sendMessage()` injects text and returns
without a correlated task result; `stop()` kills the whole runtime session;
launch uses the common Zylos working directory. Its default launch path can also
enable the Codex approval/sandbox bypass. These are source observations about
that version, not proof that every company installation has identical settings.

Those interfaces do not provide the per-Task workspace, correlated completion,
and narrowly targeted cancellation required for this M1 execution contract.
A successful message send, online HXA connection, or an isolated Codex pilot
result cannot fill that gap. A separate Zylos installation would still need a
real Task adapter; installing another copy does not create that interface.

Collect the source evidence once, through the deployment assistant's existing
authorized SSH connection. The Bash `type -P` lookup resolves an installed file;
it does not run the Zylos CLI. `HXA_M1_RELEASE_DIR` is the verified new release,
which may be inspected before switching the worker's `current` symlink.

```bash
HXA_ZYLOS_LAUNCHER="$(type -P zylos)"
test -n "$HXA_ZYLOS_LAUNCHER"
/opt/hxa-codex-worker/node/bin/node \
  "$HXA_M1_RELEASE_DIR/scripts/zylos-task-check.mjs" \
  --root /root/zylos --launcher "$HXA_ZYLOS_LAUNCHER"
```

Expected exit **2** means task execution remains blocked; inspect the JSON to
distinguish complete source evidence from argument/file errors. If the launcher
is a wrapper with an unrecognized target, the tool does not execute it. Supply
the known installed package directory with `--package-root` instead of
`--launcher`; do not guess a new runtime or run an installer.

Return `format`, `scope`, `package`, `source_review`, `inspection_complete`,
the fixed `files` metadata/hashes, and `capability`. The scope is
`static-source-only`; `runtime_verified`, `auth_inspected`, `c4_dispatched` and
`hub_contacted` stay false. This single source report is the only additional
Zylos evidence requested by this release. Do not read its config, database,
messages, process environment, authentication or live pane output.

An unknown version is unknown; an exact match still lacks the task contract.
`capability.ready` and `claim_allowed` always remain false, with code
`ZYLOS_M1_TASK_INTERFACE_UNSUPPORTED`. This is an eligibility decision, not a
new Hub authorization endpoint: no Zylos task consumer/dispatch path is shipped
or registered. Do not manually start a generic worker against a Zylos Bot to
bypass this missing interface, or silently substitute Codex for Zylos.

Keep two separate conclusions in the handoff:

- Dedicated Codex pilot: deployable after its host checks; business status is
  whatever the one approved Demo actually demonstrates.
- Existing Zylos Task executor: not delivered; source inspection and refusal of
  unsupported execution are the delivered capabilities in this release.

## 8. Stop, reconcile, and roll back

If a prerequisite, token window, guard, model attempt, or artifact operation
fails, retain the specific error and keep the dedicated worker stopped as
appropriate. Do not retry a claim, model request, or upload merely to discover
whether an earlier operation succeeded.

Use the existing read-only `--report` and systemd control-group inspection in the
runbook. Compare task/run IDs and lease state with the Hub, record confirmed file
IDs and unresolved upload intents, and confirm process cleanup. An empty local
report or absent old PID does not prove that the Hub received no claim. A graceful
maintenance stop can also retain the lock. No automatic lock removal, pruning,
upload replay, or recovery timer is part of this release.

The default rollback is to stop the new worker and leave Hub `0893c8a` and all
company Zylos workloads unchanged. Preserve the release, state, logs, files,
authentication, and the original failed and retried attempts. If returning to a
prior worker release, first establish state/configuration compatibility; switch
`current` only while stopped and restore only the recorded compatible unit/mode
settings. A code rollback does not authorize rerunning the model.

If the approved AppArmor profile itself needs rollback, use its recorded scoped
rollback after the worker is stopped and reconciled. Preserve unrelated policies
and the global user-namespace restriction. Do not disable AppArmor or replace an
unrelated profile as part of rollback. Never restore the Hub database or old
credentials to undo this worker release.

Retain unknown uploads and possible orphan-file evidence for at least 30 days.
Retain completed local runs for at least seven days before manual review for
removal; active, uncertain, or unreviewed runs are ineligible. There is no artifact
DELETE API or automatic cleanup in this milestone.

## 9. Final handoff record

Return one concise record that completes the matrix and includes:

1. Final source SHA/checksum, actual remote CI state, and final offline results.
2. Unchanged Hub identity and the old/new worker release targets.
3. Existing identity/model reuse, token expiry, and the execution-window check,
   without any secret value.
4. Exact approved AppArmor artifact/attachment evidence and actual 16-check JSON.
5. Actual window-check output, operator queue check, and the static Zylos report,
   including its blocked executor status.
6. Original failed task/run, the one retry's task/run/attempt, final Hub status,
   exit metadata, files, and local recovery status.
7. Mac download and business acceptance observations, including anything not yet
   demonstrated.
8. Final service mode, remaining blockers, rollback state, and confirmation that
   existing company Zylos workloads were preserved.

Do not return tokens, cookies, `auth.json`, full environment dumps, or raw customer
logs. Do not mark the pilot complete solely because code was published, checks
passed, or a task left the queue. Code delivery, host readiness, and accepted
business output must each have their own evidence.
