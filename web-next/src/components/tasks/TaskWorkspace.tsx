'use client';

import { useCallback } from 'react';
import { useTaskResource } from '@/hooks/useTaskResource';
import { listTaskAgents } from '@/lib/tasks-api';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import { NewTaskForm } from './NewTaskForm';

export function TaskWorkspace({ id }: { id?: string }) {
  const loadAgents = useCallback((signal: AbortSignal) => listTaskAgents(signal), []);
  const agents = useTaskResource('task-agents', loadAgents, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {id === 'new' ? (
        <NewTaskForm
          agents={agents.data?.items ?? []}
          agentsLoading={agents.loading}
          agentsError={agents.error}
          reloadAgents={agents.refresh}
        />
      ) : id ? (
        <TaskDetail key={id} id={id} agents={agents.data?.items ?? []} />
      ) : (
        <TaskList agents={agents.data?.items ?? []} />
      )}
    </div>
  );
}
