import { useEffect } from "react";
import { X, SlidersHorizontal } from "lucide-react";
import { Client } from "../api/clients";
import { DeviceFilters } from "../api/devices";
import { QuickFilter } from "./DevicesTable";

const MOBILE_QUICK_FILTERS: { id: QuickFilter; label: string; color?: string }[] = [
  { id: "all", label: "All" },
  { id: "online", label: "Online", color: "#34d399" },
  { id: "stale", label: "Stale", color: "#fbbf24" },
  { id: "offline", label: "Offline", color: "#94a3b8" },
  { id: "critical", label: "Critical", color: "#f87171" },
  { id: "warnings", label: "Warnings", color: "#fbbf24" },
  { id: "needs_attention", label: "Attention", color: "#fb923c" },
  { id: "needs_updates", label: "Updates", color: "#fbbf24" },
  { id: "favorites", label: "Starred" },
];

interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  quickFilter: QuickFilter;
  onQuickFilterChange: (f: QuickFilter) => void;
  clients?: Client[];
  filters: DeviceFilters;
  onFilterChange: (key: keyof DeviceFilters, value: string | boolean | undefined) => void;
}

export function FilterSheet({
  open,
  onClose,
  quickFilter,
  onQuickFilterChange,
  clients = [],
  filters,
  onFilterChange,
}: FilterSheetProps) {
  // Lock body scroll while sheet is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 md:hidden"
        style={{
          background: "rgba(0,0,0,0.5)",
          pointerEvents: open ? "auto" : "none",
          opacity: open ? 1 : 0,
          transition: "opacity 280ms ease",
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 max-h-[82vh] overflow-y-auto rounded-t-2xl md:hidden"
        style={{
          background: "var(--th-bg-card)",
          borderTop: "1px solid var(--th-border-subtle)",
          transform: open ? "translateY(0)" : "translateY(100%)",
          transition: "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
          paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
        }}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 flex items-center justify-between px-4 py-3"
          style={{
            background: "var(--th-bg-card)",
            borderBottom: "1px solid var(--th-border-subtle)",
          }}
        >
          <div className="flex items-center gap-2">
            <SlidersHorizontal
              className="h-4 w-4"
              style={{ color: "var(--th-text-muted)" }}
            />
            <span
              className="text-[13px] font-bold"
              style={{ color: "var(--th-text-primary)" }}
            >
              Filters
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors active:bg-white/[0.06]"
            style={{ color: "var(--th-text-muted)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-4">
          {/* Quick status filters */}
          <div>
            <p
              className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: "var(--th-text-muted)" }}
            >
              Filter by status
            </p>
            <div className="flex flex-wrap gap-2">
              {MOBILE_QUICK_FILTERS.map(({ id, label, color }) => {
                const active = quickFilter === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      onQuickFilterChange(id);
                      onClose();
                    }}
                    className="rounded-full px-3 py-1.5 text-[12px] font-semibold transition-all active:opacity-75"
                    style={{
                      background: active
                        ? "rgba(249,115,22,0.15)"
                        : "rgba(255,255,255,0.05)",
                      border: `1px solid ${active ? "rgba(249,115,22,0.35)" : "rgba(255,255,255,0.1)"}`,
                      color: active ? (color ?? "#fb923c") : (color ?? "var(--th-text-secondary)"),
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Connection state */}
          <div>
            <p
              className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: "var(--th-text-muted)" }}
            >
              Connection
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { value: "all", label: "All" },
                { value: "online", label: "Online" },
                { value: "stale", label: "Stale" },
                { value: "offline", label: "Offline" },
              ].map(({ value, label }) => {
                const active = (filters.freshness_state ?? "all") === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() =>
                      onFilterChange(
                        "freshness_state",
                        value === "all" ? undefined : value
                      )
                    }
                    className="rounded-lg px-3 py-2 text-[12px] font-semibold transition-all"
                    style={{
                      background: active
                        ? "rgba(249,115,22,0.1)"
                        : "rgba(255,255,255,0.04)",
                      border: `1px solid ${active ? "rgba(249,115,22,0.25)" : "var(--th-border-subtle)"}`,
                      color: active ? "#fb923c" : "var(--th-text-secondary)",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Client list */}
          {clients.length > 0 && (
            <div>
              <p
                className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.1em]"
                style={{ color: "var(--th-text-muted)" }}
              >
                Client
              </p>
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => {
                    onFilterChange("client_id", undefined);
                    onClose();
                  }}
                  className="flex w-full items-center rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors active:opacity-75"
                  style={{
                    background: !filters.client_id
                      ? "rgba(249,115,22,0.1)"
                      : "rgba(255,255,255,0.03)",
                    border: `1px solid ${!filters.client_id ? "rgba(249,115,22,0.25)" : "var(--th-border-subtle)"}`,
                    color: !filters.client_id ? "#fb923c" : "var(--th-text-primary)",
                  }}
                >
                  All clients
                </button>
                {clients
                  .filter((c) => c.id && c.name && c.name !== "User" && c.name.trim() !== "")
                  .map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => {
                      onFilterChange("client_id", String(client.id));
                      onClose();
                    }}
                    className="flex w-full items-center rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors active:opacity-75"
                    style={{
                      background:
                        filters.client_id === client.id
                          ? "rgba(249,115,22,0.1)"
                          : "rgba(255,255,255,0.03)",
                      border: `1px solid ${filters.client_id === client.id ? "rgba(249,115,22,0.25)" : "var(--th-border-subtle)"}`,
                      color:
                        filters.client_id === client.id
                          ? "#fb923c"
                          : "var(--th-text-primary)",
                    }}
                  >
                    {client.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
