import { mockScripts } from "./fakePowerShell";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const SID = "c".repeat(32);
const BASE = `**/api/v1/devices/1/terminal/sessions/${SID}`;

test("Windows without a pseudo console runs PowerShell a command at a time, in the same console", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "the own window is a desktop popup");
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockScripts(page);
  await page.route("**/api/v1/devices/1/terminal/sessions", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          json: {
            session_id: SID,
            operator_ws_path: "",
            operator_ticket: "",
            expires_in_seconds: 3600,
            mode: "command",
          },
        })
      : route.fallback(),
  );
  const sent: { command: string; cwd: string | null }[] = [];
  await page.route(`${BASE}/commands`, (route) => {
    sent.push(route.request().postDataJSON() as { command: string; cwd: string | null });
    return route.fulfill({ json: { action_id: sent.length } });
  });
  await page.route(`${BASE}/commands/*`, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/").pop());
    const { command } = sent[id - 1];
    const version = command.startsWith("$PSVersionTable");
    return route.fulfill({
      json: {
        action_id: id,
        status: "completed",
        done: true,
        output: version ? "4.0" : "\n    Directory: C:\\inetpub\n\nwwwroot",
        stderr: null,
        error: null,
        failed: false,
        duration_ms: 180,
        cwd: version ? "C:\\Windows\\system32" : "C:\\inetpub",
        truncated: false,
      },
    });
  });

  await page.goto("/terminal/1?engine=powershell&name=PDC");
  await page.getByLabel("Two-factor code").fill("123456");
  await page.getByRole("button", { name: "Open PowerShell" }).click();
  const root = page.getByTestId("powershell-console");
  await expect(root.locator(".ps-chip", { hasText: "Recording" })).toBeVisible();
  await expect(root.getByText(/command mode \(no pseudo console on this Windows\)/)).toBeVisible();
  const screen = root.getByTestId("command-mode-screen");
  await expect(screen.getByText("Connected · PowerShell 4.0")).toBeVisible();

  // Typed straight into the screen, at its prompt, as in the live console.
  const prompt = screen.getByTestId("command-mode-prompt");
  await expect(prompt).toBeFocused();
  await screen.click({ position: { x: 400, y: 300 } });
  await expect(prompt).toBeFocused();
  await page.keyboard.type("cd C:\\inetpub; Get-ChildItem");
  await page.keyboard.press("Enter");
  await expect(screen.getByText("PS C:\\Windows\\system32> cd C:\\inetpub; Get-ChildItem")).toBeVisible();
  await expect(screen.getByText("wwwroot")).toBeVisible();

  // The command bar under it works as well.
  const bar = root.getByPlaceholder(/Type a command/);
  await bar.fill("Get-Location");
  await bar.press("Enter");
  await expect(screen.getByText("PS C:\\inetpub> Get-Location")).toBeVisible();
  // ↑ at the prompt brings back this session's commands.
  await expect(prompt).toBeVisible();
  await prompt.focus();
  await page.keyboard.press("ArrowUp");
  await expect(prompt).toHaveValue("Get-Location");
  await page.keyboard.press("ArrowUp");
  await expect(prompt).toHaveValue("cd C:\\inetpub; Get-ChildItem");
  await expect(screen.getByText("PS C:\\inetpub>", { exact: true })).toBeVisible();
  // The folder the last command ended in goes with the next one.
  expect(sent.map((s) => s.cwd)).toEqual([null, "C:\\Windows\\system32", "C:\\inetpub"]);
  // The session's command list and PowerShell version fill in as with the live console.
  await expect(root.getByText("4.0").first()).toBeVisible();
  if (process.env.SCREENS) await page.screenshot({ path: "e2e/.screens/powershell-command-mode.png" });

  await page.route(`${BASE}/close`, (route) => route.fulfill({ status: 204 }));
  await root.getByRole("button", { name: "End session" }).click();
  await expect(root.getByText("Session ended").first()).toBeVisible();
});
