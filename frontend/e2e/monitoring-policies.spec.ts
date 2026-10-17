import type { Page } from "@playwright/test";
import type { MonitoringPolicy, PipelineHealth, PolicyBody } from "../src/api/monitoring";
import { READONLY } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// The two seeded policies, as the backend answers them.
const POLICIES: MonitoringPolicy[] = [
  {
    id: 1,
    name: "Workstations",
    description: "Every device unless a more specific policy applies.",
    scope: "default",
    scope_value: null,
    enabled: true,
    version: 3,
    sample_seconds: 60,
    upload_seconds: 900,
    buffer_mb: 50,
    keep_days: 7,
    monitors: [
      { key: "cpu", metric: "cpu", op: ">", threshold: 95, duration_s: 900, severity: "critical", enabled: true },
      { key: "mem", metric: "mem", op: ">", threshold: 90, duration_s: 600, severity: "warning", enabled: true },
      { key: "disk", metric: "disk", op: ">", threshold: 90, duration_s: 0, severity: "warning", enabled: true },
      {
        key: "no_data",
        metric: "no_data",
        op: ">",
        threshold: 0,
        duration_s: 600,
        severity: "critical",
        enabled: true,
      },
    ],
    updated_at: "2026-10-16T21:00:00Z",
    updated_by: "system",
    devices: 489,
    devices_current: 486,
  },
  {
    id: 2,
    name: "Servers",
    description: "Every device classified as a server.",
    scope: "device_type",
    scope_value: "server",
    enabled: true,
    version: 5,
    sample_seconds: 60,
    upload_seconds: 900,
    buffer_mb: 50,
    keep_days: 7,
    monitors: [
      { key: "cpu", metric: "cpu", op: ">", threshold: 95, duration_s: 900, severity: "critical", enabled: true },
      {
        key: "disk_forecast",
        metric: "disk_forecast_days",
        op: "<",
        threshold: 14,
        duration_s: 0,
        severity: "warning",
        enabled: true,
      },
      {
        key: "net_rx",
        metric: "net_rx_mbps",
        op: ">",
        threshold: 800,
        duration_s: 300,
        severity: "info",
        enabled: false,
      },
    ],
    updated_at: "2026-10-16T21:00:00Z",
    updated_by: "system",
    devices: 38,
    devices_current: 38,
  },
];

const PIPELINE: PipelineHealth = {
  devices_online: 516,
  devices_one_minute: 512,
  uploads_last_hour: 509,
  median_delay_seconds: 420,
  devices_with_backlog: 4,
  oldest_backlog_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  dropped_30d: 12,
  samples_30d: 600_000,
  policy_behind: 3,
  storage: [
    { name: "1-minute", keep: "7 days", bytes: 600 * 1024 ** 2, rows: null },
    { name: "5-minute", keep: "30 days", bytes: 800 * 1024 ** 2, rows: null },
    { name: "Hourly", keep: "13 months", bytes: 1024 ** 3, rows: null },
  ],
};

async function mockMonitoring(page: Page) {
  const sent: PolicyBody[] = [];
  await page.route("**/api/v1/monitoring/policies", (route) => route.fulfill({ json: POLICIES }));
  await page.route("**/api/v1/monitoring/pipeline", (route) => route.fulfill({ json: PIPELINE }));
  await page.route("**/api/v1/monitoring/policies/*", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const body = route.request().postDataJSON() as PolicyBody;
    sent.push(body);
    const id = Number(new URL(route.request().url()).pathname.split("/").pop());
    const before = POLICIES.find((p) => p.id === id)!;
    return route.fulfill({ json: { ...before, ...body, version: before.version + 1, devices_current: 0 } });
  });
  return sent;
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: an admin edits a threshold and publishes the policy`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    const sent = await mockMonitoring(page);

    await page.goto("/");
    if (testInfo.project.name === "desktop") {
      await page.getByRole("navigation").getByRole("link", { name: "Monitoring" }).click();
    } else {
      await page.goto("/more");
      await page
        .getByRole("button", { name: /Monitoring/ })
        .first()
        .click();
    }
    await expect(page).toHaveURL(/\/monitoring$/);
    await expect(page.getByRole("heading", { name: "Monitoring" }).first()).toBeVisible();

    // The list: both seeded policies, in words.
    const list = page.getByRole("region", { name: "Policies" });
    await expect(list.getByRole("button", { name: /Workstations/ })).toContainText("Default · every device");
    await expect(list.getByRole("button", { name: /Workstations/ })).toContainText("486 / 489 on v3");
    await expect(list.getByRole("button", { name: /Servers/ })).toContainText("Every server");

    // Pipeline health and storage.
    const pipeline = page.getByRole("region", { name: "Pipeline health" });
    await expect(pipeline).toContainText("512 / 516");
    await expect(pipeline).toContainText("7 min");
    await expect(pipeline).toContainText("4 · oldest 2 d");
    await expect(pipeline).toContainText("3 devices");
    const storage = page.getByRole("region", { name: "Storage" });
    await expect(storage).toContainText("2.4 GB in total");
    await expect(storage).toContainText("13 months · 1.0 GB");

    // Edit the default policy's CPU threshold and publish.
    const editor = page.getByRole("region", { name: "Policy Workstations" });
    await editor.getByRole("spinbutton", { name: "Monitor 1 threshold" }).fill("92");
    await expect(editor.getByText("Unsaved changes")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`monitoring-${theme}.png`), fullPage: true });
    await editor.getByRole("button", { name: "Publish v4 to 489 devices" }).click();
    await expect(editor.getByText("Published v4 to 489 devices")).toBeVisible();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "Workstations",
      scope: "default",
      scope_value: null,
      sample_seconds: 60,
      upload_seconds: 900,
      buffer_mb: 50,
      keep_days: 7,
    });
    expect(sent[0].monitors[0]).toEqual({
      key: "cpu",
      metric: "cpu",
      op: ">",
      threshold: 92,
      duration_s: 900,
      severity: "critical",
      enabled: true,
    });
    expect(sent[0].monitors).toHaveLength(4);
  });
}

test("an out-of-range setting blocks publishing and says why", async ({ page }) => {
  const sent = await mockMonitoring(page);
  await page.goto("/monitoring");
  const editor = page.getByRole("region", { name: "Policy Workstations" });
  await editor.getByRole("spinbutton", { name: "Sample every" }).fill("10");
  await expect(editor.getByText("Sample every 30–900 seconds.")).toBeVisible();
  await expect(editor.getByRole("button", { name: /Publish v4/ })).toBeDisabled();
  expect(sent).toHaveLength(0);
});

test("a read-only operator sees the policies without editing or pipeline health", async ({ page, api }) => {
  api.user = READONLY;
  await mockMonitoring(page);
  await page.goto("/monitoring");
  const editor = page.getByRole("region", { name: "Policy Workstations" });
  await expect(editor.getByText("CPU usage")).toBeVisible();
  await expect(editor.getByText("You can view this policy; changing it needs an admin.")).toBeVisible();
  await expect(editor.getByRole("spinbutton", { name: "Monitor 1 threshold" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New policy" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Pipeline health" })).toHaveCount(0);
});
