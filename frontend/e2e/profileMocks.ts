import type { Page } from "@playwright/test";
import type { ClientMonitoring } from "../src/api/monitoring";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const hours = (fn: (h: number) => number | null) => Array.from({ length: 24 }, (_, h) => fn(h));
const workday = (base: number) => hours((h) => (h >= 8 && h <= 18 ? base + (h % 5) * 4 : null));

/** Northwind's monitoring for a range: a server on 1-minute data, two PCs
 *  (one still on the 5-minute heartbeat), a filling disk and a quiet laptop. */
export function northwindMonitoring(range: ClientMonitoring["range"] = "7d"): ClientMonitoring {
  const daily = range === "30d" || range === "13mo";
  const points = daily ? 30 : range === "24h" ? 24 : 7 * 24;
  const step = daily ? 86_400_000 : 3_600_000;
  return {
    range,
    devices_total: 4,
    devices_reporting: 3,
    one_minute_devices: 2,
    coverage_pct: 99.7,
    coverage_breakdown: { received: 9900, late: 80, missing_minutes: 30, off_minutes: 0, pct: 99.7, segments: [] },
    monitor_alerts: 3,
    monitor_alerts_open: 1,
    cpu_avg: 18,
    busiest_hour: 10,
    busiest_hour_cpu: 41,
    disks_at_risk: 1,
    heatmap: [
      { device_id: 3, name: "NW-SRV-01", cells: hours((h) => (h === 2 ? 82 : 22 + (h % 4) * 3)), peak: 97 },
      { device_id: 1, name: "NW-RECEPTION-01", cells: workday(30), peak: 71 },
      { device_id: 2, name: "NW-DOCTOR-02", cells: workday(12), peak: 42 },
    ],
    trend: Array.from({ length: points }, (_, i) => {
      const work = daily || (i % 24 >= 8 && i % 24 <= 18);
      return {
        t: new Date(Date.now() - (points - 1 - i) * step).toISOString(),
        cpu_avg: work ? 24 + (i % 6) : 8,
        cpu_p95: work ? 55 + (i % 9) * 3 : 20,
        mem_avg: work ? 52 : 38,
      };
    }),
    attention: [
      {
        device_id: 3,
        name: "NW-SRV-01",
        kind: "disk_forecast",
        severity: "critical",
        title: "NW-SRV-01 · D: fills up",
        detail: "86% used, grows 1.1 GB/day: 90% in 5 days, full in 31.",
      },
      {
        device_id: 1,
        name: "NW-RECEPTION-01",
        kind: "mem_sustained",
        severity: "warning",
        title: "NW-RECEPTION-01 · memory pressure",
        detail: "Above 90% on average for 4 h in this period.",
      },
      {
        device_id: 2,
        name: "NW-DOCTOR-02",
        kind: "not_seen",
        severity: "info",
        title: "NW-DOCTOR-02 · not seen for 4 days",
        detail: "No heartbeat or telemetry since then.",
      },
    ],
    devices: [
      {
        device_id: 3,
        name: "NW-SRV-01",
        kind: "server",
        agent_version: "2.1.29",
        spark: Array.from({ length: 40 }, (_, i) => 20 + (i % 6) * 8),
        cpu_peak: 97,
        mem_peak: 84,
        disk_worst: "D:",
        disk_worst_pct: 86,
        coverage_pct: 99.98,
        one_minute: true,
        monitors_firing: 1,
      },
      {
        device_id: 1,
        name: "NW-RECEPTION-01",
        kind: "client",
        agent_version: "2.1.29",
        spark: Array.from({ length: 40 }, (_, i) => (i % 8 < 4 ? 30 : 6)),
        cpu_peak: 71,
        mem_peak: 93,
        disk_worst: "C:",
        disk_worst_pct: 54,
        coverage_pct: 99.4,
        one_minute: true,
        monitors_firing: 0,
      },
      {
        device_id: 2,
        name: "NW-DOCTOR-02",
        kind: "client",
        agent_version: "2.1.20",
        spark: Array.from({ length: 40 }, (_, i) => (i % 8 < 4 ? 14 : null)),
        cpu_peak: 42,
        mem_peak: 51,
        disk_worst: null,
        disk_worst_pct: 72,
        coverage_pct: null,
        one_minute: false,
        monitors_firing: 0,
      },
    ],
  };
}

// Northwind in production's shape: 42 devices over two categories and groups,
// alerts of three kinds, and an activity log of remote sessions and actions.
export async function northwindProfile(page: Page) {
  await page.route("**/api/v1/clients/1/monitoring?*", (route) => {
    const range = new URL(route.request().url()).searchParams.get("range") as ClientMonitoring["range"];
    return route.fulfill({ json: northwindMonitoring(range ?? "7d") });
  });
  await page.route("**/api/v1/clients/1/profile", (route) =>
    route.fulfill({
      json: {
        client: {
          id: 1,
          name: "Northwind Clinic",
          slug: "northwind",
          description: "Clinic network, 3 sites",
          is_active: true,
          created_at: "2025-02-01T00:00:00Z",
        },
        stats: { total: 42, online: 28, stale: 3, offline: 11 },
        by_category: {
          clientpc: { total: 32, online: 21, stale: 2, offline: 9 },
          servers: { total: 9, online: 7, stale: 1, offline: 1 },
          network: { total: 1, online: 0, stale: 0, offline: 1 },
        },
        alerts: {
          total_open: 14,
          by_severity: { critical: 5, warning: 9 },
          by_kind: { device_offline: 6, low_disk: 5, high_ram: 3 },
          devices_affected: 12,
          oldest_open_at: iso(60 * 50),
        },
        average_health: 74,
        health_critical: 3,
        health_warning: 8,
        needs_updates: 7,
        agents_outdated: 2,
        groups: [
          { id: 1, name: "Front desk", devices: 18 },
          { id: 3, name: "Labs", devices: 15 },
          { id: 4, name: "Servers", devices: 9 },
        ],
        last_seen: iso(1),
      },
    }),
  );
  await page.route("**/api/v1/clients/1/activity/summary*", (route) =>
    route.fulfill({
      json: {
        days: 30,
        since: iso(60 * 24 * 30),
        events: 64,
        remote_connects: 41,
        remote_devices: 9,
        last_remote_at: iso(5),
        terminal_sessions: 4,
        terminal_seconds: 2710,
        remote_sessions: 0,
        remote_minutes: 0,
        operators: [
          { username: "mario", events: 38, remote_connects: 29, last_at: iso(5) },
          { username: "denis", events: 19, remote_connects: 10, last_at: iso(40) },
          { username: "sabina", events: 7, remote_connects: 2, last_at: iso(60 * 30) },
        ],
        devices: [
          { device_id: 1, name: "NW-RECEPTION-01", remote_connects: 18, last_at: iso(5) },
          { device_id: 3, name: "NW-SRV-01", remote_connects: 11, last_at: iso(40) },
          { device_id: 2, name: "NW-DOCTOR-02", remote_connects: 6, last_at: iso(60 * 26) },
        ],
      },
    }),
  );
  await page.route("**/api/v1/clients/1/activity?*", (route) =>
    route.fulfill({
      json: {
        total: 3,
        device_names: { "1": "NW-RECEPTION-01", "3": "NW-SRV-01" },
        items: [
          {
            id: 9,
            operator_id: 1,
            operator_username: "denis",
            action: "remote_connect",
            entity_type: "device",
            entity_id: 1,
            device_id: 1,
            client_id: 1,
            details_json: '{"techi_remote_id": "250862989", "remote_support_status": "online", "ip": "185.66.128.121"}',
            created_at: iso(5),
          },
          {
            id: 8,
            operator_id: 2,
            operator_username: "sabina",
            action: "action_queued",
            entity_type: "remote_action",
            entity_id: 77,
            device_id: 3,
            client_id: 1,
            details_json: '{"action_type": "restart_device"}',
            created_at: iso(40),
          },
          {
            id: 7,
            operator_id: 1,
            operator_username: "denis",
            action: "terminal_session_closed",
            entity_type: "terminal_session",
            entity_id: null,
            device_id: 3,
            client_id: 1,
            details_json: '{"reason": "operator_closed", "duration_seconds": 1520, "engine": "bash"}',
            created_at: iso(180),
          },
        ],
      },
    }),
  );
}
