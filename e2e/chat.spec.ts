import { expect, test } from "./app";

test("an answer streams, the chat gets a title, and it's still there after a restart", async ({ app, page }) => {
  const errors = await app.ready();
  await app.send("How do I parse JSON in Rust with serde?");
  // Saved straight away, under a provisional title.
  await expect(app.chatRow("How do I parse JSON in Rust with serde?")).toBeVisible();
  await app.waitForAnswer();
  await expect(app.turns.last()).toContainText("short tour");
  await expect(app.sidebar.locator("li").first()).toContainText("Parse JSON Rust With");

  await page.reload();
  await app.chatRow("Parse JSON Rust With").getByRole("button").first().click();
  await expect(app.turns).toHaveCount(1);
  await expect(app.turns.first()).toContainText("How do I parse JSON in Rust with serde?");
  expect(errors).toEqual([]);
});

test("stop, edit and resend, regenerate", async ({ app, page }) => {
  await app.ready();
  await app.send("first question");
  await app.waitForAnswer();

  await app.send("/slow second question");
  await expect(app.stopButton).toBeVisible();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape"); // focus is still in the message box
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(app.sendButton).toBeVisible();

  // Edit the stopped exchange's question.
  const second = app.turns.nth(1);
  await second.hover();
  await second.getByRole("button", { name: "Edit message" }).click();
  const editor = page.locator("textarea[id^=edit-]");
  await expect(page.getByText("Sending replaces the answer.")).toBeVisible();
  await editor.fill("second question, edited");
  await editor.press("Enter");
  await app.waitForAnswer();
  await expect(app.turns).toHaveCount(2);
  await expect(page.getByText("Stopped", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(app.stopButton).toBeVisible();
  await app.waitForAnswer();
  await expect(app.turns).toHaveCount(2);

  // Editing the first question removes everything after it.
  const first = app.turns.first();
  await first.hover();
  await first.getByRole("button", { name: "Edit message" }).click();
  await expect(page.getByText("Sending replaces the answer and removes the 2 messages after it.")).toBeVisible();
  await editor.fill("a new first question");
  await editor.press("Enter");
  await app.waitForAnswer();
  await expect(app.turns).toHaveCount(1);
});

test("an answer cut off by closing the app is marked as interrupted", async ({ app, page }) => {
  await app.ready();
  await app.send("/slow a long answer");
  await expect(app.turns.last()).toContainText("Here's", { timeout: 15_000 });
  // Long enough for a periodic save to include some of the answer.
  await page.waitForTimeout(1500);
  await page.reload();
  await app.chatRow("/slow a long answer").getByRole("button").first().click();
  await expect(page.getByText("Alpha was closed before the answer finished. What arrived is kept above.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
});

test("errors from the model server explain what to do", async ({ app, page }) => {
  await app.ready();
  await app.send("/error 429");
  await expect(page.getByText(/Too many requests. You can retry in \ds\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled();

  await app.page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await app.send("/error 404");
  await expect(page.getByText("Qwen isn't available right now. Try another model.")).toBeVisible();
  // Retries the same question with the other model (the mock server fails this one for every model).
  await page.getByRole("button", { name: "Ask Gemma" }).click();
  await expect(page.getByText("Gemma isn't available right now. Try another model.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Model:/ })).toHaveText("Gemma");
  await expect(app.turns).toHaveCount(1);
});

test("the model server being unreachable shows a banner that retries", async ({ app, page }) => {
  await app.open("unreachable");
  await expect(page.getByText("Can't reach the model server. Are you on VPN?")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(app.composer).toBeEnabled();
  await expect(page.getByText("Can't reach the model server. Are you on VPN?")).toBeHidden();
});
