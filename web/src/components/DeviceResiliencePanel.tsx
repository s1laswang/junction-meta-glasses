import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CameraSource, ChaosConfig, SessionSnapshot } from "../types.ts";

export type DeviceResiliencePanelProps = {
  snapshot: SessionSnapshot;
  chaos: ChaosConfig;
  onChangeChaos: (next: ChaosConfig) => void;
  serverOrigin: string;
  bridgeQrSvg?: string;
  hudQrSvg?: string;
  bridgeLink?: string;
  hudUrl?: string;
};

type Tone = "ok" | "warn" | "danger" | "neutral";
type ChaosKey = keyof ChaosConfig;
type CopyTarget = "session" | "hud" | "bridge";

type FaultSpec = {
  key: ChaosKey;
  title: string;
  reaction: string;
};

type TelemetryTile = {
  id: string;
  label: string;
  value: string;
  subvalue: string;
  tone: Tone;
};

const FAULT_SPECS: readonly FaultSpec[] = [
  {
    key: "forceWsDrop",
    title: "Simulate Live WS Drop",
    reaction: "Switches seamlessly to HTTP Snapshot + TTS mode"
  },
  {
    key: "forceOffline",
    title: "Simulate Complete Offline",
    reaction: "Switches to local on-device Barcode Match mode"
  },
  {
    key: "simulateGlassesDoffed",
    title: "Simulate Glasses Taken Off (Doffed)",
    reaction: "Announces state change and falls back to phone camera"
  },
  {
    key: "simulateLowBattery",
    title: "Simulate Glasses Low Battery (<10%)",
    reaction: "Warns wearer and falls back to phone camera"
  }
];

const TONE_BADGE_STYLES: Record<Tone, CSSProperties> = {
  ok: {
    backgroundColor: "var(--verdict-match-bg, #064e3b)",
    color: "var(--verdict-match-fg, #ecfdf5)",
    border: "var(--border-width, 1.5px) solid var(--verdict-match-border, #34d399)"
  },
  warn: {
    backgroundColor: "var(--verdict-unsure-bg, #78350f)",
    color: "var(--verdict-unsure-fg, #fffbeb)",
    border: "var(--border-width, 1.5px) solid var(--verdict-unsure-border, #fbbf24)"
  },
  danger: {
    backgroundColor: "var(--verdict-warning-bg, #7f1d1d)",
    color: "var(--verdict-warning-fg, #fef2f2)",
    border: "var(--border-width, 1.5px) solid var(--verdict-warning-border, #f87171)"
  },
  neutral: {
    backgroundColor: "var(--bg-elevated, #1e293b)",
    color: "var(--text-primary, #f1f5f9)",
    border: "var(--border-width, 1.5px) solid var(--border-strong, #64748b)"
  }
};

const TONE_DOT_COLORS: Record<Tone, string> = {
  ok: "var(--verdict-match-border, #34d399)",
  warn: "var(--verdict-unsure-border, #fbbf24)",
  danger: "var(--verdict-warning-border, #f87171)",
  neutral: "var(--border-strong, #94a3b8)"
};

function formatTransportMode(mode: SessionSnapshot["mode"]): string {
  if (mode === "live") return "LIVE";
  if (mode === "snapshot") return "SNAPSHOT";
  return "OFFLINE";
}

function getTransportTone(mode: SessionSnapshot["mode"]): Tone {
  if (mode === "live") return "ok";
  if (mode === "snapshot") return "warn";
  return "danger";
}

function getLiveSocketTone(state: SessionSnapshot["liveState"]): Tone {
  if (state === "open") return "ok";
  if (state === "connecting" || state === "reconnecting" || state === "degraded") return "warn";
  return "neutral";
}

function formatCameraEye(source: CameraSource): string {
  if (source === "glasses") return "Glasses DAT";
  if (source === "demo") return "Demo Prop";
  return "Phone Camera";
}

function toSvgDataUri(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:image/")) {
    return trimmed;
  }
  const normalized =
    trimmed.startsWith("<svg") && !trimmed.includes("xmlns=")
      ? trimmed.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')
      : trimmed;
  return `data:image/svg+xml;utf8,${encodeURIComponent(normalized)}`;
}

async function writeClipboardText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      void 0;
    }
  }
  if (typeof document !== "undefined") {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }
  return false;
}

export function DeviceResiliencePanel(props: DeviceResiliencePanelProps) {
  const {
    snapshot,
    chaos,
    onChangeChaos,
    serverOrigin,
    bridgeQrSvg,
    hudQrSvg,
    bridgeLink,
    hudUrl
  } = props;

  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (target: CopyTarget, value: string) => {
    const copied = await writeClipboardText(value);
    if (!copied) return;
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
    }
    setCopiedTarget(target);
    copyTimerRef.current = setTimeout(() => {
      setCopiedTarget(null);
      copyTimerRef.current = null;
    }, 2000);
  };

  const fallbackOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost:8787";
  const normalizedOrigin = (serverOrigin.trim() || fallbackOrigin).replace(/\/+$/, "");

  const resolvedHudUrl =
    hudUrl && hudUrl.trim().length > 0
      ? hudUrl.trim()
      : `${normalizedOrigin}/hud?session=${encodeURIComponent(snapshot.sessionId)}`;

  const resolvedBridgeLink =
    bridgeLink && bridgeLink.trim().length > 0
      ? bridgeLink.trim()
      : `holdupbridge://connect?server=${encodeURIComponent(normalizedOrigin)}&session=${encodeURIComponent(snapshot.sessionId)}`;

  const activeFaultCount = FAULT_SPECS.reduce(
    (count, spec) => (chaos[spec.key] ? count + 1 : count),
    0
  );
  const anyFaultActive = activeFaultCount > 0;

  const toggleFault = (key: ChaosKey) => {
    onChangeChaos({
      ...chaos,
      [key]: !chaos[key]
    });
  };

  const resetAllFaults = () => {
    onChangeChaos({
      forceWsDrop: false,
      forceOffline: false,
      simulateGlassesDoffed: false,
      simulateLowBattery: false
    });
  };

  const activeModelText = snapshot.activeModel ?? "standby";
  const rttValue = snapshot.network.online
    ? snapshot.network.rttMs !== null
      ? `${snapshot.network.rttMs} ms`
      : "measuring"
    : "offline";

  const jpegPercent =
    snapshot.network.jpegQuality <= 1
      ? Math.round(snapshot.network.jpegQuality * 100)
      : Math.round(snapshot.network.jpegQuality);
  const adaptiveStreamValue = `${snapshot.network.targetFps} fps @ ${jpegPercent}% JPEG`;

  const glassesBatteryText =
    snapshot.device.battery !== null ? `${snapshot.device.battery}%` : "N/A";
  const glassesWornText = snapshot.device.worn ? "Worn" : "Doffed";
  const glassesConnText = snapshot.device.connected ? "Connected" : "Disconnected";
  const glassesValue = `${glassesConnText} / ${glassesWornText} / ${glassesBatteryText}`;

  const glassesTone: Tone = !snapshot.device.connected
    ? "neutral"
    : snapshot.device.battery !== null && snapshot.device.battery < 10
      ? "danger"
      : !snapshot.device.worn
        ? "warn"
        : "ok";

  const rttTone: Tone = !snapshot.network.online
    ? "danger"
    : snapshot.network.rttMs === null || snapshot.network.rttMs > 600
      ? "warn"
      : "ok";

  const permissionsTone: Tone =
    snapshot.permissions.camera === "denied" || snapshot.permissions.microphone === "denied"
      ? "danger"
      : snapshot.permissions.camera === "granted" && snapshot.permissions.microphone === "granted"
        ? "ok"
        : "neutral";

  const telemetryTiles: TelemetryTile[] = [
    {
      id: "transport-mode",
      label: "Transport Mode",
      value: formatTransportMode(snapshot.mode),
      subvalue:
        snapshot.mode === "live"
          ? "Bidirectional Gemini Live stream"
          : snapshot.mode === "snapshot"
            ? "HTTP /api/verify + TTS fallback"
            : "On-device BarcodeDetector match",
      tone: getTransportTone(snapshot.mode)
    },
    {
      id: "live-socket",
      label: "Live Socket",
      value: `${snapshot.liveState} (${activeModelText})`,
      subvalue: snapshot.checking
        ? `Model: ${activeModelText} - verifying label`
        : `Active Gemini model: ${activeModelText}`,
      tone: getLiveSocketTone(snapshot.liveState)
    },
    {
      id: "camera-eye",
      label: "Camera Eye",
      value: formatCameraEye(snapshot.device.source),
      subvalue: snapshot.cameraActive
        ? snapshot.autoStopRemainingSec !== null
          ? `Active check (${snapshot.autoStopRemainingSec}s auto-stop)`
          : "Active check streaming"
        : "Camera idle (privacy-safe)",
      tone: snapshot.device.source === "glasses" ? "ok" : "neutral"
    },
    {
      id: "network-rtt",
      label: "Network RTT",
      value: rttValue,
      subvalue: snapshot.network.online
        ? "Live WebSocket ping-pong telemetry"
        : "Network unreachable - local mode",
      tone: rttTone
    },
    {
      id: "adaptive-stream",
      label: "Adaptive Stream",
      value: adaptiveStreamValue,
      subvalue: "Auto-tuned frame rate and compression",
      tone: snapshot.network.online ? "ok" : "neutral"
    },
    {
      id: "rayban-glasses",
      label: "Ray-Ban Glasses",
      value: glassesValue,
      subvalue: snapshot.device.streaming
        ? "DAT camera frames streaming"
        : snapshot.device.connected
          ? "Bluetooth audio ready, DAT idle"
          : "Phone camera active as eye",
      tone: glassesTone
    },
    {
      id: "rayban-hud",
      label: "Ray-Ban Display HUD",
      value: snapshot.hudConnected ? "Connected (/hud)" : "Waiting (/hud)",
      subvalue: snapshot.hudConnected
        ? "600x600 in-lens card synced"
        : "Open /hud for side-by-side display",
      tone: snapshot.hudConnected ? "ok" : "warn"
    },
    {
      id: "mic-permissions",
      label: "Mic & Camera Access",
      value: `Mic: ${snapshot.permissions.microphone} / Cam: ${snapshot.permissions.camera}`,
      subvalue:
        snapshot.permissions.camera === "denied" || snapshot.permissions.microphone === "denied"
          ? "Permission recovery flow enabled"
          : "In-context consent verified",
      tone: permissionsTone
    }
  ];

  const panelStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5, 20px)",
    padding: "var(--space-5, 20px)",
    borderRadius: "var(--radius-lg, 18px)",
    border: "var(--border-width, 1.5px) solid var(--border-subtle, color-mix(in srgb, currentColor 22%, transparent))",
    backgroundColor: "var(--bg-surface, color-mix(in srgb, currentColor 4%, transparent))",
    color: "var(--text-primary, inherit)"
  };

  const sectionCardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3, 12px)",
    padding: "var(--space-4, 16px)",
    borderRadius: "var(--radius-md, 12px)",
    border: "var(--border-width, 1.5px) solid var(--border-subtle, color-mix(in srgb, currentColor 18%, transparent))",
    backgroundColor: "var(--bg-elevated, color-mix(in srgb, currentColor 4%, transparent))"
  };

  const actionButtonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "56px",
    padding: "10px 16px",
    borderRadius: "var(--radius-md, 12px)",
    border: "var(--border-width, 1.5px) solid var(--border-strong, color-mix(in srgb, currentColor 32%, transparent))",
    backgroundColor: "var(--bg-surface, color-mix(in srgb, currentColor 8%, transparent))",
    color: "var(--text-primary, inherit)",
    fontSize: "var(--text-sm, 0.95rem)",
    fontWeight: 700,
    textDecoration: "none",
    cursor: "pointer"
  };

  return (
    <section
      aria-labelledby="device-resilience-panel-title"
      className="card device-resilience-panel"
      style={panelStyle}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px"
        }}
      >
        <div>
          <h2
            id="device-resilience-panel-title"
            style={{ margin: 0, fontSize: "1.25rem", lineHeight: 1.3 }}
          >
            Device State Telemetry &amp; Resilience Simulator
          </h2>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.92rem", opacity: 0.85 }}>
            Real-time glasses, network, and Gemini state with interactive fault injection for judges.
          </p>
        </div>
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px",
            borderRadius: "999px",
            fontSize: "0.85rem",
            fontWeight: 700,
            ...(anyFaultActive ? TONE_BADGE_STYLES.danger : TONE_BADGE_STYLES.ok)
          }}
        >
          <span>
            {anyFaultActive
              ? `${activeFaultCount} Fault${activeFaultCount === 1 ? "" : "s"} Simulated`
              : "Nominal Telemetry"}
          </span>
        </div>
      </header>

      {snapshot.lastError ? (
        <div
          role="alert"
          style={{
            padding: "12px 14px",
            borderRadius: "10px",
            fontSize: "0.92rem",
            ...TONE_BADGE_STYLES.danger
          }}
        >
          <strong>Last Error ({snapshot.lastError.code}):</strong> {snapshot.lastError.message}{" "}
          <span>
            ({snapshot.lastError.recoverable ? "recoverable fallback active" : "manual action needed"})
          </span>
        </div>
      ) : null}

      <div role="group" aria-labelledby="telemetry-grid-title" style={sectionCardStyle}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px"
          }}
        >
          <h3 id="telemetry-grid-title" style={{ margin: 0, fontSize: "1.05rem" }}>
            Live System Telemetry
          </h3>
          <span style={{ fontSize: "0.82rem", opacity: 0.8, fontFamily: "monospace" }}>
            Origin: {normalizedOrigin}
          </span>
        </div>

        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "10px"
          }}
        >
          {telemetryTiles.map((tile) => (
            <div
              key={tile.id}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "6px",
                padding: "12px",
                borderRadius: "10px",
                border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
                backgroundColor: "color-mix(in srgb, currentColor 5%, transparent)"
              }}
            >
              <dt
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  fontSize: "0.8rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  opacity: 0.85
                }}
              >
                <span>{tile.label}</span>
                <span
                  aria-hidden="true"
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "999px",
                    backgroundColor: TONE_DOT_COLORS[tile.tone],
                    flexShrink: 0
                  }}
                />
              </dt>
              <dd style={{ margin: 0 }}>
                <div
                  style={{
                    fontSize: "1rem",
                    fontWeight: 700,
                    lineHeight: 1.3,
                    wordBreak: "break-word"
                  }}
                >
                  {tile.value}
                </div>
                <div style={{ marginTop: "4px", fontSize: "0.82rem", opacity: 0.82, lineHeight: 1.3 }}>
                  {tile.subvalue}
                </div>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div role="group" aria-labelledby="resilience-simulator-title" style={sectionCardStyle}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px"
          }}
        >
          <div>
            <h3 id="resilience-simulator-title" style={{ margin: 0, fontSize: "1.05rem" }}>
              Interactive Resilience Simulator (Judge Demo Controls)
            </h3>
            <p style={{ margin: "4px 0 0 0", fontSize: "0.88rem", opacity: 0.85 }}>
              Toggle faults live to test graceful fallback across network drops, offline mode, and glasses states.
            </p>
          </div>
          {anyFaultActive ? (
            <button
              type="button"
              onClick={resetAllFaults}
              style={{
                minHeight: "56px",
                padding: "10px 18px",
                borderRadius: "10px",
                fontWeight: 700,
                fontSize: "0.95rem",
                cursor: "pointer",
                ...TONE_BADGE_STYLES.warn
              }}
            >
              Reset All Faults
            </button>
          ) : null}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "12px"
          }}
        >
          {FAULT_SPECS.map((spec) => {
            const active = chaos[spec.key];
            return (
              <button
                key={spec.key}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFault(spec.key)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  justifyContent: "space-between",
                  gap: "8px",
                  minHeight: "56px",
                  padding: "12px 14px",
                  borderRadius: "12px",
                  textAlign: "left",
                  cursor: "pointer",
                  ...(active
                    ? {
                        backgroundColor: "#7f1d1d",
                        color: "#ffffff",
                        border: "2px solid #f87171"
                      }
                    : {
                        backgroundColor: "color-mix(in srgb, currentColor 6%, transparent)",
                        color: "inherit",
                        border: "2px solid color-mix(in srgb, currentColor 24%, transparent)"
                      })
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "10px",
                    width: "100%",
                    fontWeight: 700,
                    fontSize: "0.96rem",
                    lineHeight: 1.3
                  }}
                >
                  <span>{spec.title}</span>
                  <span
                    style={{
                      padding: "3px 8px",
                      borderRadius: "999px",
                      fontSize: "0.75rem",
                      fontWeight: 800,
                      letterSpacing: "0.04em",
                      flexShrink: 0,
                      ...(active
                        ? {
                            backgroundColor: "#fef2f2",
                            color: "#7f1d1d"
                          }
                        : {
                            backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
                            color: "inherit"
                          })
                    }}
                  >
                    {active ? "ACTIVE" : "OFF"}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: "0.86rem",
                    lineHeight: 1.35,
                    opacity: active ? 0.96 : 0.85
                  }}
                >
                  {spec.reaction}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div role="group" aria-labelledby="hardware-pairing-title" style={sectionCardStyle}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px"
          }}
        >
          <div>
            <h3 id="hardware-pairing-title" style={{ margin: 0, fontSize: "1.05rem" }}>
              Hardware Pairing (Android DAT Bridge + Ray-Ban Display /hud)
            </h3>
            <p style={{ margin: "4px 0 0 0", fontSize: "0.88rem", opacity: 0.85 }}>
              Pair the first-person DAT camera bridge or open the 600x600 Ray-Ban Display HUD side-by-side.
            </p>
          </div>
          <div
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 12px",
                borderRadius: "10px",
                fontFamily: "monospace",
                fontSize: "0.9rem",
                fontWeight: 700,
                ...TONE_BADGE_STYLES.neutral
              }}
            >
              <span>Session:</span>
              <code>{snapshot.sessionId}</code>
            </span>
            <button
              type="button"
              onClick={() => void handleCopy("session", snapshot.sessionId)}
              style={actionButtonStyle}
            >
              {copiedTarget === "session" ? "Copied Session ID" : "Copy Session ID"}
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "14px"
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: "12px",
              padding: "14px",
              borderRadius: "10px",
              border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
              backgroundColor: "color-mix(in srgb, currentColor 5%, transparent)"
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <strong style={{ fontSize: "0.98rem" }}>Ray-Ban Display HUD (/hud)</strong>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    ...(snapshot.hudConnected ? TONE_BADGE_STYLES.ok : TONE_BADGE_STYLES.warn)
                  }}
                >
                  {snapshot.hudConnected ? "Connected" : "Waiting"}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.85, lineHeight: 1.35 }}>
                Opens the 600x600 additive-light HUD in a new tab so laptop judges can inspect verdicts live alongside the phone app.
              </p>
              <a
                href={resolvedHudUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
                  backgroundColor: "color-mix(in srgb, currentColor 6%, transparent)",
                  color: "inherit",
                  fontFamily: "monospace",
                  fontSize: "0.82rem",
                  wordBreak: "break-all"
                }}
              >
                {resolvedHudUrl}
              </a>
            </div>

            {hudQrSvg && hudQrSvg.trim().length > 0 ? (
              <div
                style={{
                  alignSelf: "flex-start",
                  padding: "10px",
                  borderRadius: "10px",
                  backgroundColor: "#ffffff",
                  border: "1px solid #cbd5e1"
                }}
              >
                <img
                  src={toSvgDataUri(hudQrSvg)}
                  alt="QR code to open the Ray-Ban Display HUD"
                  width={148}
                  height={148}
                  style={{ display: "block", width: "148px", height: "148px" }}
                />
              </div>
            ) : null}

            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <a
                href={resolvedHudUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...actionButtonStyle,
                  ...TONE_BADGE_STYLES.ok
                }}
              >
                Open /hud in New Tab
              </a>
              <button
                type="button"
                onClick={() => void handleCopy("hud", resolvedHudUrl)}
                style={actionButtonStyle}
              >
                {copiedTarget === "hud" ? "Copied HUD URL" : "Copy HUD URL"}
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: "12px",
              padding: "14px",
              borderRadius: "10px",
              border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
              backgroundColor: "color-mix(in srgb, currentColor 5%, transparent)"
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <strong style={{ fontSize: "0.98rem" }}>Android DAT Bridge</strong>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    ...(snapshot.device.connected ? TONE_BADGE_STYLES.ok : TONE_BADGE_STYLES.neutral)
                  }}
                >
                  {snapshot.device.connected ? "Glasses Linked" : "Standby"}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.85, lineHeight: 1.35 }}>
                Deep-links the HoldUp Bridge Android app with the active server URL and session ID for Ray-Ban DAT camera streaming.
              </p>
              <a
                href={resolvedBridgeLink}
                style={{
                  display: "block",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
                  backgroundColor: "color-mix(in srgb, currentColor 6%, transparent)",
                  color: "inherit",
                  fontFamily: "monospace",
                  fontSize: "0.82rem",
                  wordBreak: "break-all"
                }}
              >
                {resolvedBridgeLink}
              </a>
            </div>

            {bridgeQrSvg && bridgeQrSvg.trim().length > 0 ? (
              <div
                style={{
                  alignSelf: "flex-start",
                  padding: "10px",
                  borderRadius: "10px",
                  backgroundColor: "#ffffff",
                  border: "1px solid #cbd5e1"
                }}
              >
                <img
                  src={toSvgDataUri(bridgeQrSvg)}
                  alt="QR code to configure the HoldUp Android DAT Bridge"
                  width={148}
                  height={148}
                  style={{ display: "block", width: "148px", height: "148px" }}
                />
              </div>
            ) : null}

            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <a href={resolvedBridgeLink} style={actionButtonStyle}>
                Launch DAT Bridge
              </a>
              <button
                type="button"
                onClick={() => void handleCopy("bridge", resolvedBridgeLink)}
                style={actionButtonStyle}
              >
                {copiedTarget === "bridge" ? "Copied Bridge Link" : "Copy Bridge Link"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default DeviceResiliencePanel;
