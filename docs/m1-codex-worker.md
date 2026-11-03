# M1 Codex Worker: Deployment, Acceptance, and Recovery

**Current selected route:** the user chose the implemented custom Zylos Core
Task runtime. Follow [its unified runbook](m1-zylos-task-runtime.md), with the new
`zylos-worker.mjs` entrypoint, exact token deadline and 20 checks. This document
describes the reusable underlying mechanisms and the earlier independent Codex
backend. Do not activate that backend as a fallback or replay its historical
installation/one-shot steps for the new Zylos route.

M1 adds one dedicated, serial Codex executor beside the existing M0 pilot. The
Hub continues to own tasks, attempts, leases, cancellation, and human acceptance.
The worker runs `codex exec` in a per-attempt workspace and uploads bounded result
files through the Hub. A successful execution enters `reviewing`; only the human
task owner or an authorized Bot administrator accepts the business result.

The first-install sections describe the original preparation; the existing-pilot
sections below record later deployment state. Record repository tests, CI, local
readiness, and real business acceptance separately. Do not turn an unperformed
check or a correctly failed task into a success claim.

**Earlier Codex operator entry point:** the
[consolidated M1 delivery](m1-consolidated-delivery.md) records that earlier complete
release and acceptance sequence. Do not deploy `73ffe0e` separately. The
previously prepared exact-helper AppArmor policy and one Demo retry after
isolation checks are now approved. Preserve the existing identities/login/model;
the current token expires at `2026-11-04T06:38:16Z` and is not renewed automatically.
This document remains the detailed mechanism and first-install reference.

## Existing pilot: sandbox readiness gap after worker `1544`

The field report now identifies Hub `0893c8a` and worker baseline `1544`. The
first real Demo correctly reached `failed` after sandbox startup failed. The old
ten checks all passed, but they did not exercise sandbox execution. Their success
is not sufficient readiness evidence. On the reported Ubuntu 24.04 / AppArmor
4.0 host, `kernel.apparmor_restrict_unprivileged_userns=1`; the exact bundled
helper also failed independently with loopback `RTM_NEWADDR EPERM`, with
`unprivileged_userns` policy in the audit evidence.

The worker update can proceed with the existing dedicated identity, ChatGPT login,
member Bot, token scope/lifetime, and `gpt-6.1-sol` / `medium` configuration.
No new login, identity, model choice, or manual user inventory is needed for this
code change. Preserve the CLI-entry fix below and stage the complete new release.
Stop/reconcile only the M1 worker before switching `current`; preserve the failed
attempt and all evidence. Hub image, data, database, and TLS remain unchanged.

Install the reviewed worker unit update containing this static, non-secret canary:

```ini
SetCredential=hxa_sandbox_probe:non-secret-hxa-sandbox-canary-v1
```

This creates a known test value alongside the unit's credential file; it changes
no login, token, token scope, or OS privilege. Keep all other service restrictions
and local overrides. First use **`--check` mode** for validation. Section 5 requires
all **16** checks from the current invocation. Then follow the consolidated
queue/window checks and the already-approved one-shot retry; do not enable
resident polling or additional retries as part of this acceptance.

The deployment assistant has prepared an exact-helper AppArmor policy from an
Ubuntu template and reports that offline parsing passed. It has **not** installed
or loaded that policy. The user has since approved that concrete exact-helper
policy and one Demo retry after isolation verification. Apply the recorded
artifact and scoped rollback in the consolidated sequence without asking again.
A materially different policy or extra retry is outside that recorded scope.

## Earlier worker update: CLI entry fix after `0893c8a`

This section applies to the current direct-SSH deployment assistant after the
Zylos handoff. The dedicated user, member Bot, approved 24-hour full-scope token,
and fresh dedicated ChatGPT login are already provisioned. Preserve the configured
`gpt-6.1-sol` / `medium` pair and the existing token scope/lifetime. Do not repeat
the initial-install approval, identity creation, or login steps below.

The `0893c8a` worker's CLI entry guard could silently exit 0 when invoked through
the `current` symlink, without running `--help`, `--check`, or the worker. Exit 0
alone therefore proves nothing. During that earlier update, the already-authorized
one-shot could finish through the release's fixed real path. It subsequently
failed; the later consolidated approval now covers one conditional retry.
Retain the entry fix and these release/override safeguards.

1. Stage the complete new verified release in a new root-owned release directory,
   including the shared `scripts/cli-entrypoint.mjs`. Do not copy only the worker
   file or edit the running `0893c8a` release in place.
2. After the current task finishes, stop only the M1 worker for the switch. Check
   its control group, local `--report`, and Hub task/run state as in section 8;
   reconcile any retained lock before restarting. An old PID or empty report
   alone is insufficient.
3. Switch `current` using the existing stop-before-switch procedure. Verify the
   new target's identity and invoke **that `current` path** with `--help` and
   `--check`. Require the actual Usage text and readiness JSON described in
   section 5, not just the process or systemd exit status.
4. Only after that validation, restore or remove the **specific recorded temporary
   mode override** that pins the old real path. Preserve every other unit/drop-in
   setting. Never let removing a mode override silently restore resident mode.
   Retain `--check` until the consolidated prerequisites pass, then use the
   already-approved `--codex --once`. Reload systemd and inspect the effective
   `ExecStart` and `ExecStartPre` before the selected operation.

This is a worker CLI patch based on `0893c8a`. It changes no model, account, token,
permission, Hub image, database, data, or TLS configuration. The initial Hub-image
update instructions below are not an additional deployment step for this patch.
Keep the existing login and all service restrictions. Never remove all drop-ins
or clean old state/releases as a shortcut.

## 1. Fixed pilot context and approval boundary

The initial pre-deployment report supplied these observations. They are historical
field-reported values, not measurements made by this document. For the already
provisioned pilot, use the patch section above instead of repeating these gates:

| Item | Reported state / M1 decision |
| --- | --- |
| Existing M0 checkout | `/data/hxa-agent-m0-pilot`, detached at `99169add` |
| Local M0 files | Nine untracked files to preserve |
| M0 Compose invocation | Three Compose files; preserve their exact paths, order, environment file, project, and volume |
| Existing browser entry | `https://35.73.61.176`; Mac access and login already work |
| Local Hub endpoint | `http://127.0.0.1:4801` |
| Host capacity | 4 CPUs; about 7.7 GiB RAM, 1.8 GiB available; no swap |
| Storage | About 29 GiB free on data storage and 18 GiB on the root filesystem |
| Codex CLI | Version `0.166.0` reported from the installed CLI/help |
| M1 source | Branch `feat/m1-codex-worker`, based on `99169add`; use an approved full release commit after publication |
| Minimum Hub for real artifact acceptance | The authenticated-file cache fix in `0893c8a` or a later verified compatible release; no database migration |
| Real M1 UI/model acceptance | Pending |

The worker is a separate host service. For an initial installation still using
the `99169add` Hub, update only the pilot Hub image to the verified M1 release
that adds private/no-store cache headers to authenticated file downloads. The
current pilot already has this fix in `0893c8a`; these worker patches need no further
Hub deployment. The cache-header change introduced no database
schema, account, permission, Compose project, volume, HTTPS site, or Zylos runtime.
The original production deployment is outside this update.
Do not run `git clean`, `git reset --hard`, an upstream installer, or a checkout
switch in the detached M0 directory. Do not discard its nine local files. If a
read-only M0 Compose inspection is necessary, use all **three** recorded `-f`
arguments; generic one-file or two-file examples elsewhere are not this host's
deployment command. Record the three filenames before operating on M0.

For a new installation only, the operator records approval for the following.
The existing pilot has already completed these steps; do not repeat them:

1. The dedicated `pilot-real-worker` Unix user/group and directories, the
   root-managed release and unit, and a brief pilot-Hub image-update window.
2. A dedicated member Bot in the pilot organization, and its **full-scope** token.
   The current Task API has no narrower runner-only scope. The runner ID is only
   a label; it does not grant or restrict permission. Do not silently reuse a
   production Bot, administrator secret, or existing Zylos identity.
3. A new Codex login under the dedicated worker account, the exact model and
   reasoning-effort pair, and a small real acceptance task with an agreed budget.

The existing M0 Bot Owner login model is retained; this milestone does not create
independent employee accounts. Follow the pilot invitation/registration flow in
[company-first-login.md](company-first-login.md) for an approved new worker Bot.
Do not reinitialize the pilot organization or database.

## 2. Runtime and credential layout

| Path | Owner / purpose |
| --- | --- |
| `/opt/hxa-codex-worker/releases/<full-SHA>` | Root-owned, immutable source release |
| `/opt/hxa-codex-worker/current` | Root-managed symlink to one reviewed release |
| `/opt/hxa-codex-worker/node/bin/node` | Root-managed Node 22 executable |
| `/opt/hxa-codex-worker/codex/bin/codex` | Root-managed Codex launcher and complete distribution, pinned to `0.166.0` |
| `/etc/hxa-codex-worker/codex-worker.env` | Root-owned `0600`, non-secret configuration |
| `/etc/hxa-codex-worker/hxa-task-token` | Root-owned `0600`, assigned pilot Bot's bearer token only |
| `/var/lib/hxa-codex-worker` | Worker-owned `0700`, dedicated `HOME` |
| `/var/lib/hxa-codex-worker/codex` | Worker-owned `0700`, dedicated `CODEX_HOME` and fresh login |
| `/data/hxa-agent-m1-worker` | Worker-owned `0700`, local lock, journals, workspaces, bounded logs, and results |

`CODEX_HOME` must be a strict child of `HXA_CODEX_HOME_DIR`. The state directory
must be separate. The token source file belongs outside both home and state.
Do not use symlinks into production directories or copy another user's Codex
authentication, configuration, model gateway credentials, or session history.

The Unix user/group and runner label are `pilot-real-worker`. The service name is
`hxa-codex-worker.service`; its directories retain the `hxa-codex-worker` name.
These are different kinds of identifiers, not additional accounts.

The service user has no sudo rights, Docker group membership, Docker socket, or
production write access. `ProtectSystem=strict` permits host writes only through
the two declared worker paths, plus systemd's private temporary storage.
`ProtectHome=true` hides the normal host home locations; the dedicated home is
under `/var/lib` and remains explicitly writable. This is a host service, not a
VM boundary: other world-readable host data may remain readable.

The unit uses `LoadCredential` so the token is not a command-line argument or
environment-variable value. systemd makes a read-only credential copy available
to the unit user. This is **not strong isolation between processes sharing that
UID**: a child with equivalent filesystem access may read it. Removing a token
from the Codex child environment alone is not a security boundary. Keep the Bot
dedicated to this pilot and use trusted, bounded tasks. The shared Codex permission
profile described in section 5.1 additionally denies sandboxed commands access
to the protected directories; that enforced command policy does not turn the
Unix UID itself into a separate identity for each process.

The same dedicated Codex home is available to Codex for its own authentication.
This M1 preflight requires the local CLI to report a **ChatGPT login**; an API-key
login is not an accepted substitute, and inherited API keys are not passed to
the child. Local login status does not prove that the account can use the selected
model or that enough quota remains.
Self-hosting this worker does not keep all task contents on the server: prompts,
selected files, and tool context can be sent to the configured model provider.
Do not submit customer secrets or production credentials in the acceptance task.
The selected login does not guarantee subscription quota, permission for shared
company use, or absence of API billing. The account owner must verify the
approved access and charging arrangement; the worker does not choose a fallback
account or silently switch to API-key billing.

## 3. Prepare and review the release

Confirm the approved M1 commit exists in the supplied repository or source bundle.
Do not assume that the development branch has already been pushed. If publication
is unavailable, request the exact reviewed source package; do not substitute
`main`, an upstream release, or a moving branch tip.

Record the full source commit, source/archive checksum, and the previous worker
release if any. Inspect the four deployment documents/assets and worker code from
that same commit. Recheck available RAM and free disk immediately before launch;
the reported 1.8 GiB of available RAM is a snapshot, not a reservation. The unit
limits this pilot to one CPU, 1 GiB RAM, no swap, and 192 tasks/threads. Avoid
concurrent builds or other new workloads during first acceptance.

Required host capabilities:

- Linux with a system systemd manager; use systemd **250 or newer** for this
  template, including `LoadCredential` and `%d` credential-path expansion.
- Working CPU, memory, swap, and task-count cgroup controls. Check the actual
  effective limits after start, not just the unit text.
- Node 22 and a separately staged, complete Codex `0.166.0` distribution at the
  exact paths above. Stage verified binaries as root; do not run a global
  latest-version installer or replace the existing Zylos/Codex installation.
- Existing outbound model connectivity for the approved login and loopback Hub
  access. No inbound worker port or extra HTTPS site is required.
- The pinned Codex build must be able to use its normal sandbox under the supplied
  unit restrictions. Do not solve a sandbox failure by running as root, adding
  capabilities, disabling the sandbox, or broadening writable host paths.

Local version checks do not invoke a model:

```bash
/opt/hxa-codex-worker/node/bin/node --version
/opt/hxa-codex-worker/codex/bin/codex --version
/opt/hxa-codex-worker/codex/bin/codex exec --help
systemctl --version
```

Record the results rather than copying the field report's version into the new
release record. The worker rejects a Codex version other than `0.166.0`.

## 4. Provision only after the recorded approval

The following are **host-operator deployment steps**, not actions performed by
preparing this repository. They require the operator's existing administrative
access; do not give administrative access to the worker.

### 4.1 Dedicated identity and directories

If `pilot-real-worker` already exists, verify its ownership and purpose before
proceeding. Do not adopt an unrelated account or change its group memberships.
Apply directory commands only to new approved paths or verified paths belonging
to this pilot. If a path already has another owner or purpose, stop and inspect
it instead of changing its ownership. For a newly approved account:

```bash
useradd --system --user-group --no-create-home \
  --home-dir /var/lib/hxa-codex-worker \
  --shell /usr/sbin/nologin pilot-real-worker

install -d -o root -g root -m 0755 \
  /opt/hxa-codex-worker /opt/hxa-codex-worker/releases
install -d -o root -g root -m 0700 /etc/hxa-codex-worker
install -d -o pilot-real-worker -g pilot-real-worker -m 0700 \
  /var/lib/hxa-codex-worker \
  /var/lib/hxa-codex-worker/codex \
  /data/hxa-agent-m1-worker
```

Stage the approved Node and Codex distributions at the paths in section 2.
Keep their files and every parent directory root-owned and not writable by the
worker. Copying executable distributions does not authorize copying model
authentication or a user's home directory.

### 4.2 Immutable source and stop-before-switch

Use a separate reviewed source checkout. The source path below must **not** be
`/data/hxa-agent-m0-pilot`. Replace both placeholders with reviewed values.

```bash
set -euo pipefail
HXA_M1_SOURCE=/path/to/reviewed/source
HXA_M1_RELEASE_SHA='<approved-full-40-character-commit>'
HXA_M1_RELEASE_DIR="/opt/hxa-codex-worker/releases/$HXA_M1_RELEASE_SHA"

[[ "$HXA_M1_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C "$HXA_M1_SOURCE" rev-parse --verify "$HXA_M1_RELEASE_SHA^{commit}"
test ! -e "$HXA_M1_RELEASE_DIR"
install -d -o root -g root -m 0755 "$HXA_M1_RELEASE_DIR"
```

Extract an archive of that exact commit into the new release directory. Run the
pipeline with failure propagation; a partial export must not become `current`:

```bash
set -euo pipefail
git -C "$HXA_M1_SOURCE" archive --format=tar "$HXA_M1_RELEASE_SHA" \
  | tar --extract --file=- --directory "$HXA_M1_RELEASE_DIR" --no-same-owner
chown -R root:root "$HXA_M1_RELEASE_DIR"
chmod -R go-w "$HXA_M1_RELEASE_DIR"
test -f "$HXA_M1_RELEASE_DIR/scripts/codex-worker.mjs"
```

Stop any existing M1 worker before switching `current`. Inspect its systemd
control group and pending journals as described in section 8. On a first install,
verify that no M1 unit/process is present. Do not switch code under a running
worker, even when the change looks small.

After that check:

```bash
ln -s "$HXA_M1_RELEASE_DIR" /opt/hxa-codex-worker/current.next
mv -T /opt/hxa-codex-worker/current.next /opt/hxa-codex-worker/current
```

If `current.next` already exists, stop and inspect it. Do not automatically clean
staging files or infer that an old release is disposable.

### 4.3 Configuration, HXA token, and model login

For a first install only, copy the non-secret configuration example:

```bash
install -o root -g root -m 0600 \
  /opt/hxa-codex-worker/current/deploy/systemd/codex-worker.env.example \
  /etc/hxa-codex-worker/codex-worker.env
```

For an upgrade, compare and edit the existing configuration instead of overwriting
it. This is a systemd `EnvironmentFile`, not a shell script. Do not `source` it,
use `export`, rely on `$VARIABLE` expansion, or add commands. Fill the two blank
required values `HXA_CODEX_MODEL` and `HXA_CODEX_REASONING_EFFORT` with the exact
approved pair. For example, `medium` is acceptable only if the selected model
supports it; it is not a model-selection recommendation.

Use the dedicated worker Bot's full-scope token from the **same pilot Hub**.
Create `/etc/hxa-codex-worker/hxa-task-token` as root-owned `0600` through the
approved local secret-entry mechanism. Its contents are the token alone, with
an optional trailing newline. Do not print the token, put it in shell history,
pass it on a command line, or place it in `codex-worker.env`. M1 accepts a token
file; it does not fall back to `HXA_TASK_TOKEN` in the environment.

The token file is outside both worker-writable directories. The standard unit
sets its effective read path with:

```ini
LoadCredential=hxa_task_token:/etc/hxa-codex-worker/hxa-task-token
Environment=HXA_TASK_TOKEN_FILE=%d/hxa_task_token
SetCredential=hxa_sandbox_probe:non-secret-hxa-sandbox-canary-v1
```

The `SetCredential` value is a public test marker, not a second authentication
credential. The sandbox probe attempts to read this marker rather than the token.

For the separately approved Codex login, run the pinned CLI as the dedicated user
with the dedicated home, using the login mode supported by that version and the
account policy. The following inspects available login options; it does not log
in:

```bash
runuser -u pilot-real-worker -- env -i \
  HOME=/var/lib/hxa-codex-worker \
  CODEX_HOME=/var/lib/hxa-codex-worker/codex \
  PATH=/opt/hxa-codex-worker/node/bin:/usr/local/bin:/usr/bin:/bin \
  /opt/hxa-codex-worker/codex/bin/codex login --help
```

The account owner then performs the approved fresh login in this context. Use
device authentication only if the pinned CLI and account support it. Do not copy
`auth.json`, cookies, API keys, or gateway configuration from root, an employee,
or the existing Zylos instances. Keep the home and its Codex directory at `0700`.
Do not share login output or authentication files in a deployment report.

### 4.4 Install the service, without enabling execution yet

```bash
install -o root -g root -m 0644 \
  /opt/hxa-codex-worker/current/deploy/systemd/hxa-codex-worker.service \
  /etc/systemd/system/hxa-codex-worker.service
systemd-analyze verify /etc/systemd/system/hxa-codex-worker.service
systemctl daemon-reload
```

Review every unknown directive, missing executable, or missing path. A unit
parser warning can mean a restriction was ignored. The template deliberately
does not enable `MemoryDenyWriteExecute`, which can break Node's JIT, or
`RestrictNamespaces`, which can interfere with Codex sandbox setup. Adding either
requires a separate compatibility test, not a production guess.

Keep `Restart=no`. Do not enable boot startup during initial acceptance. A healthy
resident worker can keep polling, but failure, restart, or an uncertain outcome
requires manual inspection; this M1 service is not a high-availability system.

#### Older-systemd compatibility

Do not silently omit `LoadCredential` on an older manager. Prefer a supported
host. If an operator explicitly approves direct file access instead, the token
remains root-owned, becomes readable only by the dedicated worker group (`0640`),
and its parent directory must allow that group's traversal (`0750`). Only that
dedicated account may be in the group. The reviewed unit must remove the
`LoadCredential` line and replace `%d` with the absolute token-file path. Keep all
other restrictions and verify the actual effective unit. This is an explicit
file-access compatibility choice, never an environment-token fallback. The same
public `hxa_sandbox_probe` marker must be provisioned beside the effective token
file, with read-only worker access; a `SetCredential` in a different directory
does not satisfy that canary check. Do not move the token to make it pass. If the
host cannot enforce the resource and filesystem restrictions, stop deployment.

### 4.5 Initial installation only: pilot Hub file-header update

The existing pilot already has this patch in Hub `0893c8a`, with authenticated
download/header checks reported complete. Skip this section for the sandbox
preflight worker patch; retain the current Hub image and its deployment record.

Code preparation and local worker preflight can proceed before this step. **Real
artifact acceptance requires the M1 Hub patch** from the same approved source
release. Authenticated `GET /api/files/:id` now returns `Cache-Control: private,
no-store` and varies on `Cookie` and `Authorization`; the old `public` year-long
cache policy is unsuitable for authenticated artifacts. Access checks, Bot
permissions, file contents/names, and database schema are unchanged by this patch.

Perform this one pilot-service replacement in an approved idle window. Keep the
worker stopped. Identify and retain the existing pilot image before starting,
and confirm that the normal consistent data backup is available. Do not touch
the production Hub or start a second process against the pilot's SQLite volume.

The following values come from the supplied pilot deployment record; verify
them on the host and retain any additional approved invocation options. Use the verified
`HXA_M1_RELEASE_SHA` and `HXA_M1_RELEASE_DIR` from section 4.2 in this Bash session;
if this is a new session, restore those non-secret values from the release record.

```bash
set -euo pipefail
HXA_M0_PROJECT=hxa-agent-m0-pilot
HXA_M0_ENV=/data/hxa-agent-m0-pilot/.env
HXA_M0_COMPOSE_1=/data/hxa-agent-m0-pilot/docker-compose.yml
HXA_M0_COMPOSE_2=/data/hxa-agent-m0-pilot/compose.pilot.yml
HXA_M0_COMPOSE_3=/data/hxa-agent-m0-pilot/compose.security.yml
HXA_M0_COMPOSE=(docker compose
  --project-directory /data/hxa-agent-m0-pilot
  --env-file "$HXA_M0_ENV" --project-name "$HXA_M0_PROJECT"
  -f "$HXA_M0_COMPOSE_1" -f "$HXA_M0_COMPOSE_2" -f "$HXA_M0_COMPOSE_3")

"${HXA_M0_COMPOSE[@]}" config --quiet
HXA_M0_CONTAINER_ID="$("${HXA_M0_COMPOSE[@]}" ps -q hxa-connect)"
test -n "$HXA_M0_CONTAINER_ID"
HXA_M0_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$HXA_M0_CONTAINER_ID")"
HXA_M0_BACKUP_IMAGE="hxa-agent-platform:m0-before-m1-$HXA_M1_RELEASE_SHA"
HXA_M1_BACKUP_DIR="/var/backups/hxa-agent-m1/$HXA_M1_RELEASE_SHA"
install -d -o root -g root -m 0700 "$HXA_M1_BACKUP_DIR"
docker image tag "$HXA_M0_IMAGE_ID" "$HXA_M0_BACKUP_IMAGE"
docker image save --output "$HXA_M1_BACKUP_DIR/hub-before-m1.tar" "$HXA_M0_BACKUP_IMAGE"
```

Record the old image ID/tag, archive location, project, volume, environment-file
path, and three Compose filenames in the private operator release record. Do not
print `.env`, inspect full container environments, or publish raw resolved Compose
configuration. Ensure storage for the image archive as well as the new build.

Build from the immutable M1 release directory, leaving the detached M0 checkout
and all its local files untouched:

```bash
HXA_M1_HUB_IMAGE="hxa-agent-platform:m1-$HXA_M1_RELEASE_SHA"
docker build --tag "$HXA_M1_HUB_IMAGE" "$HXA_M1_RELEASE_DIR"
docker image inspect --format '{{.Id}}' "$HXA_M1_HUB_IMAGE"
```

With the reported limited free RAM, use a suitable maintenance/build window or
build this exact source in the approved build environment and load its verified
image. Do not run the model worker during the build. No worker model login or
token belongs in the image build context.

The repository's base Compose file supports `HXA_CONNECT_IMAGE`, but a local
overlay may hardcode `image:`. Check the **effective** image without exposing
the rest of the resolved configuration:

```bash
HXA_CONNECT_IMAGE="$HXA_M1_HUB_IMAGE" "${HXA_M0_COMPOSE[@]}" config --format json \
  | /opt/hxa-codex-worker/node/bin/node -p \
    'JSON.parse(require("node:fs").readFileSync(0,"utf8")).services["hxa-connect"].image'
```

Proceed with the environment variable only if that output is the exact reviewed
M1 image tag. If a local overlay hardcodes another image, stop for an operator
review of an additional **image-only** override, for example
`/etc/hxa-codex-worker/hub-image.override.yml`:

```yaml
services:
  hxa-connect:
    image: "${HXA_CONNECT_IMAGE:?Set the reviewed pilot Hub image}"
```

After approval, append it as the fourth file; do not replace or reorder the
existing three:

```bash
HXA_M0_COMPOSE+=(-f /etc/hxa-codex-worker/hub-image.override.yml)
```

Repeat the image-resolution check. Review that the new file contains only this
image override. Confirm that the service's project, ports, mounts, volume, and
environment remain those of the recorded pilot. Do not assume an unverified
variable assignment overrides a hardcoded image.

With the effective image verified and the pilot idle, replace only `hxa-connect`:

```bash
HXA_CONNECT_IMAGE="$HXA_M1_HUB_IMAGE" "${HXA_M0_COMPOSE[@]}" stop hxa-connect
HXA_CONNECT_IMAGE="$HXA_M1_HUB_IMAGE" "${HXA_M0_COMPOSE[@]}" \
  up -d --no-deps --no-build --pull never --wait --wait-timeout 120 hxa-connect
curl --fail --silent --show-error http://127.0.0.1:4801/health
```

Confirm the running container's image ID matches the built/loaded image, then
record the selected tag and full invocation for future operations. A later bare
Compose invocation could select the old tag from unchanged local configuration;
always pass the recorded image selection and the reviewed fourth overlay when
one was required. Do not rebuild from the old checkout, run `down -v`, prune old
images, change a volume/project name, or restore a database for this header patch.

After a real artifact exists, inspect its fresh authenticated response in the
existing Mac browser's Network panel. Confirm `private, no-store`, `Vary` including
both `Cookie` and `Authorization`, and the expected attachment filename/type.
Use a fresh response rather than a previously cached response, and report only
these headers; do not share request cookies or Authorization headers.

## 5. Local preflight under the real unit restrictions

First verify the worker CLI entry through the actual deployed `current` path:

```bash
/opt/hxa-codex-worker/node/bin/node \
  /opt/hxa-codex-worker/current/scripts/codex-worker.mjs --help
```

The command must print the real Usage line:

```text
Usage: node scripts/codex-worker.mjs --check | --report | --codex [--once]
```

An empty stdout with exit 0 is a failed CLI-entry check, not success. Preserve the
actual output as evidence; do not substitute an expected example for it.

`node scripts/codex-worker.mjs --check` performs a local check. It may inspect the
pinned binary's `--version` and local login status, but does not claim tasks,
contact the Hub, call a model, or prove that a remote account/model has quota.
The original checks inspect local login status and token-file structure; do not
describe the **entire** check as avoiding credentials. The six new sandbox checks
below use only temporary markers and an empty launcher home, with no real
authentication or token reads. Output contains status, not authentication
material. Empty required model fields fail.

Use a temporary runtime override to run this mode under the **same** credentials,
UID, paths, resource limits, and filesystem restrictions as real execution. With
the service stopped, create
`/run/systemd/system/hxa-codex-worker.service.d/10-mode.conf` containing:

```ini
[Service]
ExecStartPre=
ExecStart=
ExecStart=/opt/hxa-codex-worker/node/bin/node /opt/hxa-codex-worker/current/scripts/codex-worker.mjs --check
```

Then run:

```bash
systemctl daemon-reload
systemctl start hxa-codex-worker.service
systemctl show hxa-codex-worker.service \
  -p Result -p ExecMainCode -p ExecMainStatus -p ControlGroup
journalctl -u hxa-codex-worker.service --since '10 minutes ago' --no-pager
```

A successful short check can leave the service `inactive`. Require exit 0 **and
the actual readiness JSON from this invocation**, not a previous journal entry
or only `Result=success`. Accept the deployed preflight only when:

- `ready` is the boolean `true`.
- `codex_version_required` is exactly `"0.166.0"`.
- `model` equals the expected pinned model (`gpt-6.1-sol` for the currently
  approved pilot).
- `checks` is a nonempty array, every entry has the boolean `passed: true`, and
  all 16 distinct required check names below are present.

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

Empty/malformed stdout or JSON, missing checks, string values such as `"true"`,
or any failed check are **not accepted**, regardless of exit status. When systemd
captures stdout, inspect the JSON emitted by the just-started check invocation;
do not reuse an older readiness record. In CI or an unconfigured environment,
missing required configuration can legitimately produce a nonzero configuration
error or failed preflight. That is not a deployment-readiness pass and must not
be replaced with fabricated success output.

Record this as **local preflight**, not real model or UI acceptance. Inspect
journals locally before sharing the actual sanitized readiness output.

### 5.1 What the model-free sandbox probe proves

The worker runs a real, bounded sandbox command without `codex exec`, a model
request, a Hub claim, or external network traffic. Its launcher uses new, empty
temporary `HOME` and `CODEX_HOME` directories and does not enable
`--include-managed-config`. The pinned CLI's sandbox call uses
`sandbox -P <generated-profile> -C <probe-workspace> -- COMMAND`; there is no `linux`
subcommand. Operators should invoke the worker's `--check`, not reconstruct this
internal command with different permissions or authentication.

The worker creates random exclusive (`wx`) test markers in the real dedicated
home and Codex-home directories, then removes them. It never opens the real
`auth.json` or Hub token for these sandbox tests. The credential-directory test
uses only the static `hxa_sandbox_probe` canary supplied by systemd. The remaining
canaries and workspace are new temporary probe files, not customer data.

| New check | Evidence required |
| --- | --- |
| `sandbox_command_startup` | The actual sandbox command starts and returns its expected probe result |
| `sandbox_workspace_write` | A write inside the probe workspace succeeds and has the expected contents |
| `sandbox_outside_write_denied` | A write to the external test canary is denied and the canary remains unchanged |
| `sandbox_credential_reads_denied` | Direct reads of the dedicated-home/Codex-home test markers and credential-directory canary, and reads through symlink aliases inside the workspace, are denied |
| `sandbox_network_restricted` | The sandbox cannot connect to the parent's temporary `127.0.0.1` witness; no external endpoint is contacted |
| `sandbox_probe_cleanup` | The probe's temporary resources and test markers are cleaned up |

The probe and real task execution share a generated Codex permission profile
named `hxa_m1_<24 random hex characters>`, chosen once per worker invocation.
Codex merges configuration tables recursively; the fresh name avoids inheriting
extra rules from an unrelated fixed-name profile. It extends `:workspace`, adds deny rules for the real dedicated home,
Codex home, and credential directory, and disables sandbox network access. It
explicitly makes the state root read-only for sandboxed commands, with a deeper
write allowance only for the current workspace. This prevents a writable parent
such as `/tmp` from also
making other worker state writable. The baseline `/tmp` and `TMPDIR` write rules
remain; `TMPDIR` is fixed to the workspace's `.tmp` directory. Do not describe
this as making the workspace the only writable location on the whole machine.

The credential directory must neither contain nor be contained by the state root
or the real model-home directories. The policy uses the most specific matching
path, so an overlapping deeper write allowance could otherwise override an
ancestor deny. These are required path checks, not a reason to broaden a deny
rule or relocate existing credentials automatically.

Real execution selects the same profile through `default_permissions`; the previous
`--sandbox` override is removed so it cannot replace that profile. This tightens
command permissions. It does not grant host privileges or change
`HXA_CODEX_PROFILE=feedback-demo`, which remains the separate artifact contract.

A pass establishes these specific canary outcomes under that invocation's UID,
unit restrictions, helper, and policy. It does not prove every possible sandbox
property, remote model access, available quota, or the business Demo. The original
ten checks alone must never be reused as proof that these six checks passed.

### 5.2 Ubuntu AppArmor prerequisite and permission approval

[Ubuntu 24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/)
explain that the default unprivileged-userns policy can permit namespace creation
while denying subsequent capabilities inside it. That is consistent with the
reported helper initialization failure; an `EPERM` by itself is not a complete
diagnosis. A correctly failed Demo must remain failed until a separately
authorized new attempt.

The [Noble-updates package file list](https://packages.ubuntu.com/noble-updates/all/apparmor-profiles/filelist)
provides `bwrap-userns-restrict` under `extra-profiles`. Having its source file does
not mean it is loaded or attached to the bundled helper. The
[Ubuntu parser manual](https://manpages.ubuntu.com/manpages/noble/man8/apparmor_parser.8.html)
distinguishes offline `--skip-kernel-load` checks from loading/replacing kernel
policy. Offline parsing is neither runtime enforcement nor approval to load.

The deployment assistant owns the profile artifact. The current pilot's exact
artifact is already approved; verify it still matches that record. For a new or
materially changed policy, make the following concrete change reviewable:

- Identify the exact root-managed bundled-helper path and binary hash, the Ubuntu
  package/template version and ABI, and the proposed policy file/hash and diff.
  Use the matching Ubuntu 24.04 template; current upstream `master` may use a
  newer ABI.
- Show unique parent and child profile names, every transition/stacking target,
  and any include changes. Check existing attachments and name collisions;
  changing only the filename is insufficient. The
  [profile syntax manual](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)
  explains names and executable attachment; parser replacement acts on names.
- Describe the new userns/capability allowance for the exact helper and retain
  the intended child `audit deny capability` restriction. This helper policy is
  not a complete least-privilege filesystem sandbox. Exact executable attachment
  does not inherently limit its effect to one Unix UID.
- State the specific profiles to add/load and their scoped rollback, preserving
  existing unrelated policy. Do not disable AppArmor or the global userns
  restriction, switch to complain/unconfined as a fallback, remove sandboxing,
  or broaden the worker's systemd capabilities or writable paths.

Installing/loading a policy changes host security permissions. The current pilot
already has approval for its exact recorded artifact, in addition to the worker
identity and login. The repository supplies no policy-installation or
privilege-expansion script. Do not modify the policy automatically when a probe
fails. After applying the approved artifact, rerun all 16 checks under the real
unit and follow the consolidated queue/window checks before the one approved
Demo retry. Preserve the prior failed attempt; there is no automatic replay.

### 5.3 Read-only local recovery inspection

For read-only local recovery inspection, stop the worker and run the following
as the dedicated user. This mode needs only the state path, so it remains useful
when a model login or HXA token needs attention:

```bash
runuser -u pilot-real-worker -- env -i \
  HXA_CODEX_STATE_DIR=/data/hxa-agent-m1-worker \
  /opt/hxa-codex-worker/node/bin/node \
  /opt/hxa-codex-worker/current/scripts/codex-worker.mjs --report
```

`--report` summarizes local state; it does not contact the Hub, repair a lock,
delete files, or resume an attempt. Retain its task/run IDs and uncertainty
information in the operator record. The lock is
`/data/hxa-agent-m1-worker/state/worker.lock`; per-attempt journals are the JSON
files alongside it. `runs/<task-id>/<run-id>/attempt-*/` contains that attempt's
separate workspace, control files, and bounded logs. Do not publish those paths
through the web server.

## 6. Bounded real execution

For the current pilot, one retry of the failed first Demo has already been
approved after isolation verification. Use the consolidated plan's queue and
token-window checks before this section. That approval does not cover a second
retry, different task, ongoing polling, or changing a Zylos instance.

Before a real execution submits its prompt, the worker uses the pinned CLI's
`app-server --strict-config --print-startup-config` preview to inspect managed
requirements and reject an incompatible permission-profile fallback. It does not
start the app server or invoke a model. This step belongs only to the authorized
real-run path: it uses the existing dedicated Codex identity and can fetch that
account's managed configuration. It is **not** part of the credential-free sandbox
probe and is not invoked by `--check`. Unreadable policy, malformed output,
unsupported version, timeout, or an incompatible required profile fails the run
before `codex exec`; no alternative profile or model is selected.

The preview has no `--ignore-user-config` equivalent, so a dedicated
`CODEX_HOME/config.toml` is unsupported for this pilot. Preflight checks presence
without reading or removing the file; if present, stop for configuration review.
Keep the existing model/effort settings in the worker's environment file. The
preview and execution are separate operations, not an atomic lock on host/cloud
policy; keep policy stable during the authorized run and validate actual results.
Company-managed restrictions must never be removed to make this check pass.

Real execution requires the explicit `--codex` switch. `--codex --once` handles
at most one task; an empty queue may exit successfully without testing the model.
`--codex` alone continues polling serially. Do not run two worker processes with
the same Bot/state directory, and do not leave the mock runner consuming the
same Bot's queue.

The first real run requires the approved login, exact model pair, task content,
spending arrangement, and the pilot Hub header patch in section 4.5. In the
stopped unit's runtime override, replace the local-check override with:

```ini
[Service]
ExecStart=
ExecStart=/opt/hxa-codex-worker/node/bin/node /opt/hxa-codex-worker/current/scripts/codex-worker.mjs --codex --once
```

This restores the base unit's local `ExecStartPre` check. For the current pilot,
deliberately retry the existing failed Demo through the Task workflow, preserving
its earlier attempt; do not create a replacement task. For a first installation
with no existing task, create only its approved task in the existing HTTPS
dashboard and assign it to the dedicated worker Bot. Verify the queue and token
window, then reload and start the unit. Confirm that the intended run was claimed;
exit code 0 by itself is not acceptance. Test the pinned model and Codex sandbox
inside this unit rather than a less restricted interactive shell.

After the current one-shot, leave the worker stopped with its bounded mode
selection retained. Resident polling requires separate explicit authorization;
it is not a continuation of this Demo approval. Only for that separately
authorized operation may an operator remove the known `10-mode.conf` file,
reload systemd, and start the base resident unit. Stop the service before each
mode/configuration change and reconcile any retained lock before restarting it.
Do not use an automatic
restart, rollback, cleanup timer, or model fallback to make a failed test pass.

### Initial bounds

| Setting | Initial value |
| --- | --- |
| `HXA_TASK_HEARTBEAT_MS` | `15000` |
| `HXA_CODEX_TASK_TIMEOUT_MS` | `1800000` (30 minutes) |
| `HXA_CODEX_TERM_GRACE_MS` | `10000` (10 seconds) |
| `HXA_CODEX_MAX_STDOUT_BYTES` | `8388608` (8 MiB) |
| `HXA_CODEX_MAX_STDERR_BYTES` | `2097152` (2 MiB) |
| `HXA_CODEX_MAX_RESULT_BYTES` | `65536` (64 KiB) |
| `HXA_CODEX_MAX_FILE_BYTES` | `5242880` (5 MiB) |
| `HXA_CODEX_MAX_ARTIFACT_BYTES` | `10485760` (10 MiB, including metadata) |
| Artifact count | At most 19 user files plus one audit file |
| `HXA_CODEX_MIN_FREE_BYTES` | `1073741824` (1 GiB) |
| `HXA_CODEX_UPLOAD_TIMEOUT_MS` | `30000` |
| systemd stop budget | `40s`, longer than TERM grace and at least 30 seconds |

The worker uses `HXA_CODEX_PROFILE=feedback-demo` for the pilot's artifact-oriented
task instructions. This profile requires `index.html` and `README.md`: a
self-contained feedback-ticket demo with local storage and usage instructions.
The controller adds `run-metadata.json`; that filename is reserved. The `files`
profile is available for a separately selected general file-producing task and
does not require those two demo filenames. The profile is not a different
authentication account or permission boundary. `HXA_CODEX_CHILD_PATH` includes the dedicated
Node directory; do not append employee home directories or an unreviewed tools
directory. Do not add API credentials or privileged tools to the child environment.

## 7. Real acceptance through the existing Mac HTTPS session

Use the user's working `https://35.73.61.176` session. No new SSH forwarding,
TLS gate, public listener, or preview host is part of M1. Artifact URLs must use
that public base, not `127.0.0.1`, an internal container name, or a local file path.

| Check | Required evidence |
| --- | --- |
| Approved real task | Exact task/run ID, selected model/effort, pinned Codex version, execution start/end, and real output; not mock output |
| Successful result | Task reaches `reviewing`, its latest run succeeds, and there are a nonempty summary, valid artifact links, and audit/OS exit metadata |
| Mac download | The task owner clicks the result links in the existing signed-in browser and downloads the actual bytes without exposing a bearer token |
| Authenticated cache policy | A fresh artifact response has `Cache-Control: private, no-store` and `Vary` including `Cookie` and `Authorization` |
| File handling | Text, HTML, and Markdown are returned as `text/plain` attachments; HTML is not hosted or executed as a Hub-origin preview |
| Queued second task | While the first task is running, a second task assigned to that Bot stays queued; it is not run concurrently |
| Human review | A person inspects downloaded contents and explicitly accepts the selected result to reach `completed`; model exit 0 is insufficient |
| UI cancellation | Cancel a designated test task in the UI; the next heartbeat/result check stops only that attempt's process group; other Zylos/Codex workloads continue |
| Service stop | `systemctl stop` terminates this unit's control group; no worker descendants remain outside the expected lifecycle |
| Lost lease / uncertain response | An isolated acceptance case stops without re-executing the model or silently claiming more work; inspect Hub state and local journal |
| Crash/restart | A leftover lock or uncertain journal prevents an automatic restart/replay; operator reconciliation is required |
| Resource enforcement | Effective UID, CPU/memory/swap/task limits, filesystem restrictions, and process exit code/signal match the release record |
| Existing deployment | Pilot health/identities/data remain intact after the recorded image-only patch; original production and existing Zylos connections are unchanged |

Cancellation is detected through the worker's lease checks, not an instantaneous
browser-to-process push. Allow the configured heartbeat/request handling and TERM
grace, then inspect the actual process group and unit. Do not use `pkill codex`,
kill unrelated processes, or cancel a shared Zylos conversation to simulate this
test. Run lease/crash exercises only on an approved pilot task and this dedicated
unit; do not interrupt the shared Hub or host network to induce an error.

Some negative cases may already have automated coverage. Record that evidence
separately; it is not proof that the actual host sandbox, login, or Mac downloads
worked. A successful local preflight does not satisfy any real-model row above.

## 8. Stop, inspect, and reconcile uncertain outcomes

`Restart=no` is intentional. Leases fence result acceptance, but they cannot make
external model/tool effects exactly once. A transport failure may happen after
the Hub has accepted a claim, upload, or result. Do not infer failure from a lost
HTTP response, and do not repeat the whole task to discover its outcome.

**A graceful maintenance stop also retains the worker lock.** A SIGTERM/stop can
race a claim that the Hub accepted even when no local run entry was recorded.
A clean one-shot run with a confirmed result, or a confirmed empty queue, may
release the lock; a stopped resident worker is not equivalent to either case.
Do not automatically clear the lock in `ExecStopPost`, on boot, or before a
restart. There is no prune/recovery CLI that resolves this uncertainty for you.

First stop the dedicated service and collect lifecycle evidence:

```bash
systemctl stop hxa-codex-worker.service
systemctl show hxa-codex-worker.service \
  -p ActiveState -p SubState -p Result -p MainPID -p ControlGroup \
  -p ExecMainCode -p ExecMainStatus
systemd-cgls --unit hxa-codex-worker.service
```

Use the unit/control-group identity and process start information. A PID in an
old journal may have been reused; never kill a process based on that PID alone.
If descendants remain, investigate this unit through systemd and the host
operator before restarting it. Do not weaken `KillMode=control-group`.

Run the local `--report` mode while the worker is stopped, then compare its
task/run IDs with the pilot UI and the stored lease/result state. Determine:

1. Whether the original child ended, including its exit code or signal.
2. Whether the Hub run is still active, expired, cancelled, failed, or already
   reviewing/completed. A timed-out local request does not settle this question.
3. Which artifact uploads have confirmed file IDs and which only have an upload
   intent because the response was lost.
4. Whether a finish was confirmed or its acceptance is still uncertain.

An empty local report does not prove that no claim reached the Hub. Inspect the
assigned pilot Bot's runs and lease state as well, including when shutdown left
no per-run journal. Keep the worker stopped until those outcomes are resolved.

Preserve the journal and lock as evidence. A stale lock must not be deleted just
because a PID is absent. Only after checking the control group, Hub state, local
effects, and file-upload records may the operator document a reconciliation and
archive the specific stale lock through an approved recovery action. Do not
rewrite a journal to claim success or use a task retry as a reconciliation tool.

There is no artifact DELETE API in this milestone. Retain known orphan file IDs
and unknown upload intents for **at least 30 days** for review. An unknown upload
may already exist in Hub storage; do not automatically repeat or delete it.
Keep completed local run workspaces/logs for **at least 7 days**, then remove only
explicitly reviewed finished runs. Uncertain, active, or unreviewed records are
not eligible. No automatic cleanup timer, broad filesystem deletion, or orphan
deletion is installed by these assets. Also budget and review the dedicated
Codex home; its authentication is not disposable run output.

Once uncertainty is resolved, a human decides whether to accept existing output,
cancel remaining work, or explicitly retry a failed task. A deliberate retry is
a new attempt and may repeat side effects; it is not an automatic recovery of the
old process.

## 9. Rollback

The safest first-release rollback is to stop the M1 worker and leave the patched
pilot Hub running.
Preserve task history, uploaded artifacts, state, and authentication for review.
If boot startup was later approved and enabled, disable this unit as part of the
rollback. Do not revert the Hub's private-cache fix or restore its database merely
to remove the new worker.

If the pilot Hub image itself fails and the operator selects an image rollback,
keep the worker stopped. Use the exact recorded Compose array with all three
original files and the fourth image-only override if it was used. Load the old
image archive with `docker image load --input "$HXA_M1_BACKUP_DIR/hub-before-m1.tar"`
if necessary, verify that the effective `hxa-connect.image` resolves
to `HXA_M0_BACKUP_IMAGE`, then run:

```bash
HXA_CONNECT_IMAGE="$HXA_M0_BACKUP_IMAGE" "${HXA_M0_COMPOSE[@]}" stop hxa-connect
HXA_CONNECT_IMAGE="$HXA_M0_BACKUP_IMAGE" "${HXA_M0_COMPOSE[@]}" \
  up -d --no-deps --no-build --pull never --wait --wait-timeout 120 hxa-connect
curl --fail --silent --show-error http://127.0.0.1:4801/health
```

This header-only patch introduces no database migration; preserve the current
database and uploads on image rollback. The old image lacks the authenticated-file
cache fix, so pause real artifact use/acceptance until a corrected M1 image is
installed. Do not automatically restart the worker or delete uploaded evidence.

For rollback to an earlier **M1** release:

1. Stop the unit; inspect its control group, journals, uploads, and Hub runs.
2. Resolve or explicitly retain every uncertain operation. Preserve the current
   release, non-secret configuration, unit configuration, and state evidence.
3. Verify the earlier worker understands the retained state format and uses the
   approved pinned CLI/model configuration. If compatibility is unknown, leave
   the service stopped rather than guessing.
4. Switch `current` to the specific prior root-owned release using the same
   stop-before-switch symlink procedure. Restore only reviewed compatible unit
   and non-secret settings; do not roll authentication or journals backward.
5. Run local preflight under the unit, then perform a separately approved one-shot
   task before returning to resident polling.

There is no automatic rollback on error, no release-directory cleanup, and no
automatic replay of unfinished work.

## 10. Release and acceptance record

| Evidence | Result to record |
| --- | --- |
| Source full commit and archive checksum | Pending release |
| Repository tests and CI | See [M1 code validation](m1-validation.md); verify remote checks against the published full SHA |
| Static unit/config review | Record validator version and any environment limitations |
| Existing M0 commit, image, three Compose files, project, volume | Field inventory; preserve |
| Pilot Hub image and authenticated-download patch | Existing pilot: retain Hub `0893c8a` and its recorded image evidence; no Hub update is required for this worker patch |
| Actual Node / Codex / systemd versions | Field report: Node 22.23.4, Codex 0.166.0, systemd 255; record actual versions when checking the new worker |
| Dedicated user/Bot/login and model approval | Already established for this pilot; retain approval and `gpt-6.1-sol` / `medium`, without credentials |
| Local `--check` under unit | New 16-check evidence pending; the earlier ten-check pass is insufficient |
| Real task, queue, cancellation, recovery, and OS exit evidence | First Demo correctly failed at sandbox startup; preserve it. One retry after isolation checks is approved and still needs field evidence |
| Mac HTTPS downloads and human acceptance | Pending |
| Original production / Zylos unchanged | Pending post-deployment comparison |
| Outstanding blocker / rollback decision | State explicitly |

Do not return tokens, cookies, login output, `auth.json`, complete environments,
or raw model/customer content. Give task/run/file IDs, source versions, exit
metadata, and a short sanitized result summary.

## References and version boundary

- [OpenAI: Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
  documents `codex exec`, structured output, and authentication in automation.
  The former URL `https://developers.openai.com/codex/noninteractive` redirects
  there. The current page may describe a newer CLI than the field-reported
  `0.166.0`; use the pinned binary's help and the actual restricted-unit test to
  establish supported flags. Do not copy newer flags or deprecated `--full-auto`
  examples into the pinned worker without verification.
- [systemd execution configuration](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
  explains `SetCredential` for non-secret literal data, credentials, filesystem restrictions, and the JIT compatibility
  constraint of `MemoryDenyWriteExecute`.
- [systemd process termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
  explains control-group termination and the TERM/KILL lifecycle.

- OpenAI's pinned [`0.166.0` sandbox CLI](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/lib.rs)
  and [sandbox dispatcher](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/debug_sandbox.rs)
  establish the direct command shape. [Managed-config loading](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/debug_sandbox/cloud_config.rs)
  explains why an explicit permission profile without `--include-managed-config`
  keeps the new probe independent of account configuration.
- The pinned [permission profile configuration](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/config/src/permissions_toml.rs)
  and [permissions resolution](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/config/mod.rs)
  define inherited profiles and the fallback that the worker refuses.
- The pinned [startup-config preview](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/startup_config.rs)
  and [configuration manager](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/config_manager.rs)
  define the runtime-only managed-policy check and its use of the existing account.

Documentation checked on 2026-11-03. Field reports establish the reported
deployment and failed attempt; they do not establish that this new worker patch,
AppArmor policy, or a successful real business Demo has been accepted.
