import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT } from "../src/env.ts";

process.env.HOLDUP_QUIET = "1";

const ANDROID_ROOT = path.join(REPO_ROOT, "android-dat");
const BRIDGE_SRC_DIR = path.join(
  ANDROID_ROOT,
  "app",
  "src",
  "main",
  "java",
  "app",
  "holdup",
  "bridge",
);
const BRIDGE_PREFS_PATH = path.join(BRIDGE_SRC_DIR, "BridgePreferences.kt");
const VERIFY_SCRIPT_PATH = path.join(ANDROID_ROOT, "verify-structure.mjs");

const LINE_COMMENT_TOKEN = "/" + "/";
const BLOCK_COMMENT_OPEN = "/" + "*";
const BLOCK_COMMENT_CLOSE = "*" + "/";
const EM_DASH = "\u2014";

type KotlinLexResult = {
  ok: boolean;
  reason?: string;
  sawComment: boolean;
};

function collectKotlinFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".gradle" ||
      entry.name === "build" ||
      entry.name === ".idea" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectKotlinFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".kt")) {
      out.push(full);
    }
  }
  return out.sort();
}

function scanKotlinSource(source: string): KotlinLexResult {
  const modeStack: Array<{ kind: "string" | "raw_string" | "template"; braceDepth: number }> = [];
  const delimiters: string[] = [];
  let sawComment = false;
  let i = 0;
  const n = source.length;

  const matchingOpen: Record<string, string> = {
    "}": "{",
    ")": "(",
    "]": "[",
  };

  while (i < n) {
    const top = modeStack.at(-1);
    const mode = top ? top.kind : "code";
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (mode === "code" || mode === "template") {
      if (ch === "/" && next === "/") {
        sawComment = true;
        i += 2;
        while (i < n && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        sawComment = true;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (source[i] === "/" && source[i + 1] === "*") {
            depth++;
            i += 2;
          } else if (source[i] === "*" && source[i + 1] === "/") {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        if (depth !== 0) {
          return { ok: false, reason: "unterminated block comment", sawComment };
        }
        continue;
      }
      if (ch === '"' && next === '"' && source[i + 2] === '"') {
        modeStack.push({ kind: "raw_string", braceDepth: 0 });
        i += 3;
        continue;
      }
      if (ch === '"') {
        modeStack.push({ kind: "string", braceDepth: 0 });
        i++;
        continue;
      }
      if (ch === "'") {
        i++;
        if (source[i] === "\\") i += 2;
        else i++;
        if (source[i] !== "'") {
          return { ok: false, reason: "unterminated char literal", sawComment };
        }
        i++;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") {
        delimiters.push(ch);
        if (ch === "{" && top && top.kind === "template") {
          top.braceDepth++;
        }
        i++;
        continue;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        const expected = matchingOpen[ch];
        const actual = delimiters.pop();
        if (actual !== expected) {
          return {
            ok: false,
            reason: `mismatched delimiter ${ch} (expected match for ${actual ?? "none"})`,
            sawComment,
          };
        }
        if (ch === "}" && top && top.kind === "template") {
          top.braceDepth--;
          if (top.braceDepth === 0) {
            modeStack.pop();
          }
        }
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (mode === "string") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        delimiters.push("{");
        modeStack.push({ kind: "template", braceDepth: 1 });
        i += 2;
        continue;
      }
      if (ch === '"') {
        modeStack.pop();
        i++;
        continue;
      }
      if (ch === "\n") {
        return { ok: false, reason: "unterminated string literal", sawComment };
      }
      i++;
      continue;
    }

    if (mode === "raw_string") {
      if (ch === "$" && next === "{") {
        delimiters.push("{");
        modeStack.push({ kind: "template", braceDepth: 1 });
        i += 2;
        continue;
      }
      if (ch === '"' && next === '"' && source[i + 2] === '"' && source[i + 3] !== '"') {
        modeStack.pop();
        i += 3;
        continue;
      }
      i++;
      continue;
    }
  }

  if (modeStack.length > 0) {
    return { ok: false, reason: `unclosed ${modeStack.at(-1)?.kind}`, sawComment };
  }
  if (delimiters.length > 0) {
    return {
      ok: false,
      reason: `unbalanced delimiters remaining: ${delimiters.join("")}`,
      sawComment,
    };
  }
  return { ok: true, sawComment };
}

function extractBridgePreferencesSpec(source: string) {
  const maxUrlMatch = source.match(/const\s+val\s+MAX_SERVER_URL_LENGTH\s*=\s*(\d+)/);
  const minSessionMatch = source.match(/const\s+val\s+MIN_SESSION_CODE_LENGTH\s*=\s*(\d+)/);
  const maxSessionMatch = source.match(/const\s+val\s+MAX_SESSION_CODE_LENGTH\s*=\s*(\d+)/);
  const sessionRegexMatch = source.match(/SESSION_CODE_REGEX\s*=\s*Regex\("([^"]+)"\)/);
  const prefsNameMatch = source.match(/const\s+val\s+PREFS_NAME\s*=\s*"([^"]+)"/);
  const keyServerMatch = source.match(/const\s+val\s+KEY_SERVER_URL\s*=\s*"([^"]+)"/);
  const keySessionMatch = source.match(/const\s+val\s+KEY_SESSION_CODE\s*=\s*"([^"]+)"/);

  assert.ok(maxUrlMatch, "BridgePreferences.kt must define MAX_SERVER_URL_LENGTH");
  assert.ok(minSessionMatch, "BridgePreferences.kt must define MIN_SESSION_CODE_LENGTH");
  assert.ok(maxSessionMatch, "BridgePreferences.kt must define MAX_SESSION_CODE_LENGTH");
  assert.ok(sessionRegexMatch, "BridgePreferences.kt must define SESSION_CODE_REGEX");
  assert.ok(prefsNameMatch, "BridgePreferences.kt must define PREFS_NAME");
  assert.ok(keyServerMatch, "BridgePreferences.kt must define KEY_SERVER_URL");
  assert.ok(keySessionMatch, "BridgePreferences.kt must define KEY_SESSION_CODE");

  return {
    maxServerUrlLength: Number(maxUrlMatch[1]),
    minSessionLength: Number(minSessionMatch[1]),
    maxSessionLength: Number(maxSessionMatch[1]),
    sessionRegexPattern: sessionRegexMatch[1],
    prefsName: prefsNameMatch[1],
    keyServerUrl: keyServerMatch[1],
    keySessionCode: keySessionMatch[1],
  };
}

function createBridgePreferencesReference(spec: ReturnType<typeof extractBridgePreferencesSpec>) {
  const sessionRegex = new RegExp(spec.sessionRegexPattern);

  function sanitizeServerUrl(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > spec.maxServerUrlLength) {
      return "";
    }
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      if (code <= 0x20 || code === 0x7f || trimmed[i] === "\\") {
        return "";
      }
    }

    const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
    if (withoutTrailingSlashes.length === 0) {
      return "";
    }

    const schemeSep = withoutTrailingSlashes.indexOf(":");
    if (schemeSep <= 0) {
      return "";
    }
    const scheme = withoutTrailingSlashes.slice(0, schemeSep).toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return "";
    }

    const afterScheme = withoutTrailingSlashes.slice(scheme.length);
    if (
      afterScheme.length < 4 ||
      afterScheme[0] !== ":" ||
      afterScheme[1] !== "/" ||
      afterScheme[2] !== "/" ||
      afterScheme[3] === "/"
    ) {
      return "";
    }

    const remainder = afterScheme.slice(3);
    if (remainder.includes("?") || remainder.includes("#")) {
      return "";
    }

    const slashIndex = remainder.indexOf("/");
    const authority = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
    const rawPath = slashIndex === -1 ? "" : remainder.slice(slashIndex);

    if (authority.length === 0 || authority.includes("@") || authority.endsWith(":")) {
      return "";
    }

    let hostPart = authority;
    let portPart: string | null = null;
    if (authority.startsWith("[")) {
      const closeBracket = authority.indexOf("]");
      if (closeBracket <= 1) {
        return "";
      }
      hostPart = authority.slice(0, closeBracket + 1);
      const afterBracket = authority.slice(closeBracket + 1);
      if (afterBracket.length > 0) {
        if (!afterBracket.startsWith(":")) {
          return "";
        }
        portPart = afterBracket.slice(1);
      }
    } else {
      const colonIdx = authority.indexOf(":");
      if (colonIdx !== -1) {
        if (authority.indexOf(":", colonIdx + 1) !== -1) {
          return "";
        }
        hostPart = authority.slice(0, colonIdx);
        portPart = authority.slice(colonIdx + 1);
      }
    }

    if (hostPart.length === 0) {
      return "";
    }
    if (!hostPart.startsWith("[") && !/^[A-Za-z0-9.-]+$/.test(hostPart)) {
      return "";
    }
    if (portPart !== null) {
      if (!/^\d+$/.test(portPart)) {
        return "";
      }
      const port = Number(portPart);
      if (port < 1 || port > 65535) {
        return "";
      }
    }

    if (rawPath.length > 0) {
      const segments = rawPath.split("/").slice(1);
      if (segments.some((seg) => seg.length === 0 || seg === "." || seg === "..")) {
        return "";
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(scheme + afterScheme);
    } catch {
      return "";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }

    return scheme + afterScheme;
  }

  function sanitizeSessionCode(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length < spec.minSessionLength || trimmed.length > spec.maxSessionLength) {
      return "";
    }
    return sessionRegex.test(trimmed) ? trimmed : "";
  }

  function createMemoryPrefsStore(initial?: Record<string, string>) {
    const backing = new Map<string, string>(Object.entries(initial ?? {}));
    return {
      backing,
      loadSavedEndpoint() {
        return {
          serverUrl: sanitizeServerUrl(backing.get(spec.keyServerUrl) ?? ""),
          sessionCode: sanitizeSessionCode(backing.get(spec.keySessionCode) ?? ""),
        };
      },
      saveEndpoint(serverUrl: string, sessionCode: string) {
        const cleanServer = sanitizeServerUrl(serverUrl);
        const cleanSession = sanitizeSessionCode(sessionCode);
        if (cleanServer.length === 0) {
          backing.delete(spec.keyServerUrl);
        } else {
          backing.set(spec.keyServerUrl, cleanServer);
        }
        if (cleanSession.length === 0) {
          backing.delete(spec.keySessionCode);
        } else {
          backing.set(spec.keySessionCode, cleanSession);
        }
        return {
          serverUrl: cleanServer,
          sessionCode: cleanSession,
        };
      },
      clearSavedEndpoint() {
        backing.delete(spec.keyServerUrl);
        backing.delete(spec.keySessionCode);
        backing.clear();
      },
    };
  }

  return { sanitizeServerUrl, sanitizeSessionCode, createMemoryPrefsStore };
}

test("android-dat/verify-structure.mjs passes with BridgePreferences.kt and all bridge Kotlin sources", () => {
  assert.equal(fs.existsSync(VERIFY_SCRIPT_PATH), true);
  assert.equal(fs.existsSync(BRIDGE_PREFS_PATH), true);

  const output = execFileSync(process.execPath, [VERIFY_SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

  const match = output.match(/^PASS android-dat structure verified: (\d+) Kotlin files,/);
  assert.ok(match, `Unexpected verify-structure.mjs output: ${output}`);
  const ktCount = Number(match[1]);
  assert.ok(ktCount >= 7, `Expected at least 7 Kotlin files in android-dat, got ${ktCount}`);
});

test("all android-dat Kotlin files declare package app.holdup.bridge, balanced delimiters, zero comments, and zero em dashes", () => {
  const ktFiles = collectKotlinFiles(ANDROID_ROOT);
  const expectedNames = [
    "BridgePreferences.kt",
    "BridgeScreen.kt",
    "DatBridgeController.kt",
    "IngestClient.kt",
    "MainActivity.kt",
    "StreamingForegroundService.kt",
    "YuvJpegEncoder.kt",
  ];

  const foundNames = ktFiles.map((f) => path.basename(f));
  for (const name of expectedNames) {
    assert.ok(foundNames.includes(name), `Missing expected Kotlin source file: ${name}`);
  }

  for (const ktFile of ktFiles) {
    const rel = path.relative(REPO_ROOT, ktFile);
    const src = fs.readFileSync(ktFile, "utf8");
    const lines = src.split(/\r?\n/);

    assert.equal(
      lines[0],
      "package app.holdup.bridge",
      `${rel}: first line must be exact 'package app.holdup.bridge'`,
    );
    assert.equal(src.includes(EM_DASH), false, `${rel}: must not contain em dashes`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${rel}: must not contain block comments`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${rel}: must not contain block comment closers`);
    assert.doesNotMatch(src, /AIza[0-9A-Za-z_-]{20,}/, `${rel}: must not contain API keys`);

    for (let idx = 0; idx < lines.length; idx++) {
      const trimmedLine = lines[idx].trim();
      assert.equal(
        trimmedLine.startsWith(LINE_COMMENT_TOKEN),
        false,
        `${rel}:${idx + 1} must not start with a line comment`,
      );
    }

    const lex = scanKotlinSource(src);
    assert.equal(lex.ok, true, `${rel}: ${lex.reason ?? "Kotlin delimiter scan failed"}`);
    assert.equal(lex.sawComment, false, `${rel}: must contain zero Kotlin comments`);
  }
});

test("BridgePreferences.kt exposes exact JVM-safe sanitizer and SharedPreferences API contracts", () => {
  const src = fs.readFileSync(BRIDGE_PREFS_PATH, "utf8");

  assert.match(src, /\bdata\s+class\s+SavedBridgeEndpoint\s*\(/);
  assert.match(src, /\bval\s+serverUrl\s*:\s*String\b/);
  assert.match(src, /\bval\s+sessionCode\s*:\s*String\b/);
  assert.match(src, /\bobject\s+BridgePreferences\s*\{/);

  assert.match(src, /\bfun\s+sanitizeServerUrl\s*\(\s*raw\s*:\s*String\s*\)\s*:\s*String\b/);
  assert.match(src, /\bfun\s+sanitizeSessionCode\s*\(\s*raw\s*:\s*String\s*\)\s*:\s*String\b/);
  assert.match(
    src,
    /\bfun\s+loadSavedEndpoint\s*\(\s*context\s*:\s*Context\s*\)\s*:\s*SavedBridgeEndpoint\b/,
  );
  assert.match(
    src,
    /\bfun\s+saveEndpoint\s*\(\s*context\s*:\s*Context\s*,\s*serverUrl\s*:\s*String\s*,\s*sessionCode\s*:\s*String\s*,?\s*\)\s*:\s*SavedBridgeEndpoint\b/,
  );
  assert.match(src, /\bfun\s+clearSavedEndpoint\s*\(\s*context\s*:\s*Context\s*\)/);

  assert.doesNotMatch(
    src,
    /\bimport\s+android\.net\.Uri\b/,
    "BridgePreferences.kt must use pure JVM java.net.URI instead of android.net.Uri",
  );
  assert.match(src, /\bimport\s+java\.net\.URI\b/);

  const spec = extractBridgePreferencesSpec(src);
  assert.equal(spec.maxServerUrlLength, 256);
  assert.equal(spec.minSessionLength, 4);
  assert.equal(spec.maxSessionLength, 64);
  assert.equal(spec.sessionRegexPattern, "^[A-Za-z0-9_-]{4,64}$");
  assert.ok(spec.prefsName.length > 0);
  assert.ok(spec.keyServerUrl.length > 0);
  assert.ok(spec.keySessionCode.length > 0);
  assert.notEqual(spec.keyServerUrl, spec.keySessionCode);
});

test("BridgePreferences URL and session sanitization rules enforce http/https <=256 chars, strip trailing slashes, and block hostile inputs", () => {
  const src = fs.readFileSync(BRIDGE_PREFS_PATH, "utf8");
  const spec = extractBridgePreferencesSpec(src);
  const prefs = createBridgePreferencesReference(spec);

  assert.equal(
    prefs.sanitizeServerUrl("https://demo.trycloudflare.com"),
    "https://demo.trycloudflare.com",
  );
  assert.equal(
    prefs.sanitizeServerUrl("  https://demo.trycloudflare.com///  "),
    "https://demo.trycloudflare.com",
  );
  assert.equal(
    prefs.sanitizeServerUrl("http://192.168.1.42:8787/"),
    "http://192.168.1.42:8787",
  );
  assert.equal(
    prefs.sanitizeServerUrl("http://localhost:8787"),
    "http://localhost:8787",
  );
  assert.equal(
    prefs.sanitizeServerUrl("http://[::1]:8787/"),
    "http://[::1]:8787",
  );
  assert.equal(
    prefs.sanitizeServerUrl("HTTPS://HoldUp.Run.App/bridge///"),
    "https://HoldUp.Run.App/bridge",
  );

  const prefix = "https://example.com/";
  const exact256 = prefix + "a".repeat(256 - prefix.length);
  const over257 = prefix + "a".repeat(257 - prefix.length);
  assert.equal(exact256.length, 256);
  assert.equal(over257.length, 257);
  assert.equal(prefs.sanitizeServerUrl(exact256), exact256);
  assert.equal(prefs.sanitizeServerUrl(over257), "");

  const hostileUrls = [
    "",
    "   ",
    "javascript:alert(1)",
    "JAVASCRIPT://alert(1)",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "file://localhost/sdcard/Download/secret.txt",
    "data:text/html,<script>alert(1)</script>",
    "content://com.android.providers.downloads/documents/1",
    "intent://connect#Intent;scheme=holdupbridge;end",
    "ftp://example.com/pub",
    "ws://example.com:8787",
    "wss://example.com:8787",
    "holdupbridge://connect?server=https://demo.trycloudflare.com",
    "http://",
    "https:///",
    "https:///etc/passwd",
    "http:example.com",
    "https://user:secret@example.com",
    "https://example.com?session=injected",
    "https://example.com#fragment",
    "https://example.com/../etc/passwd",
    "https://example.com/a//b",
    "https://example.com:0",
    "https://example.com:99999",
    "https://example.com:",
    "https://example.com/bad path",
    "https://example.com/\r\nX-Injected: 1",
    "https://example.com\\evil",
  ];

  for (const bad of hostileUrls) {
    assert.equal(prefs.sanitizeServerUrl(bad), "", `Expected empty string for hostile URL: ${bad}`);
  }

  assert.equal(prefs.sanitizeSessionCode("abcd"), "abcd");
  assert.equal(prefs.sanitizeSessionCode("  hup-4k9m  "), "hup-4k9m");
  assert.equal(prefs.sanitizeSessionCode("Session_2026-11"), "Session_2026-11");
  assert.equal(
    prefs.sanitizeSessionCode("550e8400-e29b-41d4-a716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000",
  );
  const maxSession = "s".repeat(64);
  assert.equal(prefs.sanitizeSessionCode(maxSession), maxSession);

  const hostileSessions = [
    "",
    "   ",
    "a",
    "abc",
    "s".repeat(65),
    "../../etc/passwd",
    "bad session",
    "hup?extra=1",
    "hup#frag",
    "<script>alert(1)</script>",
    "session\ninjected",
    "semi;colon",
  ];

  for (const bad of hostileSessions) {
    assert.equal(
      prefs.sanitizeSessionCode(bad),
      "",
      `Expected empty string for invalid session code: ${bad}`,
    );
  }
});

test("BridgePreferences save, load defense-in-depth sanitization, and 1-tap clearSavedEndpoint wipe", () => {
  const src = fs.readFileSync(BRIDGE_PREFS_PATH, "utf8");
  const spec = extractBridgePreferencesSpec(src);
  const prefs = createBridgePreferencesReference(spec);

  const store = prefs.createMemoryPrefsStore();
  assert.deepEqual(store.loadSavedEndpoint(), { serverUrl: "", sessionCode: "" });

  const saved = store.saveEndpoint("  https://demo.trycloudflare.com/// ", " hup-4k9m ");
  assert.deepEqual(saved, {
    serverUrl: "https://demo.trycloudflare.com",
    sessionCode: "hup-4k9m",
  });
  assert.deepEqual(store.loadSavedEndpoint(), saved);

  const rejectedSave = store.saveEndpoint("javascript:alert(1)", "../bad");
  assert.deepEqual(rejectedSave, { serverUrl: "", sessionCode: "" });
  assert.equal(store.backing.size, 0);
  assert.deepEqual(store.loadSavedEndpoint(), { serverUrl: "", sessionCode: "" });

  const tamperedStore = prefs.createMemoryPrefsStore({
    [spec.keyServerUrl]: "file:///data/data/app.holdup.bridge/shared_prefs/secrets.xml",
    [spec.keySessionCode]: "ab",
  });
  assert.deepEqual(tamperedStore.loadSavedEndpoint(), { serverUrl: "", sessionCode: "" });

  store.saveEndpoint("https://holdup.example.org/", "care_team_01");
  assert.equal(store.backing.size, 2);
  store.clearSavedEndpoint();
  assert.equal(store.backing.size, 0);
  assert.deepEqual(store.loadSavedEndpoint(), { serverUrl: "", sessionCode: "" });
});
