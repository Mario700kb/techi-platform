import { describe, expect, it } from "vitest";

import type { Alert } from "../../types/alert";
import { describeAlert } from "../alertText";

const base = { id: 1, device_id: 7, state: "open", created_at: "", updated_at: "" } as const;
const alert = (overrides: Partial<Alert>): Alert => ({ ...base, kind: "device_offline", severity: "critical", message: "", ...overrides } as Alert);

describe("describeAlert", () => {
  it("lifts the measured value out of metric messages and drops the stale hostname", () => {
    const ram = describeAlert(alert({ kind: "high_ram", severity: "warning", message: "RAM elevated on DESKTOP-098OMH1: 81.0%" }));
    expect(ram).toEqual({ summary: "Memory usage elevated", value: "81.0%" });

    const disk = describeAlert(alert({ kind: "low_disk", severity: "critical", message: "Disk critical on srv: 97.2% used" }));
    expect(disk).toEqual({ summary: "Disk usage critical", value: "97.2%" });
  });

  it("describes offline and reconnect alerts without the device name", () => {
    expect(describeAlert(alert({ message: "pos2-qtu went offline" }))).toEqual({ summary: "Stopped sending heartbeats", value: null });
    expect(describeAlert(alert({ kind: "repeated_reconnects", severity: "warning", message: "ws-01 reconnected 4× in the last 10 minutes" })))
      .toEqual({ summary: "Connection keeps dropping", value: "4×" });
  });

  it("prefers the stored detail for Remote Support sync and unknown kinds", () => {
    expect(describeAlert(alert({ kind: "rustdesk_sync_failure", severity: "warning", message: "x", detail: "ID mismatch" })).summary).toBe("ID mismatch");
    expect(describeAlert(alert({ kind: "token_usage_warning", severity: "warning", message: "Token 'GPO' 18 of 20 uses" })).summary).toBe("Token 'GPO' 18 of 20 uses");
  });

  it("keeps a metric alert readable when its message carries no number", () => {
    expect(describeAlert(alert({ kind: "high_cpu", severity: "critical", message: "CPU critical" }))).toEqual({ summary: "CPU usage critical", value: null });
  });
});
