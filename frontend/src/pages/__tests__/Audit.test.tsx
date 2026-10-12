import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auditApi from "../../api/audit";
import Audit from "../Audit";
import { chooseOption } from "../../test/select";

const entry = (id: number, action: string, extra: Partial<auditApi.AuditLogEntry> = {}): auditApi.AuditLogEntry => ({
  id,
  operator_id: 1,
  operator_username: "denis",
  action,
  entity_type: "device",
  entity_id: 291,
  details_json: JSON.stringify({ method: "rustdesk" }),
  created_at: "2026-10-11T18:00:00Z",
  ...extra,
});

describe("Audit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers every action the log holds and filters by it", async () => {
    vi.spyOn(auditApi, "getAuditFacets").mockResolvedValue({
      actions: [
        { value: "remote_connect", count: 3517 },
        { value: "login", count: 1891 },
      ],
      entity_types: [{ value: "device", count: 3589 }],
      operators: [{ value: "denis", count: 4000 }],
    });
    const list = vi
      .spyOn(auditApi, "getAuditLogs")
      .mockResolvedValue({ total: 1, items: [entry(1, "remote_connect")] });
    render(<Audit />);
    await screen.findByText("Remote connect", { selector: ".th-status-chip" });

    await chooseOption("Filter by action", "remote_connect");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ action: "remote_connect", offset: 0 })),
    );
  });

  it("opens an event's details on click", async () => {
    vi.spyOn(auditApi, "getAuditFacets").mockResolvedValue({ actions: [], entity_types: [], operators: [] });
    vi.spyOn(auditApi, "getAuditLogs").mockResolvedValue({ total: 1, items: [entry(1, "ssh_connection_failed")] });
    render(<Audit />);
    const chip = await screen.findByText("SSH connection failed", { selector: ".th-status-chip" });
    fireEvent.click(chip.closest("tr")!);
    expect(await screen.findByText(/"method": "rustdesk"/)).toBeInTheDocument();
  });
});
