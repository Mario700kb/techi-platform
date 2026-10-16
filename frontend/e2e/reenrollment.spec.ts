import type { Page } from "@playwright/test";

import { expect, test } from "./test";

const PENDING = [
  {
    id: 7,
    device_id: 774,
    device_hostname: "DESKTOP-UKPKR96",
    new_device_id: 981,
    agent_id: "agent_new_machine_abcdef",
    matched_by: "rustdesk_id",
    status: "pending",
    hostname: "KLEVIPC",
    current_user: "Kleivid",
    domain: "TECHI",
    local_ip: "192.168.1.20",
    public_ip: "185.66.128.121",
    rustdesk_id: "439466287",
    os_caption: "Microsoft Windows 11 Pro",
    platform: "windows",
    token_name: "TECHI office",
    created_at: new Date(Date.now() - 6 * 60_000).toISOString(),
    last_seen_at: null,
    decided_at: null,
    decided_by: null,
    decision: null,
  },
];

async function stub(page: Page) {
  const decided = { approve: 0, reject: 0 };
  await page.route("**/api/v1/reenrollment-requests**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: decided.approve + decided.reject > 0 ? [] : PENDING });
    if (url.includes("/approve")) {
      decided.approve += 1;
      return route.fulfill({ json: { ...PENDING[0], status: "decided", decision: "approved" } });
    }
    if (url.includes("/reject")) {
      decided.reject += 1;
      return route.fulfill({ json: { ...PENDING[0], status: "decided", decision: "rejected" } });
    }
    return route.fallback();
  });
  return decided;
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: a held re-enrollment shows the device and both decisions`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.addInitScript((v) => window.localStorage.setItem("techi.theme", v), theme);
    await stub(page);
    await page.goto("/reenrollment");

    await expect(page.getByRole("heading", { name: "Re-enrollment review" })).toBeVisible();
    await expect(page.getByText("DESKTOP-UKPKR96").first()).toBeVisible();
    await expect(page.getByText("Matched by Remote Support ID")).toBeVisible();
    await expect(page.getByText("439466287")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`reenrollment-${theme}.png`), fullPage: true });
  });
}

test("approving hands the device over and clears the request", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  const decided = await stub(page);
  await page.goto("/reenrollment");

  await page.getByRole("button", { name: "Hand device over" }).click();
  const dialog = page.getByRole("dialog", { name: "Hand the device over" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Hand device over" }).click();

  await expect(page.getByText("Nothing to review")).toBeVisible();
  expect(decided.approve).toBe(1);
});

test("rejecting keeps two devices and clears the request", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  const decided = await stub(page);
  await page.goto("/reenrollment");

  await page.getByRole("button", { name: "Keep separate" }).click();
  const dialog = page.getByRole("dialog", { name: "Keep them separate" });
  await dialog.getByRole("button", { name: "Keep separate" }).click();

  await expect(page.getByText("Nothing to review")).toBeVisible();
  expect(decided.reject).toBe(1);
});
