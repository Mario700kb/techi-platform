import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as clientsApi from "../../api/clients";
import * as devicesApi from "../../api/devices";
import { appCache } from "../../store/appCache";
import Clients from "../Clients";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));

const client = (id: number, name: string, is_active = true) => ({
  id,
  name,
  slug: name.toLowerCase(),
  description: null,
  is_active,
  created_at: "2026-06-01T08:00:00Z",
});

function mockApi() {
  vi.spyOn(clientsApi, "getClients").mockResolvedValue([client(1, "Vasgroup"), client(2, "Oldco", false)]);
  vi.spyOn(clientsApi, "getGroups").mockResolvedValue([
    { id: 10, client_id: 1, name: "Servers", created_at: "" },
    { id: 11, client_id: 1, name: "Reception", created_at: "" },
  ]);
  vi.spyOn(clientsApi, "getTrustedDomains").mockResolvedValue([
    { id: 5, domain: "VASGROUP", client_id: 1, is_active: true } as clientsApi.TrustedDomain,
  ]);
  vi.spyOn(devicesApi, "getDeviceTree").mockResolvedValue({ total: 42, unassigned: 0, by_client: { "1": 42 } });
}

describe("Clients", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    appCache.invalidate();
  });

  it("shows each client's real status and device count", async () => {
    mockApi();
    render(<Clients />);
    const table = (await screen.findAllByRole("table"))[0];
    const vas = within(table).getByText("Vasgroup").closest("tr")!;
    expect(within(vas).getByText("Active")).toBeInTheDocument();
    expect(await within(vas).findByText("42")).toBeInTheDocument();
    const old = within(table).getByText("Oldco").closest("tr")!;
    expect(within(old).getByText("Inactive")).toBeInTheDocument();
  });

  it("finds a client by one of its groups and lists domain mappings", async () => {
    mockApi();
    render(<Clients />);
    await screen.findAllByRole("table");
    fireEvent.change(screen.getByRole("textbox", { name: "Search clients" }), { target: { value: "reception" } });
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getByText("Vasgroup")).toBeInTheDocument();
    expect(within(table).queryByText("Oldco")).toBeNull();
    expect(screen.getByText("VASGROUP")).toBeInTheDocument();
  });
});
