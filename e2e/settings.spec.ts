import { expect, test } from "./app";

test("theme is applied, saved, and used from the first paint", async ({ app, page }) => {
  await app.ready();
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "system");

  await app.openSettings("Appearance");
  await app.settings.getByRole("radio", { name: "Dark" }).click();
  expect(await theme()).toBe("dark");
  await page.keyboard.press("Escape");

  await page.reload();
  await page.waitForFunction(() => document.readyState !== "loading");
  expect(await theme()).toBe("dark");
  await expect(app.composer).toBeEnabled();
  expect(await theme()).toBe("dark");
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(ground).toBe("rgb(15, 26, 28)");

  await app.openSettings("Appearance");
  await expect(app.settings.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  await app.settings.getByRole("radio", { name: "Match system" }).click();
  expect(await theme()).toBe("system");
});

test("defaults apply to new chats, not existing ones", async ({ app, page }) => {
  await app.ready();
  const model = page.getByRole("button", { name: /^Model:/ });
  await expect(model).toHaveText("Qwen");

  await app.openSettings("New chats");
  await app.settings.getByLabel("Model").selectOption({ label: "Gemma" });
  await app.settings.getByLabel("Thinking").selectOption("off");
  await app.settings.getByLabel("System prompt").fill("Answer like a pirate.");
  await app.settings.getByLabel("Close settings").click();

  // The empty new chat on screen follows the new defaults.
  await expect(model).toHaveText("Gemma");
  await page.getByRole("button", { name: "Chat settings" }).click();
  await expect(page.getByLabel("System prompt")).toHaveValue("Answer like a pirate.");
  await page.keyboard.press("Escape");

  // An existing chat keeps its own settings.
  await app.chatRow("Docker container reaching host").getByRole("button").first().click();
  await expect(page.getByText("How does a container reach a service on my Mac?")).toBeVisible();
  await expect(model).toHaveText("Qwen");
  await expect(page.getByRole("switch", { name: /Thinking on/ })).toBeVisible();
  await page.getByRole("button", { name: "Chat settings" }).click();
  await expect(page.getByLabel("System prompt")).toHaveValue("");
  await page.keyboard.press("Escape");

  // Saved: after a restart, a new chat still starts from them.
  await page.reload();
  await expect(model).toHaveText("Gemma");
  await app.chatRow("Rust lifetimes in structs").getByRole("button").first().click();
  await expect(page.getByText("When does a struct need a lifetime parameter?")).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(model).toHaveText("Gemma");
  await app.openSettings("New chats");
  await expect(app.settings.getByLabel("System prompt")).toHaveValue("Answer like a pirate.");
  await expect(app.settings.getByLabel("Thinking")).toHaveValue("off");
});

test("auto-delete asks before deleting old chats, then keeps applying", async ({ app, page }) => {
  await app.ready();
  await app.openSettings("History");
  const retention = app.settings.getByLabel("Delete chats automatically");

  await retention.selectOption("30");
  await expect(app.settings.getByText("1 chat has had no activity in the last 30 days and will be deleted now.")).toBeVisible();
  await app.settings.getByRole("button", { name: "Cancel" }).click();
  await expect(retention).toHaveValue("never");
  await expect(app.settings.getByText("4 chats")).toBeVisible();

  await retention.selectOption("30");
  await app.settings.getByRole("button", { name: "Delete 1 chat" }).click();
  await expect(page.getByText("Deleted 1 chat with no activity in the last 30 days.")).toBeVisible();
  await expect(retention).toHaveValue("30");
  await expect(app.settings.getByText("3 chats")).toBeVisible();

  // Nothing older than 60 days: applied without asking.
  await retention.selectOption("custom");
  await app.settings.getByLabel("Days").fill("60");
  await app.settings.getByRole("button", { name: "Apply" }).click();
  await expect(app.settings.getByText("Chats with no new messages for 60 days are deleted when Alpha starts")).toBeVisible();
  await expect(app.settings.getByText(/will be deleted now/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  // (The sidebar is hidden from assistive tech, and so from these queries, while the dialog is open.)
  await expect(app.chatRow("SQL window functions")).toHaveCount(0);
  await expect(app.chatRow("Quarterly report summary")).toBeVisible();

  await page.reload();
  await expect(app.chatRow("Quarterly report summary")).toBeVisible();
  await expect(app.chatRow("SQL window functions")).toHaveCount(0);
  await expect(page.getByText("Chats are saved on this device only, and deleted after 60 days without new messages.")).toBeVisible();
  await app.openSettings("History");
  await expect(retention).toHaveValue("custom");
  await expect(app.settings.getByLabel("Days")).toHaveValue("60");
});

test("delete all history", async ({ app, page }) => {
  await app.ready();
  await app.chatRow("Rust lifetimes in structs").getByRole("button").first().click();
  await app.openSettings("History");
  await expect(app.settings.getByText("4 chats")).toBeVisible();
  await app.settings.getByRole("button", { name: "Delete all chats…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete all 4 chats?" });
  await confirm.getByRole("button", { name: "Delete all" }).click();
  await expect(page.getByText("All chats were deleted.")).toBeVisible();
  await expect(app.settings.getByText("0 chats")).toBeVisible();
  await expect(app.settings.getByRole("button", { name: "Delete all chats…" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await expect(app.sidebar.getByText("Chats you start are saved here, on this device.")).toBeVisible();
  await expect(page.getByText(/Chats are saved on this device only/)).toBeVisible();
  await page.reload();
  await expect(app.sidebar.getByText("Chats you start are saved here, on this device.")).toBeVisible();
});

test("settings that can't be read are reported", async ({ app, page }) => {
  await app.ready("history_broken");
  await app.openSettings("Appearance");
  await expect(app.settings.getByText("Couldn't read or save chat history. Changes here may not be saved.")).toBeVisible();
  await app.settings.getByRole("radio", { name: "Dark" }).click();
  await expect(page.getByText("Couldn't save settings.")).toBeVisible();
});
