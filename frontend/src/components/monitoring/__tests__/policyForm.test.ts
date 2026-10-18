import { describe, expect, it } from "vitest";

import type { PolicyBody } from "../../../api/monitoring";
import { changeMetric, DEFAULT_SERVICES, newMonitor, toBody, toDraft, validate } from "../policyForm";

const base: PolicyBody = {
  name: "Servers",
  description: null,
  scope: "device_type",
  scope_value: "servers",
  enabled: true,
  sample_seconds: 60,
  upload_seconds: 900,
  buffer_mb: 50,
  keep_days: 7,
  monitors: [],
};

describe("policy form · 2.1.33 monitors", () => {
  it("writes each kind of condition the way the backend expects", () => {
    const draft = toDraft(base);
    const taken: string[] = [];
    for (const metric of [
      "disk_busy",
      "gw_ms",
      "service",
      "disk_health",
      "critical_events",
      "reboot_pending_days",
      "security_score",
    ] as const) {
      const row = newMonitor(metric, taken);
      taken.push(row.key);
      draft.monitors.push(row);
    }
    expect(validate(draft).list).toEqual([]);
    const monitors = Object.fromEntries(toBody(draft).monitors.map((m) => [m.metric, m]));
    expect(monitors.disk_busy).toMatchObject({ key: "disk_busy", op: ">", threshold: 90, duration_s: 1200 });
    expect(monitors.gw_ms).toMatchObject({ key: "gw_latency", threshold: 150, duration_s: 600 });
    expect(monitors.service).toMatchObject({
      key: "services",
      threshold: 0,
      duration_s: 300,
      target: DEFAULT_SERVICES,
    });
    expect(monitors.disk_health).toMatchObject({ threshold: 0, duration_s: 0, severity: "critical" });
    expect(monitors.critical_events).toMatchObject({ op: ">", threshold: 0, duration_s: 0 });
    expect(monitors.reboot_pending_days).toMatchObject({ key: "reboot_pending", op: ">", threshold: 7, duration_s: 0 });
    expect(monitors.security_score).toMatchObject({ key: "security", op: "<", threshold: 70, duration_s: 0 });
    expect(monitors.disk_busy.target).toBeUndefined();
  });

  it("asks for valid service names and tidies the list", () => {
    const draft = toDraft(base);
    const row = { ...newMonitor("service", []), target: "  " };
    draft.monitors.push(row);
    expect(validate(draft).monitors[row.rowId].target).toBe("Monitor 1: name at least one service.");
    row.target = "MSSQL$SAGE, bad;name";
    expect(validate(draft).monitors[row.rowId].target).toBe('Monitor 1: "bad;name" is not a service name.');
    row.target = " vmms , MSSQL* ,vmms,, ";
    expect(validate(draft).list).toEqual([]);
    expect(toBody(draft).monitors[0].target).toBe("vmms, MSSQL*");
  });

  it("checks each threshold in its own unit", () => {
    const draft = toDraft(base);
    const score = { ...newMonitor("security_score", []), threshold: "140" };
    const events = { ...newMonitor("critical_events", ["security"]), threshold: "1.5" };
    const latency = { ...newMonitor("gw_ms", ["security", "critical_events"]), threshold: "0" };
    draft.monitors.push(score, events, latency);
    const problems = validate(draft).monitors;
    expect(problems[score.rowId].threshold).toBe("Monitor 1: a score between 1 and 100.");
    expect(problems[events.rowId].threshold).toBe("Monitor 2: a whole number of events, 0 or more.");
    expect(problems[latency.rowId].threshold).toBe("Monitor 3: a latency between 1 and 60,000 ms.");
  });

  it("gives a row switched to the service metric the default list", () => {
    const row = changeMetric(newMonitor("cpu", []), "service", []);
    expect(row.key).toBe("services");
    expect(row.target).toBe(DEFAULT_SERVICES);
    expect(changeMetric(row, "cpu", []).target).toBe("");
  });
});
