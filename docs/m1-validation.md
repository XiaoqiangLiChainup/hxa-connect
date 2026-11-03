# M1 Code Validation and Field Acceptance Boundary

Date: 2026-11-03. Development branch: `feat/m1-codex-worker`.
Base: `99169add7925f843e99eaa285603f792b05a67ef`.

This record covers the committed worker implementation and offline verification.
The exact release identity is the Git commit published with the draft PR. It is
not a record of a company-server deployment or a real model/business acceptance.

## Local validation

| Gate | Result |
| --- | --- |
| Runtime | Node 22.23.4 |
| Complete Vitest suite | 1114 passed, 7 Redis-dependent tests skipped, 0 failed; 1121 total in 41 files |
| M1 suites | 498 passing cases: the earlier 358 Codex/sandbox/static-capability/window cases plus 140 cases for the implemented native Zylos Task extension |
| Sandbox-gap follow-up | 119 additional passing cases compared with worker baseline `1544bd94aaee3505c8d698683042ca3cf2c31688`; preserves all earlier suites |
| Earlier consolidation | Historical `4c1dfb86` added 104 passing cases compared with `73ffe0ef257e528035e3da613ad2951f85374afb`; that earlier release had no active Zylos executor |
| Native Task-extension follow-up | 140 additional passing cases in 7 files compared with `4c1dfb86`; actual patched Core, bounded process controller, and temporary authenticated Hub, with no model calls |
| Source package | 320 effective files verified; reversing the shipped patch exactly restores all 314 pinned upstream files and their modes; MIT notices retained |
| Additional existing-suite regressions | 3 passing cases for finish confirmation and authenticated file downloads |
| Server TypeScript build | Passed |
| Next.js production build and static export | Passed for baseline `0893c8a`; dashboard unchanged by this worker patch; inspect the new head's Dashboard Build CI |
| Unit syntax | systemd 255 accepts a temporary copy of the existing base unit with the Zylos mode drop-in, with target Exec commands replaced by `/usr/bin/true`; no service installed or started here |
| Documentation checks | 33 Bash blocks pass `bash -n`; 52 local relative links resolve across README and six M1 documents; exact 20-check inventory and authored-source whitespace checked; target-host commands were not executed |

Commands used with the Node 22 executable on PATH:

```bash
npm test
npm run build
npm run check:zylos-source
```

The unchanged dashboard build is checked by the new head's Dashboard Build CI;
the baseline local static-export result is not a new local build claim.
The whitespace check excludes the byte-preserved upstream tree and the unified
patch file: the former retains two upstream blank-at-EOF cases, and the latter
contains required blank context lines. Source-package verification checks their
exact bytes and reversible reconstruction instead.

The complete focused model-free suite is available as `npm run test:m1`;
`npm run test:codex` retains the original Codex-only scope.
No model credentials or model service are needed for it. Temporary Hub databases,
Bot identities, files, and subprocesses belong only to test fixtures and are
cleaned up by the tests; they are not production or M1 deployment identities.

## Implemented Zylos Task extension after `4c1dfb86`

The user selected engineering the missing native Task API. The current release
ships complete fixed Zylos Core source with the project-maintained version
`0.5.2+hxa.task.1`, a reversible patch, and a real HXA executor calling
`CodexAdapter.runTask()`. This is an explicit extension of upstream
`8ee9bd9007edab46f766f3574e0ad56cf69268c2`; it is not an interface claimed to exist
in the unmodified upstream release or in the company's existing shared session.

The Core builds isolated native memory and instructions, writes durable intent,
owns task/run/attempt/execution correlation, and validates the bounded driver's
proof. The HXA adapter verifies the fixed source before import, supplies the
existing process/sandbox engine, and owns Hub lease and artifact settlement.
Tests inspect the actual native instruction bytes received on child stdin; a
label or C4 transport receipt cannot substitute for this execution path.

| New suite | Passed | Scope |
| --- | ---: | --- |
| `zylos-core-task.test.ts` | 34 | Actual patched Core; private native memory/context, durable intent, duplicate/conflicting submission, scoped cancellation, deadline, late/corrupt callbacks, proof and cleanup, restart refusal |
| `zylos-process.test.ts` | 20 | Actual bounded process controller and native instruction/proof plumbing; local Node fixtures replace Codex; nonzero exit, bad result, timeout, TERM/KILL, unrelated-process preservation |
| `zylos-worker.test.ts` | 12 | Temporary authenticated SQLite Hub through actual Core, process fixtures, artifact upload/download and human acceptance; cancel, lease expiry, heartbeat 401, uncertain upload/finish and durable replay refusal |
| `zylos-sandbox.test.ts` | 14 | Strict state-read denial, current workspace exception, direct/alias history canary, failure and cleanup boundaries; ordinary Node negative control, not a real bwrap pass |
| `zylos-provenance.test.ts` | 19 | Complete source/patch reversal, ten corruption variants rejected, file/path trust, read-only sanitized ledger, real subprocess report with no `HOME` |
| `zylos-cli.test.ts` | 20 | Actual relative/absolute/symlink CLI help, silent import, complete failed 20-check JSON, safe configuration failure, no model/Hub invocation |
| `zylos-config.test.ts` | 21 | Explicit mode, capability validation, malformed/contradictory readiness rejection, precise expiry, stop reserve, admission guard before every claim |
| **Total** | **140** | **Offline, with no production authentication, model, C4, or SSH calls** |

The actual full run exposed and resolved two delivery defects: importing Task
code without `HOME` reached an unused interactive default, and contradictory
engine evidence could produce an omitted `ready` field. A builtins-only home
fallback now permits the read-only import, and evidence validation produces
explicit boolean failure. Both regressions remain in the passing suite.

The current Zylos readiness contract has **20** named checks: the preserved ten
baseline checks, six earlier sandbox checks, an additional history-read boundary,
two source/API checks, and an execution-window check. Incomplete, duplicate,
non-boolean, contradictory, or wrong-version engine evidence cannot yield a
full pass. Source-only and time-window checks do not authenticate credentials or
prove actual model availability.

| Capability | Implemented and verified offline | Required target-host evidence |
| --- | --- | --- |
| Genuine Zylos Task execution | Fixed actual Core API, fresh native context, correlated controller proof and source audit | One real attempt's matching Core ledger, uploaded audit, process result and Hub run |
| Claim, concurrency and lease fencing | Reused `runWorker`, concurrency 1, heartbeat/abort, before-claim window guard, no automatic replay | Effective single service/consumer and queue; real lifecycle evidence |
| Task isolation | Unique private attempt paths, no shared Zylos/C4 calls, dedicated native memory, history-read deny profile | Fresh 20-check JSON under the actual UID, AppArmor, systemd and helper |
| Cancellation, deadline and cleanup | Exact identity, bounded signal propagation, process-group drain and kill, late success rejected | Any unexercised host fault case remains explicitly pending; no extra model tests are implied |
| Idempotency and recovery | Exclusive durable intent, same-process join, changed payload rejection, restart/replay refusal, combined read-only report | Reconciliation of both ledgers, Hub outcome, upload uncertainty and cgroup before restart |
| Artifact ownership and delivery | Controller schema, regular-file/path/hash checks, upload and authenticated readback, actual temporary Hub acceptance | Mac authenticated downloads, Demo interactions and explicit human accept |
| Existing company Zylos | No calls to shared launch/stop/auth/C4, no production files or memory copied | Existing process/session and service checks remain unchanged |
| Deployment/rollback | Complete source, two additive templates, reviewed consolidated runbook and static unit checks | One exact release switch, approved exact policy, then stop and restore persistent check-only mode |

The maintained Core extension is a separate Task-mode copy, using the existing
dedicated service identity and login. It does not attach to, upgrade, or claim to
execute inside the old `/root/zylos` interactive session. Upstream's own separate
test suites under the full vendor tree are not collected by HXA Vitest; the seven
explicit HXA suites above exercise the modified runtime used by this release.

## CLI entry regression after `0893c8a`

The reported failure was reproduced with Node 22.23.4 before the fix: a real-path
`codex-worker.mjs --help` returned exit 0 and 919 stdout bytes, while the same
file through a `current` directory symlink returned exit 0 with no stdout. The
URL-string guard compared the module's resolved path to the unresolved CLI path.

All three relevant entrypoints now share a helper that respects the calling
module's native `import.meta.main` boolean. Older Node versions without that
flag use canonical filesystem paths, excluding eval/stdin and query/fragment
imports. The Docker runtime script copy includes the helper required by the
existing Mock runner and Demo; this does not require another pilot Hub deployment.

The 16 additional cases include actual credential-free Node subprocesses:

- Absolute and relative real paths, directory and file symlinks, encoded path
  characters, and a whole-release symlink with `--preserve-symlinks-main`.
- Actual Usage output from Codex, Mock runner, and Demo CLI entrypoints.
- `--check` rejects absent configuration with exit 2 and a diagnostic; with
  isolated directories and intentionally absent token/executable it emits parsed
  `ready: false` JSON with all 16 checks and exit 2. No Codex binary is invoked.
- Wrapper and eval imports remain silent apart from an explicit test marker,
  including when eval's `argv[1]` happens to name the imported script. Distinct
  query/fragment imports do not start any CLI.
- Compatibility behavior for missing paths, non-file URLs, unrelated modules,
  and native `main: false`.

The deployment runbook now requires actual Usage and this invocation's readiness
JSON, including boolean `ready: true` and all 16 passing checks. Exit 0 alone
cannot establish readiness. The dedicated user's reported real-path preflight
is separate field evidence; the patched `current` path still needs host validation.

## Sandbox readiness regression after `1544bd94`

The deployment assistant reported that the first real task reached the approved
`gpt-6.1-sol` / `medium` model, but its command/file tools failed with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. The old ten local
checks had all passed. The task and run correctly failed, produced no artifacts,
and cleaned up; no automatic replay occurred. This report is field evidence of
the failed attempt, not a successful business acceptance.

The worker now retains those ten checks and appends six model-free sandbox
checks. The decisive regression sets all ten original checks to success, supplies
the exact reported bwrap failure from an offline fixture, and requires
`ready: false` with `SANDBOX_HOST_PREREQUISITE`. Exit 0, an empty/truncated result,
wrong nonce, malformed schema, a failed boundary, or uncertain cleanup cannot
produce a full readiness pass.

The exact Codex `0.166.0` npm distribution was integrity-checked against its
registry metadata. Its `--help` output and the pinned official `rust-v0.166.0`
source were inspected without a model request. The adapter uses the direct
`sandbox --permission-profile ... --cd ... -- COMMAND` interface, not a `linux`
subcommand. The [runbook's pinned references](m1-codex-worker.md#references-and-version-boundary)
record the relevant interfaces and policy resolution. An isolated credential-free
binary sandbox attempt in this development environment timed out and was stopped;
no successful real bwrap boundary check is claimed here.

The new offline cases establish that:

- The probe's launcher receives empty temporary homes and an explicit environment.
  Protected-directory checks read only synthetic canaries, including a public
  systemd marker beside the token. Open-file spies reject reads of fixture auth
  and token files. A dedicated user config is inspected only for presence.
- The trusted probe program is also run in an ordinary local Node process without
  sandbox enforcement. It detects readable protected markers, an allowed external
  write, and reachable parent loopback witness and fails the required boundaries.
  This negative control is not a real Codex sandbox pass.
- Timeout, abort, output overflow, invalid UTF-8, spawn failure, TERM/KILL cleanup,
  a new-session descendant, and process-identity changes fail conservatively.
  The nested-namespace identity case uses simulated `/proc` namespace fields,
  not an actual host user-namespace permission change.
- Listener bind/positive-control failure, timeout, interruption, late connections,
  and uncertain close cannot become network or cleanup success. Two cancellation
  cases use actual temporary `127.0.0.1` listeners. Network timeout is inconclusive
  and fails rather than counting as a denied connection.
- An interrupted check never reaches a Hub claim. Unknown process cleanup retains
  temporary evidence, and uncertain runtime-preview cleanup stays false even
  when the model process has not been spawned.
- Probe and real execution select the same random, per-invocation permission
  profile. A later real run has a separate native startup-config guard that
  rejects an observed managed-profile fallback before `exec`. All tests of this
  guard use fixtures; no real account configuration preview was performed here.

The added sandbox probe itself uses no real credentials. The complete `--check`
still includes the original dedicated login-status and token-metadata checks.
The runtime-only policy preview may use the existing account to fetch managed
configuration after real execution is authorized; it is not part of `--check`.
Its result and the following exec are separate policy snapshots, not an atomic
guarantee against concurrent host/cloud policy changes.

## Historical consolidated delivery after `73ffe0e`

The new work preserves the Codex executor and consolidates the deployment into
one release/acceptance sequence. It does not deploy patches individually. The
exact-helper AppArmor policy and one conditional Demo retry have since been
approved; the documents now reuse that approval, preserve the existing identities
and model, and record the token expiry `2026-11-04T06:38:16Z`.

Official Zylos Core `v0.5.2` was inspected at commit
`8ee9bd9007edab46f766f3574e0ad56cf69268c2`. The evidence and precise missing
interfaces are in [the Zylos assessment](m1-zylos-integration.md). Its shared
runtime/C4 transport cannot supply the strict per-task isolation, result,
artifact ownership, cancellation, idempotency and lease-fencing contract.
No native Task interface or active executor was shipped in that earlier
`4c1dfb86` delivery. The implemented custom extension is described above.

The additional offline validation establishes:

- `classifyC4Receipt` accepts only bounded, single, unambiguous JSON. Queued and
  handled receipts, transport `running/delivered/failed`, process exit 0, late
  output, and global capability assertions never become successful Task results.
  Unknown outcomes never request automatic replay or expose raw error content.
- The source inspector opens only its fixed public-file list, rejects unsafe
  redirections/nonregular/unbounded files, projects package fields, and does not
  import or execute the inspected code. Tests use synthetic auth/env sentinels,
  filesystem/network/spawn observers, real Node CLI subprocesses through symlink
  paths, and import-only entry checks. No company source or credential is used.
- A separate check against the actual downloaded official source matched all
  twelve fingerprints and still emitted `capability.ready: false`,
  `claim_allowed: false`, and exit 2. This verifies static source inspection only;
  `runtime_verified` and `auth_inspected` remained false.
- The window checker rejects expired, insufficient, malformed or reduced-reserve
  input using the host clock. It reads no token and does not authenticate it or
  choose a task; those limitations are explicit output fields.
- HTTP 401 at claim executes no adapter and is not retried. HTTP 401 during
  heartbeat aborts the current run, joins asynchronous cleanup, refuses late
  success, and stops before another claim. A failing settlement observer also
  stops. These cases use injected HTTP and executor fixtures, not a live token.

The M1 Task claim API still chooses the oldest queued task for the assigned Bot.
`--once` is not a task-ID selector. The consolidated operator sequence requires
an explicit queue check and enough remaining token time before the already-
approved one-shot. No automatic renewal, queue reordering, new token scope,
production Zylos permission change, or shared-session cancellation is added.

## What the offline cases establish

- The process controller starts real local Node fixture subprocesses with argument
  arrays, stdin input, independent working directories and process groups, and an
  explicit child environment. The fixtures replace Codex; they do not call a model.
- Cancel, timeout, TERM/KILL escalation, group-leader exit, and initial journal
  write failure terminate the verified fixture group while an unrelated sentinel
  survives. Linux process identities include start time and PID namespace.
- Nonzero exit, signals, malformed/truncated streams, missing/invalid results,
  links, file races, missing Demo structure, oversized output, and upload/download
  failures cannot become successful artifacts.
- The temporary authenticated Hub handles claim, heartbeat, files, reviewing and
  human accept. A second assigned task remains queued while the first runs.
  Browser-session downloads retain filenames and private/no-store cache headers.
- An uploaded file is read back and hash-checked before publication. Partial
  uploads retain known IDs; unknown POST outcomes retain unresolved intents and
  halt for reconciliation instead of retrying the model or upload.
- A task deadline cannot erase upload uncertainty. SIGTERM racing with claim or
  finish cannot release the reconciliation lock. Uncertain finish outcomes do
  not automatically execute the next task or repeat an earlier execution.
- The original explicit Mock CLI and its task-lifecycle tests still pass.

## Remote checks

The existing CI and SAST workflows now also target pull requests whose base is
`fix/m0-security-hardening`, so the stacked M1 draft can be checked without merging
either earlier draft or `main`. Workflow permissions remain `contents: read`.

Inspect the published PR's **Quality Gate**, **Dashboard Build**, **Semgrep Code
Scan**, and **Gitleaks Secret Scan** for the exact head SHA. Local success is not
substituted for missing, queued, failed, or skipped remote checks. The release
handoff reports the actual remote state after publication.

## Still required on the target host

The deployment assistant reports that the dedicated identities, approved token,
fresh login, model/effort pair, and baseline Hub `0893c8a` are already established.
Preserve them; do not repeat provisioning. The failed first one-shot has ended.
The user has now approved the exact prepared AppArmor policy plus one retry
after isolation checks. Follow the [current Zylos Task runbook](m1-zylos-task-runtime.md)
without asking for those same approvals again. The current token expires at
`2026-11-04T06:38:16.417Z` and cannot be renewed automatically.

The following remain target-host actions, not actions performed or accepted
from this code-authoring environment:

- Stage the exact new worker release, preserve the entry fix, add the non-secret
  unit marker, and first run `--check` under the same unit restrictions. Hub,
  database, credentials, model choice, and network/TLS remain unchanged.
- Verify and apply the deployment assistant's already-approved exact-helper
  AppArmor artifact and scoped rollback. Offline parser success is not runtime
  enforcement. No policy-installation script,
  host capability grant, global userns change, or sandbox downgrade is delivered.
- After any approved prerequisite correction, capture a fresh complete 20-check
  result. The development fixtures cannot verify target-host bwrap/AppArmor.
- After the queue/window and isolation gates pass, execute the already-approved
  single retry and validate the model/business Demo under that unit, including
  the user's Mac HTTPS/download and interaction workflow. Preserve the original
  failed attempt; do not auto-requeue or add extra model tasks.

The Demo validator checks file structure and declarations. It is not a full
JavaScript safety analysis or proof that the business interactions work. A person
must open the actual downloaded result and accept it. Images/PDFs receive format
signature checks, not malware scanning or complete format validation.

Child environment/argument/prompt filtering is not strong filesystem isolation
between processes sharing a UID. The verified task process group and the unit's
control group are different boundaries; group cleanup is not a claim that a
malicious process cannot create a new session. Use the dedicated trusted pilot
identity and the documented host controls. A stronger hostile-task isolation
design is outside this milestone.

Use [the Zylos Task deployment runbook](m1-zylos-task-runtime.md) for the next
phase; older Codex/handoff documents are historical references. Keep the PR a draft and
record code delivery, remote CI, local host preflight, and real acceptance as
separate milestones.
