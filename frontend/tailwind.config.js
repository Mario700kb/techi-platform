export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        techi: {
          orange: "#FF6A16",
          pink: "#FF4F8B",
          dark: "#0B0F1C",
          surface: "#141C2D",
        },
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0, 0, 0, 0.12)",
      },
    },
  },
  plugins: [],
};
