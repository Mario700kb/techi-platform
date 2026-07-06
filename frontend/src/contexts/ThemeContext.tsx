import { createContext, useContext, useEffect, useState, ReactNode } from "react";

type EffectiveTheme = "dark" | "light";
type ThemePreference = EffectiveTheme | "system";

interface ThemeContextValue {
  /** Resolved theme (never "system") — every existing consumer keeps working unchanged. */
  theme: EffectiveTheme;
  /** Stored preference, including "system" — Settings (Phase 6) reads this to show the active option. */
  themePreference: ThemePreference;
  /** Existing binary toggle — unchanged semantics, used by the desktop Topbar. */
  toggle: () => void;
  /** New in Phase 6: lets Settings set Dark / Light / System explicitly. */
  setThemeMode: (mode: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  themePreference: "dark",
  toggle: () => {},
  setThemeMode: () => {},
});

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePreference): EffectiveTheme {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "dark";
    const stored = localStorage.getItem("techi.theme");
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "dark";
  });
  const [theme, setTheme] = useState<EffectiveTheme>(() => resolve(themePreference));

  useEffect(() => {
    const root = document.documentElement;
    const effective = resolve(themePreference);
    setTheme(effective);
    root.classList.toggle("dark", effective === "dark");
    root.classList.toggle("light", effective === "light");
    root.style.colorScheme = effective;
    localStorage.setItem("techi.theme", themePreference);
  }, [themePreference]);

  // Track OS changes live while in "system" mode.
  useEffect(() => {
    if (themePreference !== "system" || typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const effective = resolve("system");
      setTheme(effective);
      const root = document.documentElement;
      root.classList.toggle("dark", effective === "dark");
      root.classList.toggle("light", effective === "light");
      root.style.colorScheme = effective;
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [themePreference]);

  const toggle = () => setThemePreference((t) => (resolve(t) === "dark" ? "light" : "dark"));
  const setThemeMode = (mode: ThemePreference) => setThemePreference(mode);

  return (
    <ThemeContext.Provider value={{ theme, themePreference, toggle, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
