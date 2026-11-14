import type { DemoScenarioId, ThemeMode } from "../types.ts";

export type AppSurface = "pwa" | "hud";

export type ResolvedRoute = {
  surface: AppSurface;
  sessionParam: string | null;
  initialTab: "check" | "profile" | "device";
  scenarioParam: DemoScenarioId | null;
  themeParam: ThemeMode | null;
  langParam: string | null;
  rxPayloadUri: string | null;
  hudSpeak: boolean;
};

type AppTab = ResolvedRoute["initialTab"];

const SESSION_PATTERN = /^[\w-]{4,64}$/;
const LANG_PATTERN = /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{4}))?(?:[-_]([a-zA-Z]{2}|[0-9]{3}))?$/;
const HOLDUP_RX_URI_PATTERN = /^holdup:\/\/rx(\/?)\?([^\s#]+)(?:#.*)?$/i;
const STANDARD_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const URLSAFE_BASE64_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_RX_INPUT_LENGTH = 16_384;
const DEFAULT_ORIGIN = "http://localhost:5173";

const TAB_MAP: Record<AppTab, true> = {
  check: true,
  profile: true,
  device: true
};

const SCENARIO_MAP: Record<DemoScenarioId, true> = {
  amlodipine_match: true,
  ibuprofen_nsaid: true,
  blurry_strength: true,
  hazelnut_allergy: true,
  oat_milk_safe: true,
  expired_med: true,
  back_of_box: true
};

const THEME_MAP: Record<ThemeMode, true> = {
  dark: true,
  light: true,
  "high-contrast": true
};

const VALID_TABS = new Set<string>(Object.keys(TAB_MAP));
const VALID_SCENARIOS = new Set<string>(Object.keys(SCENARIO_MAP));
const VALID_THEMES = new Set<string>(Object.keys(THEME_MAP));

function resolveSurface(pathname: string): AppSurface {
  const normalized = typeof pathname === "string" ? pathname.trim() : "";
  return normalized === "/hud" || normalized === "/hud/" ? "hud" : "pwa";
}

function parseSearchParams(search: string): URLSearchParams {
  if (typeof search !== "string" || search.length === 0) {
    return new URLSearchParams();
  }
  const withoutHash = search.split("#")[0] ?? "";
  return new URLSearchParams(withoutHash);
}

function resolveSessionParam(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  return SESSION_PATTERN.test(raw) ? raw : null;
}

function resolveInitialTab(raw: string | null): AppTab {
  if (raw !== null && VALID_TABS.has(raw)) {
    return raw as AppTab;
  }
  return "check";
}

function resolveScenarioParam(raw: string | null): DemoScenarioId | null {
  if (raw !== null && VALID_SCENARIOS.has(raw)) {
    return raw as DemoScenarioId;
  }
  return null;
}

function resolveThemeParam(raw: string | null): ThemeMode | null {
  if (raw !== null && VALID_THEMES.has(raw)) {
    return raw as ThemeMode;
  }
  return null;
}

function resolveLangParam(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 16) {
    return null;
  }
  const match = LANG_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const primary = match[1].toLowerCase();
  const script = match[2]
    ? `${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`
    : "";
  const region = match[3]
    ? match[3].length === 2
      ? match[3].toUpperCase()
      : match[3]
    : "";
  return [primary, script, region].filter(Boolean).join("-");
}

function normalizeBase64Token(rawToken: string): string | null {
  const trimmed = rawToken.trim();
  if (trimmed.length < 4 || trimmed.length > MAX_RX_INPUT_LENGTH) {
    return null;
  }
  const isStandard = STANDARD_BASE64_PATTERN.test(trimmed);
  const isUrlSafe = URLSAFE_BASE64_PATTERN.test(trimmed);
  if (!isStandard && !isUrlSafe) {
    return null;
  }
  if (trimmed.includes("=") && trimmed.length % 4 !== 0) {
    return null;
  }
  const unpadded = trimmed.replace(/=+$/g, "");
  if (unpadded.length < 4 || unpadded.length % 4 === 1) {
    return null;
  }
  return unpadded.replace(/\+/g, "-").replace(/\//g, "_");
}

function extractDataTokenFromParams(params: URLSearchParams): string | null {
  if (params.has("v") && params.get("v") !== "1") {
    return null;
  }
  const allData = params.getAll("data");
  if (allData.length !== 1 || !allData[0]) {
    return null;
  }
  return normalizeBase64Token(allData[0]);
}

function resolveRxPayloadUri(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RX_INPUT_LENGTH) {
    return null;
  }

  const holdupMatch = HOLDUP_RX_URI_PATTERN.exec(trimmed);
  if (holdupMatch) {
    const slash = holdupMatch[1] ?? "";
    const query = holdupMatch[2];
    const params = new URLSearchParams(query);
    const validToken = extractDataTokenFromParams(params);
    if (!validToken) {
      return null;
    }
    return `holdup://rx${slash}?${query}`;
  }

  if (/^https:\/\//i.test(trimmed)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return null;
    }
    if (
      parsedUrl.protocol !== "https:" ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password ||
      !/(?:^|\/)rx\/?$/i.test(parsedUrl.pathname)
    ) {
      return null;
    }
    const validToken = extractDataTokenFromParams(parsedUrl.searchParams);
    return validToken ? `holdup://rx?v=1&data=${validToken}` : null;
  }

  if (trimmed.includes(":")) {
    return null;
  }

  const validToken = normalizeBase64Token(trimmed);
  return validToken ? `holdup://rx?v=1&data=${validToken}` : null;
}

function resolveHudSpeak(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function resolveAppRoute(
  locationLike: { pathname: string; search: string } = typeof window !== "undefined" && window.location
    ? window.location
    : { pathname: "/", search: "" }
): ResolvedRoute {
  const pathname = typeof locationLike?.pathname === "string" ? locationLike.pathname : "/";
  const search = typeof locationLike?.search === "string" ? locationLike.search : "";
  const params = parseSearchParams(search);

  return {
    surface: resolveSurface(pathname),
    sessionParam: resolveSessionParam(params.get("session")),
    initialTab: resolveInitialTab(params.get("tab")),
    scenarioParam: resolveScenarioParam(params.get("scenario")),
    themeParam: resolveThemeParam(params.get("theme")),
    langParam: resolveLangParam(params.get("lang")),
    rxPayloadUri: resolveRxPayloadUri(params.get("rx")),
    hudSpeak: resolveHudSpeak(params.get("speak"))
  };
}

export function buildScenarioShareUrl(origin: string, scenario: DemoScenarioId): string {
  if (!VALID_SCENARIOS.has(scenario)) {
    throw new Error(`Unknown demo scenario: ${String(scenario)}`);
  }

  const fallbackOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : DEFAULT_ORIGIN;
  const rawOrigin =
    typeof origin === "string" && origin.trim().length > 0 ? origin.trim() : fallbackOrigin;

  const parsedOrigin = new URL(rawOrigin);
  if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
    throw new Error(`Unsupported share URL protocol: ${parsedOrigin.protocol}`);
  }

  const shareUrl = new URL("/", parsedOrigin.origin);
  shareUrl.searchParams.set("scenario", scenario);
  return shareUrl.toString();
}
