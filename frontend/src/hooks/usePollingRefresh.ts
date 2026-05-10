import { useCallback, useEffect, useRef } from "react";

interface UsePollingRefreshOptions {
  intervalMs?: number;
  enabled?: boolean;
  immediate?: boolean;
}

export function usePollingRefresh(
  task: () => Promise<void>,
  options: UsePollingRefreshOptions = {}
): { runNow: () => Promise<void> } {
  const { intervalMs = 15000, enabled = true, immediate = true } = options;
  const inFlightRef = useRef<Promise<void> | null>(null);

  const runNow = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const runPromise = task().finally(() => {
      inFlightRef.current = null;
    });

    inFlightRef.current = runPromise;
    return runPromise;
  }, [task]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (immediate) {
      void runNow();
    }

    const intervalId = window.setInterval(() => {
      void runNow();
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, immediate, intervalMs, runNow]);

  return { runNow };
}
