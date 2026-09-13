import { expect, test } from "./app";

test("a key is checked before it's saved, and signing out asks for it again", async ({ app, page }) => {
  await app.open("no_key");
  const key = page.locator("#api-key");
  const connect = page.getByRole("button", { name: "Connect" });

  await key.fill("bad");
  await connect.click();
  await expect(page.getByText("The server didn't accept that key. Check it and try again.")).toBeVisible();

  await key.fill("sk-test-key");
  await connect.click();
  await expect(app.composer).toBeEnabled();
  await expect(app.chatRow("Docker container reaching host")).toBeVisible();

  await app.openSettings("Account");
  await expect(app.settings.getByText("In the system keychain")).toBeVisible();
  await app.settings.getByRole("button", { name: "Sign out and remove key" }).click();
  await expect(key).toBeVisible();
  await expect(app.settings).toBeHidden();
});

test("a key the server rejects later opens the key screen", async ({ app, page }) => {
  await app.open("rejected");
  await expect(page.getByText("The server rejected your saved key.")).toBeVisible();
  await page.locator("#api-key").fill("sk-new-key");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(app.composer).toBeEnabled();
});
