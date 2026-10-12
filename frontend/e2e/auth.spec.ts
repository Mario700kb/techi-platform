import { expect, test } from "./test";

test.describe("signed out", () => {
  test.use({ signedOut: true });

  test("a protected page sends you to sign-in, and back after", async ({ page, api }) => {
    await page.goto("/devices");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Username or email").fill("ana.owner");
    await page.getByLabel("Password", { exact: true }).fill("correct-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/devices$/);
    expect(api.user?.username).toBe("ana.owner");
  });

  test("a wrong password shows the server's message", async ({ page, api }) => {
    await page.goto("/login");
    await page.getByLabel("Username or email").fill("ana.owner");
    await page.getByLabel("Password", { exact: true }).fill("nope");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Invalid username or password");
    expect(api.user).toBeNull();
  });

  test("two-factor sign-in asks for the code", async ({ page, api }) => {
    api.mfaOnLogin = true;
    await page.goto("/login");
    await page.getByLabel("Username or email").fill("ana.owner");
    await page.getByLabel("Password", { exact: true }).fill("correct-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
    await page.getByLabel("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert")).toHaveText("That code is not valid");

    await page.getByLabel("Authentication code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).not.toHaveURL(/\/login$/);
  });
});

test("signing out returns to the sign-in page", async ({ page, api }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  expect(api.user).toBeNull();
});

test("a role that requires 2FA sees only the setup screen", async ({ page, api }) => {
  api.mfaEnrollmentRequired = true;
  await page.goto("/devices");
  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
});
