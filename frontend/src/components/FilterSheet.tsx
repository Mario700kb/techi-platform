import { useEffect, useState } from "react";
import { Box, Check } from "lucide-react";
import { Button } from "./ui";
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
  { id: "favorites", label: "Favorites" },
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
  unassignedCount?: number;
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
  unassignedCount,
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
          <Button variant="secondary" type="button" onClick={onClose} className="min-h-[44px] px-5">Reset</Button>
          <Button type="button" onClick={handleApply} className="min-h-[44px] flex-1">Apply filters</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Status */}
        <div>
          <p className="th-msheet-label">Status</p>
          <div className="flex flex-wrap gap-2">
            {MOBILE_QUICK_FILTERS.map(({ id, label, color }) => {
              const active = draftQuickFilter === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDraftQuickFilter(id)}
                  aria-selected={active}
                  className="th-mdev-chip"
                  style={{ "--chip-tone": color } as React.CSSProperties}
                >
                  {color && <i aria-hidden="true" />}
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Client + subgroups */}
        {(validClients.length > 0 || (unassignedCount ?? 0) > 0) && (
          <div>
            <p className="th-msheet-label">Client</p>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  setDraftClientId(undefined);
                  setDraftDeviceType(undefined);
                }}
                aria-pressed={draftClientId === undefined}
                className="th-msheet-option"
              >
                <span>All clients</span>
                <Check className="th-msheet-check h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setDraftClientId(-1);
                  setDraftDeviceType(undefined);
                }}
                aria-pressed={draftClientId === -1}
                className="th-msheet-option"
              >
                <span className="flex items-center gap-2">
                  <Box className="h-4 w-4" />
                  No Client
                </span>
                {unassignedCount !== undefined && (
                  <span className="th-msheet-count">{unassignedCount}</span>
                )}
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
                      aria-pressed={clientActive}
                      className="th-msheet-option"
                    >
                      <span>{client.name}</span>
                      {subgroups && (
                        <span className="th-msheet-count">{Object.values(subgroups).reduce((a, b) => a + b, 0)}</span>
                      )}
                    </button>

                    {hasSubgroups && (
                      <div className="ml-3 mt-1 flex flex-col gap-1 border-l pl-3" style={{ borderColor: "var(--th-border-subtle)" }}>
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
                              aria-pressed={subActive}
                              className="th-msheet-option"
                              data-sub="true"
                            >
                              <span>{label}</span>
                              <span className="th-msheet-count">{count}</span>
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
