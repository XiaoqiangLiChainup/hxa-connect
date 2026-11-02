'use client';

import { ClipboardList, Plus } from 'lucide-react';
import { useDashNav } from '@/app/dashboard/shell';
import { useTranslations } from '@/i18n/context';
import { cn } from '@/lib/utils';

export function TaskSidebar() {
  const { id, navigate } = useDashNav();
  const { t } = useTranslations();
  const newTask = id === 'new';
  return (
    <nav aria-label={t('tasks.navigation')} className="space-y-2 p-1">
      <button
        type="button"
        aria-current={!newTask ? 'page' : undefined}
        onClick={() => navigate('/dashboard/tasks/')}
        className={cn(
          'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-hxa-accent',
          !newTask ? 'bg-hxa-accent/10 text-hxa-accent' : 'text-hxa-text-dim hover:bg-hxa-bg-hover',
        )}
      >
        <ClipboardList size={17} aria-hidden="true" />{t('tasks.allTasks')}
      </button>
      <button
        type="button"
        aria-current={newTask ? 'page' : undefined}
        onClick={() => navigate('/dashboard/tasks/new/')}
        className={cn(
          'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-hxa-accent',
          newTask ? 'bg-hxa-accent/10 text-hxa-accent' : 'text-hxa-text-dim hover:bg-hxa-bg-hover',
        )}
      >
        <Plus size={17} aria-hidden="true" />{t('tasks.create')}
      </button>
      <div className="mx-3 mt-6 border-t border-hxa-border pt-5">
        <p className="text-xs font-semibold text-hxa-text">{t('tasks.sidebarTitle')}</p>
        <p className="mt-2 text-xs leading-relaxed text-hxa-text-dim">{t('tasks.sidebarDescription')}</p>
        <p className="mt-4 text-xs leading-relaxed text-hxa-text-muted">{t('tasks.identityNote')}</p>
      </div>
    </nav>
  );
}
