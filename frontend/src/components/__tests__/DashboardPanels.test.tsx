import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { FleetRisk } from "../../api/devices";
import type { Alert } from "../../types/alert";
import { AgentVersionsCard, SecurityRiskCard, slaRows } from "../DashboardPanels";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function alert(id: number, fields: Partial<Alert>): Alert {
  return { id, state: "open", kind: "device_offline", severity: "warning", message: "", ...fields } as Alert;
}

const RISK: FleetRisk = {
  devices: 40,
  security: { reported: 30, average_score: 82.4, protected: 27 },
  health_reported: 35,
  checks: [
    {
      key: "no_antivirus",
      label: "No antivirus enabled",
      group: "security",
      severity: "critical",
      count: 0,
      devices: [],
    },
    {
      key: "firewall_off",
      label: "Firewall off",
      group: "security",
      severity: "warning",
      count: 10,
      devices: [{ id: 7, name: "PC-07", client_name: "Northwind", detail: "Firewall off: Public" }],
    },
    {
      key: "disk_full",
      label: "Disk over 90% full",
      group: "health",
      severity: "warning",
      count: 1,
      devices: [{ id: 9, name: "SRV-01", client_name: null, detail: "96% used" }],
    },
  ],
  agent_versions: [
    { family: "windows", version: "2.1.47", count: 30 },
    { family: "windows", version: "2.1.20", count: 8 },
    { family: "linux", version: "2.1.39", count: 2 },
  ],
  generated_at: "2026-11-05T22:00:00Z",
};

describe("slaRows", () => {
  it("lists the nearest deadline first, overdue ones on top, and leaves out alerts with none running", () => {
    const rows = slaRows([
      alert(1, { resolve_due_at: inMinutes(300) }),
      alert(2, { ack_due_at: inMinutes(-20) }),
      alert(3, { ack_due_at: inMinutes(10) }),
      alert(4, { resolve_due_at: inMinutes(5), waiting_since: inMinutes(-60) }),
      alert(5, {}),
      alert(3, { ack_due_at: inMinutes(10) }),
      alert(6, { acknowledged_at: inMinutes(-5), ack_due_at: inMinutes(-30), resolve_due_at: inMinutes(60) }),
    ]);
    expect(rows.map((a) => a.id)).toEqual([2, 3, 6, 1]);
  });
});

describe("SecurityRiskCard", () => {
  it("puts failing checks first and opens the devices behind one", () => {
    render(
      <MemoryRouter>
        <SecurityRiskCard risk={RISK} failed={false} onRetry={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Score 82/100")).toBeInTheDocument();
    expect(screen.getByText("Protection · 27 of 30 protected")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Firewall off10");
    expect(screen.getByRole("button", { name: /No antivirus enabled/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Firewall off/ }));
    const device = screen.getByRole("link", { name: /PC-07/ });
    expect(device).toHaveAttribute("href", "/devices?device=7");
    expect(device).toHaveTextContent("Firewall off: Public");
    expect(screen.getByText("and 9 more")).toBeInTheDocument();
  });
});

describe("AgentVersionsCard", () => {
  it("shows the share on the active versions and links the rest to the update filter", () => {
    render(
      <MemoryRouter>
        <AgentVersionsCard
          risk={RISK}
          failed={false}
          onRetry={() => undefined}
          activeWindows="2.1.47"
          activeLinux={["2.1.39"]}
        />
      </MemoryRouter>,
    );
    const card = screen.getByText("Agent versions").closest("section")!;
    // 32 of 40 agents on an active version.
    expect(within(card).getByText("80%")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Update 8" })).toHaveAttribute(
      "href",
      "/devices?filter=needs_agent_update",
    );
    expect(within(card).getByText("2.1.47 · active")).toBeInTheDocument();
    expect(within(card).getByText("2.1.20").closest("a")).toHaveAttribute("href", "/devices?filter=needs_agent_update");
  });
});
