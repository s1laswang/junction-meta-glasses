import "./styles/tokens.css";
import "./styles/app.css";
import "./hud/hud.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa/registerSw.ts";

export function shouldRegisterPwaServiceWorker(pathname: string): boolean {
  const normalized = typeof pathname === "string" ? pathname.trim() : "";
  return normalized !== "/hud" && normalized !== "/hud/";
}

if (typeof document !== "undefined") {
  if (typeof window !== "undefined" && shouldRegisterPwaServiceWorker(window.location.pathname)) {
    void registerServiceWorker();
  }

  const rootEl = document.getElementById("root");
  if (rootEl) {
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  }
}
