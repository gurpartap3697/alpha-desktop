import { expect, test as base, type Page } from "@playwright/test";

/** Page helpers shared by the specs. Each test gets a fresh browser context, so mock history starts seeded. */
export class App {
  constructor(readonly page: Page) {}

  async open(scenario?: string) {
    const errors: string[] = [];
    this.page.on("pageerror", (e) => errors.push(String(e)));
    await this.page.goto(scenario ? `/?scenario=${scenario}` : "/");
    return errors;
  }

  /** Open the app with models loaded and the composer ready. */
  async ready(scenario?: string) {
    const errors = await this.open(scenario);
    await expect(this.composer).toBeEnabled();
    return errors;
  }

  get composer() {
    return this.page.locator("#composer");
  }

  get sidebar() {
    return this.page.getByRole("complementary", { name: "Chats" });
  }

  get settings() {
    return this.page.getByRole("dialog", { name: "Settings" });
  }

  get sendButton() {
    return this.page.getByRole("button", { name: "Send", exact: true });
  }

  get stopButton() {
    return this.page.getByRole("button", { name: "Stop", exact: true });
  }

  /** One per question in the open chat. */
  get turns() {
    return this.page.locator("section");
  }

  chatRow(title: string | RegExp) {
    return this.sidebar.locator("li").filter({ hasText: title });
  }

  async send(text: string) {
    await this.composer.fill(text);
    await this.composer.press("Enter");
    // Cleared once sent; an answer that fails fast may never show the Stop button.
    await expect(this.composer).toHaveValue("");
    await expect(this.turns.last()).toContainText(text.split("\n")[0]);
  }

  async waitForAnswer() {
    await expect(this.sendButton).toBeVisible({ timeout: 20_000 });
  }

  async openSettings(section?: string) {
    await this.page.locator("header").getByRole("button", { name: "Settings", exact: true }).click();
    await expect(this.settings).toBeVisible();
    if (section) await this.settings.getByRole("tab", { name: section }).click();
  }
}

export const test = base.extend<{ app: App }>({
  app: async ({ page }, use) => {
    await use(new App(page));
  },
});

export { expect };
