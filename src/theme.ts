import type { Theme } from "./api";

// The theme is saved in the database, which is read after the first paint. A copy in localStorage
// lets the page start in the right colors.
const KEY = "alpha.theme";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Only the startup colors are affected.
  }
}

export function applySavedTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch {
    // Follow the OS until settings load.
  }
}
