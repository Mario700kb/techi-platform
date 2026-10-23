import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

// The owner: "Statusi i device (online, offline, stale) duhet te jete ne real
// time". A device's status changes on screen the moment the platform knows
// (an event), and by time alone when no event can say it (a heartbeat that
// does not come), without a reload.
//
// STATUS_SHOTS=<dir> also saves each chip state, per theme, for review.

const SHOTS = process.env.STATUS_SHOTS;

/** The status chip of one device, in its table row (desktop) or card (phone). */
function statusOf(page: Page, name: string): Locator {
  // Visible only: the page renders the table and the phone cards, one hidden.
  return page
    .locator("tr, .th-device-card", { hasText: name })
    .filter({ visible: true })
    .getByTestId("device-status")
    .first();
}

async function fakeRealtime(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/devices(\?|$)/, (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "connection_ready", data: { channel: "devices" } }));
  });
  const send = (type: string, data: Record<string, unknown>, reason: string | null = null) =>
    sockets.forEach((ws) => ws.send(JSON.stringify({ type, reason, data })));
  return { sockets, send };
}

async function shoot(page: Page, target: Locator, file: string, saved: string[]) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  const out = path.join(SHOTS, file);
  await target.screenshot({ path: out });
  saved.push(out);
}

/** The states side by side, one image per theme. */
async function saveStrip(page: Page, theme: string, saved: string[]) {
  if (!SHOTS || saved.length === 0) return;
  const images = saved.map((file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`);
  const bg = theme === "light" ? "#f4f4f6" : "#0a0a0b";
  const strip = await page.context().newPage();
  await strip.setViewportSize({ width: 1400, height: 600 });
  await strip.setContent(
    `<body style="margin:0;background:${bg}"><div id="s" style="display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:16px;width:max-content">${images
      .map((src) => `<img src="${src}" style="display:block">`)
      .join("")}</div></body>`,
  );
  await strip.locator("#s").screenshot({ path: path.join(SHOTS, `status-${theme}-strip.png`) });
  await strip.close();
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: a device goes online, live, loses its connection and goes offline — no reload`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    const { sockets, send } = await fakeRealtime(page);
    await page.goto("/devices");
    const desktop = testInfo.project.name === "desktop";
    const row = page
      .locator(desktop ? "tr" : ".th-device-card", { hasText: "BH-WH-SCANNER" })
      .filter({ visible: true })
      .first();
    const status = statusOf(page, "BH-WH-SCANNER");
    await expect(status).toContainText("Offline");
    await expect(status).toContainText("Shut down");
    await expect.poll(() => sockets.length, { message: "the realtime socket is open" }).toBeGreaterThan(0);
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    const shots: string[] = [];
    const shot = (name: string) => (desktop ? shoot(page, row, `status-${theme}-${name}.png`, shots) : undefined);

    await shot("1-offline-shutdown");

    // The agent starts: its heartbeat (or its channel) brings it online.
    const scope = { id: 4, client_id: 2, group_id: 2 };
    send("device_online", {
      ...scope,
      status: "online",
      freshness_state: "online",
      offline_reason: null,
      last_seen: new Date().toISOString(),
      live: false,
      live_lost_at: null,
    });
    await expect(status).toContainText("Online");
    await expect(status).toContainText("just now");
    await expect(status).toHaveAttribute("data-state", "online");
    await shot("2-online-heartbeat");

    // Its live channel opens: live, no age.
    send("device_updated", { ...scope, live: true, live_lost_at: null }, "agent_channel_connected");
    await expect(status).toContainText("live");
    await expect(status.locator(".th-devstatus-dot")).toHaveAttribute("data-live", "true");
    await shot("3-online-live");

    // The connection drops: still online while the backend waits for it.
    const droppedAt = new Date();
    send("device_updated", { ...scope, live: false, live_lost_at: droppedAt.toISOString() }, "agent_channel_dropped");
    await expect(status).toContainText("reconnecting…");
    await expect(status).toHaveAttribute("data-state", "online");
    await expect(status.locator(".th-devstatus-dot")).toHaveAttribute("data-reconnecting", "true");
    await shot("4-online-reconnecting");

    // It did not come back within the grace: offline, why, and since when.
    send(
      "device_offline",
      {
        ...scope,
        status: "offline",
        freshness_state: "offline",
        offline_reason: "connection_lost",
        last_seen: droppedAt.toISOString(),
        live: false,
        live_lost_at: null,
      },
      "agent_channel_lost",
    );
    await expect(status).toContainText("Offline");
    await expect(status).toContainText("Connection lost");
    await expect(status).toContainText(/since \d\d:\d\d/);
    await expect(status).toHaveAttribute("data-state", "offline");
    await shot("5-offline-connection-lost");

    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

    if (desktop) {
      // A status change is counted again 3 s later (STATUS_REFRESH_DELAY_MS);
      // here that reload answers with the mock's fixed state. Let it land
      // before the drawer's own events, or it can overwrite them (flaky).
      await page.waitForTimeout(3500);
      await page.waitForLoadState("networkidle");
      // The drawer's header chip says the same.
      await row.getByText("BH-WH-SCANNER").first().click();
      const header = page.locator(".th-drawer").getByTestId("device-status").first();
      const strip = page.locator(".th-drawer header");
      await expect(header).toContainText("Connection lost");
      await page.waitForTimeout(400); // the drawer slides in
      await shoot(page, strip, `status-${theme}-6-drawer-offline.png`, shots);
      send("device_online", { ...scope, status: "online", offline_reason: null, last_seen: new Date().toISOString() });
      send("device_updated", { ...scope, live: true }, "agent_channel_connected");
      await expect(header).toContainText("live");
      await shoot(page, strip, `status-${theme}-7-drawer-live.png`, shots);
    }
    await saveStrip(page, theme, shots);
  });
}

test("a heartbeat device turns stale at 6 minutes and offline at 25 on its own", async ({ page }, testInfo) => {
  const reception = DEVICES.find((d) => d.id === 1)!;
  const lastSeen = new Date(reception.last_seen!).getTime();
  await page.addInitScript(() => window.localStorage.setItem("techi.theme", "dark"));
  // The page opens one minute after the device's last heartbeat.
  await page.clock.install({ time: lastSeen + 60_000 });
  await page.goto("/devices");
  const status = statusOf(page, "NW-RECEPTION-01");
  await expect(status).toContainText("Online");
  await expect(status).toContainText("1m ago");

  // 5m50s old: still online.
  await page.clock.runFor(4 * 60_000 + 50_000);
  await expect(status).toContainText("Online");
  await expect(status).toContainText("5m ago");

  // Past 6 minutes, by the next tick of the shared 15 s clock: stale. No
  // event, no request: the page knows the rule.
  await page.clock.runFor(25_000);
  await expect(status).toContainText("Stale");
  await expect(status).toContainText("6m ago");
  await expect(status).toHaveAttribute("data-state", "stale");
  if (SHOTS && testInfo.project.name === "desktop") {
    const row = page.locator("tr", { hasText: "NW-RECEPTION-01" }).first();
    await row.screenshot({ path: path.join(SHOTS, "status-dark-stale.png") });
  }

  // Past 25 minutes: offline, no heartbeat.
  await page.clock.runFor(19 * 60_000);
  await expect(status).toContainText("Offline");
  await expect(status).toContainText("No heartbeat");
});

test("light: a stale device reads the same in the light theme", async ({ page }, testInfo) => {
  test.skip(!SHOTS || testInfo.project.name !== "desktop", "only for the review screenshots");
  await page.addInitScript(() => window.localStorage.setItem("techi.theme", "light"));
  await page.goto("/devices");
  const status = statusOf(page, "NW-DOCTOR-02");
  await expect(status).toContainText("Stale");
  const row = page.locator("tr", { hasText: "NW-DOCTOR-02" }).first();
  await row.screenshot({ path: path.join(SHOTS!, "status-light-stale.png") });
});
