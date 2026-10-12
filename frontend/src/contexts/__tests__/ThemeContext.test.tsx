import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { THEME_CHROME_COLOR, ThemeProvider, useTheme } from "../ThemeContext";

let api: ReturnType<typeof useTheme>;
function Probe() {
  api = useTheme();
  return null;
}

const chrome = () => document.querySelector('meta[name="theme-color"]')?.getAttribute("content");

describe("ThemeProvider window chrome", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.head.innerHTML = '<meta name="theme-color" content="#E85A3C">';
  });

  it("colours the title bar like the app's top bar and follows a theme change", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(chrome()).toBe(THEME_CHROME_COLOR.dark);
    expect(chrome()).toBe("#131316");

    act(() => api.setThemeMode("light"));
    expect(chrome()).toBe("#ffffff");
    expect(document.documentElement.classList.contains("light")).toBe(true);

    act(() => api.toggle());
    expect(chrome()).toBe("#131316");
  });
});
