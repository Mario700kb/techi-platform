import { CSSProperties, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  ExternalLink,
  MapPin,
  MapPinOff,
  Pencil,
  Plus,
  RefreshCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import {
  applyLocationRules,
  ClientLocation,
  countryName,
  deleteClientLocation,
  getClientLocations,
  getLocationSuggestions,
  LOCATION_KINDS,
  LocationKind,
  LocationStats,
  LocationSuggestion,
} from "../api/clients";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { formatCount } from "../utils/number";
import ConfirmationModal from "./ConfirmationModal";
import LocationFormModal, { Draft, draftOf, emptyDraft } from "./LocationFormModal";
import CountryTag from "./CountryTag";
import { Button, EmptyState } from "./ui";

const KIND_LABEL = Object.fromEntries(LOCATION_KINDS.map((k) => [k.value, k.label])) as Record<LocationKind, string>;

function StatusBar({ stats }: { stats: LocationStats }) {
  const total = stats.total || 1;
  return (
    <span
      className="th-loc-bar"
      role="img"
      aria-label={`${formatCount(stats.online)} online · ${formatCount(stats.stale)} stale · ${formatCount(stats.offline)} offline`}
    >
      {stats.total > 0 && (
        <>
          <i style={{ flexGrow: stats.online / total, background: "var(--th-status-online)" }} />
          <i style={{ flexGrow: stats.stale / total, background: "var(--th-status-stale)" }} />
          <i style={{ flexGrow: stats.offline / total, background: "var(--th-status-offline)" }} />
        </>
      )}
    </span>
  );
}

export default function ClientLocations({ clientId, canManage }: { clientId: number; canManage: boolean }) {
  const navigate = useNavigate();
  const list = useCachedQuery(`page.client.${clientId}.locations`, () => getClientLocations(clientId));
  const suggestions = useCachedQuery(canManage ? `page.client.${clientId}.location-suggestions` : null, () =>
    getLocationSuggestions(clientId),
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientLocation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const locations = useMemo(() => list.data?.locations ?? [], [list.data]);
  const unlocated = list.data?.unlocated;
  const severalCountries = new Set(locations.map((l) => l.country)).size > 1;

  // Country → city → sites, in the order the API sorts them.
  const cities = useMemo(() => {
    const out: { key: string; country: string; city: string; sites: ClientLocation[] }[] = [];
    for (const site of locations) {
      const key = `${site.country}|${site.city.toLowerCase()}`;
      const last = out[out.length - 1];
      if (last?.key === key) last.sites.push(site);
      else out.push({ key, country: site.country, city: site.city, sites: [site] });
    }
    return out;
  }, [locations]);

  const reloadAll = async () => {
    await Promise.all([list.reload(), suggestions.reload()]);
  };

  const openDevices = (folder: string) => navigate(`/devices?folder=${encodeURIComponent(folder)}`);

  const startFromSuggestion = (suggestion: LocationSuggestion, lan?: string) => {
    setDraft(emptyDraft([{ public_ip: suggestion.public_ip, lan_cidr: lan ?? "" }]));
  };

  const reapply = async () => {
    setApplying(true);
    try {
      const result = await applyLocationRules(clientId);
      setNotice(
        result.assigned || result.cleared
          ? `Rules applied: ${formatCount(result.assigned)} placed, ${formatCount(result.cleared)} back to no location.`
          : "Rules applied: every device was already in place.",
      );
      await reloadAll();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't apply the rules");
    } finally {
      setApplying(false);
    }
  };

  const pending = suggestions.data ?? [];

  return (
    <div className="space-y-4">
      {/* ── toolbar ─────────────────────────────────────────────────── */}
      <div className="th-onb-card th-onb-enter !flex-row flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
            Locations
          </h2>
          <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            {locations.length
              ? `${formatCount(locations.length)} ${locations.length === 1 ? "site" : "sites"} in ${formatCount(cities.length)} ${cities.length === 1 ? "city" : "cities"} · ${formatCount(unlocated?.total ?? 0)} devices at no location`
              : "Offices, branches, shops and data centres, each with the devices at it."}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            {locations.length > 0 && (
              <Button variant="secondary" size="sm" onClick={reapply} disabled={applying}>
                <RefreshCcw className={`h-3.5 w-3.5 ${applying ? "animate-spin" : ""}`} />
                Re-apply rules
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setDraft(emptyDraft());
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              Add location
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": "var(--th-status-info)" } as CSSProperties}
          role="status"
        >
          <span className="flex-1">{notice}</span>
          <button type="button" className="th-explorer-clear" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── suggestions ─────────────────────────────────────────────── */}
      {canManage && pending.length > 0 && (
        <section className="premium-card th-onb-enter p-0" style={{ "--i": 1 } as CSSProperties}>
          <div className="th-panel-head">
            <h2 className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" style={{ color: "var(--th-accent)" }} />
              Suggested from shared internet lines
            </h2>
            <span className="whitespace-nowrap text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {formatCount(pending.length)} public {pending.length === 1 ? "IP" : "IPs"}
            </span>
          </div>
          <p className="px-5 pb-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            Devices behind one public IP are usually one site. Name it to place them. When the networks behind an IP are
            separate sites (branches over a VPN), create one location per network instead.
          </p>
          <ul className="th-loc-suggestions">
            {pending.map((s) => (
              <li key={s.public_ip}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                      {s.public_ip}
                    </span>
                    <span className="text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                      {formatCount(s.devices)} devices · {formatCount(s.online)} online
                    </span>
                  </div>
                  {s.sample_hostnames.length > 0 && (
                    <p className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                      {s.sample_hostnames.join(", ")}
                      {s.devices > s.sample_hostnames.length ? "…" : ""}
                    </p>
                  )}
                  {s.networks.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {s.networks.map((n) => (
                        <button
                          key={n.lan_cidr}
                          type="button"
                          className="th-loc-chip"
                          title={`Create a location for ${n.lan_cidr} behind ${s.public_ip}`}
                          onClick={() => startFromSuggestion(s, n.lan_cidr)}
                        >
                          <Plus className="h-3 w-3" />
                          <span className="font-mono">{n.lan_cidr}</span>
                          <b className="tabular-nums">{formatCount(n.devices)}</b>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => startFromSuggestion(s)}>
                  <Plus className="h-3.5 w-3.5" />
                  Create location
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── sites by city ───────────────────────────────────────────── */}
      {list.loading && !list.data ? (
        <div className="th-onb-card" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.2 }} />
          ))}
        </div>
      ) : locations.length === 0 ? (
        pending.length === 0 && (
          <div className="th-onb-card">
            <EmptyState
              icon={<MapPin className="h-5 w-5" />}
              title="No locations yet"
              description={
                canManage
                  ? "Add the client's offices and branches; devices are placed by the site's public IP or network."
                  : "No one has added this client's sites yet."
              }
            />
          </div>
        )
      ) : (
        cities.map((city, cityIndex) => {
          const devices = city.sites.reduce((sum, site) => sum + site.stats.total, 0);
          return (
            <section key={city.key} className="th-onb-enter" style={{ "--i": cityIndex + 2 } as CSSProperties}>
              <div className="th-loc-city">
                <span className="th-loc-city-name">
                  <CountryTag code={city.country} /> {city.city}
                  {severalCountries && <small>{countryName(city.country)}</small>}
                </span>
                <span className="tabular-nums">
                  {formatCount(city.sites.length)} {city.sites.length === 1 ? "site" : "sites"} · {formatCount(devices)}{" "}
                  {devices === 1 ? "device" : "devices"}
                </span>
              </div>
              <div className="th-loc-grid">
                {city.sites.map((site) => (
                  <article key={site.id} className="th-onb-card th-loc-card">
                    <header>
                      <span className="th-loc-icon">
                        <Building2 className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate" title={site.name}>
                          {site.name}
                        </h3>
                        <p className="truncate">{site.address || `${site.city}, ${countryName(site.country)}`}</p>
                      </div>
                      <span className="th-tag" data-neutral="true">
                        {KIND_LABEL[site.kind] ?? site.kind}
                      </span>
                    </header>

                    <div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className="text-[22px] font-semibold tabular-nums"
                          style={{ color: "var(--th-text-primary)" }}
                        >
                          {formatCount(site.stats.total)}
                          <small className="ml-1.5 text-[12px] font-normal" style={{ color: "var(--th-text-muted)" }}>
                            {site.stats.total === 1 ? "device" : "devices"}
                          </small>
                        </span>
                        <span className="text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                          {formatCount(site.stats.online)} online
                          {site.stats.offline > 0 && ` · ${formatCount(site.stats.offline)} offline`}
                        </span>
                      </div>
                      <StatusBar stats={site.stats} />
                      <p className="mt-2 text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                        {formatCount(site.stats.clientpc)} {site.stats.clientpc === 1 ? "Client PC" : "Client PCs"} ·{" "}
                        {formatCount(site.stats.servers)} {site.stats.servers === 1 ? "Server" : "Servers"}
                        {site.manual_devices > 0 && ` · ${formatCount(site.manual_devices)} placed by hand`}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {site.rules.length === 0 ? (
                        <span className="text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                          No rules: devices are placed here by hand.
                        </span>
                      ) : (
                        site.rules.map((rule) => (
                          <span key={rule.id} className="th-loc-rule">
                            {rule.public_ip && (
                              <>
                                <b>IP</b>
                                <span className="font-mono">{rule.public_ip}</span>
                              </>
                            )}
                            {rule.lan_cidr && (
                              <>
                                <b>LAN</b>
                                <span className="font-mono">{rule.lan_cidr}</span>
                              </>
                            )}
                          </span>
                        ))
                      )}
                    </div>

                    {site.contact && (
                      <p
                        className="truncate text-[12px]"
                        style={{ color: "var(--th-text-secondary)" }}
                        title={site.contact}
                      >
                        {site.contact}
                      </p>
                    )}

                    <footer>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openDevices(`client-${clientId}-loc-${site.id}`)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open in Devices
                      </Button>
                      {canManage && (
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className="th-onb-action"
                            aria-label={`Edit ${site.name}`}
                            title="Edit"
                            onClick={() => {
                              setDraft(draftOf(site));
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="th-onb-action"
                            aria-label={`Delete ${site.name}`}
                            title="Delete"
                            onClick={() => setConfirmDelete(site)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </span>
                      )}
                    </footer>
                  </article>
                ))}
              </div>
            </section>
          );
        })
      )}

      {locations.length > 0 && (unlocated?.total ?? 0) > 0 && (
        <div className="th-onb-card th-loc-unlocated">
          <span className="th-loc-icon">
            <MapPinOff className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {formatCount(unlocated!.total)} {unlocated!.total === 1 ? "device" : "devices"} at no location
            </p>
            <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              Laptops on the move, and devices no rule recognises yet.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => openDevices(`client-${clientId}-loc-none`)}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open in Devices
          </Button>
        </div>
      )}

      {/* ── create / edit ───────────────────────────────────────────── */}
      {draft && (
        <LocationFormModal
          clientId={clientId}
          initial={draft}
          knownCities={locations.map((l) => l.city)}
          onClose={() => setDraft(null)}
          onSaved={(saved) => {
            setDraft(null);
            setNotice(
              `${saved.name}: ${formatCount(saved.stats.total)} ${saved.stats.total === 1 ? "device" : "devices"} at this location.`,
            );
            void reloadAll();
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmationModal
          title="Delete location"
          confirmLabel="Delete location"
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => {
            try {
              await deleteClientLocation(clientId, confirmDelete.id);
              setNotice(`${confirmDelete.name} deleted; its devices went to the other rules or to no location.`);
              await reloadAll();
            } catch (err) {
              setNotice(err instanceof Error ? err.message : "Couldn't delete the location");
            }
            setConfirmDelete(null);
          }}
        >
          Delete <strong style={{ color: "var(--th-text-primary)" }}>{confirmDelete.name}</strong>? Its{" "}
          {formatCount(confirmDelete.stats.total)} devices go to the other locations&apos; rules, or to no location. The
          devices themselves are not touched.
        </ConfirmationModal>
      )}
    </div>
  );
}
