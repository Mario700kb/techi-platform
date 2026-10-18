import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, DeviceGroup } from "../../api/clients";
import type { Device } from "../../api/devices";
import DeviceAssignmentCard from "../DeviceAssignmentCard";

const assignDeviceClient = vi.fn();
vi.mock("../../api/devices", async (importActual) => ({
  ...(await importActual<typeof import("../../api/devices")>()),
  assignDeviceClient: (...a: unknown[]) => assignDeviceClient(...a),
}));
vi.mock("../../api/clients", async (importActual) => ({
  ...(await importActual<typeof import("../../api/clients")>()),
  getClientLocations: () => Promise.resolve({ locations: [], unlocated: { total: 0, online: 0 } }),
}));

const CLIENTS: Client[] = [
  { id: 1, name: "TECHI shpk", slug: "techi", is_active: true, created_at: "2025-01-01T00:00:00Z" },
  { id: 2, name: "Northwind", slug: "northwind", is_active: true, created_at: "2025-01-01T00:00:00Z" },
];
const GROUPS: DeviceGroup[] = [
  { id: 5, client_id: 1, name: "Servers", created_at: "2025-01-01T00:00:00Z" },
  { id: 6, client_id: 2, name: "Front desk", created_at: "2025-01-01T00:00:00Z" },
];

const DEVICE = {
  id: 7,
  hostname: "HV-PROD-01",
  client_id: 1,
  client_name: "TECHI shpk",
  group_id: 5,
  group_name: "Servers",
  location_id: 3,
  location_name: "HQ",
  location_city: "Durrës",
  location_country: "AL",
  location_source: "rule",
  assignment_source: "manual",
} as Device;

function renderCard(perms: { client?: boolean; location?: boolean; group?: boolean } = {}, device = DEVICE) {
  const onDeviceUpdated = vi.fn();
  const view = render(
    <DeviceAssignmentCard
      device={device}
      clients={CLIENTS}
      groups={GROUPS}
      canAssignClient={perms.client ?? false}
      canAssignLocation={perms.location ?? false}
      canAssignGroup={perms.group ?? false}
      active
      onDeviceUpdated={onDeviceUpdated}
    />,
  );
  return { ...view, onDeviceUpdated };
}

describe("DeviceAssignmentCard", () => {
  beforeEach(() => assignDeviceClient.mockReset());

  it("reads as a compact grid: client, group, location by rule and the source", () => {
    renderCard({ client: true, location: true, group: true });
    const card = screen.getByRole("region", { name: "Client assignment" });
    expect(within(card).getByText("TECHI shpk")).toBeInTheDocument();
    expect(within(card).getByText("Servers")).toBeInTheDocument();
    expect(within(card).getByText("HQ · Durrës, Albania · by rule")).toBeInTheDocument();
    expect(within(card).getByText("Manual")).toBeInTheDocument();
    // Read view by default: no pickers until the operator asks for them.
    expect(within(card).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(card).getByRole("button", { name: "Edit assignment" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the three pickers in place and closes them again with Done", () => {
    renderCard({ client: true, location: true, group: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit assignment" }));
    const editor = screen.getByRole("group", { name: "Edit assignment" });
    expect(within(editor).getByRole("combobox", { name: "Assign client" })).toHaveTextContent("TECHI shpk");
    expect(within(editor).getByRole("combobox", { name: "Assign location" })).toBeInTheDocument();
    expect(within(editor).getByRole("combobox", { name: "Assign group" })).toHaveTextContent("Servers");
    expect(editor.style.getPropertyValue("--cols")).toBe("3");
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("group", { name: "Edit assignment" })).toBeNull();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });

  it("saves a new client the moment it is chosen, as before", async () => {
    const updated = { ...DEVICE, client_id: 2, client_name: "Northwind" };
    assignDeviceClient.mockResolvedValue(updated);
    const { onDeviceUpdated } = renderCard({ client: true, group: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit assignment" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Assign client" }));
    fireEvent.click(screen.getByRole("option", { name: "Northwind" }));
    await waitFor(() => expect(assignDeviceClient).toHaveBeenCalledWith(7, 2));
    await waitFor(() => expect(onDeviceUpdated).toHaveBeenCalledWith(updated));
  });

  it("offers no edit to someone who may not assign", () => {
    renderCard({});
    expect(screen.queryByRole("button", { name: "Edit assignment" })).toBeNull();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getByText("TECHI shpk")).toBeInTheDocument();
  });

  it("shows only the pickers the operator is allowed to use", () => {
    // Location needs manage_clients; client and group need operate rights.
    const { unmount } = renderCard({ location: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit assignment" }));
    let editor = screen.getByRole("group", { name: "Edit assignment" });
    expect(
      within(editor)
        .getAllByRole("combobox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Assign location"]);
    expect(editor.style.getPropertyValue("--cols")).toBe("1");
    unmount();

    renderCard({ client: true, group: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit assignment" }));
    editor = screen.getByRole("group", { name: "Edit assignment" });
    expect(
      within(editor)
        .getAllByRole("combobox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Assign client", "Assign group"]);
  });

  it("closes the editor when the drawer moves to another device", () => {
    const { rerender } = renderCard({ client: true, group: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit assignment" }));
    expect(screen.getByRole("group", { name: "Edit assignment" })).toBeInTheDocument();
    rerender(
      <DeviceAssignmentCard
        device={{ ...DEVICE, id: 8 }}
        clients={CLIENTS}
        groups={GROUPS}
        canAssignClient
        canAssignLocation={false}
        canAssignGroup
        active
      />,
    );
    expect(screen.queryByRole("group", { name: "Edit assignment" })).toBeNull();
  });

  it("keeps the group picker off until the device has a client", () => {
    renderCard({ client: true, group: true }, { ...DEVICE, client_id: undefined, client_name: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Edit assignment" }));
    expect(screen.getByRole("combobox", { name: "Assign group" })).toBeDisabled();
  });
});
