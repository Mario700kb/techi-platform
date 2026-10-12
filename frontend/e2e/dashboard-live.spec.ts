import { presence } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// The mock API has no realtime server, so the dashboard runs as it does when
// the socket is down: everything it shows must still refresh on its own.
test("without a socket the dashboard keeps refreshing itself", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the header chips are on the desktop dashboard");
  await page.clock.install();
  const overviewCalls: number[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/devices/overview") overviewCalls.push(Date.now());
  });

  await page.goto("/");
  const status = page.getByText(/^Polling/);
  await expect(status).toContainText("updated just now");
  await expect(page.getByText(/1 operator\s+online/)).toBeVisible();
  const before = overviewCalls.length;

  // Someone else signs in; nothing announces it, the next poll shows it.
  await page.route("**/api/v1/operators/presence", (route) =>
    route.fulfill({ json: presence.map((p) => ({ ...p, is_online: true })) }),
  );
  await page.clock.fastForward(31_000);

  await expect(page.getByText(new RegExp(`${presence.length} operators\\s+online`))).toBeVisible();
  await expect.poll(() => overviewCalls.length).toBeGreaterThan(before);
});
