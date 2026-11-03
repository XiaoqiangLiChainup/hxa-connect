# Company Pilot Deployment

This runbook is for a company already running HXA and multiple Zylos instances.
The default deployment is an independent M0 pilot with its own directory, Compose
project, data volume, unused host port, and HTTPS site. Existing HXA databases,
configuration, Bot identities, proxy sites, and Zylos-to-Hub mappings remain under
their existing deployment. This does not yet connect Zylos as a real Task executor.

## Recommended placement

Use one company test server, or an independent application directory on the
existing Zylos host if its capacity and ownership allow it:

- One Compose project containing one HXA Hub with its bundled static dashboard.
- SQLite and uploaded files in the named `/app/data` volume.
- The company's existing Nginx or Caddy providing a trusted HTTPS hostname at
  the root path, for example `https://agent.company.example`.
- A separate, explicitly invoked mock runner for the first acceptance check.
- The existing Zylos remains available through its current company chat channel
  and can act as a deployment assistant if its OS/container permissions permit.

The browser conversation that prepared this code has no configured company
VPN/SSH session. Transfer the source package through an approved company channel,
or use an accessible repository after the branch is actually published. The
company-side operator builds and runs it, then returns an access URL and a small
sanitized result summary. No inbound route from this conversation is required.

Use the repository/branch retrieval commands in the README after remote
publication has been confirmed. Stop if that branch does not resolve; the upstream
or default branch may not contain the Task changes. A supplied development source
snapshot or Git bundle is an alternative. Record `git rev-parse HEAD` when working
from Git; the package version remains 1.7.5 and is not a feature-build identifier.

## 1. Inspect the actual execution environment

From this source directory, run:

```bash
sh deploy/preflight.sh
```

The script reports the OS/architecture, tool availability, Docker daemon access,
Zylos version when available, and whether the example port is occupied. It does
not install software or read credentials.

Also inventory the existing company deployment through its existing management
interface. The generic script does not enumerate or claim to understand it:

| Item | Record |
| --- | --- |
| Existing HXA | Source commit/image ID, version, local patches, SQLite or PostgreSQL |
| Existing deployment | Compose project, service/container name, volume/path, host port |
| Entry point | Actual hostname, path prefix, TLS and proxy location |
| Each Zylos | Instance location/version, HXA plugin version, connected Hub URL |

Do not print secrets or full process/container environments to obtain this list.
The M0 baseline is HXA 1.7.5 at `547eae7453a812efaa51c9091a1ce2bcb82c09df`;
arbitrary company versions and local modifications are not automatically compatible.

Confirm the deployment context. A Zylos process inside a container may have no
access to the host's Docker daemon, files, or reverse proxy. If so, have the host
operator run this runbook or use an already approved company deployment channel.
Do not assume that a chat-connected Zylos can administer the host.

Required for the container path:

- Docker Engine with Compose v2 supporting `up --wait`.
- Access to the company's permitted image/package registries for build inputs.
- An available application port, writable persistent volume, and a trusted HTTPS
  hostname/certificate for browser access.

Node on the host is not required for the Docker path. The image uses Node 22.
If tools are missing on the existing Zylos host, report that fact before changing
its shared system installation. A dedicated test VM is also suitable.

## 2. Choose the deployment mode

| Existing HXA state | Action |
| --- | --- |
| Database, version, or local patches unknown | Independent SQLite pilot |
| PostgreSQL | Independent SQLite pilot; keep the existing database configuration |
| SQLite and compatible code identified | Validate the pilot first, then plan a selected Hub upgrade |
| In-place upgrade selected by the operator | Use the explicit upgrade conditions below; do not execute fresh-pilot initialization over it |

### Existing-Hub upgrade conditions

This branch modifies the Hub server and dashboard. Installing only a Runner beside
an unmodified Hub will not add `/api/tasks` to that Hub.

For an existing-Hub upgrade, first compare its commit and company changes with this
baseline. Do not downgrade a newer/custom installation to 1.7.5 to obtain M0. If
compatibility is unresolved, keep using the independent pilot.

When an upgrade is selected, identify exactly one target Hub and a maintenance
window. Finish/stop active work, make a consistent backup of the complete data
volume and its configuration, record the old image, and validate restoration.
Keep the existing database, organization/Bot identities, administrator secret,
project/volume identity, and published URL. Stop the old process before starting
the replacement: do not run two Hub processes against the same SQLite data volume.
Existing Zylos clients must be checked for reconnection after the selected Hub's
restart. Code rollback may also require restoring the compatible database snapshot;
an image change alone is not a universal rollback guarantee.

### Configure a fresh pilot

For a fresh pilot directory only:

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally. Generate the administrator secret on the company server and
keep it there; never send it back in chat. Configure:

```dotenv
COMPOSE_PROJECT_NAME=hxa-agent-pilot
HXA_CONNECT_IMAGE=hxa-agent-platform:m0-local
HXA_CONNECT_ADMIN_SECRET=<locally-generated-secret>
HXA_CONNECT_BIND_ADDRESS=127.0.0.1
HXA_CONNECT_PORT=4801
DOMAIN=agent.company.example
HXA_CONNECT_CORS_ORIGINS=
```

The hostname is a placeholder. Use the real browser-facing hostname without a
scheme or path. Keep the Compose project name stable across release directories;
changing it can select a different named data volume. When updating the **same
previously created pilot**, preserve that pilot's project name and `.env`.
A fresh pilot must not adopt the production Hub's project name or data volume.

M0 Tasks require SQLite and one Hub process. Do not switch this pilot to the
historical PostgreSQL/Redis example elsewhere in the original README. Task
operations on a non-SQLite backend return `503 TASK_STORAGE_UNSUPPORTED`.

## 3. Build and start the Hub

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env build hxa-connect
docker compose --env-file .env up -d --wait --wait-timeout 120 hxa-connect
docker compose --env-file .env ps
curl --fail --silent --show-error http://127.0.0.1:4801/health
```

Adjust the last URL if the host port was changed. The container itself always
listens on port 4800. The Dockerfile builds both the server and the dashboard,
includes the runner scripts, and temporarily installs native compiler tools for
`better-sqlite3` when a matching prebuilt binary is unavailable.

The Hub health check verifies its HTTP endpoint and database availability.
It does not prove that an agent or model is ready. `restart: unless-stopped`
restarts an exited container; an unhealthy probe alone does not trigger a Docker
restart. Connect the probe to existing monitoring if continuous operation matters.

## 4. Connect the existing HTTPS entry point

Use one of the supplied examples with the company's existing proxy:

- `deploy/nginx.hxa.conf.example`
- `deploy/Caddyfile.hxa.example`

They assume the proxy runs on the Docker host and forwards to loopback port 4801.
Set actual hostname/certificate paths, preserve other sites, validate the proxy
configuration using its installed tooling, and reload through the company's
normal procedure. The files are templates; they are not automatically enabled.

The normal HXA login cookie is `Secure`. A plain HTTP private-IP URL may load the
page and pass `/health` while failing to retain the browser login. Use HTTPS with
a certificate trusted by employee browsers. Opening CORS or setting `DEV_MODE`
is not a substitute for this pilot configuration.

If the HTTPS hostname is not yet available but the loopback-only pilot is healthy,
an operator with existing approved SSH access can perform a limited browser check
using [SSH forwarding and localhost](company-browser-check.md). This preserves
normal cookie/CSRF settings and records browser acceptance separately from the
company HTTPS entry-point acceptance.

Nginx must forward WebSocket Upgrade/Connection headers for `/ws`; the example
does this. Caddy reverse_proxy supports WebSocket upgrades. Preserve the external
Host and protocol, and keep `DOMAIN` aligned with the URL employees use.

### Network address selection

| Caller | Hub address |
| --- | --- |
| Proxy or local process on the Docker host | `http://127.0.0.1:4801` with the example mapping |
| Mock runner in this Compose network | `http://hxa-connect:4800` |
| Existing Zylos or proxy in a different container | Company HTTPS URL, or a deliberately shared Docker network and service name |
| Employee browser or local agent | Company HTTPS hostname reachable over the company network/VPN |

`127.0.0.1` inside a separate container refers to that container. A service name
is resolvable only on a shared Docker network. Do not put a private container IP
into a permanent configuration.

Use an independent hostname at `/` for this pilot. A `/hub` subpath also requires
a frontend build-time base path, a runtime guide base path, and matching HTTP/WS
prefix rewriting; it is outside this prepared configuration.

## 5. Verify the task lifecycle using an explicit mock

1. Follow [First login and Bot registration](company-first-login.md), including
   the direct `/admin/` entry point and API registration step. Keep returned
   credentials local. Reuse a test organization only when it already belongs to
   this pilot Hub's database.
2. Log in as a Bot Owner, create a task, and assign a dedicated test bot. Do not
   treat a Super Admin session as a Task user; Tasks use the existing Bot Owner
   identity model.
3. Put the assigned test bot's full-scope bearer token in the local `.env` as
   `HXA_TASK_TOKEN`. This is not the Hub administrator secret.
4. Run exactly one mock attempt:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f deploy/compose.mock-runner.yml \
  config --quiet

docker compose --env-file .env \
  -f docker-compose.yml -f deploy/compose.mock-runner.yml \
  run --rm task-runner-mock
```

5. Confirm the UI shows the run and the explicit `No model invoked` result, then
   accept it. Check that the task is `completed` and its history remains visible.

The overlay is separate so the default Hub can start without a task token. The
mock uses the built Hub image, receives only its own bot token, and does not mount
the Hub's named data volume. It exits after one task and is not auto-restarted.
An empty queue also exits successfully, so verify the actual task's state; exit
code 0 alone is not the acceptance criterion.

The worker credential must identify a Bot in the database behind `HXA_TASK_URL`.
A fresh Hub does not recognize a different Hub's organizations, Bot IDs, or tokens.
Use the dedicated pilot worker; do not redirect a production Zylos identity merely
to exercise the mock. An upgrade preserving the same Hub database preserves those
identities unless credential rotation is separately performed.

The Agent list's messaging-online flag is separate from Task Runner readiness.
Installing the existing `zylos-hxa-connect` chat bridge does not implement the new
Task `claim`, `heartbeat`, and `finish` interfaces.

## 6. Real Zylos execution is the next integration

The existing Zylos can help deploy this package through its current interaction
channel. Making it execute platform tasks requires a separate adapter that maps
task/run IDs to its input and structured completion result, honors cancellation,
and fences late results. A message being queued or delivered to a session is not
a business-task completion signal.

Use an isolated execution workspace/session for the first real task. Do not
interrupt a shared company Zylos conversation to implement per-task cancellation.
The runner continues to own leases; model input should not contain the lease token.
See `docs/task-runner.md` for the execution adapter contract.

Having multiple existing Zylos instances does not make them Task consumers.
Integrate and verify one real instance first, then map additional instances to
their own Bot identities, execution sessions/workspaces, and cancellation behavior.

## Operations and handoff

- Preserve the named data volume. Do not use `docker compose down -v` to update.
- For an initial simple backup, wait until no task is running, stop the Hub during
  a maintenance window, and back up the complete data volume, including uploads
  and any SQLite WAL/SHM files present. Restart, then validate a restore in a
  separate environment before treating the backup procedure as proven.
- Record the source commit, built image ID/tag, project name, and volume identity.
  Use a distinct release tag for later updates and retain the prior M0 image.
- Update only the Hub service after examining active tasks. Keep the existing
  Zylos installation and model login independent from this pilot's release cycle.
- Return the internal access URL, tool versions, source/image identity, health
  status, mock task ID/status, and specific blocking errors. Remove tokens,
  cookies, credentials, and customer data from any shared diagnostic excerpt.

The current preparation environment has no Docker daemon, company TLS certificate,
or company network route. Source checks and configuration validation here do not
replace the company's image-build, proxy, browser, and runtime acceptance steps.

## References

- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
- [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)
- [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
