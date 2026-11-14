import type { CoachCue, VerdictLevel } from "../../../shared/types.ts";

type P = { size?: number; className?: string };
const base = (size = 28) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false });

export function Logo({ size = 32 }: P) {
  // a hand-held box inside viewfinder brackets
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#ffd23f" />
      <path d="M7 12V8h4M21 8h4v4M25 20v4h-4M11 24H7v-4" stroke="#0b1018" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <rect x="12.5" y="11" width="7" height="10" rx="1.2" fill="#0b1018" />
    </svg>
  );
}

/** Verdict glyphs: each level has its own outer shape so it reads without colour. */
export function VerdictGlyph({ level, size = 72 }: { level: VerdictLevel; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 72 72", "aria-hidden": true, focusable: false } as const;
  if (level === "match")
    return (
      <svg {...common}>
        <circle cx="36" cy="36" r="32" fill="currentColor" />
        <path d="M21 37l10 10 20-22" stroke="#0b1018" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (level === "warning")
    return (
      <svg {...common}>
        <path d="M36 5l33 60H3z" fill="currentColor" strokeLinejoin="round" />
        <path d="M36 26v18" stroke="#0b1018" strokeWidth="7" strokeLinecap="round" />
        <circle cx="36" cy="54" r="4" fill="#0b1018" />
      </svg>
    );
  if (level === "unsure")
    return (
      <svg {...common}>
        <path d="M36 3l33 33-33 33L3 36z" fill="currentColor" />
        <path d="M28 29a8 8 0 1 1 11 7.4c-2 .9-3 2.4-3 4.6v1" stroke="#0b1018" strokeWidth="6" fill="none" strokeLinecap="round" />
        <circle cx="36" cy="52" r="3.8" fill="#0b1018" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="5" y="5" width="62" height="62" rx="10" fill="currentColor" />
      <circle cx="36" cy="22" r="4.5" fill="#0b1018" />
      <path d="M36 33v20" stroke="#0b1018" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

export const LEVEL_WORD: Record<VerdictLevel, string> = { match: "Match", warning: "Warning", unsure: "Not sure", info: "Info" };

export function CueArrow({ cue, size = 56 }: { cue: CoachCue | null; size?: number }) {
  const p = { ...base(size), strokeWidth: 2.4 };
  switch (cue) {
    case "rotate_left":
      return (
        <svg {...p}>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 3v6h6" />
        </svg>
      );
    case "rotate_right":
      return (
        <svg {...p}>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v6h-6" />
        </svg>
      );
    case "closer":
      return (
        <svg {...p}>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          <path d="M9 12h6M12 9v6" />
        </svg>
      );
    case "farther":
      return (
        <svg {...p}>
          <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
          <path d="M9 12h6" />
        </svg>
      );
    case "more_light":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      );
    case "hold_still":
      return (
        <svg {...p}>
          <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v8M14 11.5V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-12.2 4.7L5 16.5a1.6 1.6 0 0 1 2.4-2.1L8 15" />
        </svg>
      );
    case "other_side":
      return (
        <svg {...p}>
          <path d="M17 3l4 4-4 4" />
          <path d="M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4" />
          <path d="M21 13v2a2 2 0 0 1-2 2H3" />
        </svg>
      );
    case "ok":
      return (
        <svg {...p}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
        </svg>
      );
  }
}

export const Icon = {
  camera: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  mic: (p: P) => (
    <svg {...base(p.size)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  cloud: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4.3 4.3 0 0 1-.5 8.5z" />
    </svg>
  ),
  phone: (p: P) => (
    <svg {...base(p.size)}>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  ),
  lock: (p: P) => (
    <svg {...base(p.size)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  check: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  x: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  glasses: (p: P) => (
    <svg {...base(p.size)}>
      <circle cx="6.5" cy="14" r="3.5" />
      <circle cx="17.5" cy="14" r="3.5" />
      <path d="M10 14h4M3 14l1.5-6h3M21 14l-1.5-6h-3" />
    </svg>
  ),
  wifiOff: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.1-1.5M2 9a15 15 0 0 1 4.3-2.6M22 9a15 15 0 0 0-9.4-3.9" />
      <circle cx="12" cy="20" r="0.8" fill="currentColor" />
    </svg>
  ),
  alert: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18h.01" />
    </svg>
  ),
  info: (p: P) => (
    <svg {...base(p.size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </svg>
  ),
  list: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  ),
  shield: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  ),
  scan: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 9v6M10 9v6M13 9v6M17 9v6" />
    </svg>
  ),
  trash: (p: P) => (
    <svg {...base(p.size)}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  ),
};
