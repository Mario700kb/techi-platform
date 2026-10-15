import type { Page } from "@playwright/test";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// Northwind in production's shape: 42 devices over two categories and groups,
// alerts of three kinds, and an activity log of remote sessions and actions.
export async function northwindProfile(page: Page) {
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
