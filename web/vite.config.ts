import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const API = process.env.HOLDUP_SERVER ?? "http://localhost:8787";
const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // cloudflared quick tunnels use random hostnames
    allowedHosts: true,
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/ingest": { target: API, changeOrigin: true },
      "/live": { target: API, ws: true, changeOrigin: true },
      "/hud-ws": { target: API, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      // two HTML entries so a plain static server can serve /hud/ without SPA fallback
      input: {
        main: resolve(root, "index.html"),
        hud: resolve(root, "hud/index.html"),
      },
    },
  },
});
