import { useEffect } from "react";

export type ShortcutAction =
  | "toggle_check"
  | "snapshot_verify"
  | "offline_barcode"
  | "log_dose"
  | "repeat"
  | "cycle_theme"
  | "open_privacy";

export type ShortcutEventInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  targetTagName?: string;
  isContentEditable?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
};

export type ShortcutLegendItem = {
  key: string;
  action: ShortcutAction;
  description: string;
};

export const SHORTCUT_LEGEND: readonly ShortcutLegendItem[] = Object.freeze([
  {
    key: "Space",
    action: "toggle_check",
    description: "Start or stop live label check"
  },
  {
    key: "S",
    action: "snapshot_verify",
    description: "Capture and verify a single snapshot"
  },
  {
    key: "B",
    action: "offline_barcode",
    description: "Scan barcode offline against saved profile"
  },
  {
    key: "L",
    action: "log_dose",
    description: "Log dose for the matched medication"
  },
  {
    key: "R",
    action: "repeat",
    description: "Repeat the last spoken verdict or coaching cue"
  },
  {
    key: "T",
    action: "cycle_theme",
    description: "Cycle visual theme (dark, light, high-contrast)"
  },
  {
    key: "P",
    action: "open_privacy",
    description: "Open privacy and local data controls"
  }
]);

function extractTagName(ev: ShortcutEventInput): string {
  if (typeof ev.targetTagName === "string") {
    return ev.targetTagName.trim().toUpperCase();
  }
  const target = ev.target as { tagName?: unknown } | null | undefined;
  if (target && typeof target === "object" && typeof target.tagName === "string") {
    return target.tagName.trim().toUpperCase();
  }
  return "";
}

function extractContentEditable(ev: ShortcutEventInput): boolean {
  if (typeof ev.isContentEditable === "boolean") {
    return ev.isContentEditable;
  }
  const target = ev.target as
    | { isContentEditable?: unknown; contentEditable?: unknown }
    | null
    | undefined;
  if (target && typeof target === "object") {
    if (target.isContentEditable === true) return true;
    if (target.contentEditable === "true" || target.contentEditable === "plaintext-only") {
      return true;
    }
  }
  return false;
}

export function resolveShortcut(ev: ShortcutEventInput): ShortcutAction | null {
  if (!ev || typeof ev.key !== "string") return null;
  if (ev.defaultPrevented) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  if (extractContentEditable(ev)) return null;

  const tag = extractTagName(ev);
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return null;
  }

  if (ev.key === " ") {
    if (tag === "BUTTON" || tag === "A") return null;
    return "toggle_check";
  }

  switch (ev.key) {
    case "s":
    case "S":
      return "snapshot_verify";
    case "b":
    case "B":
      return "offline_barcode";
    case "l":
    case "L":
      return "log_dose";
    case "r":
    case "R":
      return "repeat";
    case "t":
    case "T":
      return "cycle_theme";
    case "p":
    case "P":
      return "open_privacy";
    default:
      return null;
  }
}

export type KeydownHost = {
  addEventListener(type: "keydown", listener: (ev: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", listener: (ev: KeyboardEvent) => void): void;
};

export function bindShortcutListener(
  onAction: (action: ShortcutAction, ev: KeyboardEvent) => void,
  options?: { enabled?: boolean; host?: KeydownHost | null }
): () => void {
  if (options?.enabled === false) return () => {};
  const host: KeydownHost | null =
    options?.host !== undefined
      ? options.host
      : typeof window !== "undefined"
        ? window
        : null;
  if (!host) return () => {};

  const listener = (ev: KeyboardEvent) => {
    if (ev.repeat) return;
    const action = resolveShortcut(ev);
    if (!action) return;
    ev.preventDefault();
    onAction(action, ev);
  };

  host.addEventListener("keydown", listener);
  return () => {
    host.removeEventListener("keydown", listener);
  };
}

export function useKeyboardShortcuts(
  onAction: (action: ShortcutAction, ev: KeyboardEvent) => void,
  enabled = true
): void {
  useEffect(() => bindShortcutListener(onAction, { enabled }), [enabled, onAction]);
}
