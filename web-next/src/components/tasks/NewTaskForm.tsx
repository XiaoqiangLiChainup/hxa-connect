'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Send } from 'lucide-react';
import { useDashNav } from '@/app/dashboard/shell';
import { useTranslations } from '@/i18n/context';
import * as api from '@/lib/tasks-api';
import type { TaskAgent } from '@/lib/tasks-types';
import {
  TaskError, TaskLoading, TaskSimulationNotice, taskInputClass, taskPrimaryClass,
} from './task-ui';

interface NewTaskFormProps {
  agents: TaskAgent[];
  agentsLoading: boolean;
  agentsError: unknown;
  reloadAgents: () => void;
}

function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'task-' + Array.from(crypto.getRandomValues(new Uint32Array(4)), part => part.toString(16)).join('-');
}

export function NewTaskForm({ agents, agentsLoading, agentsError, reloadAgents }: NewTaskFormProps) {
  const { t } = useTranslations();
  const { navigate } = useDashNav();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [agentId, setAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [validation, setValidation] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const titleInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    titleInput.current?.focus();
    return () => { mounted.current = false; };
  }, []);

  function edited() {
    requestKey.current = null;
    setError(undefined);
    setValidation(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    if (!title.trim() || !description.trim() || !agents.some(agent => agent.id === agentId)) {
      setValidation(t('tasks.formRequired'));
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    setValidation(null);
    // Keep the key after network failures; an edited request receives a new key.
    requestKey.current ??= newIdempotencyKey();
    try {
      const task = await api.createTask({
        title: title.trim(),
        description: description.trim(),
        assigned_bot_id: agentId,
      }, requestKey.current);
      if (mounted.current) navigate('/dashboard/tasks/' + encodeURIComponent(task.id) + '/');
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      busy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6 lg:p-8">
      <a href="#/dashboard/tasks/" className="inline-flex min-h-10 items-center gap-2 text-sm text-hxa-text-dim hover:text-hxa-accent focus-visible:outline-2 focus-visible:outline-hxa-accent">
        <ArrowLeft size={16} aria-hidden="true" />{t('tasks.backToList')}
      </a>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-hxa-text">{t('tasks.create')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-hxa-text-dim">{t('tasks.createDescription')}</p>
      </div>
      <TaskSimulationNotice />
      <form onSubmit={handleSubmit} className="rounded-xl border border-hxa-border p-4 theme-panel sm:p-6" aria-busy={submitting}>
        <fieldset disabled={submitting} className="min-w-0 space-y-5">
          <legend className="sr-only">{t('tasks.formLegend')}</legend>
          <div>
            <label htmlFor="task-title" className="mb-2 block text-sm font-semibold text-hxa-text">{t('tasks.titleLabel')}</label>
            <input
              ref={titleInput}
              id="task-title"
              name="title"
              value={title}
              maxLength={200}
              required
              onChange={event => { setTitle(event.target.value); edited(); }}
              placeholder={t('tasks.titlePlaceholder')}
              className={taskInputClass}
            />
          </div>
          <div>
            <label htmlFor="task-description" className="mb-2 block text-sm font-semibold text-hxa-text">{t('tasks.descriptionLabel')}</label>
            <textarea
              id="task-description"
              name="description"
              value={description}
              rows={7}
              maxLength={20000}
              required
              onChange={event => { setDescription(event.target.value); edited(); }}
              placeholder={t('tasks.descriptionPlaceholder')}
              aria-describedby="task-description-hint"
              className={taskInputClass + ' min-h-40 resize-y'}
            />
            <p id="task-description-hint" className="mt-2 text-xs leading-relaxed text-hxa-text-dim">{t('tasks.descriptionHint')}</p>
          </div>
          <div>
            <label htmlFor="task-agent" className="mb-2 block text-sm font-semibold text-hxa-text">{t('tasks.agentLabel')}</label>
            {agentsLoading ? <TaskLoading /> : (
              <select
                id="task-agent"
                name="assigned_bot_id"
                required
                value={agentId}
                disabled={agents.length === 0}
                onChange={event => { setAgentId(event.target.value); edited(); }}
                aria-describedby="task-agent-hint"
                className={taskInputClass}
              >
                <option value="">{t('tasks.chooseAgent')}</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name + (agent.role ? ' · ' + agent.role : '') + ' · ' + t(agent.online ? 'tasks.agentOnline' : 'tasks.agentOffline')}
                  </option>
                ))}
              </select>
            )}
            <p id="task-agent-hint" className="mt-2 text-xs leading-relaxed text-hxa-text-dim">{t('tasks.agentHint')}</p>
            {!agentsLoading && agentsError === undefined && agents.length === 0 && (
              <p role="status" className="mt-3 rounded-lg border border-hxa-border p-3 text-sm text-hxa-text-dim">{t('tasks.noAgents')}</p>
            )}
          </div>
        </fieldset>
        {agentsError !== undefined && <div className="mt-5"><TaskError error={agentsError} retry={reloadAgents} /></div>}
        {validation && <p role="alert" className="mt-5 text-sm text-hxa-red">{validation}</p>}
        {error !== undefined && (
          <div className="mt-5 space-y-2">
            <TaskError error={error} />
            <p className="text-xs leading-relaxed text-hxa-text-dim">{t('tasks.retrySubmissionHint')}</p>
          </div>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-hxa-border pt-5">
          <p className="max-w-md text-xs leading-relaxed text-hxa-text-dim">{t('tasks.submitHint')}</p>
          <button type="submit" disabled={submitting || agentsLoading || agents.length === 0} className={taskPrimaryClass}>
            {submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            {t(submitting ? 'tasks.submitting' : 'tasks.submit')}
          </button>
        </div>
      </form>
      {submitting && <p role="status" className="text-xs text-hxa-text-dim">{t('tasks.submittingHint')}</p>}
    </div>
  );
}
