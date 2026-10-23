import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const shoot = (name: string) => (process.env.SCREENS ? { path: `e2e/.screens/${name}.png` } : undefined);

test("the queue shows each alert's deadline, the incident and what is overdue", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the desktop queue");
  await page.goto("/alerts");
  const row = page.locator("tr", { hasText: "BH-WH-SCANNER" });
  await expect(row.getByText(/Take overdue/)).toBeVisible();
  await expect(row.getByText("+2 devices")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Overdue/ })).toContainText("1");

  await page.getByRole("tab", { name: /All open/ }).click();
  const disk = page.locator("tr", { hasText: "NW-DOCTOR-02" });
  await expect(disk.getByText("Recurring")).toBeVisible();
  await expect(disk.getByText(/Take in/)).toBeVisible();
  const shot = shoot("alerts-deadlines");
  if (shot) await page.screenshot(shot);

  await page.getByRole("tab", { name: /Overdue/ }).click();
  await expect(page.locator("tr", { hasText: "BH-WH-SCANNER" })).toBeVisible();
  await expect(page.locator("tr", { hasText: "NW-DOCTOR-02" })).toHaveCount(0);
});

test("the panel says who else has the problem and lets the owner wait on someone", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the desktop drawer");
  await page.goto("/alerts");
  await page.locator("tr", { hasText: "BH-WH-SCANNER" }).getByText("Device offline").click();
  const drawer = page.getByRole("complementary", { name: "Alert" });
  await expect(drawer.getByRole("heading", { name: "Incident" })).toBeVisible();
  await expect(drawer.getByText("BH-WH-PRINTER")).toBeVisible();
  await expect(drawer.getByText(/counted every hour/)).toBeVisible();
  await drawer.getByRole("button", { name: /Waiting on/ }).click();
  await expect(drawer.getByRole("menuitem", { name: "Waiting on the client" })).toBeVisible();
  await drawer.getByRole("menuitem", { name: "Waiting on a vendor" }).click();
  await expect(drawer.getByRole("button", { name: "Stop the clock" })).toBeVisible();
  await drawer.getByRole("button", { name: /Give to/ }).click();
  await expect(drawer.getByRole("menuitem", { name: "Besi Ops" })).toBeVisible();
  const shot = shoot("alerts-drawer-deadlines");
  if (shot) await page.screenshot(shot);
});

test("the duty tab names today's dispatcher and the deadlines; the handover lists what stays open", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "the desktop tabs");
  await page.goto("/alerts");
  await page.getByRole("tab", { name: "Duty" }).click();
  await expect(page.getByText("Dispatcher today")).toBeVisible();
  await expect(page.getByText("Besi Ops").first()).toBeVisible();
  await expect(page.getByText("Stand-in: Ana Owner", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add shift" })).toBeVisible();
  const duty = shoot("alerts-duty");
  if (duty) await page.screenshot({ ...duty, fullPage: true });

  await page.getByRole("button", { name: "Handover" }).click();
  const dialog = page.getByRole("dialog", { name: "Handover" });
  await expect(dialog.getByText("BH-WH-SCANNER")).toBeVisible();
  await expect(dialog.getByText(/Overdue/)).toBeVisible();
  const handover = shoot("alerts-handover");
  if (handover) await page.screenshot(handover);
});
