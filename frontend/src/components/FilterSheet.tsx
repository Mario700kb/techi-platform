import { useEffect, useState } from "react";
import { Client } from "../api/clients";
import { DeviceFilters } from "../api/devices";
import { QuickFilter } from "./DevicesTable";
import { MobileSheet } from "./mobile/MobileSheet";

/**
 * Mobile UI 2.0 FilterSheet (docs/reference/MOBILE-DESIGN-SPEC.md — Devices/
 * "FilterSheet v2"): built on the shared MobileSheet; a single status
 * section (the old duplicate "Connection" section is removed — it repeated
 * Online/Stale/Offline with different semantics and confused what was
 * actually active); selections are staged as a draft and only committed on
 * Apply, with Reset discarding the draft (matches the approved mockup,
 * where Reset simply dismisses without applying).
 *
 * Implementation Note (docs/reference/MOBILE-DESIGN-SPEC.md — Devices):
 * the mockup's Apply button reads "Shfaq N pajisje" (a live match count).
 * Computing that count here would require duplicating DevicesTable's full
 * client-side filter predicate (quick filter + health/patch/alert maps) —
 * a maintenance/drift risk with no corresponding gain. Apply reads "Apply
 * filters" instead; the count is unnecessary since the list re-renders
 * immediately after Apply.
 */

const MOBILE_QUICK_FILTERS: { id: QuickFilter; label: string; color?: string }[] = [
  { id: "all", label: "All" },
  { id: "online", label: "Online", color: "var(--th-status-online)" },
  { id: "stale", label: "Stale", color: "var(--th-status-stale)" },
  { id: "offline", label: "Offline", color: "var(--th-status-offline)" },
  { id: "critical", label: "Critical", color: "var(--th-status-critical)" },
  { id: "warnings", label: "Warnings", color: "var(--th-status-warning)" },
  { id: "needs_attention", label: "Attention", color: "var(--th-accent)" },
  { id: "needs_updates", label: "Updates", color: "var(--th-status-warning)" },
  { id: "needs_agent_update", label: "Agent Update", color: "var(--th-status-agent)" },
  { id: "favorites", label: "Starred" },
];

const SUBGROUP_CONFIG: Record<string, { label: string; deviceType: "server" | "client" }> = {
  servers: { label: "Servers", deviceType: "server" },
  clientpc: { label: "Client PC", deviceType: "client" },
};

interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  quickFilter: QuickFilter;
  onQuickFilterChange: (f: QuickFilter) => void;
  clients?: Client[];
  clientGroups?: Record<string, Record<string, number>>;
  filters: DeviceFilters;
  onFilterChange: (key: keyof DeviceFilters, value: string | boolean | undefined) => void;
}

export function FilterSheet({
  open,
  onClose,
  quickFilter,
  onQuickFilterChange,
  clients = [],
  clientGroups,
  filters,
  onFilterChange,
}: FilterSheetProps) {
  const [draftQuickFilter, setDraftQuickFilter] = useState<QuickFilter>(quickFilter);
  const [draftClientId, setDraftClientId] = useState<number | undefined>(
    typeof filters.client_id === "number" ? filters.client_id : undefined,
  );
  const [draftDeviceType, setDraftDeviceType] = useState<DeviceFilters["device_type"] | undefined>(
    filters.device_type,
  );

  // Re-sync the draft to the committed filters every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setDraftQuickFilter(quickFilter);
    setDraftClientId(typeof filters.client_id === "number" ? filters.client_id : undefined);
    setDraftDeviceType(filters.device_type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const validClients = clients.filter(
    (c) => c.id && c.name && c.name !== "User" && c.name.trim() !== "",
  );

  const handleApply = () => {
    // Order matters: onFilterChange and onQuickFilterChange each call
    // Devices.tsx's setSearchParams independently, and react-router-dom's
    // setSearchParams resolves its "updater" against the searchParams
    // snapshot from the current render — not a live value — so calling it
    // more than once in the same synchronous handler makes the LAST call
    // win outright, silently discarding whatever the earlier call(s) set.
    // onQuickFilterChange owns the one URL param this sheet changes
    // ("filter"), so it must run last or Apply would drop it (confirmed
    // while wiring FilterSheet v2: the "filter" param was disappearing).
    onFilterChange("client_id", draftClientId !== undefined ? String(draftClientId) : undefined);
    onFilterChange("device_type", draftDeviceType);
    onQuickFilterChange(draftQuickFilter);
    onClose();
  };

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title="Filters"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-xl px-[18px] text-[12.5px] font-bold"
            style={{ border: "1px solid var(--th-border-subtle)", color: "var(--th-text-secondary)", minHeight: 44 }}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="flex-1 rounded-xl text-[13.5px] font-extrabold text-white"
            style={{ background: "var(--th-accent)", minHeight: 44 }}
          >
            Apply filters
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Status */}
        <div>
          <p
            className="mb-[10px] text-[10px] font-extrabold uppercase tracking-[0.1em]"
            style={{ color: "var(--th-text-muted)" }}
          >
            Status
          </p>
          <div className="flex flex-wrap gap-2">
            {MOBILE_QUICK_FILTERS.map(({ id, label, color }) => {
              const active = draftQuickFilter === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDraftQuickFilter(id)}
                  className="rounded-full px-3 py-[7px] text-[12px] font-bold transition-colors"
                  style={{
                    background: active ? "var(--th-accent-glow)" : "var(--th-chip-bg)",
                    border: `1px solid ${active ? "var(--th-accent-border)" : "var(--th-border-subtle)"}`,
                    color: active ? (color ?? "var(--th-accent)") : (color ?? "var(--th-text-secondary)"),
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Client + subgroups */}
        {validClients.length > 0 && (
          <div>
            <p
              className="mb-[10px] text-[10px] font-extrabold uppercase tracking-[0.1em]"
              style={{ color: "var(--th-text-muted)" }}
            >
              Client
            </p>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  setDraftClientId(undefined);
                  setDraftDeviceType(undefined);
                }}
                className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-[13px] font-bold transition-colors"
                style={{
                  background: draftClientId === undefined ? "var(--th-accent-glow)" : "var(--th-chip-bg)",
                  border: `1px solid ${draftClientId === undefined ? "var(--th-accent-border)" : "var(--th-border-subtle)"}`,
                  color: draftClientId === undefined ? "var(--th-accent)" : "var(--th-text-primary)",
                }}
              >
                All clients
              </button>

              {validClients.map((client) => {
                const clientActive = draftClientId === client.id;
                const subgroups = clientGroups?.[String(client.id)];
                const hasSubgroups =
                  subgroups && Object.keys(subgroups).some((k) => k in SUBGROUP_CONFIG && subgroups[k] > 0);

                return (
                  <div key={client.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftClientId(client.id);
                        setDraftDeviceType(undefined);
                      }}
                      className="flex min-h-[44px] w-full items-center justify-between rounded-lg px-3 text-[13px] font-bold transition-colors"
                      style={{
                        background: clientActive ? "var(--th-accent-glow)" : "var(--th-chip-bg)",
                        border: `1px solid ${clientActive ? "var(--th-accent-border)" : "var(--th-border-subtle)"}`,
                        color: clientActive ? "var(--th-accent)" : "var(--th-text-primary)",
                      }}
                    >
                      <span>{client.name}</span>
                      {subgroups && (
                        <span className="text-[11px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
                          {Object.values(subgroups).reduce((a, b) => a + b, 0)}
                        </span>
                      )}
                    </button>

                    {hasSubgroups && (
                      <div className="ml-3 mt-[3px] flex flex-col gap-[3px] border-l-2 pl-3" style={{ borderColor: "var(--th-border-subtle)" }}>
                        {Object.entries(SUBGROUP_CONFIG).map(([catKey, { label, deviceType }]) => {
                          const count = subgroups?.[catKey] ?? 0;
                          if (count === 0) return null;
                          const subActive = clientActive && draftDeviceType === deviceType;
                          return (
                            <button
                              key={catKey}
                              type="button"
                              onClick={() => {
                                setDraftClientId(client.id);
                                setDraftDeviceType(deviceType);
                              }}
                              className="flex min-h-[40px] w-full items-center justify-between rounded-md px-3 text-[12px] font-bold transition-colors"
                              style={{
                                background: subActive ? "var(--th-accent-glow)" : "transparent",
                                color: subActive ? "var(--th-accent)" : "var(--th-text-secondary)",
                              }}
                            >
                              <span>{label}</span>
                              <span className="text-[11px]" style={{ color: subActive ? "var(--th-accent)" : "var(--th-text-muted)" }}>
                                {count}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </MobileSheet>
  );
}
