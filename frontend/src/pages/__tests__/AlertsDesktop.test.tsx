import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as alertsApi from "../../api/alerts";
import type { Alert, AlertCount, AlertDetail } from "../../types/alert";
import AlertsDesktop from "../AlertsDesktop";

const reloadAlerts = vi.fn();
vi.mock("../../contexts/AppDataContext", () => ({
  useAppData: () => ({ latestEvent: null, reloadAlerts }),
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, username: "denis" }, can: () => true, hasPermission: () => true }),
}));

const service: Alert = {
  id: 11,
  device_id: 774,
  kind: "service_stopped",
  severity: "critical",
  state: "open",
  message: "Service stopped for 5 min on SRV-FILE-02: Veeam",
  created_at: "2026-10-19T10:00:00Z",
  updated_at: "2026-10-19T10:00:00Z",
  device_name: "SRV-FILE-02",
  client_name: "Vasgroup",
  priority: 1,
  title: "Service stopped · Veeam",
  summary: "Set to start automatically",
  device_role: "server",
  occurrences: 1,
  fingerprint: "svc:veeam",
};
const shutdown: Alert = {
  id: 12,
  device_id: 81,
  kind: "critical_events",
  severity: "warning",
  state: "open",
  message: "Unexpected shutdown: 3 times in 7 days on RECEPTION-08",
  created_at: "2026-10-19T09:00:00Z",
  updated_at: "2026-10-19T09:00:00Z",
  device_name: "RECEPTION-08",
  client_name: "Vasgroup",
  priority: 2,
  title: "Unexpected shutdown",
  summary: "3× in 7 days · last 19 Oct 18:59 UTC",
  value: "3×",
  occurrences: 2,
  fingerprint: "evt:shutdown",
  assigned_to_id: null,
};
const counts: AlertCount = {
  total_open: 41,
  by_severity: { critical: 3, warning: 38 },
  by_kind: { critical_events: 30, service_stopped: 11 },
  views: { needs_action: 2, mine: 0, open: 41, snoozed: 5 },
  by_priority: { "1": 1, "2": 1, "3": 39 },
};

function renderPage() {
  render(
    <MemoryRouter>
      <AlertsDesktop />
    </MemoryRouter>,
  );
}

describe("AlertsDesktop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    reloadAlerts.mockReset();
    vi.spyOn(alertsApi, "getAlertCount").mockResolvedValue(counts);
  });

  it("opens on Needs action, with the server's words, priority and counts", async () => {
    const queue = vi.spyOn(alertsApi, "getAlertQueue").mockResolvedValue({ items: [service, shutdown], total: 2 });
    renderPage();

    const table = await screen.findByRole("table");
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ view: "needs_action", offset: 0 }));
    expect(within(table).getByText("Service stopped · Veeam")).toBeInTheDocument();
    expect(within(table).getByText("Unexpected shutdown")).toBeInTheDocument();
    expect(within(table).getByText("×2")).toBeInTheDocument();
    expect(within(table).getByText("P1")).toBeInTheDocument();
    expect(within(table).queryByText("critical_events")).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Alert view" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /All open/ })).toHaveTextContent("41"));
  });

  it("switches views on the server", async () => {
    const queue = vi.spyOn(alertsApi, "getAlertQueue").mockResolvedValue({ items: [service], total: 1 });
    renderPage();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("tab", { name: /Snoozed/ }));
    await waitFor(() => expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({ view: "snoozed" })));
  });

  it("takes an alert", async () => {
    vi.spyOn(alertsApi, "getAlertQueue").mockResolvedValue({ items: [service, shutdown], total: 2 });
    const take = vi
      .spyOn(alertsApi, "takeAlert")
      .mockResolvedValue({ ...service, assigned_to_id: 1, assigned_to_name: "denis" });
    renderPage();
    const table = await screen.findByRole("table");
    const row = within(table).getByText("Service stopped · Veeam").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Take" }));
    await waitFor(() => expect(take).toHaveBeenCalledWith(11));
    expect(reloadAlerts).toHaveBeenCalled();
  });

  it("opens the alert panel with the description, runbook and AI analysis", async () => {
    vi.spyOn(alertsApi, "getAlertQueue").mockResolvedValue({ items: [shutdown], total: 1 });
    const detail: AlertDetail = {
      alert: shutdown,
      description: "Unexpected shutdown on this workstation. 3× in 7 days.",
      facts: { role: "pc", os: "Windows 11 Pro" },
      evidence: {
        events: [
          {
            at: "2026-10-19T16:59:00Z",
            source: "Microsoft-Windows-Kernel-Power",
            event_id: 41,
            title: "Restarted without a clean shutdown",
            message: null,
            counts: true,
          },
        ],
      },
      history: ["2026-10-14T11:40:00Z", "2026-10-19T16:59:00Z"],
      activity: [{ id: 1, at: "2026-10-19T17:00:00Z", actor: null, action: "opened", detail: null }],
      runbook: {
        key: "evt:shutdown",
        why: "Windows restarted without shutting down cleanly.",
        steps: ["Read the Kernel-Power 41 details."],
        commands: [
          {
            label: "Kernel-Power 41 details",
            script: "Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41 }",
            risk: "read_only",
          },
        ],
        escalate: null,
      },
      analysis: null,
      ai_enabled: true,
    };
    vi.spyOn(alertsApi, "getAlertDetail").mockResolvedValue(detail);
    const analyze = vi.spyOn(alertsApi, "analyzeAlert").mockResolvedValue({
      id: 5,
      alert_id: 12,
      group_key: null,
      language: "sq",
      model: "claude-opus-5-5",
      created_at: "2026-10-19T17:05:00Z",
      created_by: "denis",
      result: {
        summary: "Tri rinisje pa fikje normale.",
        likely_causes: [{ cause: "Ndërprerje korrenti", confidence: "high", evidence: "Asnjë 1001" }],
        diagnostic_steps: [
          { step: "Lexo eventet 41", command: "Get-WinEvent -LogName System -MaxEvents 5", risk: "read_only" },
        ],
        fix_steps: [{ step: "Fshi temp", command: "Remove-Item C:\\Temp -Recurse", risk: "data_risk" }],
        verify: "Asnjë 41 i ri.",
        escalate_when: "Disa PC njëherësh.",
        missing_information: [],
      },
      error: null,
      input_tokens: 6100,
      output_tokens: 2400,
      cost_usd: 0.072,
      rating: null,
      cached: false,
      stale: false,
    });
    renderPage();
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByText("Unexpected shutdown"));

    const panel = await screen.findByRole("complementary", { name: "Alert" });
    expect(
      await within(panel).findByText("Unexpected shutdown on this workstation. 3× in 7 days."),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Kernel-Power 41 details")).toBeInTheDocument();
    expect(within(panel).getByText("2× in 30 days")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: /Analyze with AI/ }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(12, { language: "sq", force: false }));
    expect(await within(panel).findByText("Tri rinisje pa fikje normale.")).toBeInTheDocument();
    expect(within(panel).getByText("Data risk")).toBeInTheDocument();
  });

  it("groups by issue and drills into one", async () => {
    const queue = vi.spyOn(alertsApi, "getAlertQueue").mockResolvedValue({ items: [shutdown], total: 1 });
    vi.spyOn(alertsApi, "getAlertGroups").mockResolvedValue([
      {
        key: "critical_events|evt:shutdown",
        label: "Unexpected shutdown",
        title: "Unexpected shutdown",
        kind: "critical_events",
        fingerprint: "evt:shutdown",
        client_id: null,
        device_id: null,
        count: 4,
        devices: 4,
        priority: 2,
        critical: 0,
        latest: "2026-10-19T17:00:00Z",
      },
    ]);
    renderPage();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "By issue" }));
    const row = (await screen.findByText("Unexpected shutdown")).closest("tr")!;
    expect(within(row).getByRole("button", { name: /Analyze group/ })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({ issue: "critical_events|evt:shutdown" })),
    );
    expect(screen.getByRole("button", { name: /Show all/ })).toBeInTheDocument();
  });
});
