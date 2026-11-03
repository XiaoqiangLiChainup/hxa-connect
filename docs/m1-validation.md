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
| Complete Vitest suite | 751 passed, 7 Redis-dependent tests skipped, 0 failed; 758 total in 26 files |
| New M1 suites | 135 passing cases: process controller 32, artifacts 70, worker/lifecycle integration 17, CLI entrypoints 16 |
| Additional existing-suite regressions | 3 passing cases for finish confirmation and authenticated file downloads |
| Server TypeScript build | Passed |
| Next.js production build and static export | Passed for baseline `0893c8a`; dashboard unchanged by this entry fix; inspect the new head's Dashboard Build CI |
| Unit syntax | At baseline, systemd 255 accepted a temporary copy with both Exec commands replaced by `/usr/bin/true`; unit unchanged by this fix, no service installed or started here |
| Configuration/document checks | Example parsed; Bash blocks, relative links, and whitespace checked |

Commands used with the Node 22 executable on PATH:

```bash
npm test
npm run build
cd web-next
npm run build
```

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
  `ready: false` JSON with all ten checks and exit 2. No Codex binary is invoked.
- Wrapper and eval imports remain silent apart from an explicit test marker,
  including when eval's `argv[1]` happens to name the imported script. Distinct
  query/fragment imports do not start any CLI.
- Compatibility behavior for missing paths, non-file URLs, unrelated modules,
  and native `main: false`.

The deployment runbook now requires actual Usage and this invocation's readiness
JSON, including boolean `ready: true` and all ten passing checks. Exit 0 alone
cannot establish readiness. The dedicated user's reported real-path preflight
is separate field evidence; the patched `current` path still needs host validation.

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

The following have not been performed from this code-authoring environment.
The deployment assistant reports that the dedicated identities, approved token,
fresh login, baseline Hub update, and real-path local preflight are now in place;
do not repeat provisioning. Continue the current authorized one-shot, then apply
the worker-only patch as described in the runbook:

- Creating a dedicated Unix user or Hub identity, approving its current required
  full-scope credential, or establishing a fresh Codex login.
- Installing or starting the unit, updating the pilot Hub image, or changing any
  company process, container, network, firewall, TLS configuration, or credential.
- Running the real Codex 0.166.0 binary with the approved model under the actual
  systemd/sandbox restrictions; local checks do not prove model access or quota.
- Producing the customer-feedback business Demo with a model and exercising its
  interactions in the user's existing Mac HTTPS/download workflow.

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
