interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

class AppCache {
  private store = new Map<string, CacheEntry<unknown>>();

  set<T>(key: string, data: T): void {
    this.store.set(key, { data, cachedAt: Date.now() });
  }

  /** Returns data only if within TTL, null if expired or missing. */
  get<T>(key: string, ttlMs: number): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > ttlMs) return null;
    return entry.data;
  }

  /** Stale-while-revalidate: returns data regardless of age, null only if never fetched. */
  peek<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    return entry ? entry.data : null;
  }

  invalidate(key?: string): void {
    if (key) this.store.delete(key);
    else this.store.clear();
  }
}

export const appCache = new AppCache();

export const CACHE_KEYS = {
  dashboardSnapshot:  "dashboard.snapshot",     // DevicesSummary
  recentActions:      "dashboard.actions",       // RemoteActionWithDevice[]
  operatorPresence:   "dashboard.op-presence",   // OperatorPresenceRecord[]
  recentDeployments:  "dashboard.deployments",   // RecentDeployment[]
  clientsList:        "clients.list",            // Client[]
  groupsList:         "clients.groups",          // DeviceGroup[]
  operatorsList:      "operators.list",          // OperatorRecord[]
} as const;

export const CACHE_TTL = {
  dashboardSnapshot:  60_000,
  recentActions:      30_000,
  operatorPresence:   30_000,
  recentDeployments:  60_000,
  clientsList:        120_000,
  groupsList:         120_000,
  operatorsList:      120_000,
} as const;
