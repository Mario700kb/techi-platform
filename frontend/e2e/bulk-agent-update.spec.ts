import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// The Devices bulk bar updates the agent on the selected devices: the dialog
// shows the plan (who updates from which version, who is left out and why)
// before anything is queued.
test("Update agent from the bulk bar shows the plan and updates the rest", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the bulk bar is the desktop table");
  const ids = DEVICES.map((d) => d.id);
  const [first, second, ...rest] = DEVICES;
  await page.route("**/api/v1/commands/bulk/self-update/preview", (route) =>
    route.fulfill({
      json: {
        version: "2.1.33",
        update: [first, ...rest].map((d, i) => ({
          device_id: d.id,
          name: d.hostname,
          from_version: i === 0 ? "2.1.32" : "2.1.20",
          to_version: "2.1.33",
          live: i === 0,
        })),
        skipped: [{ device_id: second.id, name: second.hostname, reason: "Already on 2.1.33" }],
      },
    }),
  );
  let sent: unknown = null;
  await page.route("**/api/v1/commands/bulk", (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        batch_id: "b1",
        device_count: ids.length - 1,
        created_at: new Date().toISOString(),
        skipped: [],
        pushed: 1,
      },
    });
  });

  await page.goto("/devices");
  await page.getByRole("checkbox", { name: "Select all devices on this page" }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await bar.getByRole("button", { name: "Update agent" }).click();

  const dialog = page.getByRole("dialog", { name: /Update the agent on/ });
  const plan = dialog.getByTestId("bulk-update-plan");
  await expect(plan.getByLabel("Devices left out")).toContainText("Already on 2.1.33");
  await expect(plan).toContainText("1 start at once over the live channel");
  await dialog.screenshot({ path: testInfo.outputPath("bulk-update-dialog.png") });
  await bar.screenshot({ path: testInfo.outputPath("bulk-bar.png") });

  await dialog.getByRole("button", { name: /^Update \d+ devices?$/ }).click();
  await expect(page.getByText(/^Agent update started on/)).toBeVisible();
  expect(sent).toMatchObject({ command_type: "self_update", target: "devices", timeout_seconds: 900 });
});
