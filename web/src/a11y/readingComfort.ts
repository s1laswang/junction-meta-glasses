import {
  loadOrCreateSessionId,
  type KeyValueStorage
} from "../storage/profileStore.ts";

export type { KeyValueStorage };

export type TextScale = "100" | "125" | "150";

export type CognitiveDensity = "full" | "calm";

export type ReadingComfortPrefs = {
  textScale: TextScale;
  density: CognitiveDensity;
};

export const READING_COMFORT_KEY = "holdup.readingComfort";

export const TEXT_SCALES: readonly TextScale[] = Object.freeze(["100", "125", "150"]);

export const COGNITIVE_DENSITIES: readonly CognitiveDensity[] = Object.freeze([
  "full",
  "calm"
]);

export const DEFAULT_READING_COMFORT: ReadingComfortPrefs = Object.freeze({
  textScale: "100",
  density: "full"
});

type FallbackEntry = {
  anchorSessionId: string;
  raw: string;
};

const SESSION_ANCHOR_KEY = "holdup.sessionId";

let defaultFallbackEntry: FallbackEntry | null = null;
const fallbackByTarget = new WeakMap<KeyValueStorage, FallbackEntry>();
const nonEnumerableAnchors = new WeakMap<KeyValueStorage, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStorageEnumeration(target: KeyValueStorage): boolean {
  return (
    "length" in target &&
    typeof (target as { length?: unknown }).length === "number" &&
    "key" in target &&
    typeof (target as { key?: unknown }).key === "function"
  );
}

export function isTextScale(value: unknown): value is TextScale {
  return value === "100" || value === "125" || value === "150";
}

export function isCognitiveDensity(value: unknown): value is CognitiveDensity {
  return value === "full" || value === "calm";
}

export function sanitizeReadingComfort(raw: unknown): ReadingComfortPrefs {
  if (!isRecord(raw)) {
    return {
      textScale: DEFAULT_READING_COMFORT.textScale,
      density: DEFAULT_READING_COMFORT.density
    };
  }
  return {
    textScale: isTextScale(raw.textScale)
      ? raw.textScale
      : DEFAULT_READING_COMFORT.textScale,
    density: isCognitiveDensity(raw.density)
      ? raw.density
      : DEFAULT_READING_COMFORT.density
  };
}

function getDefaultStorageTarget(): KeyValueStorage | null {
  try {
    const ls = globalThis.localStorage;
    if (
      ls &&
      typeof ls.getItem === "function" &&
      typeof ls.setItem === "function" &&
      typeof ls.removeItem === "function"
    ) {
      return ls;
    }
  } catch {
    return null;
  }
  return null;
}

function readComfortRaw(storage?: KeyValueStorage): string | null {
  const target = storage ?? getDefaultStorageTarget();
  if (!target) {
    if (!defaultFallbackEntry) {
      return null;
    }
    const currentAnchor = loadOrCreateSessionId();
    if (currentAnchor !== defaultFallbackEntry.anchorSessionId) {
      defaultFallbackEntry = null;
      return null;
    }
    return defaultFallbackEntry.raw;
  }

  const targetFallback = fallbackByTarget.get(target);
  if (targetFallback) {
    const currentAnchor = loadOrCreateSessionId(storage);
    if (currentAnchor !== targetFallback.anchorSessionId) {
      fallbackByTarget.delete(target);
      return null;
    }
    return targetFallback.raw;
  }

  try {
    const expectedAnchor = nonEnumerableAnchors.get(target);
    if (expectedAnchor !== undefined) {
      const currentSession = target.getItem(SESSION_ANCHOR_KEY);
      if (currentSession !== expectedAnchor) {
        nonEnumerableAnchors.delete(target);
        try {
          target.removeItem(READING_COMFORT_KEY);
        } catch {
          void 0;
        }
        return null;
      }
    }
    return target.getItem(READING_COMFORT_KEY);
  } catch {
    return null;
  }
}

function writeComfortRaw(raw: string, storage?: KeyValueStorage): void {
  const target = storage ?? getDefaultStorageTarget();
  if (!target) {
    defaultFallbackEntry = {
      anchorSessionId: loadOrCreateSessionId(),
      raw
    };
    return;
  }

  try {
    target.setItem(READING_COMFORT_KEY, raw);
    if (!hasStorageEnumeration(target)) {
      const anchor = loadOrCreateSessionId(storage);
      nonEnumerableAnchors.set(target, anchor);
    } else {
      nonEnumerableAnchors.delete(target);
    }
    fallbackByTarget.delete(target);
    if (!storage) {
      defaultFallbackEntry = null;
    }
  } catch {
    const anchorSessionId = loadOrCreateSessionId(storage);
    fallbackByTarget.set(target, { anchorSessionId, raw });
    if (!storage) {
      defaultFallbackEntry = { anchorSessionId, raw };
    }
  }
}

export function loadReadingComfort(storage?: KeyValueStorage): ReadingComfortPrefs {
  const raw = readComfortRaw(storage);
  if (raw === null) {
    return {
      textScale: DEFAULT_READING_COMFORT.textScale,
      density: DEFAULT_READING_COMFORT.density
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return sanitizeReadingComfort(parsed);
  } catch {
    return {
      textScale: DEFAULT_READING_COMFORT.textScale,
      density: DEFAULT_READING_COMFORT.density
    };
  }
}

export function saveReadingComfort(
  prefs: ReadingComfortPrefs,
  storage?: KeyValueStorage
): ReadingComfortPrefs {
  const normalized = sanitizeReadingComfort(prefs);
  writeComfortRaw(JSON.stringify(normalized), storage);
  return {
    textScale: normalized.textScale,
    density: normalized.density
  };
}

export function nextTextScale(current: TextScale): TextScale {
  const index = TEXT_SCALES.indexOf(current);
  if (index === -1) {
    return "100";
  }
  return TEXT_SCALES[(index + 1) % TEXT_SCALES.length];
}

export function shouldShowSecondarySurface(density: CognitiveDensity): boolean {
  return density !== "calm";
}

export function textScaleCssPercent(scale: TextScale): "100%" | "125%" | "150%" {
  if (scale === "150") {
    return "150%";
  }
  if (scale === "125") {
    return "125%";
  }
  return "100%";
}

export function textScaleMultiplier(scale: TextScale): number {
  if (scale === "150") {
    return 1.5;
  }
  if (scale === "125") {
    return 1.25;
  }
  return 1;
}
