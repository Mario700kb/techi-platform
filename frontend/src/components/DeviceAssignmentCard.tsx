import { useId, useState } from "react";
import type { CSSProperties } from "react";
import { Check, Edit3 } from "lucide-react";
import type { Client, DeviceGroup } from "../api/clients";
import { assignDeviceClient, Device } from "../api/devices";
import { TERMS } from "../utils/deviceStatus";
import { deviceSite } from "../utils/location";
import GroupPicker from "./GroupPicker";
import LocationPicker from "./LocationPicker";
import { Kv, SectionHeader, SelectField } from "./ui";

function assignmentSourceLabel(source?: string | null): string {
  const normalized = (source || "unassigned").toLowerCase();
  if (normalized === "manual" || normalized === "legacy_manual") return "Manual";
  if (normalized === "trusted_domain") return "Domain";
  if (normalized === "enrollment_token") return "Token";
  if (normalized === "auto_os" || normalized === "system_auto") return "Auto";
  return "Unassigned";
}

/**
 * Overview → Client assignment: client, group, location and where the
 * assignment came from, read-only by default. Operators allowed to assign
 * open the pickers in place with "Edit assignment"; every picker saves the
 * moment a choice is made, as it always has, so "Done" only closes them.
 */
export default function DeviceAssignmentCard({
  device,
  clients,
  groups,
  canAssignClient,
  canAssignLocation,
  canAssignGroup,
  active,
  onDeviceUpdated,
}: {
  device: Device;
  clients: Client[];
  /** Every group the operator can see; the card keeps the device's client's. */
  groups: DeviceGroup[];
  canAssignClient: boolean;
  canAssignLocation: boolean;
  canAssignGroup: boolean;
  /** The card is on screen (the location picker loads sites only then). */
  active: boolean;
  onDeviceUpdated?: (device: Device) => void;
}) {
  const editorId = useId();
  const [editingFor, setEditingFor] = useState<number | null>(null);
  const canEdit = canAssignClient || canAssignLocation || canAssignGroup;
  const editing = canEdit && editingFor === device.id;
  const clientId = device.client_id ?? device.resolved_client_id ?? null;
  const clientGroups = groups.filter((group) => group.client_id === clientId);
  const pickers = [canAssignClient, canAssignLocation, canAssignGroup].filter(Boolean).length;

  const location = device.location_name
    ? (deviceSite(device)?.title ?? device.location_name)
    : device.location_source === "manual"
      ? "No location · placed by hand"
      : "No location";

  return (
    <section className="mb-3.5" aria-label="Client assignment">
      <SectionHeader
        title="Client assignment"
        action={
          canEdit && (
            <button
              type="button"
              className="th-link-btn th-link-btn-primary gap-1.5"
              aria-expanded={editing}
              aria-controls={editing ? editorId : undefined}
              onClick={() => setEditingFor(editing ? null : device.id)}
            >
              {editing ? <Check className="h-3.5 w-3.5" /> : <Edit3 className="h-3.5 w-3.5" />}
              {editing ? "Done" : "Edit assignment"}
            </button>
          )
        }
      />
      <div className="th-drawer-card">
        <dl className="th-kv">
          <Kv label="Client">{device.resolved_client_name || device.client_name || TERMS.noClient}</Kv>
          <Kv label="Group">{device.resolved_group || device.group_name || TERMS.noGroup}</Kv>
          <Kv label="Location">{location}</Kv>
          <Kv label="Source">
            <span className="th-kv-chip" data-pill>
              {assignmentSourceLabel(device.resolved_assignment_source || device.assignment_source)}
            </span>
          </Kv>
        </dl>
        {editing && (
          <div
            id={editorId}
            className="th-assign-edit"
            role="group"
            aria-label="Edit assignment"
            style={{ "--cols": pickers } as CSSProperties}
          >
            {canAssignClient && (
              <div>
                <span className="th-assign-edit-label">Client</span>
                <SelectField
                  aria-label="Assign client"
                  value={device.client_id ?? "none"}
                  onChange={async (event) => {
                    const value = event.target.value === "none" ? null : Number(event.target.value);
                    const updated = await assignDeviceClient(device.id, value);
                    onDeviceUpdated?.(updated);
                  }}
                  className="w-full"
                >
                  <option value="none">{TERMS.noClient}</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
            {canAssignLocation && (
              <div>
                <span className="th-assign-edit-label">Location</span>
                <LocationPicker device={device} active={active} onDeviceUpdated={onDeviceUpdated} />
              </div>
            )}
            {canAssignGroup && (
              <div>
                <span className="th-assign-edit-label">Group</span>
                <GroupPicker
                  device={device}
                  groups={clientGroups}
                  disabled={!clientId}
                  onDeviceUpdated={onDeviceUpdated}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
