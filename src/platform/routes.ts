import { Router, type Request, type Response, type NextFunction } from 'express';
import type { HubDB } from '../db.js';
import { TaskError, type TaskActor } from './types.js';
import { createInput, expectedRevision, finishInput, idempotencyKey, listOptions, objectBody, textValue } from './validation.js';

/** Mounted after the existing Hub authentication middleware. */
export function createTaskRouter(db: HubDB): Router {
  const router = Router();

  function actor(req: Request, write = false, runner = false): TaskActor {
    if (!req.bot || (req.session && req.session.role !== 'bot_owner')) {
      throw new TaskError(403, 'FORBIDDEN', 'Tasks require a bot identity or Bot Owner session');
    }
    if (req.bot.join_status !== 'active' || req.org?.status !== 'active') {
      throw new TaskError(403, 'FORBIDDEN', 'An active organization bot is required');
    }
    const scopes = req.tokenScopes ?? [];
    if (!(scopes.includes('full') || (!write && scopes.includes('read')))) {
      throw new TaskError(403, 'INSUFFICIENT_SCOPE', write ? 'Task mutations require full scope' : 'Task reads require read or full scope');
    }
    if (runner && (req.session || !req.rawToken || !req.headers.authorization?.startsWith('Bearer '))) {
      throw new TaskError(403, 'FORBIDDEN', 'Runner operations require full-scope bearer authentication without a browser session');
    }
    const ownerName = req.session?.owner_name;
    return {
      orgId: req.bot.org_id, botId: req.bot.id, admin: req.bot.auth_role === 'admin',
      name: typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim().slice(0, 128) : req.bot.name,
    };
  }

  function handle(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction) => {
      void fn(req, res).catch(error => {
        if (error instanceof TaskError) res.status(error.status).json({ error: error.message, code: error.code });
        else next(error);
      });
    };
  }

  router.get('/agents', handle(async (req, res) => {
    res.json(await db.tasks.agents(actor(req)));
  }));

  router.get('/', handle(async (req, res) => {
    const identity = actor(req);
    const options = listOptions(req.query.status, req.query.limit);
    res.json(await db.tasks.list(identity, options));
  }));

  router.post('/', handle(async (req, res) => {
    const identity = actor(req, true);
    const result = await db.tasks.create(identity, createInput(req.body), idempotencyKey(req.headers['idempotency-key']));
    res.status(result.replayed ? 200 : 201).json(result.task);
  }));

  router.post('/claim', handle(async (req, res) => {
    const identity = actor(req, true, true);
    const body = objectBody(req.body, ['runner_id']);
    res.json(await db.tasks.claim(identity, textValue(body.runner_id, 'runner_id', 128).trim()));
  }));

  router.get('/:id', handle(async (req, res) => {
    res.json(await db.tasks.detail(actor(req), req.params.id as string));
  }));

  router.post('/:id/runs/:runId/heartbeat', handle(async (req, res) => {
    const identity = actor(req, true, true);
    const body = objectBody(req.body, ['lease_token']);
    res.json(await db.tasks.heartbeat(identity, req.params.id as string, req.params.runId as string,
      textValue(body.lease_token, 'lease_token', 256)));
  }));

  router.post('/:id/runs/:runId/finish', handle(async (req, res) => {
    const identity = actor(req, true, true);
    const { leaseToken, result } = finishInput(req.body);
    res.json(await db.tasks.finish(identity, req.params.id as string, req.params.runId as string, leaseToken, result));
  }));

  for (const action of ['accept', 'retry', 'cancel'] as const) {
    router.post(`/:id/${action}`, handle(async (req, res) => {
      const identity = actor(req, true);
      const body = objectBody(req.body, ['expected_revision']);
      res.json(await db.tasks.transition(identity, req.params.id as string, action, expectedRevision(body.expected_revision)));
    }));
  }

  return router;
}
