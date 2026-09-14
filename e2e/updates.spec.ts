import { expect, test } from "./app";

test("a version the server no longer supports downloads the update and restarts into it", async ({ app, page }) => {
  await app.open("update");
  await expect(page.getByRole("heading", { name: "This version of Alpha is no longer supported" })).toBeVisible();
  await expect(page.getByText("You have version 0.1.0. The model server needs version 0.2.0 or later.")).toBeVisible();
  await expect(page.getByText("Alpha 0.2.0 is downloaded and ready to install.")).toBeVisible();

  await page.getByRole("button", { name: "Restart to update" }).click();
  // The fake "restart" reloads the page, which takes a while on the dev server.
  await expect(app.composer).toBeEnabled({ timeout: 20_000 });
  await app.openSettings("Updates");
  await expect(app.settings.getByText("You have Alpha 0.2.0.")).toBeVisible();
  await expect(app.settings.getByText("Alpha is up to date.")).toBeVisible();
});

test("with no update published, the update screen points to the download page", async ({ app, page }) => {
  await app.open("update_unpublished");
  await expect(page.getByText("Alpha can't update itself to that version.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://llm.example.org/app/download/" })).toBeVisible();
  await expect(page.getByText("No update has been published.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again" })).toBeEnabled();
});

test("an update downloaded in the background is offered, and restarting asks before stopping an answer", async ({ app, page }) => {
  await app.ready("update_available");
  const banner = page.getByRole("status").filter({ hasText: "Alpha 0.2.0 is ready to install." });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Faster startup and fixes for long chats.");

  await app.send("/slow tell me something");
  await expect(app.stopButton).toBeVisible();
  await banner.getByRole("button", { name: "Restart to update" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Stop the answer and restart?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(app.stopButton).toBeVisible();

  await banner.getByRole("button", { name: "Restart to update" }).click();
  await confirm.getByRole("button", { name: "Stop and restart" }).click();
  await expect(app.composer).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByText("is ready to install")).toBeHidden();
  await expect(app.chatRow("tell me something")).toBeVisible();
});

test("Later hides the update banner; Settings still offers it", async ({ app, page }) => {
  await app.ready("update_available");
  const banner = page.getByRole("status").filter({ hasText: "Alpha 0.2.0 is ready to install." });
  await banner.getByRole("button", { name: "Later" }).click();
  await expect(banner).toBeHidden();

  await app.openSettings("Updates");
  await expect(app.settings.getByText("Alpha 0.2.0 is downloaded and ready to install.")).toBeVisible();
  await expect(app.settings.getByRole("button", { name: "Restart to update" })).toBeVisible();
});

test("a failed download shows in Settings and can be retried", async ({ app }) => {
  await app.ready("update_broken");
  await app.openSettings("Updates");
  await expect(app.settings.getByText("Can't reach the model server. Are you on VPN?")).toBeVisible();
  await expect(app.settings.getByText("Alpha 0.2.0 is available.")).toBeVisible();
  await app.settings.getByRole("button", { name: "Download again" }).click();
  await expect(app.settings.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
  await expect(app.settings.getByRole("button", { name: "Download again" })).toBeVisible();
});

test("an up-to-date app says so", async ({ app }) => {
  await app.ready();
  await app.openSettings("Updates");
  await expect(app.settings.getByText("You have Alpha 0.1.0.")).toBeVisible();
  await expect(app.settings.getByText("Alpha is up to date.")).toBeVisible();
  await app.settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(app.settings.getByText("Alpha is up to date.")).toBeVisible();
  await expect(app.settings.getByText(/Last checked/)).toBeVisible();
});
