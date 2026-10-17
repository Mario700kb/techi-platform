import type { Page } from "@playwright/test";
import { fakePowerShell, mockPowerShellSession, mockScripts, PS_VERSION } from "./fakePowerShell";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const WINDOW_URL = "/terminal/1?engine=powershell&name=NW-RECEPTION-01";

async function openWindow(page: Page) {
  await page.goto(WINDOW_URL);
  await page.getByLabel("Two-factor code").fill("123456");
  await page.getByRole("button", { name: "Open PowerShell" }).click();
  const consoleRoot = page.getByTestId("powershell-console");
  await expect(consoleRoot.locator(".ps-chip", { hasText: "Recording" })).toBeVisible();
  return consoleRoot;
}

async function expectNoPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.x, "horizontal overflow").toBeLessThanOrEqual(0);
  expect(overflow.y, "page scroll").toBeLessThanOrEqual(0);
}

test.describe("PowerShell in its own window", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the own window is a desktop popup");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("header, console, side panel, command bar and saved scripts", async ({ page }, testInfo) => {
    await mockPowerShellSession(page, 1, "ps-9");
    await mockScripts(page);
    const shell = await fakePowerShell(page, "ps-9");
    const runs: string[] = [];
    await page.route("**/api/v1/devices/1/terminal/sessions/ps-9/scripts/*", (route) => {
      runs.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({
        json: {
          command: "& ([scriptblock]::Create('Q2xlYXItRG5zQ2xpZW50Q2FjaGU='))  # TECHI script: Flush DNS v3",
          script: { id: 2, name: "Flush DNS", version: 3, uses: 31 },
        },
      });
    });

    const root = await openWindow(page);

    // Header.
    await expect(root.getByRole("heading", { name: "NW-RECEPTION-01 · PowerShell (Administrator)" })).toBeVisible();
    await expect(
      root.getByText("Northwind Clinic · #1 · runs as NT AUTHORITY\\SYSTEM over the live channel"),
    ).toBeVisible();
    await expect(root.locator(".ps-countdown")).toHaveText(/idle closes in 1[45]:\d\d/);
    await expect(root.getByRole("button", { name: "End session" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Fullscreen" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Download transcript" })).toBeVisible();

    // Console: the local banner (never sent) and the agent's prompt.
    const screen = root.locator(".xterm-rows");
    await expect(screen).toContainText("Session started by ana.owner at");
    await expect(screen).toContainText("after a 2FA code · Microsoft Windows 11 Pro");
    await expect(screen).toContainText("PS C:\\Windows\\system32>");
    expect(shell.received.join("")).not.toContain("Session started");

    // Side panel.
    const details = root.getByTestId("ps-session-details");
    await expect(details).toContainText("Operatorana.owner (owner)");
    await expect(details).toContainText("2FA confirmed");
    await expect(details).toContainText("Runs asSYSTEM");
    await expect(details).toContainText(`PowerShell${PS_VERSION}`);
    await expect(details).toContainText("Everything the console shows · kept 180 days");
    await expect(details).toContainText("Signed-in useruser · sees nothing");
    await expect(root.getByTestId("ps-command-count")).toHaveText("0 · 0 failed");

    // Command bar: Enter runs; the agent's title marker fills the list.
    const bar = root.getByRole("textbox", { name: "Command" });
    await bar.fill("Get-Service spooler");
    await bar.press("Enter");
    await expect.poll(() => shell.received).toContain("Get-Service spooler\r");
    const commands = root.getByRole("list", { name: "Commands this session" });
    await expect(commands.getByText("Get-Service spooler")).toBeVisible();
    await expect(screen).toContainText("Running");

    await bar.fill("Get-Item C:\\nope");
    await root.getByRole("button", { name: "Run", exact: true }).click();
    await expect(root.getByTestId("ps-command-count")).toHaveText("2 · 1 failed");
    await expect(commands.locator("li").nth(1)).toContainText("failed");

    // ↑ brings back the last command.
    await bar.press("ArrowUp");
    await expect(bar).toHaveValue("Get-Item C:\\nope");
    await bar.fill("");

    // Saved scripts: confirm, POST, then the line goes over the console.
    const saved = root.getByRole("list", { name: "Saved scripts" });
    await expect(saved.locator(".ps-script-name")).toHaveText(["Flush DNS", "Restart print spooler", "Disk usage"]);
    await saved.locator("li").first().hover();
    await saved.getByRole("button", { name: "Run Flush DNS" }).click();
    const dialog = page.getByRole("dialog", { name: "Run “Flush DNS”" });
    await expect(dialog.getByLabel("Script body")).toHaveValue(
      "Clear-DnsClientCache\nWrite-Output 'DNS cache cleared'",
    );
    expect(runs).toEqual([]);
    await dialog.getByRole("button", { name: "Run as SYSTEM" }).click();
    await expect(dialog).toHaveCount(0);
    expect(runs).toEqual(["POST /api/v1/devices/1/terminal/sessions/ps-9/scripts/2"]);
    await expect
      .poll(() => shell.received)
      .toContain("& ([scriptblock]::Create('Q2xlYXItRG5zQ2xpZW50Q2FjaGU='))  # TECHI script: Flush DNS v3\r");
    await expect(commands.getByText("Script · Flush DNS")).toBeVisible();
    await expect(root.getByTestId("ps-command-count")).toHaveText("3 · 1 failed");

    await expectNoPageScroll(page);
    await page.screenshot({ path: testInfo.outputPath("powershell-window-1440.png") });

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(root.locator(".ps-side")).toBeVisible();
    await expectNoPageScroll(page);
    await page.screenshot({ path: testInfo.outputPath("powershell-window-1280.png") });

    // Light theme: the chrome follows it, the console stays a dark terminal.
    await page.evaluate(() => document.documentElement.classList.add("light"));
    await page.screenshot({ path: testInfo.outputPath("powershell-window-1280-light.png") });
  });

  test("the library creates a script and says when a name is taken", async ({ page }) => {
    await mockPowerShellSession(page, 1, "ps-9");
    await mockScripts(page);
    await fakePowerShell(page, "ps-9");
    const posted: unknown[] = [];
    await page.route("**/api/v1/console/scripts", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { name: string };
      posted.push(body);
      if (body.name === "Flush DNS") {
        return route.fulfill({ status: 409, json: { detail: "A script with this name already exists." } });
      }
      return route.fulfill({
        json: {
          ...body,
          id: 11,
          version: 1,
          uses: 0,
          last_used_at: null,
          updated_by: "ana.owner",
          updated_at: new Date().toISOString(),
        },
      });
    });

    const root = await openWindow(page);
    await root.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Script library" });
    await expect(library.getByRole("list", { name: "Library scripts" }).getByRole("button")).toHaveCount(3);
    await expect(library.getByTestId("ps-script-meta")).toContainText("v2 · 7 uses");

    await library.getByRole("button", { name: "New", exact: true }).click();
    await library.getByLabel("Name").fill("Flush DNS");
    await library.getByLabel("Script", { exact: true }).fill("ipconfig /flushdns");
    await library.getByRole("button", { name: "Create script" }).click();
    await expect(library.getByRole("alert")).toHaveText("A script named “Flush DNS” already exists.");

    await library.getByLabel("Name").fill("Uptime");
    await library.getByRole("button", { name: "Create script" }).click();
    await expect(library.getByRole("list", { name: "Library scripts" }).getByRole("button")).toHaveCount(4);
    expect(posted).toHaveLength(2);
    await library.getByRole("button", { name: "Close" }).first().click();
    await expect(library).toHaveCount(0);
  });

  test("ending the session offers the transcript", async ({ page }) => {
    await mockPowerShellSession(page, 1, "ps-9");
    await mockScripts(page);
    await fakePowerShell(page, "ps-9");
    await page.route("**/api/v1/devices/1/terminal/sessions/ps-9/recording", (route) =>
      route.fulfill({ body: '{"version":2,"width":80,"height":24}\n[0.1,"o","PS C:\\\\> "]\n' }),
    );
    const root = await openWindow(page);
    await root.getByRole("button", { name: "End session" }).click();
    await expect(root.locator(".ps-chip", { hasText: "Session ended" })).toBeVisible();
    await expect(root.getByRole("textbox", { name: "Command" })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await root.getByRole("status").getByRole("button", { name: "Download transcript" }).click();
    expect((await download).suggestedFilename()).toBe("powershell-ps-9.cast");
    await root.getByRole("button", { name: "New session" }).click();
    await expect(page.getByLabel("Two-factor code")).toBeVisible();
  });
});
