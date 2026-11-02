'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { ArrowUpRight, ClipboardList, Plus, RefreshCw } from 'lucide-react';
import { useTranslations } from '@/i18n/context';
import { useTaskResource } from '@/hooks/useTaskResource';
import * as api from '@/lib/tasks-api';
import { TASK_STATUSES, type TaskAgent, type TaskStatus } from '@/lib/tasks-types';
import { cn } from '@/lib/utils';
import {
  TaskError, TaskLoading, TaskSimulationNotice, TaskStatusBadge,
  taskButtonClass, taskDate, taskInputClass, taskPrimaryClass,
} from './task-ui';

export function TaskList({ agents }: { agents: TaskAgent[] }) {
  const { t, locale } = useTranslations();
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const load = useCallback(
    (signal: AbortSignal) => api.listTasks({ status: status || undefined, limit: 100 }, signal),
    [status],
  );
  const resource = useTaskResource('tasks:' + status, load);
  useEffect(() => { titleRef.current?.focus(); }, []);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 ref={titleRef} tabIndex={-1} className="text-2xl font-bold tracking-tight text-hxa-text outline-none">
            {t('tasks.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-hxa-text-dim">{t('tasks.subtitle')}</p>
        </div>
        <a href="#/dashboard/tasks/new/" className={taskPrimaryClass}>
          <Plus size={17} aria-hidden="true" />{t('tasks.create')}
        </a>
      </div>
      <TaskSimulationNotice />

      <section aria-label={t('tasks.listLabel')} className="overflow-hidden rounded-xl border border-hxa-border theme-panel">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-hxa-border p-4">
          <div className="w-full sm:w-56">
            <label htmlFor="task-status-filter" className="mb-1.5 block text-xs font-semibold text-hxa-text-dim">
              {t('tasks.filter')}
            </label>
            <select
              id="task-status-filter"
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
              className={taskInputClass}
            >
              <option value="">{t('tasks.allStatuses')}</option>
              {TASK_STATUSES.map(value => <option key={value} value={value}>{t('tasks.status.' + value)}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-hxa-text-dim" aria-live="polite">
              {resource.data ? t('tasks.count', { count: resource.data.total }) : ''}
            </span>
            <button type="button" onClick={resource.refresh} disabled={resource.refreshing} className={taskButtonClass}>
              <RefreshCw size={15} className={cn(resource.refreshing && 'animate-spin')} aria-hidden="true" />
              {t('tasks.refresh')}
            </button>
          </div>
        </div>

        {resource.error !== undefined && <div className="p-4"><TaskError error={resource.error} retry={resource.refresh} /></div>}
        {resource.loading && <TaskLoading />}
        {resource.data && resource.data.items.length === 0 && (
          <div className="flex flex-col items-center px-5 py-14 text-center">
            <div className="mb-4 rounded-2xl bg-hxa-accent/10 p-4 text-hxa-accent">
              <ClipboardList size={29} aria-hidden="true" />
            </div>
            <h2 className="font-semibold text-hxa-text">{t(status ? 'tasks.emptyFiltered' : 'tasks.emptyTitle')}</h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-hxa-text-dim">
              {t(status ? 'tasks.emptyFilteredHint' : 'tasks.emptyDescription')}
            </p>
            {!status && (
              <a href="#/dashboard/tasks/new/" className={cn(taskButtonClass, 'mt-5')}>
                <Plus size={16} aria-hidden="true" />{t('tasks.createFirst')}
              </a>
            )}
          </div>
        )}
        {resource.data && resource.data.items.length > 0 && (
          <ul className="divide-y divide-hxa-border">
            {resource.data.items.map(task => {
              const agent = agents.find(item => item.id === task.assigned_bot_id);
              return (
                <li key={task.id}>
                  <a
                    href={'#/dashboard/tasks/' + encodeURIComponent(task.id) + '/'}
                    className="group block p-4 transition-colors hover:bg-hxa-bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-hxa-accent sm:p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="break-words text-sm font-semibold text-hxa-text group-hover:text-hxa-accent sm:text-base">{task.title}</h2>
                        {task.description && <p className="mt-1.5 line-clamp-2 break-words text-sm leading-relaxed text-hxa-text-dim">{task.description}</p>}
                      </div>
                      <ArrowUpRight size={18} className="mt-0.5 shrink-0 text-hxa-text-muted group-hover:text-hxa-accent" aria-hidden="true" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-hxa-text-dim">
                      <TaskStatusBadge status={task.status} />
                      <span className="break-all">{t('tasks.agentLabel')}: {agent?.name || task.assigned_bot_id}</span>
                      <span className="break-words">{t('tasks.creatorLabel')}: {task.created_by_name}</span>
                      <time dateTime={new Date(task.updated_at).toISOString()} className="sm:ml-auto">
                        {t('tasks.updatedAt', { date: taskDate(task.updated_at, locale) })}
                      </time>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {resource.data && resource.data.total > resource.data.items.length && (
          <p className="border-t border-hxa-border px-4 py-3 text-xs text-hxa-text-dim">
            {t('tasks.limitNote', { shown: resource.data.items.length, total: resource.data.total })}
          </p>
        )}
      </section>
      <p className="text-xs leading-relaxed text-hxa-text-muted">{t('tasks.pollingNote')}</p>
    </div>
  );
}
