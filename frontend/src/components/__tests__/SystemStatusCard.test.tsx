import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as systemApi from "../../api/system";
import SystemStatusCard from "../SystemStatusCard";

vi.mock("../../contexts/AppDataContext", () => ({
  useAppData: () => ({ realtimeStatus: "connected" }),
}));

const services: systemApi.ServiceTile[] = [
  { key: "database", state: "ok", label: "Live", detail: "3 ms · schema e1f2a3b4c5d6" },
  { key: "agents", state: "ok", label: "Live", detail: "612 reporting · last 5 min", value: 612, total: 665 },
  { key: "agent_versions", state: "done", label: "Synced", detail: "687 / 773 on 2.1.20", value: 687, total: 773 },
  { key: "workers", state: "ok", label: "4 / 4", detail: "All background jobs ticking",
    items: [{ name: "reports", state: "ok" }, { name: "reconcile", state: "ok" }] },
  { key: "cleanup", state: "done", label: "Done", detail: "41,208 rows removed · 1.8 s", at: "2026-10-05T03:00:00" },
  { key: "backup", state: "done", label: "Done", detail: "148 MB · verified", at: "2026-10-05T01:00:00" },
];

describe("SystemStatusCard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows all eight services, the browser-measured API and the realtime link", async () => {
    vi.spyOn(systemApi, "getSystemStatus").mockResolvedValue({ checked_at: "2026-10-05T15:00:00Z", services });
    render(<SystemStatusCard />);
    expect(await screen.findByText("All systems operational")).toBeInTheDocument();
    for (const title of ["API ↔ Web", "Realtime", "Database", "Agents", "Agent versions", "Workers", "Nightly cleanup", "Nightly backup"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getByText("WebSocket connected")).toBeInTheDocument();
    expect(screen.getByText(/ms · round trip/)).toBeInTheDocument();
  });

  it("summarises a down service in the header", async () => {
    vi.spyOn(systemApi, "getSystemStatus").mockResolvedValue({
      checked_at: "2026-10-05T15:00:00Z",
      services: services.map((s) => (s.key === "backup" ? { ...s, state: "down", label: "Missing", detail: "No verified backup found" } : s)),
    });
    render(<SystemStatusCard />);
    expect(await screen.findByText("1 service down")).toBeInTheDocument();
  });

  it("marks the API down when the backend does not answer", async () => {
    vi.spyOn(systemApi, "getSystemStatus").mockRejectedValue(new Error("Network error"));
    render(<SystemStatusCard />);
    await waitFor(() => expect(screen.getByText("Backend not responding")).toBeInTheDocument());
    expect(screen.getByText("1 service down")).toBeInTheDocument();
  });
});
