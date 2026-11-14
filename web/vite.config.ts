import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const PROFILE_CARDS_RE =
  /ProfileManager|ScheduleChecklistCard|DoseTimelineCard|CaregiverAlertCard|EmergencyMedCard|PharmacyImportModal|LanguageVoiceSupportCard|OfflineReadinessCard|PrivacyFlowCard|ConsentOnboarding|BrailleStickerGuardCard|PilotOnboardingCard|WhyGlassesComparisonCard|CognitiveRoutineCard/;

export function manualChunks(id: string): string | undefined {
  const normalized = id.replaceAll("\0", "").replaceAll("\\", "/");
  if (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/")) {
    return "vendor";
  }
  if (normalized.includes("/web/src/components/") || normalized.startsWith("src/components/")) {
    if (PROFILE_CARDS_RE.test(normalized)) {
      return "cards-profile";
    }
    return "cards";
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
      "/architecture-poster.html": "http://localhost:8787",
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
