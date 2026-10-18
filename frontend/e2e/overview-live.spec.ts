import type { Page, WebSocketRoute } from "@playwright/test";
import { metricsFixture, monitoringFixture } from "../src/components/__tests__/monitoringFixtures";
import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// The owner's HV-PROD-01: the Live tiles sat empty ("Connecting…") while the
// drawer opened and blanked when the stream paused. The Overview now paints
// the best values it already has at once (this session's last live frame,
// else the last heartbeat), streams while the drawer is open on any tab, and
// keeps the last values, dimmed, when the stream stops.
//
// OVERVIEW_SHOTS=<dir> (and OVERVIEW_SHOTS_TAG=before|after) saves the whole
// Overview in both themes for review.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const HV_PROD = {
  ...DEVICES[0],
  hostname: "HV-PROD-01",
  device_type: "server",
  os_name: "windows",
  platform: "windows",
  os_caption: "Microsoft Windows Server 2025 Standard Evaluation",
  os_build: "10.0.26100",
  windows_product_type: 3,
  current_user: "Administrator",
  user_source: "console_session",
  user_session_state: "active",
  cpu: "Intel64 Family 6 Model 85 Stepping 7, GenuineIntel",
  ram: "63 GB",
  storage: "85 GB free / 930 GB total",
  agent_version: "2.1.31",
  capabilities: { powershell: "" },
  assignment_source: "manual",
};

/** What the last heartbeat said: what the tiles show before the first frame. */
const HEALTH = {
  device_id: 1,
  health_score: 64,
  health_state: "warning",
  latest_telemetry: {
    id: 1,
    device_id: 1,
    cpu_percent: 23,
    ram_percent: 71,
    disk_percent: 90.8,
    uptime_seconds: 5 * 86400 + 3 * 3600,
    heartbeat_latency_ms: 40,
    created_at: ago(2),
  },
  reasons: ["Disk critical: 90.8%", "1 warning alert(s) open"],
};

const PROCESSES = [
  ["sqlservr.exe", 22.4, 4100],
  ["vmms.exe", 9.6, 820],
  ["vmwp.exe", 8.1, 2048],
  ["MsMpEng.exe", 4.2, 310],
  ["svchost.exe", 2.9, 96],
  ["w3wp.exe", 2.1, 640],
  ["lsass.exe", 1.2, 64],
  ["techi-agent.exe", 0.8, 38],
  ["explorer.exe", 0.4, 140],
  ["dwm.exe", 0.2, 88],
] as const;

const FRAME = {
  cpu_percent: 57.4,
  ram_percent: 82.4,
  ram_used_mb: 53_000,
  ram_total_mb: 64_400,
  disks: [
    { mount: "C:", used_percent: 90.8, free_gb: 85.6, total_gb: 930.4 },
    { mount: "D:", used_percent: 42.1, free_gb: 1080.2, total_gb: 1863 },
  ],
  net_rx_kbps: 2480.4,
  net_tx_kbps: 395.1,
  uptime_seconds: 5 * 86400 + 3 * 3600,
  current_user: "HV\\Administrator",
  user_session_state: "active",
  process_count: 212,
  processes: PROCESSES.map(([name, cpu, mem], i) => ({ pid: 1000 + i, name, cpu_percent: cpu, memory_mb: mem })),
};

const alert = (id: number, kind: string, severity: string, state: string, minutes: number, message: string) => ({
  id,
  device_id: 1,
  kind,
  severity,
  state,
  message,
  created_at: ago(minutes + 10),
  updated_at: ago(minutes),
  resolved_at: state === "resolved" ? ago(minutes) : undefined,
  device_name: "HV-PROD-01",
  client_name: "Northwind Clinic",
});

const OPEN_ALERTS = [alert(1, "low_disk", "warning", "open", 30, "C: has 9% free")];
const RESOLVED_ALERTS = [
  alert(2, "high_cpu", "critical", "resolved", 40, "CPU at 97% for 10 minutes"),
  alert(3, "high_ram", "warning", "resolved", 90, "Memory at 92%"),
  alert(4, "device_offline", "critical", "resolved", 300, "HV-PROD-01 went offline"),
  alert(5, "rustdesk_sync_failure", "warning", "resolved", 600, "Remote Support ID did not sync"),
  alert(6, "repeated_reconnects", "warning", "resolved", 900, "Reconnected 6 times in an hour"),
  alert(7, "low_disk", "warning", "resolved", 1200, "C: has 8% free"),
];

const COMPONENT_STATES = {
  schema_version: 1,
  device_id: 1,
  components: [
    {
      component_id: "agent",
      display_name: "TECHI Agent",
      icon_key: "agent",
      installed_version: "2.1.31",
      desired_version: "2.1.31",
      health: "current",
      status: "Current",
    },
    {
      component_id: "rustdesk",
      display_name: "TECHI Remote Support",
      icon_key: "rustdesk",
      installed_version: "1.4.6",
      desired_version: "1.4.6",
      health: "current",
      status: "Current",
    },
  ],
};

interface LiveServer {
  /** Every live socket the page opened. */
  sockets: WebSocketRoute[];
  /** How many of them have closed. */
  closed: number;
  /** Delay before a new socket's first frame. */
  firstFrameMs: number;
  /** The frame sent every 3 s. */
  frame: typeof FRAME;
  /** Stops the stream: sends nothing more and closes the open sockets (and any new one). */
  stop: () => void;
  /** Accepts sockets again. */
  resume: () => void;
}

/** A live endpoint that answers the first frame after `firstFrameMs`, then every 3 s. */
async function liveServer(page: Page, firstFrameMs: number): Promise<LiveServer> {
  let stopped = false;
  const server: LiveServer = {
    sockets: [],
    closed: 0,
    firstFrameMs,
    frame: FRAME,
    stop: () => {
      stopped = true;
      for (const ws of server.sockets) void ws.close({ code: 1000 }).catch(() => undefined);
    },
    resume: () => {
      stopped = false;
    },
  };
  await page.routeWebSocket(/\/ws\/devices\/\d+\/live/, (ws) => {
    if (stopped) {
      void ws.close({ code: 1000 }).catch(() => undefined);
      return;
    }
    server.sockets.push(ws);
    let open = true;
    ws.onClose(() => {
      open = false;
      server.closed += 1;
    });
    ws.send(JSON.stringify({ type: "live_status", agent_connected: true, interval_seconds: 3 }));
    const send = () => {
      if (stopped || !open) return;
      ws.send(JSON.stringify({ type: "live", device_id: 1, data: server.frame }));
      setTimeout(send, 3000);
    };
    setTimeout(send, server.firstFrameMs);
  });
  return server;
}

async function mockHvProd(page: Page, theme: "dark" | "light" = "dark") {
  await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
  await page.route(
    (url) => url.pathname === "/api/v1/devices/",
    (route) => route.fulfill({ json: { devices: [HV_PROD, ...DEVICES.slice(1)], total: DEVICES.length } }),
  );
  await page.route("**/api/v1/devices/1", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: HV_PROD }) : route.fallback(),
  );
  await page.route("**/api/v1/devices/1/health", (route) => route.fulfill({ json: HEALTH }));
  await page.route("**/api/v1/devices/1/metrics?**", (route) => route.fulfill({ json: metricsFixture() }));
  await page.route("**/api/v1/devices/1/monitoring", (route) => route.fulfill({ json: monitoringFixture(false) }));
  await page.route("**/api/v1/alerts/device/1?**", (route) => {
    const state = new URL(route.request().url()).searchParams.get("state");
    return route.fulfill({ json: state === "resolved" ? RESOLVED_ALERTS : OPEN_ALERTS });
  });
  await page.route("**/api/v1/devices/1/component-states", (route) => route.fulfill({ json: COMPONENT_STATES }));
}

async function openHvProd(page: Page) {
  await page.goto("/devices");
  await page.locator("tr", { hasText: "HV-PROD-01" }).getByText("HV-PROD-01").first().click();
  return page.locator(".th-drawer-panel");
}

const desktopOnly = () => test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");

for (const theme of ["dark", "light"] as const) {
  test(`screenshot the Overview with Live (${theme})`, async ({ page }) => {
    desktopOnly();
    await page.setViewportSize({ width: 1440, height: 3600 });
    await mockHvProd(page, theme);
    await liveServer(page, 100);
    const drawer = await openHvProd(page);
    const panel = drawer.getByRole("region", { name: "Live" });
    await expect(panel.getByText("Live · every 3 s")).toBeVisible();
    await expect(panel.getByText("57%")).toBeVisible();
    await expect(drawer.getByText("1-minute data · nothing lost")).toBeVisible();
    await expect(drawer.getByText("TECHI Remote Support").first()).toBeVisible();
    const dir = process.env.OVERVIEW_SHOTS;
    const name = `overview-live-${process.env.OVERVIEW_SHOTS_TAG ?? "after"}-${theme}.png`;
    await drawer
      .locator(".th-tab-panel")
      .first()
      .screenshot({ path: dir ? `${dir}/${name}` : test.info().outputPath(name) });
  });
}

/** The Overview's section titles, top to bottom. */
async function sectionTitles(page: Page): Promise<string[]> {
  return page
    .locator(".th-drawer-panel .th-tab-panel")
    .first()
    .locator(".th-section-head > .premium-kicker")
    .allTextContents();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>(".th-drawer-panel");
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    let inner = 0;
    for (const el of Array.from(drawer?.querySelectorAll<HTMLElement>(".th-tab-panel section, .th-live-card") ?? [])) {
      inner = Math.max(inner, el.scrollWidth - el.clientWidth);
    }
    return Math.max(doc, inner, drawer ? drawer.scrollWidth - drawer.clientWidth : 0);
  });
}

test("the Live tiles paint at once from the heartbeat, then switch to live frames in place", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  const server = await liveServer(page, 2000);
  await page.goto("/devices");
  const row = page.locator("tr", { hasText: "HV-PROD-01" }).getByText("HV-PROD-01").first();
  await expect(row).toBeVisible();
  await row.click();

  const panel = page.getByRole("region", { name: "Live" });
  const cpu = panel.getByTestId("live-tile-CPU");
  // Within 300 ms of the click: numbers, not skeletons (the last heartbeat).
  await expect(cpu).toContainText("23%", { timeout: 300 });
  await expect(panel.getByTestId("live-tile-Memory")).toContainText("71%", { timeout: 300 });
  await expect(panel.getByTestId("live-status")).toHaveText(/^From \d+m ago · connecting…$/);
  await expect(panel).toHaveAttribute("data-live-source", "heartbeat");
  const before = await cpu.boundingBox();

  // The first frame (2 s later) replaces them in place: same tile, same box.
  await expect(panel.getByTestId("live-status")).toHaveText("Live · every 3 s", { timeout: 5000 });
  await expect(cpu).toContainText("57%");
  await expect(panel.getByTestId("live-tile-Network")).toContainText("↓ 2.5 Mb/s");
  await expect(panel.getByText("sqlservr.exe")).toBeVisible();
  const after = await cpu.boundingBox();
  expect(after).toEqual(before);
  expect(server.sockets.length).toBe(1);

  // The stream stops: the values stay, dimmed, with "Paused".
  server.stop();
  await expect(panel.getByTestId("live-status")).toHaveText(/^Paused · last at \d{2}:\d{2}$/);
  await expect(panel).toHaveAttribute("data-live-mode", "paused");
  await expect(cpu).toContainText("57%");
  await expect(panel.getByText("sqlservr.exe")).toBeVisible();
  expect(await cpu.boundingBox()).toEqual(before);
});

test("a device opened again paints this session's last live values at once", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  const server = await liveServer(page, 100);
  const drawer = await openHvProd(page);
  const panel = page.getByRole("region", { name: "Live" });
  await expect(panel.getByTestId("live-status")).toHaveText("Live · every 3 s");
  await expect(panel.getByTestId("live-tile-CPU")).toContainText("57%");

  // Closed: the socket is released.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("data-open", "false");
  await expect.poll(() => server.closed).toBe(1);

  // Reload (memory gone, sessionStorage kept); the next frame is 2 s away.
  server.firstFrameMs = 2000;
  server.frame = { ...FRAME, cpu_percent: 12 };
  await page.reload();
  const row = page.locator("tr", { hasText: "HV-PROD-01" }).getByText("HV-PROD-01").first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(panel.getByTestId("live-tile-CPU")).toContainText("57%", { timeout: 300 });
  await expect(panel.getByText("sqlservr.exe")).toBeVisible({ timeout: 300 });
  await expect(panel).toHaveAttribute("data-live-source", "live");
  await expect(panel.getByTestId("live-status")).toHaveText(/^From .+ · connecting…$/);
  // Then the new frame.
  await expect(panel.getByTestId("live-tile-CPU")).toContainText("12%", { timeout: 5000 });
  await expect(panel.getByTestId("live-status")).toHaveText("Live · every 3 s");
});

test("the stream starts on open and keeps running on another tab", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  const server = await liveServer(page, 100);
  const drawer = await openHvProd(page);
  await drawer.getByRole("tab", { name: "Notes" }).click();
  await expect.poll(() => server.sockets.length).toBe(1);
  await drawer.getByRole("tab", { name: "Overview" }).click();
  const panel = page.getByRole("region", { name: "Live" });
  // No reconnect on the way back: the same socket, already live.
  await expect(panel.getByTestId("live-status")).toHaveText("Live · every 3 s");
  expect(server.sockets.length).toBe(1);
});

test("the Overview reads top to bottom in one order, with one header style", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  await liveServer(page, 100);
  const drawer = await openHvProd(page);
  await expect(drawer.getByText("TECHI Remote Support").first()).toBeVisible();
  await expect(drawer.getByText("1-minute data · nothing lost")).toBeVisible();
  expect(await sectionTitles(page)).toEqual([
    "Status",
    "Live",
    "Last 24 hours",
    "Alerts",
    "Services",
    "Security",
    "Identity",
    "Client assignment",
    "Network",
    "Components",
    "Maintenance",
  ]);
  // Every header: the title on the left, its meta on the right, on one line.
  for (const name of ["Live", "Last 24 hours", "Alerts", "Components"]) {
    const head = drawer.getByRole("region", { name }).locator(".th-section-head").first();
    const [title, meta] = await Promise.all([
      head.locator(".premium-kicker").boundingBox(),
      head.locator(".th-section-meta").boundingBox(),
    ]);
    expect(Math.abs(title!.y + title!.height / 2 - (meta!.y + meta!.height / 2))).toBeLessThanOrEqual(2);
    expect(meta!.x).toBeGreaterThan(title!.x + title!.width);
  }
  await expect(drawer.getByRole("region", { name: "Alerts" }).locator(".th-section-meta")).toHaveText("1 active");
  await expect(drawer.getByRole("region", { name: "Components" }).locator(".th-section-meta")).toHaveText(
    "2 managed · all current",
  );
});

test("busiest processes: top 5, then all 10", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  await liveServer(page, 100);
  await openHvProd(page);
  const processes = page.getByRole("group", { name: "Busiest processes" });
  await expect(processes.locator("tbody tr")).toHaveCount(5);
  await expect(processes.locator("tbody tr").first()).toHaveText(/sqlservr\.exe\s*22\.4%\s*4\.0 GB/);
  await processes.getByRole("button", { name: "Show all 10" }).click();
  await expect(processes.locator("tbody tr")).toHaveCount(10);
  await expect(processes.getByText("dwm.exe")).toBeVisible();
  await processes.getByRole("button", { name: "Show top 5" }).click();
  await expect(processes.locator("tbody tr")).toHaveCount(5);
  // CPU and memory right-aligned in their columns.
  const cells = processes.locator("tbody tr").first().locator("td");
  expect(await cells.nth(1).evaluate((td) => getComputedStyle(td).textAlign)).toBe("right");
  expect(await cells.nth(2).evaluate((td) => getComputedStyle(td).textAlign)).toBe("right");
});

test("alerts: the active one, then three recently resolved and the rest on request", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  await liveServer(page, 100);
  const drawer = await openHvProd(page);
  const alerts = drawer.getByRole("region", { name: "Alerts" });
  await expect(alerts.getByText("C: has 9% free")).toBeVisible();
  await expect(alerts.getByText("Recently resolved")).toBeVisible();
  await expect(alerts.getByText("CPU at 97% for 10 minutes")).toBeVisible();
  await expect(alerts.getByText("HV-PROD-01 went offline")).toBeVisible();
  await expect(alerts.getByText("Remote Support ID did not sync")).toHaveCount(0);
  await alerts.getByRole("button", { name: "Show 3 more" }).click();
  await expect(alerts.getByText("Remote Support ID did not sync")).toBeVisible();
  await expect(alerts.getByText("C: has 8% free")).toBeVisible();
  await alerts.getByRole("button", { name: "Show fewer" }).click();
  await expect(alerts.getByText("C: has 8% free")).toHaveCount(0);
});

for (const [label, width, drawerWidth] of [
  ["720 px drawer", 1440, 720],
  ["780 px drawer", 1600, 780],
] as const) {
  test(`no horizontal overflow with Live streaming (${label})`, async ({ page }) => {
    desktopOnly();
    await page.setViewportSize({ width, height: 900 });
    await mockHvProd(page);
    await liveServer(page, 100);
    const drawer = await openHvProd(page);
    await expect(page.getByRole("region", { name: "Live" }).getByText("sqlservr.exe")).toBeVisible();
    expect(Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(drawerWidth);
    await page.getByRole("button", { name: "Show all 10" }).click();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    // Four tiles in one row, equal.
    const tiles = page.locator(".th-live-tile");
    const boxes = await Promise.all([0, 1, 2, 3].map((i) => tiles.nth(i).boundingBox()));
    for (const box of boxes) {
      expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.height - boxes[0]!.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
    }
  });
}

test("no horizontal overflow with Live streaming at phone width (390 px)", async ({ page }) => {
  desktopOnly();
  await mockHvProd(page);
  await liveServer(page, 100);
  const drawer = await openHvProd(page);
  await expect(page.getByRole("region", { name: "Live" }).getByText("sqlservr.exe")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(390);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // 2×2 tiles on a phone.
  const tiles = page.locator(".th-live-tile");
  const [a, c] = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(2).boundingBox()]);
  expect(c!.y - a!.y).toBeGreaterThan(10);
});
