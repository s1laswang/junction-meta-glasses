import { useEffect, useState, type CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";

export type ServerFeatureStats = {
  calls: number;
  ok: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  tokens_thinking?: number;
  tokens_think?: number;
  models: Record<string, number>;
  latency_p50_s: number | null;
  latency_p95_s: number | null;
  first_audio_p50_s?: number | null;
  tool_p50_s?: number | null;
  tool_calls?: number;
};

export type ServerLedgerStats = {
  since: number | string | null;
  total: number;
  features: Record<string, ServerFeatureStats>;
};

export type EvalProofCardProps = {
  initialStats?: ServerLedgerStats | null;
  fetchImpl?: typeof fetch;
  lang: string;
};

type Tone = "ok" | "warn" | "info" | "neutral";

type SafetyGateSpec = {
  id: string;
  badge: string;
  title: string;
  detail: string;
};

const SAFETY_GATES: readonly SafetyGateSpec[] = [
  {
    id: "strength-confidence-gate",
    badge: "HARD GATE",
    title: ">= 80% Strength Confidence Gate (ECE 0.0138)",
    detail:
      "Refuses uncertain mg strength below 0.80 confidence (0 confident wrong doses, 100% occluded abstention)."
  },
  {
    id: "dual-tier-reader",
    badge: "GROUNDED",
    title: "Dual-Tier Live + Schema Reader",
    detail:
      "Gemini Live coaches hand framing at ~1 fps; schema-locked verify_label extracts fields before deterministic safety checks."
  },
  {
    id: "zero-retention",
    badge: "RAM ONLY",
    title: "Zero Server Image Retention",
    detail:
      "Frames live only in an 8-slot RAM ring buffer cleared on disconnect; personal med profiles stay in device localStorage."
  },
  {
    id: "coaching-privacy-judge",
    badge: "VERIFIED",
    title: "8/8 Gemini Coaching & Privacy Judge Pass",
    detail:
      "5.0/5 mean judge score across brevity, tool grounding, bystander face-ignore rules, and pharmacist handoff."
  }
];

const SUBTITLE_BY_LOCALE: Record<UiLocale, string> = {
  en: "Live ledger metrics from the Node backend paired with HoldUp's deterministic clinical-boundary invariants.",
  fi: "Reaaliaikaiset Gemini-mittarit palvelimelta sekä HoldUpin deterministiset turvallisuusrajat.",
  sv: "Realtidsmätetal från Gemini-servern tillsammans med HoldUps deterministiska säkerhetsgränser."
};

const TONE_BADGE_STYLES: Record<Tone, CSSProperties> = {
  ok: {
    backgroundColor: "var(--verdict-match-bg, #06261d)",
    color: "var(--verdict-match-fg, #7ef7c8)",
    border: "var(--border-width, 1.5px) solid var(--verdict-match-border, #2dd4a0)"
  },
  warn: {
    backgroundColor: "var(--verdict-unsure-bg, #261b04)",
    color: "var(--verdict-unsure-fg, #ffe169)",
    border: "var(--border-width, 1.5px) solid var(--verdict-unsure-border, #f5b82e)"
  },
  info: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)"
  },
  neutral: {
    backgroundColor: "var(--bg-elevated, #1a2333)",
    color: "var(--text-primary, #f8fafc)",
    border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)"
  }
};

const TONE_DOT_COLORS: Record<Tone, string> = {
  ok: "var(--verdict-match-border, #2dd4a0)",
  warn: "var(--verdict-unsure-border, #f5b82e)",
  info: "var(--verdict-info-border, #4da3ff)",
  neutral: "var(--border-strong, #6980a3)"
};

const SR_ONLY_STYLE: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0
};

function toFiniteNonNegative(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : fallback;
}

function toNullableSeconds(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : null;
}

export function parseServerLedgerStats(raw: unknown): ServerLedgerStats | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.total !== "number" || !Number.isFinite(obj.total) || obj.total < 0) {
    return null;
  }

  let since: number | string | null = null;
  if (typeof obj.since === "number" && Number.isFinite(obj.since)) {
    since = obj.since;
  } else if (typeof obj.since === "string") {
    since = obj.since;
  }

  const features: Record<string, ServerFeatureStats> = {};
  if (obj.features && typeof obj.features === "object" && !Array.isArray(obj.features)) {
    for (const [featureKey, rawFeat] of Object.entries(obj.features as Record<string, unknown>)) {
      if (!rawFeat || typeof rawFeat !== "object" || Array.isArray(rawFeat)) {
        continue;
      }
      const f = rawFeat as Record<string, unknown>;
      const models: Record<string, number> = {};
      if (f.models && typeof f.models === "object" && !Array.isArray(f.models)) {
        for (const [modelName, count] of Object.entries(f.models as Record<string, unknown>)) {
          if (modelName.trim().length > 0 && typeof count === "number" && Number.isFinite(count) && count >= 0) {
            models[modelName] = count;
          }
        }
      }

      const normalized: ServerFeatureStats = {
        calls: toFiniteNonNegative(f.calls),
        ok: toFiniteNonNegative(f.ok),
        errors: toFiniteNonNegative(f.errors),
        tokens_in: toFiniteNonNegative(f.tokens_in),
        tokens_out: toFiniteNonNegative(f.tokens_out),
        models,
        latency_p50_s: toNullableSeconds(f.latency_p50_s),
        latency_p95_s: toNullableSeconds(f.latency_p95_s)
      };

      if (typeof f.tokens_thinking === "number" && Number.isFinite(f.tokens_thinking)) {
        normalized.tokens_thinking = Math.max(0, f.tokens_thinking);
      }
      if (typeof f.tokens_think === "number" && Number.isFinite(f.tokens_think)) {
        normalized.tokens_think = Math.max(0, f.tokens_think);
      }
      if (f.first_audio_p50_s !== undefined) {
        normalized.first_audio_p50_s = toNullableSeconds(f.first_audio_p50_s);
      }
      if (f.tool_p50_s !== undefined) {
        normalized.tool_p50_s = toNullableSeconds(f.tool_p50_s);
      }
      if (typeof f.tool_calls === "number" && Number.isFinite(f.tool_calls)) {
        normalized.tool_calls = Math.max(0, f.tool_calls);
      }

      features[featureKey] = normalized;
    }
  }

  return {
    since,
    total: obj.total,
    features
  };
}

export async function fetchServerLedgerStats(
  fetchImpl?: typeof fetch
): Promise<ServerLedgerStats | null> {
  const resolvedFetch =
    fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (!resolvedFetch) {
    return null;
  }
  try {
    const response = await resolvedFetch("/api/stats", {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    return parseServerLedgerStats(payload);
  } catch {
    return null;
  }
}

function formatSeconds(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) {
    return "N/A";
  }
  return `${Number(sec.toFixed(3))}s`;
}

function formatSinceTimestamp(since: number | string | null | undefined): string | null {
  if (since === null || since === undefined) {
    return null;
  }
  if (typeof since === "number" && Number.isFinite(since)) {
    return `${new Date(since).toISOString().slice(11, 19)} UTC`;
  }
  if (typeof since === "string" && since.trim().length > 0) {
    const parsed = Date.parse(since);
    if (Number.isFinite(parsed)) {
      return `${new Date(parsed).toISOString().slice(11, 19)} UTC`;
    }
    return since.trim();
  }
  return null;
}

function aggregateModels(features: Record<string, ServerFeatureStats>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const feat of Object.values(features)) {
    for (const [model, count] of Object.entries(feat.models ?? {})) {
      if (!model || typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
        continue;
      }
      counts.set(model, (counts.get(model) ?? 0) + count);
    }
  }
  return [...counts.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])));
}

export function EvalProofCard(props: EvalProofCardProps) {
  const { initialStats, fetchImpl, lang } = props;
  const locale = normalizeLang(lang);

  const [stats, setStats] = useState<ServerLedgerStats | null>(() =>
    initialStats ? (parseServerLedgerStats(initialStats) ?? initialStats) : null
  );
  const [loading, setLoading] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (initialStats !== undefined) {
      setStats(initialStats ? (parseServerLedgerStats(initialStats) ?? initialStats) : null);
      setFetchFailed(false);
    }
  }, [initialStats]);

  useEffect(() => {
    if (initialStats !== undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchServerLedgerStats(fetchImpl).then((next) => {
      if (cancelled) return;
      setLoading(false);
      if (next) {
        setStats(next);
        setFetchFailed(false);
      } else {
        setFetchFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialStats, fetchImpl]);

  const handleRefresh = async () => {
    if (loading) return;
    setLoading(true);
    const next = await fetchServerLedgerStats(fetchImpl);
    setLoading(false);
    if (next) {
      setStats(next);
      setFetchFailed(false);
      setAnnouncement(
        next.total > 0
          ? `Refreshed live telemetry: ${next.total} total Gemini calls.`
          : "Refreshed live telemetry: No live calls recorded in this session yet."
      );
    } else {
      setFetchFailed(true);
      setAnnouncement("Live telemetry endpoint offline. Safety gates remain enforced.");
    }
  };

  const features = stats?.features ?? {};
  const featureEntries = Object.entries(features);
  const totalCalls = stats?.total ?? 0;
  const hasRecordedCalls = totalCalls > 0;

  let totalOk = 0;
  let totalErrors = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalTokensThinking = 0;

  for (const [, feat] of featureEntries) {
    totalOk += toFiniteNonNegative(feat.ok);
    totalErrors += toFiniteNonNegative(feat.errors);
    totalTokensIn += toFiniteNonNegative(feat.tokens_in);
    totalTokensOut += toFiniteNonNegative(feat.tokens_out);
    totalTokensThinking += toFiniteNonNegative(feat.tokens_thinking ?? feat.tokens_think ?? 0);
  }

  const totalTokensAll = totalTokensIn + totalTokensOut + totalTokensThinking;
  const verifyStats = features.verify;
  const liveStats = features.live;
  const modelEntries = aggregateModels(features);
  const sinceText = formatSinceTimestamp(stats?.since);

  const featureSummaryParts = featureEntries
    .filter(([, f]) => f.calls > 0)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([name, f]) => `${name}: ${f.calls}`);

  const callsTone: Tone = !hasRecordedCalls ? "neutral" : totalErrors > 0 ? "warn" : "ok";
  const callsSubvalue = hasRecordedCalls
    ? `${totalOk} ok / ${totalErrors} errors${
        featureSummaryParts.length > 0 ? ` (${featureSummaryParts.join(", ")})` : ""
      }`
    : "0 ok / 0 errors in current ledger";

  const verifyHasLatency =
    verifyStats !== undefined &&
    (verifyStats.latency_p50_s !== null || verifyStats.latency_p95_s !== null);
  const verifyValue = verifyHasLatency
    ? `${formatSeconds(verifyStats.latency_p50_s)} / ${formatSeconds(verifyStats.latency_p95_s)}`
    : "Standby";
  const verifySubvalue =
    verifyStats && verifyStats.calls > 0
      ? `Across ${verifyStats.ok} verified ${verifyStats.ok === 1 ? "read" : "reads"} (${verifyStats.calls} total)`
      : "Awaiting first /api/verify check";
  const verifyTone: Tone = verifyHasLatency ? "ok" : "neutral";

  const liveHasFirstAudio =
    liveStats !== undefined &&
    liveStats.first_audio_p50_s !== undefined &&
    liveStats.first_audio_p50_s !== null;
  const liveValue = liveHasFirstAudio
    ? formatSeconds(liveStats.first_audio_p50_s)
    : liveStats && liveStats.calls > 0 && liveStats.latency_p50_s !== null
      ? `${formatSeconds(liveStats.latency_p50_s)} session p50`
      : "Standby";
  const liveSubvalue =
    liveStats && liveStats.calls > 0
      ? liveStats.tool_p50_s !== undefined && liveStats.tool_p50_s !== null
        ? `Tool p50: ${formatSeconds(liveStats.tool_p50_s)} (${liveStats.tool_calls ?? 0} tool ${
            (liveStats.tool_calls ?? 0) === 1 ? "call" : "calls"
          })`
        : `${liveStats.ok} live ${liveStats.ok === 1 ? "session" : "sessions"} (${
            liveStats.tool_calls ?? 0
          } tool ${(liveStats.tool_calls ?? 0) === 1 ? "call" : "calls"})`
      : "Awaiting first /live coaching turn";
  const liveTone: Tone = liveHasFirstAudio ? "ok" : "neutral";

  const modelsTone: Tone = modelEntries.length > 0 ? "info" : "neutral";
  const tokensTone: Tone = totalTokensAll > 0 ? "ok" : "neutral";
  const avgTokensPerCall = hasRecordedCalls ? Math.round(totalTokensAll / totalCalls) : 0;

  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5, 20px)",
    padding: "var(--space-5, 20px)",
    borderRadius: "var(--radius-lg, 18px)",
    border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
    backgroundColor: "var(--bg-surface, #121926)",
    color: "var(--text-primary, #f8fafc)"
  };

  const regionStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3, 12px)",
    padding: "var(--space-4, 16px)",
    borderRadius: "var(--radius-md, 12px)",
    border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
    backgroundColor: "var(--bg-elevated, #1a2333)"
  };

  const tileStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: "6px",
    padding: "12px",
    borderRadius: "var(--radius-md, 12px)",
    border: "1px solid var(--border-subtle, #2c3a52)",
    backgroundColor: "var(--bg-surface, #121926)"
  };

  const tileLabelStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    fontSize: "var(--text-xs, 0.875rem)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--text-secondary, #d8e1ee)"
  };

  const refreshButtonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    minHeight: "56px",
    padding: "10px 18px",
    borderRadius: "var(--radius-md, 12px)",
    border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
    backgroundColor: "var(--bg-surface, #121926)",
    color: "var(--text-primary, #f8fafc)",
    fontSize: "var(--text-sm, 1rem)",
    fontWeight: 700,
    cursor: loading ? "wait" : "pointer"
  };

  return (
    <section
      aria-labelledby="eval-proof-card-title"
      lang={locale}
      className="card eval-proof-card"
      style={cardStyle}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only eval-proof-live-status"
        style={SR_ONLY_STYLE}
      >
        {announcement}
      </div>

      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h2
            id="eval-proof-card-title"
            style={{ margin: 0, fontSize: "var(--text-lg, 1.25rem)", lineHeight: 1.3 }}
          >
            Live Ledger Telemetry &amp; Safety Proof
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              color: "var(--text-secondary, #d8e1ee)",
              lineHeight: 1.4
            }}
          >
            {SUBTITLE_BY_LOCALE[locale]}
          </p>
        </div>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px",
            borderRadius: "var(--radius-pill, 9999px)",
            fontSize: "var(--text-xs, 0.875rem)",
            fontWeight: 700,
            ...(fetchFailed
              ? TONE_BADGE_STYLES.warn
              : hasRecordedCalls
                ? TONE_BADGE_STYLES.ok
                : TONE_BADGE_STYLES.neutral)
          }}
        >
          {fetchFailed
            ? "Offline Fallback Active"
            : sinceText
              ? `Ledger Since ${sinceText}`
              : "Session Standby"}
        </span>
      </header>

      <section
        role="region"
        aria-labelledby="eval-runtime-telemetry-heading"
        className="eval-telemetry-region"
        style={regionStyle}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px"
          }}
        >
          <h3
            id="eval-runtime-telemetry-heading"
            style={{ margin: 0, fontSize: "var(--text-base, 1.125rem)", lineHeight: 1.3 }}
          >
            Runtime Gemini Telemetry (/api/stats)
          </h3>

          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading}
            aria-disabled={loading}
            aria-busy={loading}
            className="btn btn-secondary eval-refresh-btn"
            style={refreshButtonStyle}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={{ width: "18px", height: "18px", flexShrink: 0 }}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            <span>Refresh Live Telemetry</span>
          </button>
        </div>

        {!hasRecordedCalls ? (
          <div
            role="status"
            className="eval-empty-telemetry-banner"
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-sm, 8px)",
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 600,
              ...(fetchFailed ? TONE_BADGE_STYLES.warn : TONE_BADGE_STYLES.neutral)
            }}
          >
            <span>No live calls recorded in this session yet</span>
            {fetchFailed ? (
              <span style={{ display: "block", marginTop: "4px", fontSize: "var(--text-xs, 0.875rem)" }}>
                Server /api/stats unreachable; deterministic safety gates remain enforced locally.
              </span>
            ) : null}
          </div>
        ) : null}

        <dl
          className="eval-telemetry-grid"
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: "10px"
          }}
        >
          <div className="eval-metric-tile" data-metric="total-calls" style={tileStyle}>
            <dt style={tileLabelStyle}>
              <span>Total Gemini Calls</span>
              <span
                aria-hidden="true"
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  backgroundColor: TONE_DOT_COLORS[callsTone],
                  flexShrink: 0
                }}
              />
            </dt>
            <dd style={{ margin: 0 }}>
              <div style={{ fontSize: "var(--text-lg, 1.25rem)", fontWeight: 800, lineHeight: 1.25 }}>
                {totalCalls}
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "var(--text-xs, 0.875rem)",
                  color: "var(--text-secondary, #d8e1ee)",
                  lineHeight: 1.35
                }}
              >
                {callsSubvalue}
              </div>
            </dd>
          </div>

          <div className="eval-metric-tile" data-metric="verify-latency" style={tileStyle}>
            <dt style={tileLabelStyle}>
              <span>Verify p50 / p95 Latency</span>
              <span
                aria-hidden="true"
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  backgroundColor: TONE_DOT_COLORS[verifyTone],
                  flexShrink: 0
                }}
              />
            </dt>
            <dd style={{ margin: 0 }}>
              <div
                style={{
                  fontSize: "var(--text-lg, 1.25rem)",
                  fontWeight: 800,
                  lineHeight: 1.25,
                  fontFamily: "var(--font-mono, monospace)"
                }}
              >
                {verifyValue}
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "var(--text-xs, 0.875rem)",
                  color: "var(--text-secondary, #d8e1ee)",
                  lineHeight: 1.35
                }}
              >
                {verifySubvalue}
              </div>
            </dd>
          </div>

          <div className="eval-metric-tile" data-metric="live-first-audio" style={tileStyle}>
            <dt style={tileLabelStyle}>
              <span>Live First-Audio p50</span>
              <span
                aria-hidden="true"
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  backgroundColor: TONE_DOT_COLORS[liveTone],
                  flexShrink: 0
                }}
              />
            </dt>
            <dd style={{ margin: 0 }}>
              <div
                style={{
                  fontSize: "var(--text-lg, 1.25rem)",
                  fontWeight: 800,
                  lineHeight: 1.25,
                  fontFamily: "var(--font-mono, monospace)"
                }}
              >
                {liveValue}
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "var(--text-xs, 0.875rem)",
                  color: "var(--text-secondary, #d8e1ee)",
                  lineHeight: 1.35
                }}
              >
                {liveSubvalue}
              </div>
            </dd>
          </div>

          <div className="eval-metric-tile" data-metric="active-models" style={tileStyle}>
            <dt style={tileLabelStyle}>
              <span>Active Models Used</span>
              <span
                aria-hidden="true"
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  backgroundColor: TONE_DOT_COLORS[modelsTone],
                  flexShrink: 0
                }}
              />
            </dt>
            <dd style={{ margin: 0 }}>
              {modelEntries.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px",
                    marginTop: "2px"
                  }}
                >
                  {modelEntries.map(([modelName, count]) => (
                    <span
                      key={modelName}
                      data-model={modelName}
                      className="badge eval-model-badge"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 8px",
                        borderRadius: "var(--radius-sm, 8px)",
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "0.8rem",
                        fontWeight: 700,
                        ...TONE_BADGE_STYLES.info
                      }}
                    >
                      {`${modelName} (${count})`}
                    </span>
                  ))}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: "var(--text-base, 1.125rem)", fontWeight: 700, lineHeight: 1.25 }}>
                    None yet
                  </div>
                  <div
                    style={{
                      marginTop: "4px",
                      fontSize: "var(--text-xs, 0.875rem)",
                      color: "var(--text-secondary, #d8e1ee)",
                      lineHeight: 1.35
                    }}
                  >
                    Default: gemini-3.8-live + gemini-3.8-flash
                  </div>
                </>
              )}
            </dd>
          </div>

          <div className="eval-metric-tile" data-metric="token-efficiency" style={tileStyle}>
            <dt style={tileLabelStyle}>
              <span>Token Efficiency</span>
              <span
                aria-hidden="true"
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  backgroundColor: TONE_DOT_COLORS[tokensTone],
                  flexShrink: 0
                }}
              />
            </dt>
            <dd style={{ margin: 0 }}>
              <div style={{ fontSize: "var(--text-lg, 1.25rem)", fontWeight: 800, lineHeight: 1.25 }}>
                {hasRecordedCalls ? `${totalTokensAll} total (${avgTokensPerCall} avg/call)` : "0 tokens"}
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "var(--text-xs, 0.875rem)",
                  color: "var(--text-secondary, #d8e1ee)",
                  lineHeight: 1.35
                }}
              >
                {`In: ${totalTokensIn} / Out: ${totalTokensOut} / Thinking: ${totalTokensThinking}`}
              </div>
            </dd>
          </div>
        </dl>
      </section>

      <section
        role="region"
        aria-labelledby="eval-safety-gates-heading"
        className="eval-safety-gates-region"
        style={regionStyle}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px"
          }}
        >
          <h3
            id="eval-safety-gates-heading"
            style={{ margin: 0, fontSize: "var(--text-base, 1.125rem)", lineHeight: 1.3 }}
          >
            Deterministic Safety Gates
          </h3>
          <span
            className="badge"
            style={{
              padding: "4px 10px",
              borderRadius: "var(--radius-pill, 9999px)",
              fontSize: "0.78rem",
              fontWeight: 800,
              ...TONE_BADGE_STYLES.ok
            }}
          >
            Always Enforced
          </span>
        </div>

        <ul
          aria-label="Deterministic safety gates"
          className="eval-safety-gates-list"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: "10px"
          }}
        >
          {SAFETY_GATES.map((gate) => (
            <li
              key={gate.id}
              data-gate-id={gate.id}
              className="eval-safety-gate-item"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "12px",
                borderRadius: "var(--radius-md, 12px)",
                border: "1.5px solid var(--verdict-match-border, #2dd4a0)",
                backgroundColor: "var(--bg-surface, #121926)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "2px 8px",
                    borderRadius: "var(--radius-sm, 8px)",
                    fontSize: "0.75rem",
                    fontWeight: 800,
                    letterSpacing: "0.03em",
                    ...TONE_BADGE_STYLES.ok
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                    style={{ width: "14px", height: "14px", flexShrink: 0 }}
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span>{gate.badge}</span>
                </span>
              </div>

              <strong style={{ fontSize: "var(--text-sm, 1rem)", lineHeight: 1.3 }}>
                {gate.title}
              </strong>

              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-xs, 0.875rem)",
                  color: "var(--text-secondary, #d8e1ee)",
                  lineHeight: 1.4
                }}
              >
                {gate.detail}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

export default EvalProofCard;
