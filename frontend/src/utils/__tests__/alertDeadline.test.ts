import { describe, expect, it } from "vitest";

import type { Alert } from "../../types/alert";
import { alertDeadline, formatSpan } from "../alertDeadline";

const NOW = Date.parse("2026-10-19T08:00:00Z");

function alert(extra: Partial<Alert>): Alert {
  return {
    id: 7,
    device_id: 2,
    kind: "service_stopped",
    severity: "critical",
    state: "open",
    message: "Veeam stopped",
    created_at: "2026-10-19T07:50:00",
    updated_at: "2026-10-19T07:50:00",
    ...extra,
  };
}

describe("alertDeadline", () => {
  it("counts down to taking it while nobody has", () => {
    const d = alertDeadline(alert({ ack_due_at: "2026-10-19T08:05:00", resolve_due_at: "2026-10-19T11:50:00" }), NOW);
    expect(d?.label).toBe("Take in 5m");
    expect(d?.overdue).toBe(false);
  });

  it("counts down to the fix once taken, and says when it is late", () => {
    const taken = { acknowledged_at: "2026-10-19T07:55:00", ack_due_at: "2026-10-19T08:05:00" };
    expect(alertDeadline(alert({ ...taken, resolve_due_at: "2026-10-19T11:20:00" }), NOW)?.label).toBe("Fix in 3h 20m");
    const late = alertDeadline(alert({ ...taken, resolve_due_at: "2026-10-19T06:00:00" }), NOW);
    expect(late?.label).toBe("Fix overdue 2h");
    expect(late?.tone).toBe("var(--th-status-critical)");
  });

  it("shows who it waits on instead of a clock, and nothing once resolved", () => {
    expect(alertDeadline(alert({ waiting_since: "2026-10-19T07:00:00", waiting_reason: "vendor" }), NOW)?.label).toBe(
      "Waiting on a vendor",
    );
    expect(alertDeadline(alert({ state: "resolved", resolve_due_at: "2026-10-19T06:00:00" }), NOW)).toBeNull();
  });

  it("formats spans in minutes, hours and days", () => {
    expect(formatSpan(45 * 60_000)).toBe("45m");
    expect(formatSpan(4 * 3_600_000)).toBe("4h");
    expect(formatSpan(52 * 3_600_000)).toBe("2d 4h");
  });
});
