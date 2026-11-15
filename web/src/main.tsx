import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { Hud } from "./screens/Hud.tsx";
import { accessKey } from "./lib/key.ts";

accessKey(); // read ?key= once, store it, and strip it from the address bar

const path = location.pathname.replace(/\/+$/, "");
const isHud = path.endsWith("/hud");
// /stage: projector view for the live demo (read-only); loaded on demand so the phone bundle stays small
const isStage = path.endsWith("/stage");
const Stage = lazy(() => import("./screens/Stage.tsx").then((m) => ({ default: m.Stage })));

if (isHud) document.body.classList.add("hud-body");
if (isStage) document.body.classList.add("stage-body");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isHud ? (
      <Hud />
    ) : isStage ? (
      <Suspense fallback={null}>
        <Stage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);

// Service worker: caches the app shell so offline mode still loads. Skipped in dev to avoid stale bundles.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
