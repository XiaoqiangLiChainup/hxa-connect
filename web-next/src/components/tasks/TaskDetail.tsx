'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Check, ExternalLink, History, Loader2, MessageSquare, RefreshCw, RotateCcw, X,
} from 'lucide-react';
import { useTranslations } from '@/i18n/context';
import { useSession } from '@/hooks/useSession';
import { useTaskResource } from '@/hooks/useTaskResource';
import * as api from '@/lib/tasks-api';
import type { TaskAction, TaskAgent, TaskRun } from '@/lib/tasks-types';
import { cn } from '@/lib/utils';
import {
  TaskError, TaskLoading, TaskSimulationNotice, TaskStatusBadge, safeTaskArtifactUrl,
  taskButtonClass, taskDate, taskPrimaryClass,
} from './task-ui';

function RunCard({ run, latest }: { run: TaskRun; latest: boolean }) {
  const { t, locale } = useTranslations();
  return (
    <li>
      <details open={latest} className="group rounded-xl border border-hxa-border theme-panel">
        <summary className="cursor-pointer rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-hxa-accent sm:p-5">
          <span className="ml-1 inline-flex flex-wrap items-center gap-2 align-middle">
            <span className="text-sm font-semibold text-hxa-text">{t('tasks.attempt', { attempt: run.attempt })}</span>
            {latest && <span className="text-xs text-hxa-text-muted">{t('tasks.latestRun')}</span>}
            <TaskStatusBadge status={run.status} run />
          </span>
          <span className="ml-5 mt-2 block text-xs text-hxa-text-dim">{taskDate(run.started_at, locale)}</span>
        </summary>
        <div className="space-y-4 border-t border-hxa-border p-4 sm:p-5">
          {run.summary && (
            <section aria-label={t('tasks.result')}>
              <h3 className="mb-2 text-sm font-semibold text-hxa-text">{t('tasks.result')}</h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-hxa-text-dim">{run.summary}</p>
            </section>
          )}
          {run.error && (
            <section aria-label={t('tasks.failureReason')} className="rounded-lg border border-hxa-red/20 bg-hxa-red/5 p-3">
              <h3 className="mb-1 text-sm font-semibold text-hxa-red">{t('tasks.failureReason')}</h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-hxa-text">{run.error}</p>
            </section>
          )}
          {run.artifacts.length > 0 && (
            <section aria-label={t('tasks.artifacts')}>
              <h3 className="mb-2 text-sm font-semibold text-hxa-text">{t('tasks.artifacts')}</h3>
              <ul className="space-y-2">
                {run.artifacts.map((artifact, index) => {
                  const href = safeTaskArtifactUrl(artifact.url);
                  return (
                    <li key={artifact.url + ':' + index}>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-lg border border-hxa-border px-3 py-2 text-sm text-hxa-accent hover:bg-hxa-bg-hover focus-visible:outline-2 focus-visible:outline-hxa-accent"
                        >
                          <ExternalLink size={15} className="shrink-0" aria-hidden="true" />
                          <span className="break-words">{artifact.title || href}</span>
                          <span className="sr-only">{t('tasks.opensNewTab')}</span>
                        </a>
                      ) : (
                        <span className="break-words text-sm text-hxa-text-dim">{artifact.title} · {t('tasks.invalidArtifact')}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {!run.summary && !run.error && run.artifacts.length === 0 && (
            <p className="text-sm text-hxa-text-dim">{t(run.status === 'running' ? 'tasks.runPending' : 'tasks.noRunOutput')}</p>
          )}
          <details className="border-t border-hxa-border pt-3">
            <summary className="cursor-pointer text-xs text-hxa-text-dim focus-visible:outline-2 focus-visible:outline-hxa-accent">
              {t('tasks.executionDetails')}
            </summary>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-hxa-text-dim">{t('tasks.runner')}</dt>
                <dd className="mt-1 break-all font-mono text-hxa-text">{run.runner_id}</dd>
              </div>
              <div>
                <dt className="text-hxa-text-dim">{t('tasks.finishedAt')}</dt>
                <dd className="mt-1 text-hxa-text">{run.finished_at === null ? t('tasks.notFinished') : taskDate(run.finished_at, locale)}</dd>
              </div>
            </dl>
          </details>
        </div>
      </details>
    </li>
  );
}

export function TaskDetail({ id, agents }: { id: string; agents: TaskAgent[] }) {
  const { t, locale } = useTranslations();
  const { session } = useSession();
  const [action, setAction] = useState<TaskAction | null>(null);
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const load = useCallback((signal: AbortSignal) => api.getTask(id, signal), [id]);
  const resource = useTaskResource('task:' + id, load, 5000, action === null);
  const task = resource.data?.task;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (task?.id) titleRef.current?.focus();
  }, [task?.id]);
  useEffect(() => {
    if (confirmCancel) cancelConfirmRef.current?.focus();
  }, [confirmCancel]);

  async function performAction(nextAction: TaskAction) {
    if (!task || busy.current) return;
    busy.current = true;
    resource.abort();
    setAction(nextAction);
    setActionError(undefined);
    setNotice('');
    try {
      const updated = await api.actOnTask(task.id, nextAction, task.revision);
      if (!mounted.current) return;
      let runs = resource.data?.runs ?? [];
      if (updated.latest_run) {
        const latest = updated.latest_run;
        runs = [latest, ...runs.filter(run => run.id !== latest.id)];
      }
      resource.replace({ task: updated, runs });
      setConfirmCancel(false);
      setNotice(t('tasks.actionSuccess.' + nextAction));
    } catch (error) {
      if (mounted.current) {
        setActionError(error);
        setConfirmCancel(false);
      }
    } finally {
      busy.current = false;
      // Resuming the resource refreshes the revision and execution history.
      if (mounted.current) setAction(null);
    }
  }

  function dismissCancel() {
    setConfirmCancel(false);
    cancelTriggerRef.current?.focus();
  }

  const botId = session?.bot?.id ?? session?.bot_id;
  const canManage = !!task && (task.created_by === botId || session?.bot?.auth_role === 'admin');
  const canCancel = !!task && ['queued', 'running', 'reviewing', 'failed'].includes(task.status);
  const assignedAgent = agents.find(agent => agent.id === task?.assigned_bot_id);
  const runs = [...(resource.data?.runs ?? [])].sort((a, b) => b.attempt - a.attempt);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href="#/dashboard/tasks/" className="inline-flex min-h-10 items-center gap-2 text-sm text-hxa-text-dim hover:text-hxa-accent focus-visible:outline-2 focus-visible:outline-hxa-accent">
          <ArrowLeft size={16} aria-hidden="true" />{t('tasks.backToList')}
        </a>
        <button type="button" onClick={resource.refresh} disabled={resource.refreshing || action !== null} className={taskButtonClass}>
          <RefreshCw size={15} className={cn(resource.refreshing && 'animate-spin')} aria-hidden="true" />
          {t('tasks.refresh')}
        </button>
      </div>
      {resource.error !== undefined && <TaskError error={resource.error} retry={resource.refresh} />}
      {resource.loading && <TaskLoading />}
      {task && (
        <>
          <header>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <TaskStatusBadge status={task.status} />
              <span className="break-all text-xs font-mono text-hxa-text-muted">{t('tasks.taskId')}: {task.id}</span>
            </div>
            <h1 ref={titleRef} tabIndex={-1} className="break-words text-2xl font-bold leading-snug tracking-tight text-hxa-text outline-none">
              {task.title}
            </h1>
          </header>
          <TaskSimulationNotice />
          <section aria-label={t('tasks.taskDetails')} className="space-y-5 rounded-xl border border-hxa-border p-4 theme-panel sm:p-6">
            <div>
              <h2 className="mb-2 text-sm font-semibold text-hxa-text">{t('tasks.descriptionLabel')}</h2>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-hxa-text-dim">{task.description}</p>
            </div>
            <dl className="grid grid-cols-1 gap-4 border-t border-hxa-border pt-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-hxa-text-dim">{t('tasks.agentLabel')}</dt>
                <dd className="mt-1 break-words font-medium text-hxa-text">{assignedAgent?.name || task.assigned_bot_id}</dd>
              </div>
              <div>
                <dt className="text-xs text-hxa-text-dim">{t('tasks.creatorLabel')}</dt>
                <dd className="mt-1 break-words text-hxa-text">{task.created_by_name}</dd>
              </div>
              <div>
                <dt className="text-xs text-hxa-text-dim">{t('tasks.createdAt')}</dt>
                <dd className="mt-1 text-hxa-text">{taskDate(task.created_at, locale)}</dd>
              </div>
              <div>
                <dt className="text-xs text-hxa-text-dim">{t('tasks.lastUpdated')}</dt>
                <dd className="mt-1 text-hxa-text">{taskDate(task.updated_at, locale)}</dd>
              </div>
            </dl>
            {task.thread_id && (
              <a href={'#/dashboard/threads/' + encodeURIComponent(task.thread_id) + '/'} className={taskButtonClass}>
                <MessageSquare size={16} aria-hidden="true" />{t('tasks.openThread')}
              </a>
            )}
          </section>

          <section aria-label={t('tasks.actions')} className="space-y-4">
            <div className="rounded-xl border border-hxa-border bg-hxa-bg-secondary p-4">
              <p className="text-sm leading-relaxed text-hxa-text">{t('tasks.stateHint.' + task.status)}</p>
              {canManage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {task.status === 'reviewing' && (
                    <button type="button" onClick={() => void performAction('accept')} disabled={action !== null} className={taskPrimaryClass}>
                      {action === 'accept' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                      {t('tasks.accept')}
                    </button>
                  )}
                  {task.status === 'failed' && (
                    <button type="button" onClick={() => void performAction('retry')} disabled={action !== null} className={taskPrimaryClass}>
                      {action === 'retry' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
                      {t('tasks.retry')}
                    </button>
                  )}
                  {canCancel && (
                    <button
                      ref={cancelTriggerRef}
                      type="button"
                      onClick={() => { setConfirmCancel(true); setActionError(undefined); }}
                      disabled={action !== null}
                      aria-expanded={confirmCancel}
                      aria-controls="task-cancel-confirmation"
                      className={cn(taskButtonClass, 'text-hxa-red')}
                    >
                      <X size={16} aria-hidden="true" />{t('tasks.cancel')}
                    </button>
                  )}
                </div>
              )}
              {!canManage && <p className="mt-2 text-xs text-hxa-text-dim">{t('tasks.readOnlyActions')}</p>}
            </div>
            {confirmCancel && canManage && canCancel && (
              <div
                id="task-cancel-confirmation"
                role="group"
                aria-labelledby="task-cancel-title"
                className="rounded-xl border border-hxa-red/30 bg-hxa-red/5 p-4"
                onKeyDown={event => { if (event.key === 'Escape' && action === null) dismissCancel(); }}
              >
                <h2 id="task-cancel-title" className="text-sm font-semibold text-hxa-text">{t('tasks.cancelConfirmTitle')}</h2>
                <p className="mt-1 text-sm leading-relaxed text-hxa-text-dim">{t('tasks.cancelConfirmDescription')}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button ref={cancelConfirmRef} type="button" disabled={action !== null} onClick={() => void performAction('cancel')} className={cn(taskButtonClass, 'border-hxa-red/40 text-hxa-red')}>
                    {action === 'cancel' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {t('tasks.confirmCancel')}
                  </button>
                  <button type="button" disabled={action !== null} onClick={dismissCancel} className={taskButtonClass}>{t('tasks.keepTask')}</button>
                </div>
              </div>
            )}
            {actionError !== undefined && <TaskError error={actionError} />}
            {notice && <p role="status" className="rounded-lg border border-hxa-green/25 bg-hxa-green/5 p-3 text-sm text-hxa-text">{notice}</p>}
          </section>

          <section aria-labelledby="task-runs-title" className="space-y-3">
            <div className="flex items-center gap-2">
              <History size={18} className="text-hxa-accent" aria-hidden="true" />
              <h2 id="task-runs-title" className="font-semibold text-hxa-text">{t('tasks.runHistory')}</h2>
              <span className="text-xs text-hxa-text-dim">({runs.length})</span>
            </div>
            {runs.length > 0 ? (
              <ol className="space-y-3">{runs.map((run, index) => <RunCard key={run.id} run={run} latest={index === 0} />)}</ol>
            ) : (
              <p className="rounded-xl border border-dashed border-hxa-border p-6 text-center text-sm text-hxa-text-dim">{t('tasks.noRuns')}</p>
            )}
          </section>
          <p className="text-xs leading-relaxed text-hxa-text-muted">{t('tasks.pollingNote')}</p>
        </>
      )}
    </div>
  );
}
