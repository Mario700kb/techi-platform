// The screen an operator lands on after signing in, chosen in Settings and
// kept per browser.
const DEFAULT_SCREEN_KEY = "techi.preferences.defaultScreen";

export type DefaultScreen = "/" | "/devices" | "/alerts";

export function getPreferredDefaultScreen(): DefaultScreen {
  try {
    const stored = window.localStorage.getItem(DEFAULT_SCREEN_KEY);
    return stored === "/devices" || stored === "/alerts" ? stored : "/";
  } catch {
    return "/";
  }
}

export function setPreferredDefaultScreen(screen: DefaultScreen): void {
  try {
    window.localStorage.setItem(DEFAULT_SCREEN_KEY, screen);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
