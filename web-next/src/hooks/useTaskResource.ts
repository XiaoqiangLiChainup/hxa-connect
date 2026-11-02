'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

function isPageVisible() {
  return document.visibilityState !== 'hidden';
}

/**
 * Refresh only while the page is visible. Requests are serial and abortable;
 * resource keys and generations prevent late responses replacing another task.
 * A zero interval loads once, with manual refresh and visibility recovery.
 */
export function useTaskResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs = 5000,
  enabled = true,
) {
  const [result, setResult] = useState<{ key: string; value: T } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);

  const abort = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function clearTimer() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      clearTimer();
      if (!disposed && enabled && intervalMs > 0 && isPageVisible()) {
        timer = setTimeout(refresh, intervalMs);
      }
    }

    async function refresh() {
      clearTimer();
      abort();
      if (disposed || !enabled || !isPageVisible()) {
        setRefreshing(false);
        return;
      }
      const requestGeneration = generation.current;
      const requestController = new AbortController();
      controller.current = requestController;
      setRefreshing(true);
      try {
        const value = await load(requestController.signal);
        if (!disposed && requestGeneration === generation.current) {
          setResult({ key, value });
          setFailure(null);
        }
      } catch (error) {
        if (!disposed && requestGeneration === generation.current && !requestController.signal.aborted) {
          setFailure({ key, error });
        }
      } finally {
        if (!disposed && requestGeneration === generation.current) {
          controller.current = null;
          setRefreshing(false);
          schedule();
        }
      }
    }

    function onVisibilityChange() {
      if (!isPageVisible()) {
        clearTimer();
        abort();
        setRefreshing(false);
      } else {
        void refresh();
      }
    }

    refreshRef.current = refresh;
    scheduleRef.current = schedule;
    void refresh();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      clearTimer();
      abort();
      if (refreshRef.current === refresh) refreshRef.current = null;
      if (scheduleRef.current === schedule) scheduleRef.current = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [key, load, intervalMs, enabled, abort]);

  const refresh = useCallback(() => refreshRef.current?.(), []);
  const replace = useCallback((value: T) => {
    abort();
    setResult({ key, value });
    setFailure(null);
    setRefreshing(false);
    // An aborted request cannot schedule from its finally block.
    scheduleRef.current?.();
  }, [abort, key]);

  const data = result?.key === key ? result.value : undefined;
  const error = failure?.key === key ? failure.error : undefined;
  return { data, error, loading: data === undefined && error === undefined, refreshing, refresh, abort, replace };
}
