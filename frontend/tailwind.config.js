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
          orange: "#E85A3C",
          bright: "#FF6B47",
          soft:   "#F87060",
          pink:   "#FF6B47",
          dark:   "#0A0A0B",
          surface: "#131316",
          card:   "#1A1A1E",
          hover:  "#22222A",
          "accent-dim": "#3A1A14",
        },
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0, 0, 0, 0.18)",
      },
    },
  },
  plugins: [],
};
