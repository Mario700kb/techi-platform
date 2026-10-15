import { DeviceGroup } from "../api/clients";
import { assignDeviceGroup, assignDeviceStandardGroup, Device } from "../api/devices";
import { STANDARD_GROUPS, StandardGroup } from "../types/groups";
import { TERMS } from "../utils/deviceStatus";
import { SelectField } from "./ui";

const STANDARD = "std:";

/**
 * A device's group, set by hand: the six standard groups every client can
 * have (Servers, Client PC, Network, Storage, Hypervisors, Other — one is made
 * for the client the first time it is chosen), then the client's own groups.
 * A group chosen here is kept; the automatic assignment never undoes it.
 */
export default function GroupPicker({
  device,
  groups,
  disabled = false,
  onDeviceUpdated,
}: {
  device: Device;
  /** The client's existing groups. */
  groups: DeviceGroup[];
  disabled?: boolean;
  onDeviceUpdated?: (device: Device) => void;
}) {
  const byName = new Map(groups.map((g) => [g.name.trim().toLowerCase(), g]));
  const standardValue = (name: StandardGroup) => {
    const existing = byName.get(name.toLowerCase());
    return existing ? String(existing.id) : `${STANDARD}${name}`;
  };
  const custom = groups.filter(
    (g) => !STANDARD_GROUPS.some((name) => name.toLowerCase() === g.name.trim().toLowerCase()),
  );
  // A standard group made a moment ago may not be in `groups` yet: show it by name.
  const known = device.group_id != null && groups.some((g) => g.id === device.group_id);
  const madeNow = STANDARD_GROUPS.find((name) => name.toLowerCase() === (device.group_name ?? "").trim().toLowerCase());
  const value =
    device.group_id == null ? "none" : known || !madeNow ? String(device.group_id) : `${STANDARD}${madeNow}`;

  return (
    <SelectField
      value={value}
      disabled={disabled}
      aria-label="Assign group"
      onChange={async (event) => {
        const next = event.target.value;
        const updated =
          next === "none"
            ? await assignDeviceGroup(device.id, null)
            : next.startsWith(STANDARD)
              ? await assignDeviceStandardGroup(device.id, next.slice(STANDARD.length) as StandardGroup)
              : await assignDeviceGroup(device.id, Number(next));
        onDeviceUpdated?.(updated);
      }}
      className="w-full"
    >
      <option value="none">{TERMS.noGroup}</option>
      {STANDARD_GROUPS.map((name) => (
        <option key={name} value={standardValue(name)}>
          {name}
        </option>
      ))}
      {custom.map((group) => (
        <option key={group.id} value={group.id}>
          {group.name}
        </option>
      ))}
    </SelectField>
  );
}
