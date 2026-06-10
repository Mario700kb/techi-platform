import { defineConfig, loadEnv, Plugin } from "vite";
import react from "@vitejs/plugin-react";

function requireProductionEnv(): Plugin {
  return {
    name: "require-production-env",
    config(_, { mode }) {
      if (mode !== "production") return;
      const env = loadEnv(mode, process.cwd(), "VITE_");
      const url = env.VITE_API_BASE_URL ?? "";
      if (!url || /localhost|127\.0\.0\.1/.test(url)) {
        throw new Error(
          "\n\n❌  VITE_API_BASE_URL is missing or points to localhost.\n" +
          "    Production builds must set this to the real API domain.\n" +
          "    Create frontend/.env.production with:\n" +
          "      VITE_API_BASE_URL=https://api-rdp.techi.com.al\n" +
          "      VITE_WS_BASE_URL=wss://api-rdp.techi.com.al\n"
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [requireProductionEnv(), react()],
  build: {
    rollupOptions: {
      output: {
        // Keep a deployment namespace in asset URLs so a poisoned upstream
        // cache entry cannot survive a frontend image replacement.
        assetFileNames: "assets/[name]-v2-[hash][extname]",
        chunkFileNames: "assets/[name]-v2-[hash].js",
        entryFileNames: "assets/[name]-v2-[hash].js",
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
