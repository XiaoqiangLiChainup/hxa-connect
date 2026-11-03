# Zylos Core task extension source

`vendor/zylos-core/` contains the complete Zylos Core source tree derived from
official tag `v0.5.2`, commit `8ee9bd9007edab46f766f3574e0ad56cf69268c2`, with the
explicit custom task-mode changes in
`patches/zylos-core-0.5.2-task-runtime.patch`. The original MIT license and
copyright notice are preserved at `vendor/zylos-core/LICENSE`.

The custom variant is `0.5.2+hxa.task.1`. It is maintained by this project and is
not an official upstream task API. The installed company Zylos and its shared
interactive runtime remain separate and unmodified.

The complete patched source is shipped, not fetched by an installer. Reverse
applying the patch reproduces every file and mode in
`third_party/zylos-core-upstream.json`. The effective tree and patch are pinned
in `scripts/zylos-runner/source-manifest.json`. `npm run check:zylos-source`
verifies both the effective tree and that reverse reconstruction offline. CI
runs this gate before the HXA tests.

Only the explicit task adapter is imported. Its execution dependency graph uses
Node builtins and the shipped source; no upstream npm installation, postinstall,
global CLI, runtime auto-detection, C4, PM2, scheduler or context monitor is
started. The full tree includes these original implementations for provenance
and review; their presence does not authorize invoking them.

The patch also hardens a few bundled, inactive maintenance functions that remote
SAST identified: process arguments are passed without a shell, and the legacy
web-console diagnostic correctly describes its HTTP backend and remote TLS proxy
requirement. This does not add TLS to that backend, start it, or change the
company's installed Zylos. These changes remain in the reversible source patch;
no finding is hidden through a rule suppression or vendor scan exclusion.

Upstream's independent Jest/node test suites and poster assets are retained as
source. HXA's Vitest collection excludes `vendor/**` and instead runs the explicit
`test/zylos-*.test.ts` suites against the actual modified Core, controller and
temporary Hub. A passing HXA suite is not a claim that all upstream suites or a
real model task have run.

To regenerate the exact manifests and patch after an intentional source change,
use an existing pristine checkout of the pinned upstream commit:

```bash
node scripts/build-zylos-task-source.mjs --write --upstream /absolute/pristine/zylos-core
node scripts/build-zylos-task-source.mjs --check
```

These are source-development commands. They never install or upgrade a company
Zylos instance. Do not regenerate manifests on the host to conceal a damaged or
unexpected release; restore the reviewed complete release instead.
