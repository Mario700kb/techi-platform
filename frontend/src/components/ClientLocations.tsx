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
  countryFlag,
  countryName,
  createClientLocation,
  deleteClientLocation,
  getClientLocations,
  getLocationSuggestions,
  LOCATION_KINDS,
  LocationInput,
  LocationKind,
  LocationStats,
  LocationSuggestion,
  updateClientLocation,
} from "../api/clients";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { formatCount } from "../utils/number";
import ConfirmationModal from "./ConfirmationModal";
import { Button, EmptyState, Modal, Select } from "./ui";

// Countries the console's clients are in, nearest first. A site saved with
// another code keeps it: the picker adds that code instead of showing Albania.
const COUNTRIES = [
  "AL",
  "XK",
  "MK",
  "ME",
  "RS",
  "GR",
  "IT",
  "DE",
  "AT",
  "CH",
  "FR",
  "GB",
  "NL",
  "BE",
  "ES",
  "HR",
  "SI",
  "BA",
  "BG",
  "RO",
  "TR",
  "FI",
  "IE",
  "SE",
  "PL",
  "CZ",
  "HU",
  "US",
  "AE",
];

const CITIES = [
  "Tiranë",
  "Durrës",
  "Vlorë",
  "Shkodër",
  "Elbasan",
  "Korçë",
  "Fier",
  "Berat",
  "Lushnjë",
  "Kavajë",
  "Pogradec",
  "Gjirokastër",
  "Sarandë",
  "Lezhë",
  "Kukës",
  "Kamëz",
  "Vorë",
  "Prishtinë",
  "Prizren",
  "Pejë",
  "Gjakovë",
  "Ferizaj",
  "Mitrovicë",
  "Shkup",
  "Tetovë",
  "Podgoricë",
  "Ulqin",
];

const KIND_LABEL = Object.fromEntries(LOCATION_KINDS.map((k) => [k.value, k.label])) as Record<LocationKind, string>;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;

interface RuleDraft {
  public_ip: string;
  lan_cidr: string;
}

interface Draft {
  id?: number;
  name: string;
  kind: LocationKind;
  country: string;
  city: string;
  address: string;
  contact: string;
  notes: string;
  rules: RuleDraft[];
}

const emptyDraft = (rules: RuleDraft[] = []): Draft => ({
  name: "",
  kind: "office",
  country: "AL",
  city: "",
  address: "",
  contact: "",
  notes: "",
  rules,
});

const draftOf = (location: ClientLocation): Draft => ({
  id: location.id,
  name: location.name,
  kind: location.kind,
  country: location.country,
  city: location.city,
  address: location.address ?? "",
  contact: location.contact ?? "",
  notes: location.notes ?? "",
  rules: location.rules.map((r) => ({ public_ip: r.public_ip ?? "", lan_cidr: r.lan_cidr ?? "" })),
});

/** What is wrong with the draft, or null. Mirrors the API so most mistakes never leave the form. */
function problem(draft: Draft): string | null {
  if (!draft.name.trim()) return "Give the location a name, e.g. “Tiranë – Zyra qendrore”.";
  if (!/^[A-Za-z]{2}$/.test(draft.country.trim())) return "Choose the country.";
  if (!draft.city.trim()) return "Enter the city.";
  for (const rule of draft.rules) {
    const ip = rule.public_ip.trim();
    const lan = rule.lan_cidr.trim();
    if (!ip && !lan) return "Each rule needs a public IP, a LAN network, or both — or remove it.";
    if (ip && !IPV4.test(ip)) return `“${ip}” is not an IPv4 address.`;
    if (lan && !CIDR.test(lan)) return `“${lan}” is not a network. Write it like 10.130.50.0/24.`;
  }
  return null;
}

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
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
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

  const cityOptions = useMemo(() => [...new Set([...locations.map((l) => l.city), ...CITIES])], [locations]);

  const reloadAll = async () => {
    await Promise.all([list.reload(), suggestions.reload()]);
  };

  const openDevices = (folder: string) => navigate(`/devices?folder=${encodeURIComponent(folder)}`);

  const startFromSuggestion = (suggestion: LocationSuggestion, lan?: string) => {
    setFormError(null);
    setDraft(emptyDraft([{ public_ip: suggestion.public_ip, lan_cidr: lan ?? "" }]));
  };

  const save = async () => {
    if (!draft) return;
    const issue = problem(draft);
    if (issue) {
      setFormError(issue);
      return;
    }
    const input: LocationInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      country: draft.country.trim().toUpperCase(),
      city: draft.city.trim(),
      address: draft.address.trim() || null,
      contact: draft.contact.trim() || null,
      notes: draft.notes.trim() || null,
      rules: draft.rules.map((r) => ({
        public_ip: r.public_ip.trim() || null,
        lan_cidr: r.lan_cidr.trim() || null,
      })),
    };
    setSaving(true);
    setFormError(null);
    try {
      const saved = draft.id
        ? await updateClientLocation(clientId, draft.id, input)
        : await createClientLocation(clientId, input);
      setDraft(null);
      setNotice(
        `${saved.name}: ${formatCount(saved.stats.total)} ${saved.stats.total === 1 ? "device" : "devices"} at this location.`,
      );
      await reloadAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn't save the location");
    } finally {
      setSaving(false);
    }
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

  const setRule = (index: number, patch: Partial<RuleDraft>) =>
    draft && setDraft({ ...draft, rules: draft.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

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
                setFormError(null);
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
                  {countryFlag(city.country)} {city.city}
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
                              setFormError(null);
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
        <Modal
          title={draft.id ? "Edit location" : "New location"}
          subtitle="A site of this client. Its rules place the devices at it."
          icon={MapPin}
          size="lg"
          busy={saving}
          onClose={() => setDraft(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : draft.id ? "Save changes" : "Create location"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <label className="th-onb-field">
                Name
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. Tiranë – Zyra qendrore"
                  maxLength={120}
                  autoFocus
                />
              </label>
              <div className="th-onb-field">
                Type
                <Select
                  id="location-kind"
                  aria-label="Type"
                  value={draft.kind}
                  onChange={(value) => setDraft({ ...draft, kind: value as LocationKind })}
                  options={LOCATION_KINDS}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="th-onb-field">
                Country
                <Select
                  id="location-country"
                  aria-label="Country"
                  value={draft.country}
                  onChange={(value) => setDraft({ ...draft, country: value })}
                  options={(COUNTRIES.includes(draft.country) ? COUNTRIES : [draft.country, ...COUNTRIES]).map(
                    (code) => ({ value: code, label: `${countryFlag(code)} ${countryName(code)}` }),
                  )}
                />
              </div>
              <label className="th-onb-field">
                City
                <input
                  value={draft.city}
                  onChange={(e) => setDraft({ ...draft, city: e.target.value })}
                  placeholder="e.g. Tiranë"
                  maxLength={80}
                  list="location-cities"
                />
                <datalist id="location-cities">
                  {cityOptions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </label>
            </div>
            <label className="th-onb-field">
              Address <span style={{ color: "var(--th-text-faint)", fontWeight: 400 }}>· optional</span>
              <input
                value={draft.address}
                onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                placeholder="Street, building, floor"
                maxLength={200}
              />
            </label>
            <label className="th-onb-field">
              Local contact <span style={{ color: "var(--th-text-faint)", fontWeight: 400 }}>· optional</span>
              <input
                value={draft.contact}
                onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
                placeholder="Name · phone · email"
                maxLength={200}
              />
            </label>

            <div className="th-onb-field">
              <span className="flex items-center justify-between gap-2">
                Rules
                <button
                  type="button"
                  className="th-link-btn"
                  onClick={() => setDraft({ ...draft, rules: [...draft.rules, { public_ip: "", lan_cidr: "" }] })}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add rule
                </button>
              </span>
              {draft.rules.length === 0 ? (
                <p className="th-onb-hint">
                  No rules: only devices you place here by hand. Add the site&apos;s public IP so its devices come here
                  on their own.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {draft.rules.map((rule, index) => (
                    <li key={index} className="th-loc-rule-row">
                      <input
                        value={rule.public_ip}
                        onChange={(e) => setRule(index, { public_ip: e.target.value })}
                        placeholder="Public IP, e.g. 80.90.87.187"
                        aria-label={`Rule ${index + 1} public IP`}
                        className="font-mono"
                      />
                      <input
                        value={rule.lan_cidr}
                        onChange={(e) => setRule(index, { lan_cidr: e.target.value })}
                        placeholder="LAN, e.g. 10.130.50.0/24"
                        aria-label={`Rule ${index + 1} LAN network`}
                        className="font-mono"
                      />
                      <button
                        type="button"
                        className="th-onb-action"
                        aria-label={`Remove rule ${index + 1}`}
                        onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="th-onb-hint">
                A device matches a rule by its public IP, its LAN network, or both. The most specific rule wins: IP and
                network, then network, then IP — so a branch behind the head office&apos;s line is told apart by its
                network. Devices you place by hand stay where you put them.
              </p>
            </div>

            <label className="th-onb-field">
              Notes <span style={{ color: "var(--th-text-faint)", fontWeight: 400 }}>· optional</span>
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Opening hours, access, ISP, where the rack is…"
                maxLength={4000}
                rows={3}
                className="!min-h-[84px]"
              />
            </label>

            {formError && (
              <div
                className="th-onb-note th-onb-reveal"
                style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
                role="alert"
              >
                <span className="flex-1">{formError}</span>
              </div>
            )}
          </div>
        </Modal>
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
