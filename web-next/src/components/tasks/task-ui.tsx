'use client';

import { AlertCircle, FlaskConical, Loader2 } from 'lucide-react';
import { useTranslations } from '@/i18n/context';
import { TasksApiError } from '@/lib/tasks-api';
import type { TaskRunStatus, TaskStatus } from '@/lib/tasks-types';
import { cn } from '@/lib/utils';

export const taskButtonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-hxa-border px-3 py-2 text-sm font-medium text-hxa-text transition-colors hover:bg-hxa-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hxa-accent disabled:cursor-not-allowed disabled:opacity-50';
export const taskPrimaryClass = cn(taskButtonClass, 'gradient-btn border-transparent font-semibold');
export const taskInputClass = 'theme-input w-full rounded-lg border border-hxa-border px-3 py-2.5 text-sm text-hxa-text placeholder:text-hxa-text-muted focus:border-hxa-accent focus:outline-2 focus:outline-offset-2 focus:outline-hxa-accent disabled:opacity-60';

const statusClasses: Record<TaskStatus | TaskRunStatus, string> = {
  queued: 'text-hxa-text-dim bg-hxa-bg-tertiary',
  running: 'text-hxa-blue bg-hxa-blue/10',
  reviewing: 'text-hxa-amber bg-hxa-amber/10',
  completed: 'text-hxa-green bg-hxa-green/10',
  succeeded: 'text-hxa-green bg-hxa-green/10',
  failed: 'text-hxa-red bg-hxa-red/10',
  expired: 'text-hxa-red bg-hxa-red/10',
  cancelled: 'text-hxa-text-dim bg-hxa-bg-tertiary',
};

export function TaskStatusBadge({ status, run = false }: { status: TaskStatus | TaskRunStatus; run?: boolean }) {
  const { t } = useTranslations();
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', statusClasses[status])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {t((run ? 'tasks.runStatus.' : 'tasks.status.') + status)}
    </span>
  );
}

export function TaskSimulationNotice() {
  const { t } = useTranslations();
  return (
    <div className="flex items-start gap-3 rounded-xl border border-hxa-amber/25 bg-hxa-amber/5 p-3.5 text-sm">
      <FlaskConical size={19} className="mt-0.5 shrink-0 text-hxa-amber" aria-hidden="true" />
      <div>
        <p className="font-semibold text-hxa-text">{t('tasks.simulationTitle')}</p>
        <p className="mt-1 leading-relaxed text-hxa-text-dim">{t('tasks.simulationDescription')}</p>
      </div>
    </div>
  );
}

export function TaskLoading() {
  const { t } = useTranslations();
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-hxa-text-dim">
      <Loader2 size={18} className="animate-spin" aria-hidden="true" />
      {t('tasks.loading')}
    </div>
  );
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function taskErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof TasksApiError) {
    if (error.status === 401) return t('tasks.error.session');
    if (error.status === 403) return t('tasks.error.permission');
    if (error.status === 404) return t('tasks.error.notFound');
    if (error.code === 'REVISION_CONFLICT' || error.code === 'INVALID_TRANSITION') return t('tasks.error.conflict');
    if (error.code === 'IDEMPOTENCY_CONFLICT') return t('tasks.error.idempotency');
    if (error.code === 'VALIDATION_ERROR') return t('tasks.error.validation');
    if (error.status === 429) return t('tasks.error.rateLimit');
    if (error.status >= 500) return t('tasks.error.server');
  }
  return t('tasks.error.network');
}

export function TaskError({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useTranslations();
  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 rounded-xl border border-hxa-red/25 bg-hxa-red/5 p-4">
      <AlertCircle size={18} className="mt-0.5 shrink-0 text-hxa-red" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-hxa-text">{taskErrorMessage(error, t)}</p>
      {retry && <button type="button" onClick={retry} className={taskButtonClass}>{t('tasks.reload')}</button>}
    </div>
  );
}

export function taskDate(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Keep runner-provided links inert unless they are ordinary web URLs. */
export function safeTaskArtifactUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
