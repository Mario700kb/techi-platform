import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// Over the agent's live channel an action is done before the POST that queued
// it returns: its realtime events reach the page first. The history must show
// it once, at its real status.
test("an action that runs live appears once, completed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  // The page holds more than one realtime socket; events go to all of them.
  const realtime: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/devices(\?|$)/, (ws) => {
    realtime.push(ws);
    ws.send(JSON.stringify({ type: "connection_ready", data: { channel: "devices" } }));
  });
  await page.route("**/api/v1/devices/1/agent-channel", (route) => route.fulfill({ json: { connected: true } }));
  // What the server holds: the page re-reads it after realtime events.
  const serverActions: Record<string, unknown>[] = [];
  await page.route("**/api/v1/devices/1/actions?**", (route) => route.fulfill({ json: serverActions }));

  const base = {
    id: 2584,
    device_id: 1,
    action_type: "ping",
    created_at: new Date().toISOString(),
    created_by: "owner",
    execution_timeout_seconds: 300,
  };
  await page.route("**/api/v1/devices/1/actions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    serverActions.unshift({ ...base, status: "completed", result_message: "Agent is reachable" });
    for (const [type, status] of [
      ["action_queued", "queued"],
      ["action_status_changed", "sent"],
      ["action_status_changed", "acknowledged"],
      ["action_status_changed", "completed"],
    ]) {
      realtime.forEach((ws) =>
        ws.send(JSON.stringify({ type, data: { ...base, status, result_message: "Agent is reachable" } })),
      );
    }
    await page.waitForTimeout(150);
    await route.fulfill({ json: { ...base, status: "sent" } });
  });

  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
  await page.getByRole("tab", { name: "Maintenance" }).click();
  await expect(page.getByText("Device is connected live. Actions run within seconds.")).toBeVisible();

  expect(realtime.length, "the dashboard opened its realtime socket").toBeGreaterThan(0);
  // Check after the POST has answered: that is when the duplicate appeared.
  const posted = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/devices/1/actions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Ping/ }).first().click();
  await posted;
  await expect(page.getByText("Agent is reachable")).toHaveCount(1);
  await expect(page.getByText("Completed", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Sent", { exact: true })).toHaveCount(0);
});

// Mario-Lenovo, 18 Oct: "Restart agent" was refused because an agent update
// was still queued, and the refusal only reached the browser console.
test("an action refused by a queued one says why and offers to cancel it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  await page.route("**/api/v1/devices/1/agent-channel", (route) => route.fulfill({ json: { connected: true } }));
  await page.route("**/api/v1/devices/1/actions?**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/devices/1/actions", (route) =>
    route.request().method() !== "POST"
      ? route.fallback()
      : route.fulfill({
          status: 409,
          json: {
            detail: {
              code: "action_conflict",
              detail:
                "Cannot queue 'restart_agent': conflicts with active 'self_update' (action #2633, status=queued).",
              action_id: 2633,
              action_type: "self_update",
              status: "queued",
            },
          },
        }),
  );
  let cancelled = false;
  await page.route("**/api/v1/actions/2633/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { id: 2633, device_id: 1, action_type: "self_update", status: "cancelled" } });
  });

  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
  await page.getByRole("tab", { name: "Maintenance" }).click();
  await page
    .getByRole("button", { name: /^Restart agent/ })
    .first()
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Restart agent" }).click();

  const notice = page.getByRole("alert").filter({ hasText: "was not sent" });
  await expect(notice).toContainText("(#2633) is still queued");
  await notice.getByRole("button", { name: "Cancel #2633" }).click();
  await expect(notice).toHaveCount(0);
  expect(cancelled).toBe(true);
});
