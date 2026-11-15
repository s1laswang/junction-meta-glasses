import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceState } from "../../shared/types.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import { getHub, getOrCreateHub, markLatest, type Hub } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

const EM_DASH = "\u2014";
const SLASH = "/";
const STAR = "*";
const AUTH_HINT = " (access key missing or wrong: add ?key=... to Server URL)";
const TUNNEL_KEY = "holdup-0630-lock-key_99";

const origHoldupKey = process.env.HOLDUP_KEY;
const origQuiet = process.env.HOLDUP_QUIET;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;

const ledgerTmpDir = fs.mkdtempSync("/dev/shm/holdup-gw2-deeplink-");
env.ledgerPath = path.join(ledgerTmpDir, "ledger.jsonl");

let server: http.Server;
let baseUrl = "";
const trackedHubIds = new Set<string>();

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function kotlinJavaUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(new RegExp("[!\\x27()~]", "g"), (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeServerMirror(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return s;
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = `https://${s}`;
  return s;
}

function uploaderEndpointMirror(serverInput: string, routePath: string, session: string): string {
  const raw = serverInput.trim();
  const q = raw.indexOf("?");
  const host = q >= 0 ? raw.slice(0, q) : raw;
  const params: string[] = [];
  if (q >= 0) {
    for (const part of raw.slice(q + 1).split("&")) {
      if (part.trim().length > 0) params.push(part);
    }
  }
  const s = session.trim();
  if (s.length > 0) params.push(`session=${kotlinJavaUrlEncode(s)}`);
  const base = normalizeServerMirror(host) + routePath;
  return params.length === 0 ? base : `${base}?${params.join("&")}`;
}

interface DeepLinkConfigMirror {
  server: string | null;
  session: string | null;
}

function parseDeepLinkMirror(
  scheme: string | null,
  host: string | null,
  serverParam: string | null,
  sessionParam: string | null,
  keyParam: string | null,
): DeepLinkConfigMirror | null {
  if (scheme !== "holdupbridge" || host !== "connect") return null;
  const trimmedServer = serverParam?.trim() ? serverParam.trim() : null;
  const trimmedSession = sessionParam?.trim() ? sessionParam.trim() : null;
  const trimmedKey = keyParam?.trim() ? keyParam.trim() : null;
  let resolvedServer = trimmedServer;
  if (trimmedServer !== null && trimmedKey !== null) {
    const q = trimmedServer.indexOf("?");
    const queryBeforeHash = q >= 0 ? trimmedServer.slice(q + 1).split("#")[0] : "";
    const hasKey =
      q >= 0 &&
      queryBeforeHash.split("&").some((part) => part === "key" || part.startsWith("key="));
    if (!hasKey) {
      const sep =
        q < 0
          ? "?"
          : trimmedServer.endsWith("?") || trimmedServer.endsWith("&")
            ? ""
            : "&";
      resolvedServer = `${trimmedServer}${sep}key=${kotlinJavaUrlEncode(trimmedKey)}`;
    }
  }
  return { server: resolvedServer, session: trimmedSession };
}

function resolveTargetMirror(
  serverUrl: string,
  sessionCode: string,
): { server: string; code: string } | null {
  const normalized = normalizeServerMirror(serverUrl);
  const code = sessionCode.trim();
  return normalized.length === 0 ? null : { server: normalized, code };
}

function parseQrDeepLinkUri(rawUri: string): DeepLinkConfigMirror | null {
  const parsed = new URL(rawUri);
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname || parsed.host;
  return parseDeepLinkMirror(
    scheme,
    host,
    parsed.searchParams.get("server"),
    parsed.searchParams.get("session"),
    parsed.searchParams.get("key"),
  );
}

function frameHttpHintMirror(code: number): string {
  if (code === 401 || code === 403) return AUTH_HINT;
  if (code === 404) return " (server has no /ingest/frame? check URL/branch)";
  if (code === 400 || code === 410) return " (unknown session code?)";
  if (code === 502 || code === 503 || code === 530) return " (tunnel up but server down?)";
  return "";
}

function scanSourceStructure(name: string, source: string): { commentCount: number } {
  const stack: string[] = [];
  let commentCount = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    const next2 = i + 2 < source.length ? source[i + 2] : "";

    if (ch === SLASH && next === SLASH) {
      commentCount += 1;
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === SLASH && next === STAR) {
      commentCount += 1;
      i += 2;
      while (i + 1 < source.length && !(source[i] === STAR && source[i + 1] === SLASH)) i += 1;
      assert.ok(i + 1 < source.length, `Unclosed block comment in ${name}`);
      i += 2;
      continue;
    }
    if (ch === '"' && next === '"' && next2 === '"') {
      i += 3;
      while (
        i + 2 < source.length &&
        !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"')
      ) {
        i += 1;
      }
      assert.ok(i + 2 < source.length, `Unclosed triple-quoted string in ${name}`);
      i += 3;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i += 2;
        else i += 1;
      }
      assert.ok(i < source.length, `Unclosed double-quoted string in ${name}`);
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\") i += 2;
        else i += 1;
      }
      assert.ok(i < source.length, `Unclosed single-quoted literal in ${name}`);
      i += 1;
      continue;
    }
    if (ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") i += 2;
        else i += 1;
      }
      assert.ok(i < source.length, `Unclosed template string in ${name}`);
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === ")" || ch === "]") {
      assert.ok(stack.length > 0, `Unmatched closing '${ch}' in ${name}`);
      const open = stack.pop()!;
      const expected = open === "{" ? "}" : open === "(" ? ")" : "]";
      assert.equal(ch, expected, `Mismatched delimiter in ${name}: opened '${open}', closed '${ch}'`);
    }
    i += 1;
  }
  assert.equal(stack.length, 0, `Unclosed delimiters in ${name}: ${stack.join("")}`);
  return { commentCount };
}

function makeValidJpeg(byteLength = 192, seed = 0x44): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf.fill(seed & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

function createTrackedHub(id: string): Hub {
  trackedHubIds.add(id);
  const hub = getOrCreateHub(id);
  hub.dropFrames();
  hub.live = undefined;
  hub.device = undefined;
  hub.source = "glasses";
  return hub;
}

interface HealthResponse {
  ok: boolean;
  glasses: {
    source: "phone" | "glasses" | null;
    device: DeviceState | null;
    framesAccepted: number;
    framesDropped: number;
    lastFrameAgoS: number | null;
  };
}

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  return (await res.json()) as HealthResponse;
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  env.apiKey = "";
  delete process.env.HOLDUP_KEY;
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected tcp server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  env.apiKey = "";
});

afterEach(() => {
  restoreHoldupKey();
  env.apiKey = origApiKey;
  for (const id of trackedHubIds) {
    const hub = getHub(id);
    if (hub) {
      hub.dropFrames();
      hub.live = undefined;
      hub.device = undefined;
      hub.source = "phone";
    }
  }
});

after(async () => {
  try {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    restoreHoldupKey();
    env.apiKey = origApiKey;
    env.ledgerPath = origLedgerPath;
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    fs.rmSync(ledgerTmpDir, { recursive: true, force: true });
  }
});

test("all android-dat Kotlin main and test sources have balanced delimiters, zero em dashes, and zero comments in new files and edited sections", () => {
  const mainKtDir = path.join(REPO_ROOT, "android-dat/app/src/main/java/app/holdup/bridge");
  const testKtDir = path.join(REPO_ROOT, "android-dat/app/src/test/java/app/holdup/bridge");

  const mainFiles = fs.readdirSync(mainKtDir).filter((f) => f.endsWith(".kt")).sort();
  const testFiles = fs.readdirSync(testKtDir).filter((f) => f.endsWith(".kt")).sort();
  assert.ok(mainFiles.includes("BridgeViewModel.kt"));
  assert.ok(testFiles.includes("DeepLinkAndAuthHintTest.kt"));

  for (const file of mainFiles) {
    const full = path.join(mainKtDir, file);
    const src = fs.readFileSync(full, "utf8");
    assert.equal(src.includes(EM_DASH), false, `Unexpected em dash in ${file}`);
    assert.match(src, /^package app\.holdup\.bridge\b/);
    scanSourceStructure(file, src);
  }

  for (const file of testFiles) {
    const full = path.join(testKtDir, file);
    const src = fs.readFileSync(full, "utf8");
    assert.equal(src.includes(EM_DASH), false, `Unexpected em dash in ${file}`);
    assert.match(src, /^package app\.holdup\.bridge\b/);
    const stats = scanSourceStructure(file, src);
    if (file === "DeepLinkAndAuthHintTest.kt") {
      assert.equal(stats.commentCount, 0, "DeepLinkAndAuthHintTest.kt must have zero comments");
    }
  }

  const vmSrc = fs.readFileSync(path.join(mainKtDir, "BridgeViewModel.kt"), "utf8");
  const extractBalancedFunctionOrBlock = (src: string, anchor: string): string => {
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, `Missing anchor ${anchor}`);
    const firstBrace = src.indexOf("{", start);
    assert.ok(firstBrace >= start, `Missing '{' after ${anchor}`);
    let depth = 0;
    let idx = firstBrace;
    while (idx < src.length) {
      if (src[idx] === '"') {
        idx += 1;
        while (idx < src.length && src[idx] !== '"') {
          idx += src[idx] === "\\" ? 2 : 1;
        }
      } else if (src[idx] === "'") {
        idx += 1;
        while (idx < src.length && src[idx] !== "'") {
          idx += src[idx] === "\\" ? 2 : 1;
        }
      } else if (src[idx] === "{") {
        depth += 1;
      } else if (src[idx] === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(start, idx + 1);
      }
      idx += 1;
    }
    throw new Error(`Unclosed block starting at ${anchor}`);
  };

  for (const anchor of [
    "internal fun parseDeepLink(",
    "internal fun frameHttpHint(code: Int)",
    "fun handleDeepLink(uri: Uri?)",
    "private fun pushState(force: Boolean = false)",
  ]) {
    const block = extractBalancedFunctionOrBlock(vmSrc, anchor);
    assert.equal(scanSourceStructure(anchor, block).commentCount, 0);
  }

  const selfPath = path.join(REPO_ROOT, "server/test/android-dat-deeplink-auth-hint.test.ts");
  const selfSrc = fs.readFileSync(selfPath, "utf8");
  assert.equal(selfSrc.includes(EM_DASH), false);
  assert.equal(scanSourceStructure("android-dat-deeplink-auth-hint.test.ts", selfSrc).commentCount, 0);
});

test("BridgeViewModel.kt and DeepLinkAndAuthHintTest.kt implement exact 401/403 frameHttpHint, pushState auth error + clear-on-Ok, and parseDeepLink wiring", () => {
  const vmPath = path.join(
    REPO_ROOT,
    "android-dat/app/src/main/java/app/holdup/bridge/BridgeViewModel.kt",
  );
  const vmSrc = fs.readFileSync(vmPath, "utf8");

  assert.ok(vmSrc.includes("import java.net.URLEncoder"));
  assert.ok(
    vmSrc.includes("internal data class DeepLinkConfig(val server: String?, val session: String?)"),
  );
  assert.match(
    vmSrc,
    new RegExp(
      "internal fun parseDeepLink\\(\\s*scheme:\\s*String\\?,\\s*host:\\s*String\\?,\\s*server:\\s*String\\?,\\s*session:\\s*String\\?,\\s*key:\\s*String\\?,?\\s*\\):\\s*DeepLinkConfig\\?",
    ),
  );
  assert.ok(
    vmSrc.includes(`401, 403 -> "${AUTH_HINT}"`),
  );
  assert.ok(vmSrc.includes('uri.scheme != "holdupbridge"'));
  assert.ok(vmSrc.includes('uri.host != "connect"'));
  assert.ok(vmSrc.includes('uri.getQueryParameter("key")'));
  assert.ok(
    vmSrc.includes('setError("Server rejected state: HTTP ${res.code}${frameHttpHint(res.code)}")'),
  );
  assert.ok(vmSrc.includes("res.code == 401 || res.code == 403"));

  const clearTarget = 'error = if (it.error?.startsWith("Server") == true) null else it.error';
  const clearCount = vmSrc.split(clearTarget).length - 1;
  assert.ok(
    clearCount >= 2,
    "Both onFrame and pushState must clear 'Server...' errors on PostResult.Ok",
  );

  const junitPath = path.join(
    REPO_ROOT,
    "android-dat/app/src/test/java/app/holdup/bridge/DeepLinkAndAuthHintTest.kt",
  );
  const junitSrc = fs.readFileSync(junitPath, "utf8");
  assert.ok(junitSrc.includes("class DeepLinkAndAuthHintTest"));
  for (const code of [401, 403, 404, 400, 410, 502, 503, 530, 200]) {
    assert.ok(junitSrc.includes(`frameHttpHint(${code})`), `Missing frameHttpHint(${code}) in JUnit test`);
  }
  assert.ok(junitSrc.includes("BridgeViewModel.parseDeepLink"));
  assert.ok(junitSrc.includes("Uploader.endpoint"));
});

test("StringsParityTest invariants hold across EN/FI/SV strings.xml and all Kotlin/Manifest string references", () => {
  const resDir = path.join(REPO_ROOT, "android-dat/app/src/main/res");
  const localePaths = {
    en: path.join(resDir, "values/strings.xml"),
    fi: path.join(resDir, "values-fi/strings.xml"),
    sv: path.join(resDir, "values-sv/strings.xml"),
  };

  type Entry = { name: string; value: string; translatable: boolean };
  const parseLocale = (p: string): Map<string, Entry> => {
    const xml = fs.readFileSync(p, "utf8");
    assert.equal(xml.includes("<!--"), false, `XML comment forbidden in ${p}`);
    assert.equal(xml.includes(EM_DASH), false, `Em dash forbidden in ${p}`);
    assert.match(xml, /<resources>\s*[\s\S]*<\/resources>/);

    const out = new Map<string, Entry>();
    const nameAttrRe = new RegExp('\\bname="([^"]+)"');
    const transAttrRe = new RegExp('\\btranslatable="([^"]+)"');
    for (const m of xml.matchAll(/<string\s+([^>]+)>([\s\S]*?)<\/string>/g)) {
      const attrs = m[1];
      const val = m[2];
      const name = nameAttrRe.exec(attrs)?.[1] ?? "";
      assert.ok(name.length > 0);
      assert.equal(out.has(name), false);
      assert.ok(val.trim().length > 0);
      assert.equal(val, val.trim());
      const translatable = transAttrRe.exec(attrs)?.[1]?.toLowerCase() !== "false";
      out.set(name, { name, value: val, translatable });
    }
    return out;
  };

  const placeholders = (s: string) =>
    Array.from(s.matchAll(/%(\d+\$)?[-#+ 0,]*\d*(\.\d+)?[a-zA-Z]/g), (m) => m[0]);

  const en = parseLocale(localePaths.en);
  const fi = parseLocale(localePaths.fi);
  const sv = parseLocale(localePaths.sv);

  assert.deepEqual([...fi.keys()].sort(), [...en.keys()].sort());
  assert.deepEqual([...sv.keys()].sort(), [...en.keys()].sort());

  for (const [k, enItem] of en) {
    const fiItem = fi.get(k)!;
    const svItem = sv.get(k)!;
    assert.deepEqual(placeholders(fiItem.value), placeholders(enItem.value));
    assert.deepEqual(placeholders(svItem.value), placeholders(enItem.value));
    if (k === "app_name") {
      assert.equal(enItem.value, "HoldUp Bridge");
      assert.equal(fiItem.value, "HoldUp Bridge");
      assert.equal(svItem.value, "HoldUp Bridge");
    } else if (enItem.translatable) {
      assert.notEqual(fiItem.value, enItem.value);
      assert.notEqual(svItem.value, enItem.value);
      assert.notEqual(fiItem.value, svItem.value);
    }
  }

  const mainDir = path.join(REPO_ROOT, "android-dat/app/src/main");
  const refs = new Set<string>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".xml")) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/@string\/([A-Za-z0-9_]+)/g)) {
          refs.add(m[1]);
        }
      } else if (ent.name.endsWith(".kt")) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/R\.string\.([A-Za-z0-9_]+)/g)) {
          refs.add(m[1]);
        }
      }
    }
  };
  walk(mainDir);
  assert.ok(refs.size > 0);
  for (const ref of refs) {
    assert.equal(en.has(ref), true, `Missing EN string ${ref}`);
    assert.equal(fi.has(ref), true, `Missing FI string ${ref}`);
    assert.equal(sv.has(ref), true, `Missing SV string ${ref}`);
  }
});

test("parseDeepLink and frameHttpHint contract covers 401/403/404/400/410/502/503/530/200, QR ?key= variants, duplicate guard, and special URL chars", () => {
  assert.equal(frameHttpHintMirror(401), AUTH_HINT);
  assert.equal(frameHttpHintMirror(403), AUTH_HINT);
  assert.equal(frameHttpHintMirror(404), " (server has no /ingest/frame? check URL/branch)");
  assert.equal(frameHttpHintMirror(400), " (unknown session code?)");
  assert.equal(frameHttpHintMirror(410), " (unknown session code?)");
  assert.equal(frameHttpHintMirror(502), " (tunnel up but server down?)");
  assert.equal(frameHttpHintMirror(503), " (tunnel up but server down?)");
  assert.equal(frameHttpHintMirror(530), " (tunnel up but server down?)");
  assert.equal(frameHttpHintMirror(200), "");
  assert.equal(frameHttpHintMirror(204), "");

  assert.equal(parseDeepLinkMirror("https", "connect", "https://x.trycloudflare.com", "S1", "K"), null);
  assert.equal(parseDeepLinkMirror("holdupbridge", "disconnect", "https://x.trycloudflare.com", "S1", "K"), null);
  assert.equal(parseDeepLinkMirror(null, "connect", "https://x.trycloudflare.com", "S1", "K"), null);
  assert.equal(parseDeepLinkMirror("holdupbridge", null, "https://x.trycloudflare.com", "S1", "K"), null);

  assert.deepEqual(
    parseQrDeepLinkUri("holdupbridge://connect?server=https://x.trycloudflare.com&key=SECRET&session=S1"),
    { server: "https://x.trycloudflare.com?key=SECRET", session: "S1" },
  );

  assert.deepEqual(
    parseQrDeepLinkUri(
      "holdupbridge://connect?server=https%3A%2F%2Fx.trycloudflare.com%2F%3Fkey%3DSECRET&session=S1",
    ),
    { server: "https://x.trycloudflare.com/?key=SECRET", session: "S1" },
  );

  assert.deepEqual(
    parseQrDeepLinkUri(
      "holdupbridge://connect?server=https%3A%2F%2Fx.trycloudflare.com%2F%3Fkey%3DFIRST&key=SECOND&session=S1",
    ),
    { server: "https://x.trycloudflare.com/?key=FIRST", session: "S1" },
  );

  assert.deepEqual(
    parseDeepLinkMirror("holdupbridge", "connect", "https://x.trycloudflare.com/?monkey=1", "S1", "SECRET"),
    { server: "https://x.trycloudflare.com/?monkey=1&key=SECRET", session: "S1" },
  );

  assert.deepEqual(
    parseDeepLinkMirror("holdupbridge", "connect", "   ", "  S1  ", "SECRET"),
    { server: null, session: "S1" },
  );
});

test("real Express server with HOLDUP_KEY returns 401 without ?key= (matching frameHttpHint(401)) and 204 via parseDeepLink + Uploader.endpoint across top-level, encoded, duplicate-guarded, and special-char keys", async () => {
  process.env.HOLDUP_KEY = TUNNEL_KEY;
  try {
    const session = "dat-0630-qr-sess";
    const hub = createTrackedHub(session);
    markLatest(hub);

    const beforeHealth = await fetchHealth();
    const jpeg = makeValidJpeg(208, 0x52);
    const statePayload = JSON.stringify({
      connected: true,
      worn: true,
      battery: 88,
      streaming: true,
    });

    const missingKeyQr = parseQrDeepLinkUri(
      `holdupbridge://connect?server=${encodeURIComponent(baseUrl)}&session=${session}`,
    );
    assert.ok(missingKeyQr?.server);
    const missingTarget = resolveTargetMirror(missingKeyQr.server, missingKeyQr.session ?? "")!;

    const unauthFrameRes = await fetch(
      uploaderEndpointMirror(missingTarget.server, "/ingest/frame", missingTarget.code),
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: jpeg,
      },
    );
    assert.equal(unauthFrameRes.status, 401);
    assert.equal(
      `Server rejected frame: HTTP ${unauthFrameRes.status}${frameHttpHintMirror(unauthFrameRes.status)}`,
      `Server rejected frame: HTTP 401${AUTH_HINT}`,
    );

    const unauthStateRes = await fetch(
      uploaderEndpointMirror(missingTarget.server, "/ingest/state", missingTarget.code),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: statePayload,
      },
    );
    assert.equal(unauthStateRes.status, 401);
    assert.equal(
      `Server rejected state: HTTP ${unauthStateRes.status}${frameHttpHintMirror(unauthStateRes.status)}`,
      `Server rejected state: HTTP 401${AUTH_HINT}`,
    );
    assert.equal(hub.ring.length, 0);
    assert.equal(hub.device, undefined);

    const topLevelQr = parseQrDeepLinkUri(
      `holdupbridge://connect?server=${baseUrl}&key=${TUNNEL_KEY}&session=${session}`,
    );
    assert.deepEqual(topLevelQr, {
      server: `${baseUrl}?key=${TUNNEL_KEY}`,
      session,
    });
    const topTarget = resolveTargetMirror(topLevelQr!.server!, topLevelQr!.session ?? "")!;
    const topFrameUrl = uploaderEndpointMirror(topTarget.server, "/ingest/frame", topTarget.code);
    const topStateUrl = uploaderEndpointMirror(topTarget.server, "/ingest/state", topTarget.code);
    assert.equal(topFrameUrl, `${baseUrl}/ingest/frame?key=${TUNNEL_KEY}&session=${session}`);
    assert.equal(topStateUrl, `${baseUrl}/ingest/state?key=${TUNNEL_KEY}&session=${session}`);

    const okFrameTop = await fetch(topFrameUrl, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: jpeg,
    });
    assert.equal(okFrameTop.status, 204);

    const okStateTop = await fetch(topStateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: statePayload,
    });
    assert.equal(okStateTop.status, 204);
    assert.equal(hub.ring.length, 1);
    assert.deepEqual(hub.device, {
      connected: true,
      worn: true,
      battery: 88,
      streaming: true,
      source: "glasses",
    });

    const embeddedServer = `${baseUrl}/?key=${TUNNEL_KEY}`;
    const dupGuardedQr = parseQrDeepLinkUri(
      `holdupbridge://connect?server=${encodeURIComponent(embeddedServer)}&key=${TUNNEL_KEY}&session=${session}`,
    );
    assert.deepEqual(dupGuardedQr, {
      server: `${baseUrl}/?key=${TUNNEL_KEY}`,
      session,
    });
    const dupTarget = resolveTargetMirror(dupGuardedQr!.server!, dupGuardedQr!.session ?? "")!;
    const okFrameDup = await fetch(
      uploaderEndpointMirror(dupTarget.server, "/ingest/frame", dupTarget.code),
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: makeValidJpeg(212, 0x61),
      },
    );
    assert.equal(okFrameDup.status, 204);
    assert.equal(hub.ring.length, 2);

    const afterTopHealth = await fetchHealth();
    assert.equal(afterTopHealth.glasses.framesAccepted, beforeHealth.glasses.framesAccepted + 2);

    const specialSecret = "hk+2026/a=b&c?d#e f";
    process.env.HOLDUP_KEY = specialSecret;
    const specialQr = parseQrDeepLinkUri(
      `holdupbridge://connect?server=${encodeURIComponent(baseUrl)}&key=${encodeURIComponent(specialSecret)}&session=${encodeURIComponent("room 7/a")}`,
    );
    assert.ok(specialQr?.server);
    const specialHub = createTrackedHub("room 7/a");
    markLatest(specialHub);
    const specialTarget = resolveTargetMirror(specialQr.server, specialQr.session ?? "")!;

    const specialFrameRes = await fetch(
      uploaderEndpointMirror(specialTarget.server, "/ingest/frame", specialTarget.code),
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: makeValidJpeg(200, 0x73),
      },
    );
    assert.equal(specialFrameRes.status, 204);

    const specialStateRes = await fetch(
      uploaderEndpointMirror(specialTarget.server, "/ingest/state", specialTarget.code),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connected: true, worn: null, battery: null, streaming: true }),
      },
    );
    assert.equal(specialStateRes.status, 204);
  } finally {
    restoreHoldupKey();
  }
});
