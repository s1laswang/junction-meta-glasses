export function normalizeServerOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function buildBridgeDeepLink(serverOrigin: string, sessionId?: string): string {
  const normalizedOrigin = normalizeServerOrigin(serverOrigin);
  const cleanSession = sessionId !== undefined ? sessionId.trim() : "";
  const base = `holdupbridge://connect?server=${encodeURIComponent(normalizedOrigin)}`;
  if (cleanSession.length > 0) {
    return `${base}&session=${encodeURIComponent(cleanSession)}`;
  }
  return base;
}

export function buildHudUrl(serverOrigin: string, sessionId?: string): string {
  const normalizedOrigin = normalizeServerOrigin(serverOrigin);
  const cleanSession = sessionId !== undefined ? sessionId.trim() : "";
  if (cleanSession.length > 0) {
    return `${normalizedOrigin}/hud?session=${encodeURIComponent(cleanSession)}`;
  }
  return `${normalizedOrigin}/hud`;
}

export function buildMetaWebAppDeepLink(hudUrl: string, appName = "HoldUp"): string {
  const normalizedHudUrl = hudUrl.trim();
  const normalizedAppName = appName.trim() || "HoldUp";
  return `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent(normalizedAppName)}&appUrl=${encodeURIComponent(normalizedHudUrl)}`;
}
