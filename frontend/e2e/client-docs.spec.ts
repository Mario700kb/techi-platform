import type { Page, Route } from "@playwright/test";

import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const now = () => new Date().toISOString();

// A small in-browser stand-in for /clients/1/documents.
async function documentsApi(page: Page) {
  const docs: Record<string, unknown>[] = [];
  let nextId = 1;
  const summary = (d: Record<string, unknown>) => ({ ...d, excerpt: String(d.body).slice(0, 80) });
  await page.route("**/api/v1/clients/1/profile", (route) =>
    route.fulfill({
      json: {
        client: {
          id: 1,
          name: "Northwind Clinic",
          slug: "northwind",
          description: null,
          is_active: true,
          created_at: now(),
        },
        stats: { total: 3, online: 2, stale: 0, offline: 1 },
        by_category: {},
        alerts: { total_open: 0, by_severity: {}, by_kind: {}, devices_affected: 0, oldest_open_at: null },
        average_health: 90,
        health_critical: 0,
        health_warning: 0,
        needs_updates: 0,
        agents_outdated: 0,
        groups: [],
        last_seen: now(),
      },
    }),
  );
  await page.route("**/api/v1/clients/1/activity*", (route) =>
    route.fulfill({ json: { total: 0, items: [], device_names: {} } }),
  );
  await page.route(/\/api\/v1\/clients\/1\/documents(\/\d+)?(\?.*)?$/, async (route: Route) => {
    const request = route.request();
    const id = request.url().match(/documents\/(\d+)/)?.[1];
    if (request.method() === "GET" && !id)
      return route.fulfill({ json: [...docs].sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(summary) });
    if (request.method() === "GET") return route.fulfill({ json: summary(docs.find((d) => String(d.id) === id)!) });
    if (request.method() === "POST") {
      const doc = {
        id: nextId++,
        client_id: 1,
        ...request.postDataJSON(),
        created_by: "owner",
        updated_by: "owner",
        created_at: now(),
        updated_at: now(),
      };
      docs.push(doc);
      return route.fulfill({ status: 201, json: summary(doc) });
    }
    if (request.method() === "PUT") {
      const doc = docs.find((d) => String(d.id) === id)!;
      Object.assign(doc, request.postDataJSON(), { updated_at: now() });
      return route.fulfill({ json: summary(doc) });
    }
    return route.fulfill({ status: 204 });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: write, preview, save and pin a documentation page`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop layout");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await documentsApi(page);
    await page.goto("/clients/1");
    await page.getByRole("tab", { name: /Documentation/ }).click();
    await expect(page.getByText("No documentation yet")).toBeVisible();

    await page.getByRole("button", { name: "New page" }).first().click();
    await page.getByPlaceholder("e.g. Network and Wi-Fi").fill("Network and Wi-Fi");
    await page
      .getByRole("textbox", { name: "Content" })
      .fill(
        "## Addresses\n\n| Device | Address |\n| --- | --- |\n| Gateway | 10.0.0.1 |\n\n- [x] Backup configured\n- [ ] UPS tested\n\n> Wi-Fi password is in the Vault: **Clinic Wi-Fi**",
      );
    await page.getByRole("radio", { name: "preview" }).click();
    await expect(page.getByRole("cell", { name: "10.0.0.1" })).toBeVisible();
    await page.getByRole("button", { name: "Create page" }).click();

    const article = page.locator("article");
    await expect(article.getByRole("heading", { name: "Network and Wi-Fi" })).toBeVisible();
    await expect(article.getByRole("cell", { name: "Gateway" })).toBeVisible();
    await expect(article.getByRole("checkbox")).toHaveCount(2);
    await page.getByRole("button", { name: "Pin to the top" }).click();
    await expect(page.getByRole("button", { name: "Unpin" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`docs-${theme}.png`) });
  });
}
