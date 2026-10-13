interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const STORAGE_PREFIX = "techi.cache.v1:";
// Kept in sessionStorage as well, so a reload paints the Devices page (last
// page, badges, tab counts, Explorer) and the dashboard's sections (recent
// enrollments, actions, operators, trends) at once and then revalidates.
const PERSISTED_PREFIXES = [
  "devices-table",
  "devices.details",
  "devices.quick-counts",
  "clients.list",
  "clients.groups",
  "dashboard.",
];

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

class AppCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private scope = "";

  /** The signed-in operator: persisted entries are per operator, memory is cleared on a switch. */
  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.store.clear();
    this.scope = scope;
  }

  private storageKey(key: string): string {
    return `${STORAGE_PREFIX}${this.scope}:${key}`;
  }

  private persists(key: string): boolean {
    return this.scope !== "" && PERSISTED_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  private clearStorage(prefix = STORAGE_PREFIX): void {
    const s = storage();
    if (!s) return;
    for (const key of Object.keys(s)) {
      if (key.startsWith(prefix)) s.removeItem(key);
    }
  }

  private read<T>(key: string): CacheEntry<T> | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (entry || !this.persists(key)) return entry;
    try {
      const raw = storage()?.getItem(this.storageKey(key));
      if (!raw) return undefined;
      const restored = JSON.parse(raw) as CacheEntry<T>;
      this.store.set(key, restored);
      return restored;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, data: T): void {
    const entry = { data, cachedAt: Date.now() };
    this.store.set(key, entry);
    if (!this.persists(key)) return;
    const s = storage();
    if (!s) return;
    const value = JSON.stringify(entry);
    try {
      s.setItem(this.storageKey(key), value);
    } catch {
      // Quota: drop the persisted copies (memory keeps working) and try once more.
      this.clearStorage();
      try {
        s.setItem(this.storageKey(key), value);
      } catch {
        // Still too big: this entry lives in memory only.
      }
    }
  }

  /** Returns data only if within TTL, null if expired or missing. */
  get<T>(key: string, ttlMs: number): T | null {
    const entry = this.read<T>(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > ttlMs) return null;
    return entry.data;
  }

  /** Stale-while-revalidate: returns data regardless of age, null only if never fetched. */
  peek<T>(key: string): T | null {
    return this.read<T>(key)?.data ?? null;
  }

  /** Without a key: everything, persisted copies of every operator included (sign-out). */
  invalidate(key?: string): void {
    if (key) {
      this.store.delete(key);
      storage()?.removeItem(this.storageKey(key));
    } else {
      this.store.clear();
      this.clearStorage();
    }
  }

  invalidatePrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
    this.clearStorage(this.storageKey(prefix));
  }
}

export const appCache = new AppCache();

export const CACHE_KEYS = {
  dashboardRecentDevices: "dashboard.recent-devices", // Device[]
  recentActions: "dashboard.actions", // RemoteActionWithDevice[]
  operatorPresence: "dashboard.op-presence", // OperatorPresenceRecord[]
  clientsList: "clients.list", // Client[]
  groupsList: "clients.groups", // DeviceGroup[]
  devicesDetails: "devices.details", // DeviceTableDetails, suffixed with the table key
  devicesQuickCounts: "devices.quick-counts", // DeviceQuickCounts, suffixed with the filters
  operatorsList: "operators.list", // OperatorRecord[]
  dashboardInsights: "dashboard.insights", // FleetInsights, suffixed with the user id
} as const;

export const CACHE_TTL = {
  dashboardRecentDevices: 60_000,
  recentActions: 30_000,
  operatorPresence: 30_000,
  clientsList: 120_000,
  groupsList: 120_000,
  operatorsList: 120_000,
  devicesTable: 30_000,
} as const;

export function deviceTableCacheKey(
  page: number,
  limit: number,
  search: string,
  quickFilter: string,
  filters: Record<string, unknown>,
): string {
  return [
    "devices-table",
    page,
    limit,
    search,
    quickFilter,
    filters.status ?? "",
    filters.freshness_state ?? "",
    filters.maintenance_state ?? "",
    filters.client_id ?? "",
    filters.group_id ?? "",
    filters.smart_folder ?? "",
    // category + platform are tree-node filters (Platform Expansion). They MUST
    // be in the key: two selections within a client differ only by these, so
    // omitting them collides the SWR cache and serves the previous selection's
    // rows until a manual Refresh (regression after the tree moved off
    // smart_folder/device_type to category/platform).
    filters.category ?? "",
    filters.platform ?? "",
    filters.duplicate_candidates ?? "",
    filters.lifecycle_state ?? "",
    Array.isArray(filters.ids) ? filters.ids.join(",") : "",
    filters.agent_version ?? "",
    filters.hide_offline_days ?? "",
    filters.sort ?? "",
    filters.order ?? "",
  ].join("|");
}
