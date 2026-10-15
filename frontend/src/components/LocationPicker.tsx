import { useState } from "react";

import { assignDeviceLocation, getClientLocations } from "../api/clients";
import { Device, getDevice } from "../api/devices";
import { useCachedQuery } from "../hooks/useCachedQuery";
import LocationFormModal, { emptyDraft } from "./LocationFormModal";
import { SelectField } from "./ui";

const NEW = "__new";

/**
 * Where a device is, set by hand: back to the rules, one of its client's
 * sites, no location — or a new site made on the spot and the device put
 * there. A device placed by hand is never moved by the rules.
 */
export default function LocationPicker({
  device,
  active,
  onDeviceUpdated,
}: {
  device: Device;
  /** Load the client's sites only once the picker is on screen. */
  active: boolean;
  onDeviceUpdated?: (device: Device) => void;
}) {
  const clientId = device.client_id ?? null;
  const sites = useCachedQuery(active && clientId ? `page.client.${clientId}.locations` : null, () =>
    getClientLocations(clientId as number),
  );
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!clientId) {
    return (
      <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
        Assign a client first; locations belong to a client.
      </p>
    );
  }

  const place = async (locationId: number | null, mode: "manual" | "auto") => {
    setBusy(true);
    setError(null);
    try {
      await assignDeviceLocation(clientId, [device.id], locationId, mode);
      onDeviceUpdated?.(await getDevice(device.id));
      void sites.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set the location");
    } finally {
      setBusy(false);
    }
  };

  const choose = (value: string) => {
    if (value === NEW) setCreating(true);
    else if (value === "auto") void place(null, "auto");
    else if (value === "none") void place(null, "manual");
    else void place(Number(value), "manual");
  };

  const list = sites.data?.locations ?? [];
  // The device's own site stays a choice while the list is loading or stale.
  const current =
    device.location_id && device.location_name && !list.some((site) => site.id === device.location_id)
      ? {
          id: device.location_id,
          label: [device.location_name, [device.location_city, device.location_country].filter(Boolean).join(", ")]
            .filter(Boolean)
            .join(" · "),
        }
      : null;
  const value = device.location_source === "manual" ? String(device.location_id ?? "none") : "auto";

  return (
    <>
      <SelectField
        value={value}
        disabled={busy}
        onChange={(event) => choose(event.target.value)}
        className="w-full"
        aria-label="Assign location"
      >
        <option value="auto">By the rules (automatic)</option>
        {current && <option value={current.id}>{current.label}</option>}
        {list.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name} · {site.city}, {site.country}
          </option>
        ))}
        <option value="none">No location (keep it here)</option>
        <option value={NEW}>+ New location…</option>
      </SelectField>
      {error && (
        <p className="mt-1 text-[12px]" role="alert" style={{ color: "var(--th-status-critical)" }}>
          {error}
        </p>
      )}
      {creating && (
        <LocationFormModal
          clientId={clientId}
          initial={emptyDraft()}
          knownCities={list.map((site) => site.city)}
          onClose={() => setCreating(false)}
          onSaved={(saved) => {
            setCreating(false);
            void place(saved.id, "manual");
          }}
        />
      )}
    </>
  );
}
