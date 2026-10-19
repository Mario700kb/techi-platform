import { CSSProperties, memo, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronRight,
  IdCard,
  Folder,
  HardDrive,
  Layers,
  LayoutGrid,
  MapPin,
  MapPinOff,
  Monitor,
  Network,
  PackageX,
  RefreshCcw,
  Search,
  Server,
  X,
} from "lucide-react";
import clsx from "clsx";
import { Client, DeviceGroup } from "../api/clients";
import { Device, DeviceStats, TreeLocation, TreeLocationCounts } from "../api/devices";
import PlatformIcon from "./PlatformIcon";
import { shortSiteName } from "../utils/location";
import { TERMS } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";

// Platform label for a sub-folder key (Platform Expansion). Extending to a new
// platform is one entry here — the tree needs no other change.
const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  mikrotik: "MikroTik",
  synology: "Synology",
  qnap: "QNAP",
  vmware: "VMware",
  hyperv: "Hyper-V",
  proxmox: "Proxmox",
};

const SHOW_EMPTY_STORAGE_KEY = "techi.deviceTree.showEmptyGroups";
const CLIENT_FOLDERS = [
  { id: "servers", label: TERMS.servers, icon: Server },
  { id: "clientpc", label: TERMS.clientPcs, icon: Monitor },
  // Platform-class categories (Phase 7). Shown only when they have devices
  // (folderCount > 0) → with all platform flags off they never appear, so the
  // tree is identical to today. Placement is automatic (backend classifies).
  { id: "network", label: "Network", icon: Network },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "hypervisors", label: "Hypervisors", icon: Layers },
  // Devices in a custom (non-standard) group. Shown only when non-empty, like
  // the platform-class folders — with today's fleet (0 custom groups) it never
  // appears. Category comes from the Unified Classification Engine.
  { id: "other", label: "Other", icon: Folder },
] as const;

const readShowEmptyGroups = () => {
  try {
    return window.localStorage.getItem(SHOW_EMPTY_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

interface TreeCounts {
  total: number;
  unassigned: number;
  byClient: Map<number, number>;
  byClientCategory: Map<number, Map<string, number>>;
  byClientCategoryPlatform?: Map<number, Map<string, Map<string, number>>>;
  byClientStatus?: Map<number, DeviceStats>;
  // Client sites: the locations, and clientId → locationId (0: none) → counts.
  locations?: TreeLocation[];
  byClientLocation?: Map<number, Map<number, TreeLocationCounts>>;
}

const sumStats = (items: (DeviceStats | undefined)[]): DeviceStats =>
  items.reduce<DeviceStats>(
    (acc, s) => ({
      total: acc.total + (s?.total ?? 0),
      online: acc.online + (s?.online ?? 0),
      stale: acc.stale + (s?.stale ?? 0),
      offline: acc.offline + (s?.offline ?? 0),
    }),
    { total: 0, online: 0, stale: 0, offline: 0 },
  );

interface DeviceTreeProps {
  selectedKey: string;
  onSelect: (key: string) => void;
  devices: Device[];
  clients: Client[];
  groups: DeviceGroup[];
  treeCounts: TreeCounts;
  showPlatformFolders?: boolean;
  onRefreshCounts: () => void;
}

const DeviceTree = memo(function DeviceTree({
  selectedKey,
  onSelect,
  devices,
  clients,
  treeCounts,
  showPlatformFolders = false,
  onRefreshCounts,
}: DeviceTreeProps) {
  const navigate = useNavigate();
  const [expandedClients, setExpandedClients] = useState<Set<number>>(new Set());
  // Cities and locations opened below a client, by tree key.
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // Each client's sites, grouped by country and city (a city row only when it
  // holds more than one site).
  const sitesByClient = useMemo(() => {
    const byClient = new Map<number, { cityKey: string; city: string; country: string; sites: TreeLocation[] }[]>();
    const sorted = [...(treeCounts.locations ?? [])].sort(
      (a, b) =>
        a.country.localeCompare(b.country) ||
        a.city.localeCompare(b.city, undefined, { sensitivity: "base" }) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    for (const site of sorted) {
      const cities = byClient.get(site.client_id) ?? [];
      const last = cities[cities.length - 1];
      if (last && last.country === site.country && last.city.toLowerCase() === site.city.toLowerCase()) {
        last.sites.push(site);
      } else {
        cities.push({ cityKey: "", city: site.city, country: site.country, sites: [site] });
      }
      byClient.set(site.client_id, cities);
    }
    for (const [clientId, cities] of byClient) {
      for (const city of cities)
        city.cityKey = `client-${clientId}-locs-${city.sites
          .map((x) => x.id)
          .sort((a, b) => a - b)
          .join(".")}`;
    }
    return byClient;
  }, [treeCounts.locations]);

  // A selection inside a client (a reload with ?folder=, a link) opens its branch.
  useEffect(() => {
    const match = selectedKey.match(/^client-(\d+)-/);
    if (!match) return;
    const clientId = Number(match[1]);
    setExpandedClients((prev) => (prev.has(clientId) ? prev : new Set(prev).add(clientId)));
    const site = selectedKey.match(/^(client-\d+-loc-(\d+|none))-/);
    const opened: string[] = [];
    if (site) opened.push(site[1]);
    const siteId = site?.[2] ?? selectedKey.match(/^client-\d+-loc-(\d+)$/)?.[1];
    if (siteId && siteId !== "none") {
      const city = sitesByClient.get(clientId)?.find((c) => c.sites.some((x) => String(x.id) === siteId));
      if (city && city.sites.length > 1) opened.push(city.cityKey);
    }
    if (opened.length) {
      setExpandedNodes((prev) => (opened.every((k) => prev.has(k)) ? prev : new Set([...prev, ...opened])));
    }
  }, [selectedKey, sitesByClient]);

  const toggleNode = (key: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    onSelect(key);
  };
  const [showEmptyGroups, setShowEmptyGroups] = useState(readShowEmptyGroups);
  const [clientQuery, setClientQuery] = useState("");

  // Use stable treeCounts for all top-level counts — not recalculated on heartbeat
  const allCount = treeCounts.total;
  const unassignedCount = treeCounts.unassigned;
  const clientCount = (clientId: number) => treeCounts.byClient.get(clientId) ?? 0;

  const treeIndex = useMemo(() => {
    const maintenanceClients = new Set<number>();
    const maintenanceFolders = new Set<string>();
    for (const device of devices) {
      const clientId = device.resolved_client_id ?? device.client_id ?? null;
      if (clientId === null) continue;
      const category = device.resolved_device_category ?? "unassigned";
      const key = `${clientId}:${category}`;
      if (device.is_in_maintenance) {
        maintenanceClients.add(clientId);
        maintenanceFolders.add(key);
      }
    }
    return { maintenanceClients, maintenanceFolders };
  }, [devices]);
  const folderCount = (clientId: number, folderId: string) =>
    treeCounts.byClientCategory.get(clientId)?.get(folderId) ?? 0;
  // Platform sub-folders: [platform, count] under a client's category, sorted
  // with windows first. Empty unless FEATURE_LINUX is on (backend returns {}).
  const platformChildren = (clientId: number, folderId: string): Array<[string, number]> => {
    const plats = treeCounts.byClientCategoryPlatform?.get(clientId)?.get(folderId);
    if (!plats) return [];
    return [...plats.entries()].sort(([a], [b]) => (a === "windows" ? -1 : b === "windows" ? 1 : a.localeCompare(b)));
  };
  const clientHasMaintenance = (clientId: number) => treeIndex.maintenanceClients.has(clientId);
  const folderHasMaintenance = (clientId: number, folderId: string) =>
    treeIndex.maintenanceFolders.has(`${clientId}:${folderId}`);
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [clients],
  );
  const visibleClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    const matching = q ? sortedClients.filter((client) => client.name.toLowerCase().includes(q)) : sortedClients;
    if (showEmptyGroups) return matching;
    return matching.filter((client) => {
      const hasDevices = (treeCounts.byClient.get(client.id) ?? 0) > 0;
      const isActive = selectedKey === `client-${client.id}` || selectedKey.startsWith(`client-${client.id}-`);
      return hasDevices || isActive;
    });
  }, [treeCounts, selectedKey, showEmptyGroups, sortedClients, clientQuery]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_EMPTY_STORAGE_KEY, String(showEmptyGroups));
    } catch {
      // Storage blocked (private mode): the toggle still works for this visit.
    }
  }, [showEmptyGroups]);

  const toggleClient = (clientId: number) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
    onSelect(`client-${clientId}`);
  };

  return (
    <aside className="premium-card th-explorer p-0" aria-label="Device explorer">
      <header className="th-explorer-head">
        <div className="min-w-0">
          <h2>Explorer</h2>
          <p>
            {formatCount(allCount)} {allCount === 1 ? "device" : "devices"} · {formatCount(sortedClients.length)}{" "}
            {sortedClients.length === 1 ? "client" : "clients"}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefreshCounts}
          className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7"
          title="Refresh counts"
          aria-label="Refresh counts"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="fleet-tree min-h-0 flex-1 overflow-y-auto">
        <p className="th-explorer-label">Fleet</p>
        <ul className="th-explorer-list">
          <li className="th-tree-row" style={{ "--i": 0 } as CSSProperties}>
            <TreeButton
              active={selectedKey === "all"}
              icon={LayoutGrid}
              label="All devices"
              count={allCount}
              onClick={() => onSelect("all")}
            />
          </li>
          <li className="th-tree-row" style={{ "--i": 1 } as CSSProperties}>
            <TreeButton
              active={selectedKey === "unassigned"}
              icon={PackageX}
              label={TERMS.noClient}
              count={unassignedCount}
              onClick={() => onSelect("unassigned")}
            />
          </li>
        </ul>

        {/* Stays in view while the client list scrolls underneath. */}
        <div className="th-explorer-sticky">
          <div className="th-explorer-label !p-0">
            <span>Clients</span>
            <span
              className="tabular-nums"
              aria-label={`Showing ${visibleClients.length} of ${sortedClients.length} clients`}
              title={`Showing ${visibleClients.length} of ${sortedClients.length} clients`}
            >
              {visibleClients.length === sortedClients.length
                ? formatCount(sortedClients.length)
                : `${formatCount(visibleClients.length)} of ${formatCount(sortedClients.length)}`}
            </span>
          </div>
          <label className="th-search th-search-sm">
            <Search className="h-3.5 w-3.5 flex-none" />
            <input
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
              placeholder="Filter clients"
              aria-label="Filter clients"
            />
            {clientQuery && (
              <button
                type="button"
                onClick={() => setClientQuery("")}
                className="th-explorer-clear"
                aria-label="Clear filter"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
        </div>

        <ul className="th-explorer-list pb-2">
          {visibleClients.length === 0 && (
            <li className="th-explorer-empty">{clientQuery ? "No clients match." : "No clients with devices."}</li>
          )}
          {visibleClients.map((client, index) => {
            const childFolders = CLIENT_FOLDERS.filter((folder) => {
              if (showEmptyGroups) return true;
              return folderCount(client.id, folder.id) > 0 || selectedKey === `client-${client.id}-${folder.id}`;
            });
            const expanded = expandedClients.has(client.id);
            const cities = sitesByClient.get(client.id);
            const hasSites = !!cities?.length;
            return (
              <li key={client.id} className="th-tree-row" style={{ "--i": Math.min(index + 2, 16) } as CSSProperties}>
                <TreeButton
                  active={selectedKey === `client-${client.id}`}
                  withinActive={
                    selectedKey.startsWith(`client-${client.id}-`) ||
                    (expanded && (hasSites || childFolders.length > 0))
                  }
                  expanded={expanded}
                  hasChildren={hasSites || childFolders.length > 0}
                  status={treeCounts.byClientStatus?.get(client.id)}
                  label={client.name}
                  count={clientCount(client.id)}
                  hasMaintenance={clientHasMaintenance(client.id)}
                  onClick={() => toggleClient(client.id)}
                />
                {(hasSites || childFolders.length > 0) && (
                  // Always rendered so the branch can slide closed as well as
                  // open; a closed branch is hidden from focus and the a11y tree.
                  <div className="th-tree-collapse" data-open={expanded} aria-hidden={!expanded}>
                    <div className="th-tree-collapse-inner">
                      <ul className="fleet-tree-child">
                        <li style={{ "--i": 0 } as CSSProperties}>
                          <TreeButton
                            active={false}
                            child
                            icon={IdCard}
                            label="Client profile"
                            count={null}
                            onClick={() => navigate(`/clients/${client.id}`)}
                          />
                        </li>
                        {hasSites && (
                          <SiteBranch
                            clientId={client.id}
                            cities={cities!}
                            counts={treeCounts.byClientLocation?.get(client.id)}
                            selectedKey={selectedKey}
                            expandedNodes={expandedNodes}
                            showEmptyGroups={showEmptyGroups}
                            showPlatformFolders={showPlatformFolders}
                            onToggle={toggleNode}
                            onSelect={onSelect}
                          />
                        )}
                        {!hasSites &&
                          childFolders.map((folder, folderIndex) => {
                            const platforms = showPlatformFolders ? platformChildren(client.id, folder.id) : [];
                            // One platform repeats its folder's count, so it becomes an icon on the folder row.
                            const onlyPlatform = platforms.length === 1 ? platforms[0][0] : null;
                            return (
                              <li key={folder.id} style={{ "--i": folderIndex + 1 } as CSSProperties}>
                                <TreeButton
                                  active={selectedKey === `client-${client.id}-${folder.id}`}
                                  child
                                  icon={folder.icon}
                                  label={folder.label}
                                  platformBadge={onlyPlatform}
                                  count={folderCount(client.id, folder.id)}
                                  hasMaintenance={folderHasMaintenance(client.id, folder.id)}
                                  onClick={() => onSelect(`client-${client.id}-${folder.id}`)}
                                />
                                {platforms.length > 1 && (
                                  <ul className="fleet-tree-child">
                                    {platforms.map(([platform, count]) => {
                                      const key = `client-${client.id}-${folder.id}-${platform}`;
                                      return (
                                        <li key={platform}>
                                          <TreeButton
                                            active={selectedKey === key}
                                            child
                                            platformIcon={platform}
                                            label={PLATFORM_LABELS[platform] ?? platform}
                                            count={count}
                                            onClick={() => onSelect(key)}
                                          />
                                        </li>
                                      );
                                    })}
                                  </ul>
                                )}
                              </li>
                            );
                          })}
                      </ul>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <label className="th-explorer-foot">
        <span>Show empty clients</span>
        <input
          type="checkbox"
          role="switch"
          className="th-switch"
          checked={showEmptyGroups}
          onChange={(event) => setShowEmptyGroups(event.target.checked)}
        />
      </label>
    </aside>
  );
});

export default DeviceTree;

type CityGroup = { cityKey: string; city: string; country: string; sites: TreeLocation[] };

/** A client's sites: city rows (when a city holds several), each site with its
 *  categories and platforms, then the devices at no site. */
function SiteBranch({
  clientId,
  cities,
  counts,
  selectedKey,
  expandedNodes,
  showEmptyGroups,
  showPlatformFolders,
  onToggle,
  onSelect,
}: {
  clientId: number;
  cities: CityGroup[];
  counts: Map<number, TreeLocationCounts> | undefined;
  selectedKey: string;
  expandedNodes: Set<string>;
  showEmptyGroups: boolean;
  showPlatformFolders: boolean;
  onToggle: (key: string) => void;
  onSelect: (key: string) => void;
}) {
  const unlocated = counts?.get(0);

  const categoryRows = (siteKey: string, siteCounts: TreeLocationCounts | undefined) => {
    const byCategory = siteCounts?.by_category_platform ?? {};
    return CLIENT_FOLDERS.map((folder) => {
      const platforms = Object.entries(byCategory[folder.id] ?? {}).sort(([a], [b]) =>
        a === "windows" ? -1 : b === "windows" ? 1 : a.localeCompare(b),
      );
      const count = platforms.reduce((sum, [, n]) => sum + n, 0);
      return { folder, platforms, count, key: `${siteKey}-${folder.id}` };
    }).filter(
      (row) =>
        row.count > 0 ||
        selectedKey === row.key ||
        (showEmptyGroups && (row.folder.id === "servers" || row.folder.id === "clientpc")),
    );
  };

  const siteRow = (key: string, label: string, siteCounts: TreeLocationCounts | undefined, icon?: typeof MapPin) => {
    const rows = categoryRows(key, siteCounts);
    const open = expandedNodes.has(key);
    return (
      <>
        <TreeButton
          active={selectedKey === key}
          withinActive={selectedKey.startsWith(`${key}-`) || (open && rows.length > 0)}
          child
          icon={icon}
          status={icon ? undefined : (siteCounts ?? { total: 0, online: 0, stale: 0, offline: 0 })}
          label={label}
          count={siteCounts?.total ?? 0}
          expanded={open}
          hasChildren={rows.length > 0}
          onClick={() => onToggle(key)}
        />
        {rows.length > 0 && (
          <div className="th-tree-collapse" data-open={open} aria-hidden={!open}>
            <div className="th-tree-collapse-inner">
              <ul className="fleet-tree-child">
                {rows.map(({ folder, platforms, count, key: folderKey }, i) => {
                  const shown = showPlatformFolders ? platforms : [];
                  const onlyPlatform = shown.length === 1 ? shown[0][0] : null;
                  return (
                    <li key={folder.id} style={{ "--i": i } as CSSProperties}>
                      <TreeButton
                        active={selectedKey === folderKey}
                        child
                        icon={folder.icon}
                        label={folder.label}
                        platformBadge={onlyPlatform}
                        count={count}
                        onClick={() => onSelect(folderKey)}
                      />
                      {shown.length > 1 && (
                        <ul className="fleet-tree-child">
                          {shown.map(([platform, n]) => {
                            const platformKey = `${folderKey}-${platform}`;
                            return (
                              <li key={platform}>
                                <TreeButton
                                  active={selectedKey === platformKey}
                                  child
                                  platformIcon={platform}
                                  label={PLATFORM_LABELS[platform] ?? platform}
                                  count={n}
                                  onClick={() => onSelect(platformKey)}
                                />
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </>
    );
  };

  let index = 1;
  return (
    <>
      {cities.map((city) => {
        // The country prefixes every site and city row, also for a client whose
        // sites are all in one country (it showed only with several).
        const flag = `${city.country} `;
        if (city.sites.length === 1) {
          const site = city.sites[0];
          return (
            <li key={site.id} style={{ "--i": index++ } as CSSProperties}>
              {siteRow(`client-${clientId}-loc-${site.id}`, `${flag}${site.name}`, counts?.get(site.id))}
            </li>
          );
        }
        const open = expandedNodes.has(city.cityKey);
        const cityStats = sumStats(city.sites.map((x) => counts?.get(x.id)));
        return (
          <li key={city.cityKey} style={{ "--i": index++ } as CSSProperties}>
            <TreeButton
              active={selectedKey === city.cityKey}
              withinActive={open || city.sites.some((x) => selectedKey.startsWith(`client-${clientId}-loc-${x.id}`))}
              child
              status={cityStats}
              label={`${flag}${city.city}`}
              count={cityStats.total}
              expanded={open}
              hasChildren
              onClick={() => onToggle(city.cityKey)}
            />
            <div className="th-tree-collapse" data-open={open} aria-hidden={!open}>
              <div className="th-tree-collapse-inner">
                <ul className="fleet-tree-child">
                  {city.sites.map((site, i) => (
                    <li key={site.id} style={{ "--i": i } as CSSProperties}>
                      {siteRow(
                        `client-${clientId}-loc-${site.id}`,
                        shortSiteName(site.name, city.city),
                        counts?.get(site.id),
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </li>
        );
      })}
      {(unlocated?.total ?? 0) > 0 && (
        <li style={{ "--i": index } as CSSProperties}>
          {siteRow(`client-${clientId}-loc-none`, "No location", unlocated, MapPinOff)}
        </li>
      )}
    </>
  );
}

interface TreeButtonProps {
  active: boolean;
  /** A sub-folder of this item is selected. */
  withinActive?: boolean;
  child?: boolean;
  icon?: typeof LayoutGrid;
  platformIcon?: string;
  /** The folder's single platform, shown as a trailing icon instead of a sub-row. */
  platformBadge?: string | null;
  /** Client rows: freshness of its devices, drawn as a ring in the icon column. */
  status?: DeviceStats;
  label: string;
  /** null: a link row (e.g. the client profile), no count badge. */
  count: number | null;
  expanded?: boolean;
  hasChildren?: boolean;
  hasMaintenance?: boolean;
  onClick: () => void;
}

function TreeButton({
  active,
  withinActive = false,
  child = false,
  icon: Icon,
  platformIcon,
  platformBadge = null,
  status,
  label,
  count,
  expanded = false,
  hasChildren = false,
  hasMaintenance = false,
  onClick,
}: TreeButtonProps) {
  // One anatomy for every level: icon column on the left, count column and
  // disclosure slot on the right, so all rows line up whatever their depth.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      className="th-tree-item"
      data-active={active}
      data-within={withinActive}
      data-child={child}
    >
      <span className="th-tree-icon" aria-hidden={!status}>
        {status ? (
          <StatusRing stats={status} />
        ) : platformIcon ? (
          <PlatformIcon platform={platformIcon} size={14} />
        ) : Icon ? (
          <Icon className="h-4 w-4" />
        ) : null}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        // The full name as a tooltip only when it is cut off.
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          el.title = el.scrollWidth > el.clientWidth ? label : "";
        }}
      >
        {label}
      </span>
      {hasMaintenance && <span className="th-tree-maint" title="Has devices in maintenance" />}
      {platformBadge && (
        <span className="th-tree-platform" title={PLATFORM_LABELS[platformBadge] ?? platformBadge}>
          <PlatformIcon platform={platformBadge} size={12} />
        </span>
      )}
      {/* Keyed by value, so a changed count fades in rather than snapping. */}
      {count !== null && (
        <span key={count} className="th-tree-count">
          {formatCount(count)}
        </span>
      )}
      <span className="th-tree-caret" aria-hidden="true">
        {hasChildren && <ChevronRight className={clsx("th-tree-chevron h-3.5 w-3.5", expanded && "rotate-90")} />}
      </span>
    </button>
  );
}

// Share of the client's devices online (green), stale (amber) and offline
// (grey), clockwise from the top.
function StatusRing({ stats }: { stats: DeviceStats }) {
  const total = stats.total || 1;
  const online = (stats.online / total) * 100;
  const stale = online + (stats.stale / total) * 100;
  const label =
    stats.total === 0
      ? "No devices"
      : `${formatCount(stats.online)} online · ${formatCount(stats.stale)} stale · ${formatCount(stats.offline)} offline`;
  return (
    <span
      className="th-tree-ring"
      role="img"
      aria-label={label}
      title={label}
      data-empty={stats.total === 0 || undefined}
      style={{ "--online": `${online}%`, "--stale": `${stale}%` } as CSSProperties}
    />
  );
}
