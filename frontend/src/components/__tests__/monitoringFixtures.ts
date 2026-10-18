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

/** The same day from agent 2.1.33: disk activity, network quality, a busy
 * minute's top processes, a restart, an alert and the device health report. */
export function metrics233Fixture(): DeviceMetrics {
  const base = metricsFixture();
  const points = base.points.map((p, i) => ({
    ...p,
    disk_busy_avg: 8 + (i % 9),
    disk_busy_max: i === 200 ? 97 : 20 + (i % 9),
    disk_queue_avg: 0.2,
    disk_read_avg: 2_000_000 + i * 1000,
    disk_write_avg: 900_000,
    gw_ms_avg: 2 + (i % 3),
    gw_ms_max: 6,
    gw_loss_avg: i === 210 ? 25 : 0,
    gw_loss_max: i === 210 ? 50 : 0,
    wan_ms_avg: 31,
    top:
      i === 200
        ? [
            { n: "MsMpEng.exe", c: 61.2, m: 310 },
            { n: "chrome.exe", c: 12, m: 1800 },
          ]
        : null,
  }));
  return {
    ...base,
    points,
    summary: {
      ...base.summary,
      disk_busy_avg: 12,
      disk_busy_peak: 97,
      disk_read_peak: 52_000_000,
      gw_ms_avg: 2.9,
      gw_ms_peak: 6,
      gw_loss_avg: 0.1,
      wan_ms_avg: 31,
    },
    disks: [
      ...base.disks,
      {
        mount: "E:",
        used_pct: 89,
        free_gb: 0.1,
        total_gb: 1,
        growth_gb_per_day: null,
        days_to_90: null,
        days_to_full: null,
        history: [],
        monitored: false,
      },
    ],
    restarts: [at(600)],
    alerts: [
      {
        id: 91,
        kind: "high_cpu",
        severity: "critical",
        message: "CPU above 95% for 15 min on NW-RECEPTION-01",
        start: at(400),
        end: at(380),
      },
    ],
    processes: [
      { name: "MsMpEng.exe", minutes: 4, cpu_peak: 61.2, cpu_peak_at: at(400), mem_peak_mb: 310 },
      { name: "chrome.exe", minutes: 9, cpu_peak: 12, cpu_peak_at: at(380), mem_peak_mb: 1800 },
    ],
  };
}

export function monitoring233Fixture(): DeviceMonitoring {
  const base = monitoringFixture(false);
  return {
    ...base,
    monitors: [
      ...base.monitors,
      {
        key: "net_rx",
        metric: "net_rx_mbps",
        rule: "above 800 Mb/s for 5 min",
        severity: "info",
        enabled: false,
        state: "off",
        now: "now 0 Mb/s",
        alert_id: null,
      },
      {
        key: "disk_health",
        metric: "disk_health",
        rule: "a disk reports a problem",
        severity: "critical",
        enabled: true,
        state: "firing",
        now: "ST1000DM003: SMART predicts failure",
        alert_id: 92,
      },
    ],
    health: {
      collected_at: at(20),
      disks: [
        {
          name: "Samsung SSD 870 EVO 500GB",
          media: "SSD",
          bus: "SATA",
          size_gb: 465.8,
          health: "healthy",
          operational: "OK",
          predict_failure: false,
          temperature_c: 34,
          wear_pct: 3,
          power_on_hours: 8123,
          read_errors: 0,
          write_errors: 0,
          problem: null,
        },
        {
          name: "ST1000DM003",
          media: "HDD",
          bus: "SATA",
          size_gb: 931.5,
          health: "warning",
          operational: "Predictive Failure",
          predict_failure: true,
          temperature_c: 58,
          wear_pct: null,
          power_on_hours: 41000,
          read_errors: 12,
          write_errors: 0,
          problem: "SMART predicts failure",
        },
      ],
      reboot_pending: true,
      reboot_reasons: ["Windows Update"],
      reboot_pending_since: "2026-10-08T07:00:00Z",
      events: [
        {
          at: at(90),
          source: "Microsoft-Windows-WER-SystemErrorReporting",
          event_id: 1001,
          category: "crash",
          level: "critical",
          title: "Blue screen (stop error)",
          message: "The computer has rebooted from a bugcheck.",
        },
        {
          at: at(95),
          source: "disk",
          event_id: 7,
          category: "disk",
          level: "error",
          title: "Bad block on a disk",
          message: null,
        },
      ],
    },
  };
}
