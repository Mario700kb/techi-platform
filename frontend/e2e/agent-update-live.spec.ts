import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./test";

// The owner pressed Update on the TECHI Agent card and saw nothing until he
// reloaded or restarted the device. The update is now followed live: every
// realtime event moves the card's bar and stage words, and on completion the
// card re-reads the component states so Installed shows the new version.
//
// AGENT_UPDATE_SHOTS=<dir> also saves the card at each step (and a strip of
// them per theme) for review.

const SHOTS = process.env.AGENT_UPDATE_SHOTS;

type Step = {
  key: string;
  status: string;
  stage?: string | null;
  progress?: number | null;
  result_message?: string | null;
  text: string | RegExp;
  /** aria-valuenow of the bar, or null for the indeterminate sweep. */
  percent: number | null;
};

const STEPS: Step[] = [
  { key: "sent", status: "sent", text: "Sent to the agent", percent: null },
  {
    key: "dl20",
    status: "running",
    stage: "downloading",
    progress: 20,
    result_message: "Downloading (1.1 of 6.3 MB)",
    text: "Downloading 20%",
    percent: 20,
  },
  {
    key: "dl60",
    status: "running",
    stage: "downloading",
    progress: 60,
    result_message: "Downloading (4.6 of 6.3 MB)",
    text: "Downloading 60%",
    percent: 60,
  },
  {
    key: "dl80",
    status: "running",
    stage: "downloading",
    progress: 80,
    result_message: "Downloading (6.3 of 6.3 MB)",
    text: "Downloading 80%",
    percent: 80,
  },
  { key: "verify", status: "running", stage: "verifying", progress: 85, text: "Verifying the package", percent: 85 },
  { key: "install", status: "running", stage: "installing", progress: 90, text: "Installing", percent: 90 },
  { key: "restart", status: "running", stage: "restarting", progress: 95, text: "Restarting the agent", percent: 95 },
  {
    key: "confirm",
    status: "running",
    stage: "confirming",
    progress: 97,
    text: "Confirming the new version",
    percent: 97,
  },
];

function agentStates(installed: string) {
  const current = installed === "2.1.31";
  return {
    schema_version: 1,
    device_id: 1,
    components: [
      {
        component_id: "agent",
        display_name: "TECHI Agent",
        icon_key: "agent",
        installed_version: installed,
        desired_version: "2.1.31",
        health: current ? "current" : "outdated",
        status: current ? "Current" : "Outdated",
      },
    ],
  };
}

const COMPONENTS = {
  schema_version: 1,
  components: [
    {
      id: "agent",
      display_name: "TECHI Agent",
      description: "",
      icon_key: "agent",
      platforms: ["windows", "linux"],
      file_types: ["agent_binary"],
      capabilities: [],
      lifecycle: [
        { operation: "install", label: "Install", action_type: null, kind: "out_of_band" },
        { operation: "update", label: "Update", action_type: "self_update", kind: "action" },
        { operation: "restart", label: "Restart", action_type: "restart_agent", kind: "action" },
        { operation: "discover", label: "Discover", action_type: null, kind: "out_of_band" },
      ],
      policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
    },
  ],
};

/** A device with a fake realtime server, component states and the update endpoints. */
async function setUp(page: Page) {
  const realtime: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/devices(\?|$)/, (ws) => {
    realtime.push(ws);
    ws.send(JSON.stringify({ type: "connection_ready", data: { channel: "devices" } }));
  });
  const server = { installed: "2.1.30", statesReads: 0, actions: [] as Record<string, unknown>[] };
  await page.route("**/api/v1/devices/1/component-states", (route) => {
    server.statesReads += 1;
    return route.fulfill({ json: agentStates(server.installed) });
  });
  await page.route("**/api/v1/platform/components", (route) => route.fulfill({ json: COMPONENTS }));
  await page.route("**/api/v1/devices/1/agent-channel", (route) => route.fulfill({ json: { connected: true } }));
  await page.route("**/api/v1/devices/1/actions?**", (route) => route.fulfill({ json: server.actions }));

  const now = new Date().toISOString();
  const action = (id: number, extra: Record<string, unknown>) => ({
    id,
    device_id: 1,
    action_type: "self_update",
    created_at: now,
    queued_at: now,
    created_by: "owner",
    execution_timeout_seconds: 600,
    parameters: { version: "2.1.31", download_url: "https://techi.example/agent/2.1.31/techi-agent.exe" },
    progress: null,
    stage: null,
    ...extra,
  });
  const accepted = (id: number) => ({
    component_id: "agent",
    operation: "update",
    action_type: "self_update",
    label: "Update",
    action: action(id, { status: "queued" }),
  });
  await page.route("**/api/v1/devices/1/components/agent/actions", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: accepted(3001) }) : route.fallback(),
  );
  await page.route("**/api/v1/devices/1/components/actions/3001/retry", (route) =>
    route.fulfill({ json: accepted(3002) }),
  );

  const send = (type: string, data: Record<string, unknown>) =>
    realtime.forEach((ws) => ws.send(JSON.stringify({ type, data })));

  return { realtime, server, action, send };
}

async function openAgentCard(page: Page) {
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
  const card = page.locator('[data-component="agent"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("Outdated")).toBeVisible();
  return card;
}

async function pressUpdate(page: Page, card: Locator) {
  await card.getByRole("button", { name: "Update" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Update" }).click();
}

async function expectStep(card: Locator, text: string | RegExp, percent: number | null) {
  const live = card.getByTestId("agent-update-live");
  await expect(live.getByRole("status")).toContainText(text);
  const bar = live.getByRole("progressbar");
  if (percent === null) {
    await expect(bar).toHaveAttribute("data-indeterminate", "true");
    await expect(bar).not.toHaveAttribute("aria-valuenow");
  } else {
    await expect(bar).toHaveAttribute("aria-valuenow", String(percent));
    await expect(bar).not.toHaveAttribute("data-indeterminate");
  }
}

async function shoot(page: Page, card: Locator, theme: string, name: string, saved: string[]) {
  if (!SHOTS) return;
  await page.waitForTimeout(400); // let the bar's width transition settle
  const file = path.join(SHOTS, `agent-update-${theme}-${saved.length + 1}-${name}.png`);
  await card.screenshot({ path: file });
  saved.push(file);
}

/** One image of the steps side by side: what the owner sees, in order. */
async function saveStrip(page: Page, theme: string, saved: string[]) {
  if (!SHOTS || saved.length === 0) return;
  const images = saved.map((file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`);
  const bg = theme === "light" ? "#f4f4f6" : "#0a0a0b";
  const strip = await page.context().newPage();
  await strip.setViewportSize({ width: 1400, height: 400 });
  await strip.setContent(
    `<body style="margin:0;background:${bg}"><div id="s" style="display:grid;grid-template-columns:repeat(3,auto);gap:16px;padding:16px;width:max-content">${images
      .map((src) => `<img src="${src}" style="display:block;width:440px">`)
      .join("")}</div></body>`,
  );
  await strip.locator("#s").screenshot({ path: path.join(SHOTS, `agent-update-strip-${theme}.png`) });
  await strip.close();
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the agent update runs live on the card and in the history, then Installed changes without a reload`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    const { realtime, server, action, send } = await setUp(page);
    const card = await openAgentCard(page);
    expect(realtime.length, "the realtime sockets are open").toBeGreaterThan(0);
    await expect(card.getByText(/Installed:/)).toContainText("2.1.30");
    // Marks this document: a reload would clear it.
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    const saved: string[] = [];

    await pressUpdate(page, card);
    send("action_queued", action(3001, { status: "queued" }));
    await expectStep(card, "Queued — goes out at once over the live channel", null);
    await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Update" })).toHaveCount(0);
    await expect(card.getByTestId("agent-update-live")).toContainText("2.1.31");
    await shoot(page, card, theme, "queued", saved);

    for (const step of STEPS) {
      send(
        "action_status_changed",
        action(3001, {
          status: step.status,
          stage: step.stage ?? null,
          progress: step.progress ?? null,
          result_message: step.result_message ?? null,
        }),
      );
      await expectStep(card, step.text, step.percent);
      if (step.key === "dl60") {
        await expect(card.getByTestId("agent-update-live")).toContainText("4.6 of 6.3 MB");
        await expect(card.getByRole("button", { name: "Cancel" })).toHaveCount(0);
        await expect(card.getByText("Step 1 of 5")).toBeVisible();
        // The Maintenance history row shows the same progress, compact.
        await page.getByRole("tab", { name: "Maintenance" }).click();
        const row = page.getByTestId("agent-update-compact");
        await expect(row).toContainText("Downloading 60%");
        await expect(row).toContainText("4.6 of 6.3 MB");
        await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
        if (SHOTS) {
          await page.waitForTimeout(400);
          await row
            .locator("xpath=../..")
            .screenshot({ path: path.join(SHOTS, `agent-update-${theme}-history-row.png`) });
        }
        await page.getByRole("tab", { name: "Overview" }).click();
        await card.scrollIntoViewIfNeeded();
      }
      if (["dl60", "verify", "restart"].includes(step.key)) await shoot(page, card, theme, step.key, saved);
    }

    // Completed: the server now reports 2.1.31, and says so on the socket.
    const readsBefore = server.statesReads;
    server.installed = "2.1.31";
    server.actions = [action(3001, { status: "completed", result_message: "Updated to 2.1.31", duration_seconds: 96 })];
    send(
      "action_status_changed",
      action(3001, { status: "completed", result_message: "Updated to 2.1.31", duration_seconds: 96 }),
    );
    send("device_updated", { id: 1, hostname: "NW-RECEPTION-01", agent_version: "2.1.31" });
    const live = card.getByTestId("agent-update-live");
    await expect(live).toContainText("Updated to 2.1.31");
    await expect(live.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(card.getByText(/Installed:/)).toContainText("2.1.31");
    await expect(card.getByText("Outdated")).toHaveCount(0);
    await expect(card.getByText("Current")).toBeVisible();
    await shoot(page, card, theme, "updated", saved);
    expect(server.statesReads - readsBefore, "one refetch on completion").toBe(1);

    // The history row is back to a plain completed row.
    await page.getByRole("tab", { name: "Maintenance" }).click();
    await expect(page.getByTestId("agent-update-compact")).toHaveCount(0);
    await expect(page.getByText("Updated to 2.1.31").filter({ visible: true })).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();

    // After a moment the buttons come back, on the new version.
    await expect(card.getByTestId("agent-update-live")).toHaveCount(0, { timeout: 10_000 });
    await expect(card.getByRole("button", { name: "Update" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

    await saveStrip(page, theme, saved);
  });
}

test.describe("failure", () => {
  test.use({ reducedMotion: "reduce" });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: a failed update says why and retries`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
      await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
      const { action, send } = await setUp(page);
      const card = await openAgentCard(page);

      await pressUpdate(page, card);
      send("action_queued", action(3001, { status: "queued" }));
      await expectStep(card, "Queued — goes out at once over the live channel", null);
      // Reduced motion: the indeterminate bar does not sweep.
      const fill = card.getByTestId("agent-update-live").locator(".th-upd-fill");
      expect(await fill.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");

      send("action_status_changed", action(3001, { status: "running", stage: "downloading", progress: 35 }));
      await expectStep(card, "Downloading 35%", 35);
      send(
        "action_status_changed",
        action(3001, { status: "failed", error_message: "sha256 mismatch: the package was rejected" }),
      );

      const live = card.getByTestId("agent-update-live");
      await expect(live.getByRole("alert")).toHaveText("Update failed");
      await expect(live).toContainText("sha256 mismatch: the package was rejected");
      await expect(card.getByText(/Installed:/)).toContainText("2.1.30");
      await expect(card.getByText("Outdated")).toBeVisible();
      if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `agent-update-${theme}-failed.png`) });

      await live.getByRole("button", { name: "Retry update" }).click();
      await expectStep(card, "Queued — goes out at once over the live channel", null);
      await expect(card.getByText("sha256 mismatch: the package was rejected")).toHaveCount(0);
      send("action_status_changed", action(3002, { status: "running", stage: "downloading", progress: 50 }));
      await expectStep(card, "Downloading 50%", 50);
    });
  }
});
