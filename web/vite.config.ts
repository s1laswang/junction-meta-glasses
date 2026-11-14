import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function manualChunks(id: string): string | undefined {
  const normalized = id.replaceAll("\0", "").replaceAll("\\", "/");
  if (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/")) {
    return "vendor";
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ingest": "http://localhost:8787",
      "/deck": "http://localhost:8787",
      "/printable-props.html": "http://localhost:8787",
      "/judge-handout.html": "http://localhost:8787",
      "/live": { target: "ws://localhost:8787", ws: true },
      "/hud-ws": { target: "ws://localhost:8787", ws: true }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  }
});
