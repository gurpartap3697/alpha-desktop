import { expect, test } from "./app";

test("new chat, message box, search and settings from the keyboard", async ({ app, page }) => {
  await app.ready();
  await app.chatRow("Rust lifetimes in structs").getByRole("button").first().click();
  await expect(page.getByText("When does a struct need a lifetime parameter?")).toBeVisible();

  await page.getByLabel("Search chats").focus();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByText(/Chats are saved on this device only/)).toBeVisible();
  await expect(app.composer).toBeFocused();

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("Search chats")).toBeFocused();

  await page.keyboard.press("ControlOrMeta+l");
  await expect(app.composer).toBeFocused();

  await page.keyboard.press("ControlOrMeta+,");
  await expect(app.settings).toBeVisible();
  // Shortcuts wait while a dialog is open.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(app.settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(app.settings).toBeHidden();
});

test("Escape stops the answer, but not when it's closing something else", async ({ app, page }) => {
  await app.ready();
  await app.send("/slow take your time");
  await expect(app.stopButton).toBeVisible();

  // Closing a menu doesn't stop the answer.
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(app.stopButton).toBeVisible();

  // Neither does clearing a search.
  const search = page.getByLabel("Search chats");
  await search.fill("rust");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(app.stopButton).toBeVisible();

  // Anywhere else it does.
  await page.locator("main, body").first().click({ position: { x: 600, y: 300 } });
  await page.keyboard.press("Escape");
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
});

test("the shortcuts are listed in settings", async ({ app }) => {
  await app.ready();
  await app.openSettings("Keyboard");
  for (const label of ["New chat", "Go to the message box", "Search chats", "Settings", "Stop the answer"]) {
    await expect(app.settings.getByRole("tabpanel").getByText(label, { exact: true })).toBeVisible();
  }
});
