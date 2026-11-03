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
| Complete Vitest suite | 870 passed, 7 Redis-dependent tests skipped, 0 failed; 877 total in 30 files |
| M1 suites | 254 passing cases: process controller 35, artifacts 70, worker/lifecycle integration 17, CLI entrypoints 16, sandbox preflight 30, bounded sandbox subprocesses 15, runtime policy guard 57, witness lifecycle 14 |
| Sandbox-gap follow-up | 119 additional passing cases compared with worker baseline `1544bd94aaee3505c8d698683042ca3cf2c31688`; preserves all earlier suites |
| Additional existing-suite regressions | 3 passing cases for finish confirmation and authenticated file downloads |
| Server TypeScript build | Passed |
| Next.js production build and static export | Passed for baseline `0893c8a`; dashboard unchanged by this worker patch; inspect the new head's Dashboard Build CI |
| Updated unit syntax | systemd 255 accepted a temporary copy including the non-secret `SetCredential`, with both Exec commands replaced by `/usr/bin/true`; no service installed or started here |
| Documentation checks | 19 Bash blocks pass `bash -n`; 6 relative links resolve across the three M1 documents; whitespace checked |

Commands used with the Node 22 executable on PATH:

```bash
npm test
npm run build
```

The unchanged dashboard build is checked by the new head's Dashboard Build CI;
the baseline local static-export result is not a new local build claim.

The focused model-free suite is also available as `npm run test:codex`.
No model credentials or model service are needed for it. Temporary Hub databases,
Bot identities, files, and subprocesses belong only to test fixtures and are
cleaned up by the tests; they are not production or M1 deployment identities.

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
Its authorization does not cover another attempt.

The following remain target-host actions, not actions performed or accepted
from this code-authoring environment:

- Stage the exact new worker release, preserve the entry fix, add the non-secret
  unit marker, and run only `--check` under the same unit restrictions. Hub,
  database, credentials, model choice, and network/TLS remain unchanged.
- Present the deployment assistant's concrete exact-helper AppArmor policy and
  scoped rollback for user approval before installing/loading it. Offline parser
  success is not approval or runtime enforcement. No policy-installation script,
  host capability grant, global userns change, or sandbox downgrade is delivered.
- After any approved prerequisite correction, capture a fresh complete 16-check
  result. The development fixtures cannot verify target-host bwrap/AppArmor.
- Obtain the separately required real-retry approval, then validate the real model
  and business Demo under that unit, including the user's Mac HTTPS/download and
  interaction workflow. Preserve the original failed attempt; do not auto-requeue.

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

Use [the deployment runbook](m1-codex-worker.md) and
[the Zylos handoff](m1-zylos-handoff.md) for the next phase. Keep the PR a draft and
record code delivery, remote CI, local host preflight, and real acceptance as
separate milestones.
