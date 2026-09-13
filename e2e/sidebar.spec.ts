import { expect, test } from "./app";

test("search matches titles and message text", async ({ app, page }) => {
  await app.ready();
  const search = page.getByLabel("Search chats");
  await search.fill("host.docker");
  await expect(app.sidebar.locator("li")).toHaveCount(1);
  await expect(app.sidebar.locator("mark").first()).toHaveText("host.docker");

  await search.fill("no such words");
  await expect(app.sidebar.getByText("No chats contain “no such words”.")).toBeVisible();

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(app.sidebar.locator("li")).toHaveCount(4);
});

test("rename, export and delete from a chat's menu", async ({ app, page }) => {
  await app.ready();
  const menu = async (title: string, item: string) => {
    const row = app.chatRow(title);
    await row.hover();
    await row.getByRole("button", { name: `Options for ${title}` }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };

  await menu("SQL window functions", "Rename");
  const input = app.sidebar.getByLabel("Chat title");
  await input.fill("Ranking in SQL");
  await input.press("Enter");
  await expect(app.chatRow("Ranking in SQL")).toBeVisible();

  await menu("Quarterly report summary", "Export as Markdown");
  await expect(page.getByText(/^Exported to .*Quarterly report summary\.md$/)).toBeVisible();
  const markdown = await page.evaluate(() => (window as unknown as { __lastExport: string }).__lastExport);
  expect(markdown).toContain("# Quarterly report summary");
  expect(markdown).toContain("### You\n\nSummarize the attached quarterly numbers.");

  await app.chatRow("Ranking in SQL").getByRole("button").first().click();
  await expect(page.getByText("Explain ROW_NUMBER vs RANK.")).toBeVisible();
  await menu("Ranking in SQL", "Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("“Ranking in SQL” and all its messages will be removed");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(app.chatRow("Ranking in SQL")).toHaveCount(0);
  // The deleted chat was open, so a new one takes its place.
  await expect(page.getByText(/Chats are saved on this device only/)).toBeVisible();

  await page.reload();
  await expect(app.chatRow("Quarterly report summary")).toBeVisible();
  await expect(app.chatRow("Ranking in SQL")).toHaveCount(0);
});

test("empty history and a broken history file", async ({ app, page }) => {
  await app.ready("fresh");
  await expect(app.sidebar.getByText("Chats you start are saved here, on this device.")).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeDisabled();

  await app.ready("history_broken");
  await expect(app.sidebar.getByText("Couldn't read or save chat history.")).toBeVisible();
  await app.composer.fill("hello");
  await app.composer.press("Enter");
  // Nothing was saved, so the message stays in the box.
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't read or save chat history." })).toHaveCount(2);
  await expect(app.composer).toHaveValue("hello");
});
