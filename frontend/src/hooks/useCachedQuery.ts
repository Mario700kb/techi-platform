import { Dispatch, SetStateAction, useCallback, useLayoutEffect, useRef, useState } from "react";
import { appCache } from "../store/appCache";

export interface CachedQuery<T> {
  data: T | undefined;
  /** True only while nothing is on screen yet: no cached copy and no answer. */
  loading: boolean;
  /** True while a request is in flight, whether or not a cached copy is shown. */
  refreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Local update after a mutation; the cached copy follows. */
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/**
 * Stale-while-revalidate for one request: the last answer for `key` is shown
 * at once (before the first paint) and the request refreshes it.
 *
 * Keys under "page." survive a reload (sessionStorage, per operator, cleared
 * on sign-out); keys under "mem." stay in memory, for data that must not be
 * written to the browser's storage (credentials, tokens, audit). A null key
 * fetches nothing.
 */
export function useCachedQuery<T>(key: string | null, fetcher: () => Promise<T>): CachedQuery<T> {
  const [data, setDataState] = useState<T | undefined>(() => (key ? (appCache.peek<T>(key) ?? undefined) : undefined));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const requestKey = keyRef.current;
    if (!requestKey) return;
    const id = ++requestRef.current;
    setRefreshing(true);
    try {
      const value = await fetcherRef.current();
      // A newer request (or another key) owns the screen now.
      if (id !== requestRef.current) return;
      appCache.set(requestKey, value);
      setDataState(value);
      setError(null);
    } catch (err) {
      if (id !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (id === requestRef.current) setRefreshing(false);
    }
  }, []);

  // Before paint: a key change shows that key's cached copy (or nothing) at once.
  useLayoutEffect(() => {
    keyRef.current = key;
    if (!key) {
      requestRef.current += 1;
      setDataState(undefined);
      setRefreshing(false);
      setError(null);
      return;
    }
    setDataState(appCache.peek<T>(key) ?? undefined);
    setError(null);
    void reload();
  }, [key, reload]);

  const setData = useCallback<Dispatch<SetStateAction<T | undefined>>>((next) => {
    setDataState((prev) => {
      const value = typeof next === "function" ? (next as (prev: T | undefined) => T | undefined)(prev) : next;
      const currentKey = keyRef.current;
      if (currentKey && value !== undefined) appCache.set(currentKey, value);
      return value;
    });
  }, []);

  return {
    data,
    loading: key !== null && data === undefined && error === null,
    refreshing,
    error,
    reload,
    setData,
  };
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Loads a query into the cache ahead of time — when the pointer rests on what
 * opens it — so it opens with data instead of a skeleton. Skipped while a copy
 * younger than maxAgeMs is cached or the same key is already loading; errors
 * are left for the real query to show.
 */
export function prefetchQuery<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = 30_000): void {
  if (inFlight.has(key) || appCache.get<T>(key, maxAgeMs) !== null) return;
  const request = fetcher()
    .then((value) => appCache.set(key, value))
    .catch(() => undefined)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
}
