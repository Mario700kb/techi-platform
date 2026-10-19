import { describe, expect, it } from "vitest";

import type { Alert } from "../../types/alert";
import { describeAlert } from "../alertText";

const base = { id: 1, device_id: 7, state: "open", created_at: "", updated_at: "" } as const;
const alert = (overrides: Partial<Alert>): Alert =>
  ({ ...base, kind: "device_offline", severity: "critical", message: "", ...overrides }) as Alert;

describe("describeAlert", () => {
  it("lifts the measured value out of metric messages and drops the stale hostname", () => {
    const ram = describeAlert(
      alert({ kind: "high_ram", severity: "warning", message: "RAM elevated on DESKTOP-098OMH1: 81.0%" }),
    );
    expect(ram).toMatchObject({ summary: "Memory usage elevated", value: "81.0%" });

    const disk = describeAlert(
      alert({ kind: "low_disk", severity: "critical", message: "Disk critical on srv: 97.2% used" }),
    );
    expect(disk).toMatchObject({ summary: "Disk usage critical", value: "97.2%" });
  });

  it("describes offline and reconnect alerts without the device name", () => {
    expect(describeAlert(alert({ message: "pos2-qtu went offline" }))).toMatchObject({
      summary: "Stopped sending heartbeats",
      value: null,
    });
    expect(
      describeAlert(
        alert({
          kind: "repeated_reconnects",
          severity: "warning",
          message: "ws-01 reconnected 4× in the last 10 minutes",
        }),
      ),
    ).toMatchObject({ summary: "Connection keeps dropping", value: "4×" });
  });

  it("prefers the stored detail for Remote Support sync and unknown kinds", () => {
    expect(
      describeAlert(alert({ kind: "rustdesk_sync_failure", severity: "warning", message: "x", detail: "ID mismatch" }))
        .summary,
    ).toBe("ID mismatch");
    expect(
      describeAlert(alert({ kind: "token_usage_warning", severity: "warning", message: "Token 'GPO' 18 of 20 uses" }))
        .summary,
    ).toBe("Token 'GPO' 18 of 20 uses");
  });

  it("keeps a metric alert readable when its message carries no number", () => {
    expect(describeAlert(alert({ kind: "high_cpu", severity: "critical", message: "CPU critical" }))).toMatchObject({
      summary: "CPU usage critical",
      value: null,
    });
  });
});

describe("describeAlert with the server's wording", () => {
  it("uses the title, summary and value the server sends", () => {
    const shutdown = describeAlert(
      alert({
        kind: "critical_events",
        severity: "warning",
        message: "Unexpected shutdown: 2 times in 7 days on X",
        title: "Unexpected shutdown",
        summary: "2× in 7 days · last 19 Oct 18:59 UTC",
        value: "2×",
      }),
    );
    expect(shutdown).toEqual({
      title: "Unexpected shutdown",
      summary: "2× in 7 days · last 19 Oct 18:59 UTC",
      value: "2×",
    });
  });

  it("shows the measured CPU, not the monitor's threshold", () => {
    const cpu = describeAlert(
      alert({ kind: "high_cpu", severity: "critical", message: "CPU above 95% for 15 min on ARCH-03 (now 98%)" }),
    );
    expect(cpu.value).toBe("98%");
  });
});
