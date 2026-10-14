import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test("an operator edits their own name and email from Settings", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Edit profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit profile" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("are managed on the Operators page")).toBeVisible();

  // The name alone saves without a password.
  await dialog.getByLabel("Display name").fill("Ana Shehu");
  await expect(dialog.getByLabel("Current password")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByText("Profile updated.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ana Shehu" })).toBeVisible();
  await expect(dialog).toBeHidden();

  // A new email asks for the current password and says when it is wrong.
  await page.getByRole("button", { name: "Edit profile" }).click();
  await dialog.getByLabel("Email").fill("ana.shehu@example.test");
  const password = dialog.getByLabel("Current password");
  await expect(password).toBeVisible();
  await password.fill("wrong-password");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Current password is incorrect");
  await password.fill("correct-password");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByText("Profile updated.")).toBeVisible();
  await expect(page.getByText("ana.shehu@example.test").first()).toBeVisible();
});
