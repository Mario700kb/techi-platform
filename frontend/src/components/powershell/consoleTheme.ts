import type { ITheme } from "@xterm/xterm";

/** The administrator console is always a dark terminal, whatever the app theme. */
export const CONSOLE_BG = "#0c0c0e";

export const CONSOLE_THEME: ITheme = {
  background: CONSOLE_BG,
  foreground: "#d4d4d8",
  cursor: "#d4d4d8",
  cursorAccent: CONSOLE_BG,
  selectionBackground: "rgba(110, 168, 254, 0.32)",
  black: "#1c1c21",
  red: "#f2685c",
  green: "#34d399",
  yellow: "#f5b544",
  blue: "#6ea8fe",
  magenta: "#c792ea",
  cyan: "#5ccfe6",
  white: "#d4d4d8",
  brightBlack: "#71717a",
  brightRed: "#ff8a80",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd27d",
  brightBlue: "#9ec5ff",
  brightMagenta: "#ddb6f2",
  brightCyan: "#8be9fd",
  brightWhite: "#fafafa",
};

export const CONSOLE_FONT = '"Geist Mono", "JetBrains Mono", Consolas, "Cascadia Mono", ui-monospace, monospace';

export const CONSOLE_APPEARANCE = {
  theme: CONSOLE_THEME,
  fontFamily: CONSOLE_FONT,
  fontSize: 13,
  lineHeight: 1.35,
  cursorStyle: "block" as const,
};
