import type { DeviceMetrics, DeviceMonitoring, MetricPoint } from "../../api/monitoring";

const END = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(END - minutesAgo * MIN).toISOString();

/** A day of 5-minute points; minutes 600–720 ago the device was off. */
export function metricsFixture(overrides: Partial<DeviceMetrics> = {}): DeviceMetrics {
  const points: MetricPoint[] = [];
  for (let m = 1440; m >= 0; m -= 5) {
    if (m < 720 && m > 600) continue;
    const i = points.length;
    points.push({
      t: at(m),
      samples: 5,
      expected: 5,
      cpu_avg: 10 + (i % 7),
      cpu_max: 20 + (i % 11),
      mem_avg: 40 + (i % 5),
      mem_max: 45 + (i % 5),
      rx_avg: 30_000 + i * 10,
      rx_max: 60_000,
      tx_avg: 12_000,
      tx_max: 20_000,
      disk_max: 54,
    });
  }
  return {
    range: "24h",
    resolution: "5m",
    source: "agent",
    start: at(1440),
    end: at(0),
    points,
    summary: {
      cpu_avg: 12.4,
      cpu_p95: 31,
      cpu_peak: 71,
      cpu_peak_at: "2026-10-17T09:14:00Z",
      mem_avg: 42,
      mem_peak: 48,
      rx_peak: 412_000_000,
      tx_peak: 96_000_000,
    },
    disks: [
      {
        mount: "C:",
        used_pct: 41,
        free_gb: 70.2,
        total_gb: 238,
        growth_gb_per_day: 0.01,
        days_to_90: null,
        days_to_full: null,
        history: [40, 40.5, 41, 41],
      },
      {
        mount: "D:",
        used_pct: 86,
        free_gb: 65,
        total_gb: 465,
        growth_gb_per_day: 1.1,
        days_to_90: 9,
        days_to_full: 41,
        history: [80, 82, 84, 86],
      },
    ],
    coverage: {
      received: 931,
      late: 14,
      missing_minutes: 14,
      off_minutes: 120,
      pct: 99.98,
      segments: [
        { start: at(1440), end: at(720), kind: "received" },
        { start: at(720), end: at(600), kind: "off" },
        { start: at(600), end: at(300), kind: "received" },
        { start: at(300), end: at(286), kind: "missing" },
        { start: at(286), end: at(272), kind: "late" },
        { start: at(272), end: at(0), kind: "received" },
      ],
    },
    delivery: {
      last_upload_at: at(4),
      last_sample_at: at(1),
      pending: 4,
      oldest_pending_at: at(4),
      dropped_total: 0,
      clock_offset_ms: 400,
      sample_seconds: 60,
      policy_version: "3",
      policy_current: true,
    },
    policy: {
      version: "3",
      sample_seconds: 60,
      upload_seconds: 900,
      buffer_mb: 50,
      keep_days: 30,
      policies: ["Workstations"],
      monitors: [
        { key: "cpu", metric: "cpu", op: ">", threshold: 95, duration_s: 900, severity: "critical", enabled: true },
      ],
    },
    ...overrides,
  };
}

export function monitoringFixture(firing = false): DeviceMonitoring {
  const m = metricsFixture();
  return {
    policy: m.policy,
    delivery: m.delivery,
    monitors: [
      {
        key: "cpu",
        metric: "cpu",
        rule: "above 95% for 15 min",
        severity: "critical",
        enabled: true,
        state: firing ? "firing" : "ok",
        now: "now 3%",
        alert_id: firing ? 77 : null,
      },
      {
        key: "mem",
        metric: "mem",
        rule: "above 90% for 10 min",
        severity: "warning",
        enabled: true,
        state: "ok",
        now: "now 24%",
        alert_id: null,
      },
      {
        key: "disk",
        metric: "disk",
        rule: "above 90%",
        severity: "warning",
        enabled: true,
        state: "watch",
        now: "now 86%",
        alert_id: null,
      },
      {
        key: "no_data",
        metric: "no_data",
        rule: "no data for 10 min while on",
        severity: "critical",
        enabled: true,
        state: "ok",
        now: "arriving",
        alert_id: null,
      },
    ],
  };
}
