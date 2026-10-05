// Friday palette: every colour utility resolves to a --th-* token from
// src/index.css, so dark and light both follow the palette without per-class
// overrides. Tailwind's own hue names are kept as aliases so existing classes
// (`text-emerald-300`, `bg-red-500/10`, …) keep working.

// Wraps a CSS colour so Tailwind opacity modifiers (`/10`, `/[0.04]`) work.
const alpha = (color) =>
  `color-mix(in srgb, ${color} calc(<alpha-value> * 100%), transparent)`;
const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

// One semantic tone → a full 50–950 scale. Low shades lean toward the
// primary text colour (lighter in dark, darker in light), high shades sink
// into the page background, so contrast intent is kept in both themes.
const scale = (token) => {
  const t = `var(${token})`;
  const ink = "var(--th-text-primary)";
  const page = "var(--th-bg-page)";
  return {
    50: alpha(mix(t, 12, ink)),
    100: alpha(mix(t, 25, ink)),
    200: alpha(mix(t, 45, ink)),
    300: alpha(mix(t, 70, ink)),
    400: alpha(t),
    500: alpha(t),
    600: alpha(mix(t, 85, page)),
    700: alpha(mix(t, 65, page)),
    800: alpha(mix(t, 45, page)),
    900: alpha(mix(t, 30, page)),
    950: alpha(mix(t, 18, page)),
  };
};

// Friday neutrals (no slate-blue tint): text ramp on the low end, surfaces on
// the high end.
const neutral = {
  50: alpha("var(--th-text-primary)"),
  100: alpha("var(--th-text-primary)"),
  200: alpha(mix("var(--th-text-primary)", 60, "var(--th-text-secondary)")),
  300: alpha("var(--th-text-secondary)"),
  400: alpha("var(--th-text-muted)"),
  500: alpha(mix("var(--th-text-muted)", 55, "var(--th-text-faint)")),
  600: alpha("var(--th-text-faint)"),
  700: alpha("var(--th-ring-track)"),
  800: alpha("var(--th-bg-card-hover)"),
  900: alpha("var(--th-bg-card)"),
  950: alpha("var(--th-bg-page)"),
};

const critical = scale("--th-status-critical");
const warning = scale("--th-status-warning");
const online = scale("--th-status-online");
const info = scale("--th-status-info");
const maint = scale("--th-status-maint");
const agent = scale("--th-status-agent");
const accent = scale("--th-accent");
const rose = scale("--th-series-rose");

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        techi: {
          orange: alpha("var(--th-accent)"),
          bright: alpha("var(--th-accent-bright)"),
          soft: alpha("var(--th-accent-soft)"),
          pink: alpha("var(--th-accent-bright)"),
          dark: alpha("var(--th-bg-page)"),
          surface: alpha("var(--th-bg-surface)"),
          card: alpha("var(--th-bg-card)"),
          hover: alpha("var(--th-bg-card-hover)"),
          "accent-dim": alpha("var(--th-accent-dim-bg)"),
        },
        status: {
          online: alpha("var(--th-status-online)"),
          stale: alpha("var(--th-status-stale)"),
          offline: alpha("var(--th-status-offline)"),
          critical: alpha("var(--th-status-critical)"),
          warning: alpha("var(--th-status-warning)"),
          info: alpha("var(--th-status-info)"),
          maint: alpha("var(--th-status-maint)"),
          agent: alpha("var(--th-status-agent)"),
        },
        red: critical,
        rose: critical,
        orange: accent,
        amber: warning,
        yellow: warning,
        lime: online,
        green: online,
        emerald: online,
        teal: maint,
        cyan: maint,
        sky: info,
        blue: info,
        indigo: info,
        violet: agent,
        purple: agent,
        fuchsia: rose,
        pink: rose,
        slate: neutral,
        gray: neutral,
        zinc: neutral,
        neutral,
        stone: neutral,
      },
      ringColor: {
        DEFAULT: "color-mix(in srgb, var(--th-accent) 50%, transparent)",
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0, 0, 0, 0.18)",
      },
    },
  },
  plugins: [],
};
