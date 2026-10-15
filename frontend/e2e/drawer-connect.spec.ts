import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const method = (id: string, label: string, surface: "desktop" | "browser", category: string) => ({
  id,
  label,
  surface,
  capability: null,
  priority: 1,
  scheme: null,
  requires_client_os: null,
  status: "ready",
  status_reason: null,
  credential_source: null,
  transport: surface === "browser" ? "Browser" : "Desktop app",
  category,
  embedded: false,
});

test("the drawer's Connect is one split button: Remote Support, and the other methods under its arrow", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await page.route(/\/api\/v1\/devices\/1\/connect-methods/, (route) =>
    route.fulfill({
      json: {
        platform: "windows",
        methods: [
          method("remote_support", "TECHI Remote Support", "desktop", "available"),
          method("rdp", "Remote Desktop (RDP)", "desktop", "desktop_app"),
        ],
        preferred_method_id: "remote_support",
        configured_preference_id: null,
      },
    }),
  );
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
  const drawer = page.getByRole("dialog").filter({ hasText: "NW-RECEPTION-01" }).first();

  // One Connect and one arrow in the whole drawer, side by side in the header.
  const arrow = page.getByRole("button", { name: "Connect options" });
  await expect(arrow).toHaveCount(1);
  const main = arrow.locator("xpath=preceding-sibling::button[1]");
  await expect(main).toHaveText("Connect");
  const [m, a] = [(await main.boundingBox())!, (await arrow.boundingBox())!];
  expect(Math.abs(m.y - a.y)).toBeLessThanOrEqual(1);
  expect(a.x - (m.x + m.width)).toBeLessThanOrEqual(2);
  await expect(page.getByText("Connect", { exact: true }).locator("xpath=self::p")).toHaveCount(0);

  await arrow.click();
  await expect(page.getByText("Connect to NW-RECEPTION-01")).toBeVisible();
  await expect(page.getByRole("button", { name: /Remote Desktop \(RDP\)/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("drawer-connect.png") });
  void drawer;
});
