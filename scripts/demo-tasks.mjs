#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMainModule } from './cli-entrypoint.mjs';
import { runWorker, createMockExecutor, ShutdownError } from './task-runner/worker.mjs';

class DemoError extends Error {}

/** No external URL or data directory is accepted by this demonstration. */
async function isolatedHub() {
  try { await access(new URL('../dist/routes.js', import.meta.url)); } catch {
    throw new DemoError('Build the server first with npm run build. The demo does not install or build dependencies automatically.');
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hxa-task-demo-'));
  let db;
  let hubWs;
  let server;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (hubWs) await hubWs.shutdown();
    } finally {
      try {
        if (server?.listening) {
          await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
        }
      } finally {
        try { if (db) await db.close(); } finally {
          // Only the exact directory created above can reach this deletion.
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    }
  };

  try {
    const [expressModule, dbModule, driverModule, wsModule, webhookModule, routesModule, sessionModule, middlewareModule, loggerModule] = await Promise.all([
      import('express'), import('../dist/db.js'), import('../dist/db/index.js'),
      import('../dist/ws.js'), import('../dist/webhook.js'), import('../dist/routes.js'),
      import('../dist/session.js'), import('../dist/session-middleware.js'), import('../dist/logger.js'),
    ]);
    loggerModule.logger.level = 'silent';
    await mkdir(path.join(dataDir, 'files', '_tmp'), { recursive: true });
    const config = {
      port: 0, host: '127.0.0.1', data_dir: dataDir, default_persist: true,
      cors_origins: [], max_message_length: 65536, log_level: 'silent',
      admin_secret: randomBytes(32).toString('hex'),
      file_upload_mb_per_day: 10, max_file_size_mb: 1,
    };
    const driver = new driverModule.SqliteDriver(path.join(dataDir, 'hxa-connect.db'));
    db = new dbModule.HubDB(driver);
    await db.init();
    const sessionStore = new sessionModule.SqliteSessionStore(driver);
    const app = expressModule.default();
    app.use(expressModule.default.json({ limit: '1mb' }));
    app.use(middlewareModule.sessionMiddleware(sessionStore));
    app.use(middlewareModule.csrfMiddleware());
    server = createServer(app);
    hubWs = new wsModule.HubWS(server, db, new webhookModule.WebhookManager(db), config);
    hubWs.setSessionStore(sessionStore);
    app.use(routesModule.createRouter(db, hubWs, config, sessionStore));
    app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
    app.use((_error, _req, res, _next) => res.status(500).json({ code: 'DEMO_SERVER_ERROR' }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    return { url: `http://127.0.0.1:${address.port}`, adminSecret: config.admin_secret, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function request(hub, method, route, { body, token, cookie, key, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) { headers.Cookie = cookie; headers.Origin = hub.url; }
  if (key) headers['Idempotency-Key'] = key;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10_000);
  try {
    const response = await fetch(`${hub.url}${route}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      redirect: 'error',
    });
    const data = await response.json();
    if (!response.ok) {
      const code = typeof data?.code === 'string' && /^[A-Z_]{1,80}$/.test(data.code) ? data.code : 'REQUEST_FAILED';
      throw new DemoError(`Isolated Hub rejected ${method} ${route} (HTTP ${response.status}, ${code}).`);
    }
    return { data, headers: response.headers };
  } finally { clearTimeout(timer); }
}

function sessionCookie(headers) {
  const cookie = headers.get('set-cookie')?.match(/(?:^|[,;]\s*)hxa_session=([^;]+)/)?.[1];
  if (!cookie) throw new DemoError('The isolated Hub did not issue its expected session cookie.');
  return `hxa_session=${cookie}`;
}

function botId(bot) {
  const id = bot.id || bot.bot_id;
  if (!id || !bot.token) throw new DemoError('The isolated Hub returned incomplete bot registration data.');
  return id;
}

export async function runDemo({ signal, logger = console.log } = {}) {
  const hub = await isolatedHub();
  try {
    logger('模拟执行 / No model invoked. Isolated Hub bound to 127.0.0.1; all credentials stay in memory.');
    const adminLogin = await request(hub, 'POST', '/api/auth/login', {
      body: { type: 'super_admin', admin_secret: hub.adminSecret }, signal,
    });
    const org = (await request(hub, 'POST', '/api/orgs', {
      cookie: sessionCookie(adminLogin.headers), body: { name: 'Isolated task demonstration' }, signal,
    })).data;
    const creator = (await request(hub, 'POST', '/api/auth/register', {
      body: { org_id: org.id, org_secret: org.org_secret, name: 'demo-owner' }, signal,
    })).data;
    botId(creator);
    const ticket = (await request(hub, 'POST', '/api/org/tickets', {
      token: creator.token, body: { reusable: false, expires_in: 300, skip_approval: true }, signal,
    })).data;
    const worker = (await request(hub, 'POST', '/api/auth/register', {
      body: { org_id: org.id, ticket: ticket.ticket, name: 'demo-worker' }, signal,
    })).data;
    const assignedBotId = botId(worker);
    const ownerLogin = await request(hub, 'POST', '/api/auth/login', {
      body: { type: 'bot', token: creator.token, owner_name: 'Demo Product Owner' }, signal,
    });
    const ownerCookie = sessionCookie(ownerLogin.headers);
    const created = (await request(hub, 'POST', '/api/tasks', {
      cookie: ownerCookie, key: randomUUID(), signal,
      body: {
        title: '模拟：为产品需求准备 Demo 说明',
        description: '验证创建、领取、心跳、提交结果、人工验收的流程。本次不生成真实应用、不调用模型、不运行用户命令。',
        assigned_bot_id: assignedBotId,
      },
    })).data;
    if (created.status !== 'queued') throw new DemoError('The newly created task was not queued.');
    logger(JSON.stringify({ step: 'created', task_id: created.id, thread_id: created.thread_id, status: created.status }));

    const result = await runWorker({
      url: hub.url, token: worker.token, runnerId: 'isolated-demo-runner', once: true,
      heartbeatMs: 1000, // Accelerated demonstration; the normal CLI default is 15 seconds.
    }, {
      executeTask: createMockExecutor({ delayMs: 1600 }), signal,
      logger: event => logger(JSON.stringify(event)),
    });
    if (result.stopped) throw new ShutdownError();
    const detail = (await request(hub, 'GET', `/api/tasks/${created.id}`, { cookie: ownerCookie, signal })).data;
    if (detail.task?.status !== 'reviewing' || result.succeeded !== 1 || detail.runs?.length !== 1) {
      throw new DemoError('Expected one successful run and a task awaiting review.');
    }
    logger(JSON.stringify({ step: 'reviewing', task_id: created.id, status: detail.task.status }));
    const accepted = (await request(hub, 'POST', `/api/tasks/${created.id}/accept`, {
      cookie: ownerCookie, body: { expected_revision: detail.task.revision }, signal,
    })).data;
    if (accepted.status !== 'completed') throw new DemoError('Acceptance did not complete the task.');
    logger(JSON.stringify({ step: 'accepted', task_id: accepted.id, status: accepted.status }));
    logger('Demo passed: queued → running → reviewing → completed. 模拟执行 / No model invoked.');
    return { taskId: accepted.id, status: accepted.status };
  } finally {
    await hub.cleanup();
    logger('Isolated Hub closed; its temporary data directory was removed.');
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/demo-tasks.mjs --mock\nRequires npm run build. Creates one isolated local Hub, one organization, and two bots; then removes only its own temporary data.');
    return;
  }
  if (args.length !== 1 || args[0] !== '--mock') throw new DemoError('Pass --mock explicitly. This demo never invokes a model and accepts no external URL or data directory.');
  const controller = new AbortController();
  const interrupt = () => controller.abort(new ShutdownError());
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try { await runDemo({ signal: controller.signal }); } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (isMainModule(import.meta)) {
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof DemoError || error instanceof ShutdownError
      ? error.message
      : 'The isolated task demo failed. Check the server build and local Node dependencies; no model was invoked.');
    process.exitCode = 1;
  }
}
