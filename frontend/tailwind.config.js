export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        techi: {
          orange: "#FF553F",
          pink: "#FF3F32",
          dark: "#050505",
          surface: "#111010",
        },
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0, 0, 0, 0.12)",
      },
    },
  },
  plugins: [],
};
