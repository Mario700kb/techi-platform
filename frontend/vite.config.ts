import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
