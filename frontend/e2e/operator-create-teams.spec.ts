import type { Page } from "@playwright/test";
import type { TeamWithStats } from "../src/api/teams";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const TEAMS: TeamWithStats[] = ["Helpdesk", "Field", "Servers"].map((name, i) => ({
  id: i + 1,
  name,
  description: null,
  color: ["#3b82f6", "#22c55e", "#a855f7"][i],
  permissions: [],
  created_at: "2025-05-01T00:00:00Z",
  member_count: 0,
  client_count: 0,
  group_count: 0,
  explicit_device_count: 0,
  effective_device_count: 0,
  operator_ids: [],
}));

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: a new operator is created straight into the chosen teams`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.route("**/api/v1/teams/", (route) => route.fulfill({ json: TEAMS }));
    let sent: Record<string, unknown> | null = null;
    await page.route("**/api/v1/operators", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        json: {
          id: 99,
          username: "dritan",
          email: "dritan@example.test",
          display_name: "Dritan Hoxha",
          role: "operator",
          is_active: true,
          is_superuser: false,
          created_at: "2026-10-16T08:00:00Z",
          last_login_at: null,
          last_active_at: null,
          mfa_enabled: false,
        },
      });
    });

    await page.goto("/operators");
    await page.getByRole("button", { name: "Add operator" }).click();
    const dialog = page.getByRole("dialog", { name: "Add operator" });
    await dialog.getByPlaceholder("Full name").fill("Dritan Hoxha");
    await dialog.getByPlaceholder("login name").fill("dritan");
    await dialog.getByPlaceholder("user@example.com").fill("dritan@example.test");
    await dialog.getByPlaceholder("At least 8 characters").fill("secret123");

    const teams = dialog.getByRole("group", { name: "Teams" });
    await teams.getByRole("button", { name: "Helpdesk" }).click();
    await teams.getByRole("button", { name: "Servers" }).click();
    await teams.getByRole("button", { name: "Helpdesk" }).click();
    await teams.getByRole("button", { name: "Field" }).click();
    await expect(teams.getByRole("button", { name: "Field" })).toHaveAttribute("aria-pressed", "true");
    await expect(teams.getByRole("button", { name: "Helpdesk" })).toHaveAttribute("aria-pressed", "false");
    await dialog.screenshot({ path: testInfo.outputPath(`add-operator-${theme}.png`) });

    await dialog.getByRole("button", { name: "Create operator" }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toMatchObject({ username: "dritan", team_ids: [3, 2] });

    const row = page.getByRole("row", { name: /Dritan Hoxha/ });
    await expect(row.getByText("Servers")).toBeVisible();
    await expect(row.getByText("Field")).toBeVisible();
    await expect(row.getByText("Helpdesk")).toHaveCount(0);
  });
}

const BESI_IN_HELPDESK = TEAMS.map((t) => (t.name === "Helpdesk" ? { ...t, operator_ids: [2] } : t));

async function captureOperatorUpdates(page: Page) {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/v1/operators/2", async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    return route.fulfill({
      json: {
        id: 2,
        username: "besi.ops",
        email: "besi@example.test",
        display_name: body.display_name ?? "Besi Ops",
        role: "operator",
        is_active: true,
        is_superuser: false,
        created_at: "2025-05-01T00:00:00Z",
        last_login_at: null,
        last_active_at: null,
        mfa_enabled: false,
      },
    });
  });
  return sent;
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: editing an operator moves them between teams`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.route("**/api/v1/teams/", (route) => route.fulfill({ json: BESI_IN_HELPDESK }));
    const sent = await captureOperatorUpdates(page);

    await page.goto("/operators");
    await page.getByRole("button", { name: "Edit Besi Ops" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit operator" });
    const teams = dialog.getByRole("group", { name: "Teams" });
    await expect(teams.getByRole("button", { name: "Helpdesk" })).toHaveAttribute("aria-pressed", "true");

    await teams.getByRole("button", { name: "Helpdesk" }).click();
    await teams.getByRole("button", { name: "Servers" }).click();
    await dialog.screenshot({ path: testInfo.outputPath(`edit-operator-${theme}.png`) });
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual([expect.objectContaining({ team_ids: [3] })]);

    const row = page.getByRole("row", { name: /Besi Ops/ });
    await expect(row.getByText("Servers")).toBeVisible();
    await expect(row.getByText("Helpdesk")).toHaveCount(0);
  });
}

test("saving an edit without touching teams leaves them alone", async ({ page }) => {
  await page.route("**/api/v1/teams/", (route) => route.fulfill({ json: BESI_IN_HELPDESK }));
  const sent = await captureOperatorUpdates(page);

  await page.goto("/operators");
  await page.getByRole("button", { name: "Edit Besi Ops" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit operator" });
  await dialog.getByPlaceholder("Full name (optional)").fill("Besi Renamed");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty("team_ids");
});

test("teams still show when the operators list comes from the cache", async ({ page }) => {
  await page.route("**/api/v1/teams/", (route) => route.fulfill({ json: BESI_IN_HELPDESK }));
  await page.goto("/operators");
  const row = page.getByRole("row", { name: /Besi Ops/ });
  await expect(row.getByText("Helpdesk")).toBeVisible();

  await page.evaluate(() => {
    window.history.pushState({}, "", "/devices");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/devices/);
  await expect(row).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/operators/);
  await expect(row.getByText("Helpdesk")).toBeVisible();
});
