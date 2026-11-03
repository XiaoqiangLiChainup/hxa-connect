# M1 Handoff to the Company-Side Zylos / Host Operator

Use the company's existing authorized channel. This is a deployment handoff for
one dedicated Codex task worker, not a request to change Zylos itself. Follow
[m1-codex-worker.md](m1-codex-worker.md) and the matching source commit.

## Current direct-SSH patch: CLI entry after `0893c8a`

Zylos has handed off to the direct-SSH deployment assistant. The dedicated user,
member Bot, approved 24-hour full-scope token, and fresh ChatGPT login are already
provisioned; `gpt-6.1-sol` / `medium` is configured. Reuse those approvals and
settings. Do not recreate identities, log in again, extend token scope/lifetime,
or repeat initial-install gates for this worker-only patch.

The `0893c8a` CLI guard can return silent exit 0 through the `current` symlink.
The already-authorized one-shot using its fixed real path can continue: do not
interrupt the running task to apply this fix. After it finishes, stage the
**whole new verified release**, including `scripts/cli-entrypoint.mjs`; stop and
reconcile only the M1 worker before switching `current`.

Require the new `current` path's actual `--help` Usage and actual `--check`
readiness JSON. The JSON must have boolean `ready: true`,
`codex_version_required: "0.166.0"`, the expected model `gpt-6.1-sol`, and a
nonempty `checks` array with all ten names in runbook section 5 present and all
entries boolean `passed: true`. Empty/malformed output, missing checks, an old
journal record, or exit 0 alone is not accepted. Missing configuration may
legitimately fail a model-free CI check; it does not establish host readiness.

After validating the new symlink path, restore/remove only the recorded temporary
mode override that pins the old real path. Preserve other drop-ins and the
authorized `--codex --once` mode; do not accidentally enable resident polling by
removing its mode selection. Reload and inspect the effective unit before
continuing acceptance. No model, identity, permission, Hub image, data, database,
or TLS change is needed for this entry fix. The remaining sections describe the
original installation and acceptance context, not additional reprovisioning.

## Requested outcome

An approved pilot Bot can receive a task through the existing M0 dashboard, have
the new host worker execute it with the explicitly approved Codex model, return
real downloadable files, and wait for human acceptance. The first target is one
serial worker using the `feedback-demo` profile. No preview site is deployed.

The prepared branch is `feat/m1-codex-worker`, based on `99169add`. Obtain the
approved **full release commit** after it has actually been published, or use the
matching reviewed source bundle. Do not assume the branch is already available
and do not substitute `main` or an upstream installer. Record the source/archive
identity before proceeding.

## Preserve the known deployment

- The M0 checkout is `/data/hxa-agent-m0-pilot`, detached at `99169add`, with nine
  untracked local files. Leave it in place. Do not clean, reset, switch, or install
  M1 source there.
- The deployed Hub is still the reported M0 version until an approved image
  update. Real artifact acceptance requires the same M1 release's authenticated
  download cache-header patch. This is an image-only pilot update with no
  database migration or identity/permission change.
- Every M0 Compose invocation must retain its **three** existing Compose files,
  their order, the environment file, project name, and data volume. Record the
  actual filenames; do not reconstruct a command from generic M0 examples.
- The existing Mac browser can reach and log in to `https://35.73.61.176`. Use
  this same session for result downloads. Do not add a new SSH tunnel, public
  port, TLS change, or proxy deployment for M1.
- Keep existing Zylos processes, production HXA, identities, model logins,
  runtime choices, and conversation sessions unchanged. Do not copy their
  credentials or repoint their Hub URLs.

The reported host has 4 CPUs, 7.7 GiB RAM with about 1.8 GiB available, no swap,
about 29 GiB free on data storage, and 18 GiB on root. Recheck capacity before
launch. The M1 unit is bounded to one CPU, 1 GiB RAM, zero swap, and 192 tasks.
Keep large builds and other new workloads out of the first acceptance window.

## Work to prepare before applying host changes

1. Verify the approved release and review the worker, systemd unit, and environment
   example. Report missing source publication or an unexpected version.
2. Identify the target systemd version and effective cgroup support. The supplied
   credential template targets systemd 250+. Verify Node 22 and the complete,
   root-managed Codex distribution pinned to `0.166.0`; the field report alone
   does not verify the new installation.
3. Prepare the exact paths/configuration in the runbook. Keep the model and
   reasoning-effort pair explicit; do not select one or widen privileges to make
   a check succeed.
4. Record approval for the `pilot-real-worker` Unix user/group and directories,
   the pilot member Bot and its current required full-scope token, a fresh
   dedicated Codex login, the pilot Hub image update, and a bounded real task.
   This handoff does not assert those identities or approvals already exist.

Only after those choices are approved, use the host operator's existing access
to provision the runbook's isolated layout. The worker itself gets no sudo,
Docker access, administrative Bot role, or production credential.

## Deployment sequence

1. Stage root-owned source under `/opt/hxa-codex-worker/releases/<full-SHA>` and
   the Node/Codex distributions at the documented absolute paths. Preserve older
   releases and switch `current` only while the worker is stopped.
2. Follow runbook section 4.5 to build the pilot Hub image from that same immutable
   source, back up the old image, and select the new image through the exact
   existing three Compose files. Use `HXA_CONNECT_IMAGE` only after checking the
   effective image without printing secret configuration. A hardcoded company
   image requires an explicitly reviewed fourth image-only override. Preserve
   the detached M0 checkout and all nine local files. Do not run a database
   migration, change permissions, or update the production Hub.
3. Create the dedicated `0700` home, its separate Codex login directory, and
   `/data/hxa-agent-m1-worker`. Use the assigned pilot Bot's token in a root-owned
   file outside both home and state. Prefer systemd `LoadCredential`; never put
   the token value in the environment or command line.
4. Let the account owner perform a fresh ChatGPT login under the dedicated identity.
   Do not copy `auth.json` or other model credentials. Confirm that the selected
   account/model/automation arrangement is approved; do not promise that every
   run will consume a ChatGPT subscription instead of billable API usage.
5. Install and validate the unit. Keep `Restart=no`, `KillMode=control-group`,
   `NoNewPrivileges`, the resource limits, and the writable-path restrictions.
   Run the local `--check` through the runbook's temporary unit override. This
   uses no model and proves no remote quota or task completion.
6. After explicit approval of the first real task, switch the stopped unit to
   `--codex --once`. Submit the task in the existing UI, assign the dedicated
   Bot, and start this one-shot unit. Verify a real task/run and its output;
   an empty queue with exit code 0 is not acceptance.
7. Complete the acceptance checks below, including download from the user's
   actual Mac session. Only then remove the one-shot override and start resident
   `--codex` polling if the operator selected continuous operation.

Stop on a missing login, rejected model, incompatible sandbox, disk shortage,
unknown state, or unexpected privilege requirement. Return the specific blocker.
Do not run the service as root, grant capabilities, disable its sandbox, change
production permissions, or install another model/credential as a workaround.

## Acceptance to return

| Check | Result / evidence |
| --- | --- |
| Full release commit and checksum | |
| Pilot Hub old/new image IDs, old-image archive, effective image selection | |
| Node 22, Codex `0.166.0`, systemd, effective UID and limits | |
| Actual `current`-path `--help` Usage and readiness JSON; all ten checks pass | |
| Approved model and reasoning effort | |
| Real task/run ID, OS exit code/signal, `reviewing` result | |
| Actual summary, `index.html`, `README.md`, and `run-metadata.json` | |
| Result links downloaded from the existing Mac HTTPS login | |
| Fresh authenticated response: `private, no-store`; `Vary` includes Cookie and Authorization | |
| HTML/Markdown/text served as plain-text attachments, with no Hub-origin preview | |
| Second task stays queued while the first executes | |
| UI cancellation stops only the designated attempt's process group | |
| Lease loss / crash / uncertain completion stops without automatic model replay | |
| Human review and explicit task acceptance | |
| Pilot health/data/identities intact; original production and Zylos unchanged | |
| Exact remaining blocker or rollback decision | |

Repository tests and CI results belong to the exact release record. Do not invent
counts or treat fake/model-free tests as evidence that the real business demo,
account login, sandbox, or Mac download has passed.

## Failure and rollback instruction

Stop the dedicated systemd unit and inspect its control group before changing
code, configuration, or a lock. Use `--report` for read-only local state inspection
and reconcile task/run IDs with the pilot UI. A stored PID alone is not enough
to identify a process. Do not kill all Codex/Zylos processes or automatically
delete a lock after a crash.

A graceful SIGTERM/maintenance stop also retains the lock: a claim may have
reached the Hub without a local journal entry. An empty `--report` is not proof
that no work was claimed. Inspect the Hub's assigned-Bot runs and leases, local
evidence, and the now-empty unit control group before an operator explicitly
archives/removes the specific stale lock. There is no automatic prune or replay.

Preserve confirmed upload file IDs and unknown upload intents. There is no file
DELETE API. Keep orphan/unknown-upload evidence for at least 30 days and completed
local runs for at least 7 days, then review explicitly before any cleanup. Never
delete or re-execute uncertain work automatically.

For this first M1 release, rollback normally means stopping the worker while
leaving the patched pilot Hub running. If the Hub image itself must roll back,
use the backed-up image through the same recorded three/four Compose files,
preserve database/uploads, and pause real artifact use until the private-cache
fix is restored. A rollback to an older worker release also requires stopped
processes, compatible retained state, a reviewed symlink/configuration change,
and local preflight. Do not restore old authentication or journal state, revert
the Hub database, or remove uploaded artifacts to simulate rollback.

Return only sanitized operational evidence. Do not include bearer tokens,
cookies, account login output, authentication files, complete environments, or
raw customer/model transcripts.
