# First Login and Pilot Bot Registration

Use these steps for a fresh pilot Hub after HTTPS and `DOMAIN` are configured.

For a loopback-only pilot with no company HTTPS hostname yet, first follow the
optional [SSH/local-browser acceptance guide](company-browser-check.md). Its
temporary origin and hostname conditions also apply to the requests below;
retain normal cookie and CSRF protection. Reuse existing pilot identities if
initialization was already completed.
Use the Hub's actual URL in place of `https://pilot.example`. Keep administrator
secrets, organization secrets, tickets, session cookies, and issued Bot tokens
only in the company environment. Do not paste registration responses into a
shared deployment report.

For API tools, use JSON request bodies and `Content-Type: application/json`.
Cookie-authenticated POST requests also require `Origin: https://pilot.example`
(including a nonstandard port when used). A login creates a session cookie; it
does not create a registration ticket. Browser UI requests handle Origin normally.

## 1. Create the pilot organization

Open `https://pilot.example/admin/` directly. The landing page normally hides the
admin link. Log in using `HXA_CONNECT_ADMIN_SECRET` from the pilot's local `.env`,
then create one test organization and save its `id` and `org_secret` locally.

Equivalent API sequence:

```http
POST /api/auth/login
Content-Type: application/json

{"type":"super_admin","admin_secret":"<local-pilot-admin-secret>"}
```

Retain that response's session cookie in a local cookie jar, then:

```http
POST /api/orgs
Content-Type: application/json
Origin: https://pilot.example
Cookie: <super-admin-session-cookie>

{"name":"Company Agent Pilot"}
```

## 2. Create two single-use invitations

Log out of the administrator page. On the landing page select **Org Admin** and
log in using the new organization's ID and secret. On `/org/`, select **Invite
Bot** and create two separate one-use tickets, one for each pilot identity.
Select skip approval for these dedicated test invitations.

Equivalent login:

```http
POST /api/auth/login
Content-Type: application/json

{"type":"org_admin","org_id":"<pilot-org-id>","org_secret":"<local-org-secret>"}
```

Using the new Org Admin cookie, issue the following request twice. Each response
contains a different ticket:

```http
POST /api/org/tickets
Content-Type: application/json
Origin: https://pilot.example
Cookie: <org-admin-session-cookie>

{"reusable":false,"skip_approval":true,"expires_in":3600}
```

## 3. Register the owner and worker through the API

There is no direct Bot-registration form. The UI generates an invitation that an
agent or local API tool uses. Register each Bot with its own unconsumed ticket:

```http
POST /api/auth/register
Content-Type: application/json

{"org_id":"<pilot-org-id>","ticket":"<owner-ticket>","name":"pilot-owner","role":"product-manager"}
```

```http
POST /api/auth/register
Content-Type: application/json

{"org_id":"<pilot-org-id>","ticket":"<worker-ticket>","name":"pilot-worker","role":"demo-builder"}
```

Use these registration requests without a browser/admin cookie; if your API tool
sends a session cookie, supply the matching Origin header. Save each returned
`bot_id` and `token` locally when issued. These invitation-created identities are
ordinary member Bots; the selected skip-approval tickets make them active.

Direct registration with an organization secret is also supported by the original
Hub, but grants the new Bot an admin role. That shortcut is not used here: two
ordinary members suffice for task creation, execution, and owner acceptance.

## 4. Create, execute, and accept the test task

1. Log out of the Org Admin session. On the landing page choose **Bot Login**.
2. Enter the **pilot-owner** token and an operator display name.
3. Open `/dashboard/#/dashboard/tasks/` and create a task assigned to
   **pilot-worker**. Use a clearly labeled mock-verification request.
4. Set local `HXA_TASK_TOKEN` to the **pilot-worker** token. It must belong to this
   same Hub database and organization; a token from the existing company Hub will
   not identify a Bot in a fresh pilot database.
5. From this repository root, run:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f deploy/compose.mock-runner.yml \
  run --rm task-runner-mock
```

6. Confirm the specific task has a run, a `No model invoked` result, and status
   `reviewing`. As the owner, accept it and confirm `completed` with its history.

Do not use a Super Admin or Org Admin browser session as the Task user. The Task
API uses Bot Owner sessions for human actions and the assigned Bot's full-scope
bearer token for Runner actions.

## Common setup mistakes

| Symptom | Check |
| --- | --- |
| Page loads, login does not stay signed in | Use trusted HTTPS; normal session cookies are Secure |
| Cookie API call returns CSRF_ERROR | Send Origin matching the actual hostname and `DOMAIN` |
| Login returns 400 | Include the explicit login `type`; an org login is not a ticket request |
| No obvious admin link or registration form | Open `/admin/` directly; use the invitation + API registration flow above |
| Runner returns 401/403 | Use the assigned pilot worker's full-scope token, not an admin secret or another Hub's token |
| Runner exits 0 but task remains queued | Confirm the task assignee and that this Hub's queue actually contains work for that worker |
| Task API returns TASK_STORAGE_UNSUPPORTED | Use the independent SQLite pilot; the current task implementation does not run on PostgreSQL |
| Existing Zylos is messaging-online but never claims tasks | The real Task adapter is not part of this mock milestone |
