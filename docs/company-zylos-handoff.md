# Handoff to the Existing Company Zylos

Give one existing company-side Zylos the repository and deployment branch from
README.md, plus the request below, through its current authorized interaction
channel. Use a source package or Git bundle only if remote publication is not yet
available. The operator supplies the internal hostname; this conversation does
not automatically gain server access.

## Deployment request

Deploy HXA internal-agent M0 using `docs/company-deployment.md`. Verify the exact
deployment branch exists and record its commit before building. Do not fall back
to an upstream installer or the default branch if publication is missing.

The company already runs HXA and multiple Zylos instances. Identify the existing
HXA commit/image, local patches, database type, project/volume, ports, TLS entry
point, and the Zylos-to-Hub relationships. Default to a separate pilot with a new
directory, project, data volume, unused port, and HTTPS site. Do not copy production
Hub credentials into a fresh pilot or change all existing Zylos connections.
If the operator selects an existing-Hub upgrade, use the runbook's compatibility,
backup, restore, maintenance-window, and single-instance conditions first.

First inspect the execution context with `sh deploy/preflight.sh`. Determine
whether you are on the host or inside a container and whether your existing
permissions allow host deployment. Report the installed Zylos version and current
runtime if the local version provides a configuration-only command. Do not change
the installed Zylos, its runtime, model login, existing projects, or shared proxy
sites as part of this deployment.

If the required host access and tools are available, use a fresh directory and a
distinct Compose project. Generate the Hub secret locally and keep credentials in
the local protected configuration. Build the delivered image, start one SQLite
Hub, and validate its health. Use the company-approved hostname and trusted TLS
certificate with the existing proxy; validate configuration before reloading it.

Then follow `docs/company-first-login.md` to create test identities and run one explicit mock task through the real UI
and `deploy/compose.mock-runner.yml`. Accept its result and verify the retained
execution history. The acceptance target is the task lifecycle, not a real model
task. Do not describe the existing Zylos as integrated merely because it helped
deploy the Hub or because a chat bridge is online.

If host deployment access, required tooling, a source file, or the company TLS
hostname is unavailable, complete the unaffected checks and return the exact
missing prerequisite. The company host operator can execute the same runbook.
Do not expose a new public endpoint or alter host privileges to work around a
missing company access path.

Return this concise report:

| Field | Result |
| --- | --- |
| OS and architecture | |
| Host or container execution context | |
| Zylos version and runtime, if available | |
| Existing HXA commit/image, database, and local changes | |
| Selected mode: independent pilot or planned existing-Hub upgrade | |
| Existing Zylos-to-Hub connections affected | |
| Docker Engine / Compose versions and access | |
| Source commit / built image identity | |
| Compose project / persistent volume identity | |
| Internal HTTPS access URL | |
| Hub health | |
| Mock task ID and final status | |
| Browser login and task-history result | |
| Remaining blocker, if any | |

Do not include `.env`, model authentication files, API keys, bearer tokens,
cookies, full container environments, or raw customer/chat logs in the report.
