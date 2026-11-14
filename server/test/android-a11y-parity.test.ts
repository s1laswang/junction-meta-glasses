import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { DeviceState, ServerMsg } from "../../shared/types.ts";
import {
  buildBridgeDeepLink,
  buildHudUrl,
  buildMetaWebAppDeepLink,
  normalizeServerOrigin,
} from "../../web/src/pairing/links.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import {
  getHub,
  getOrCreateHub,
  latestHub,
  markLatest,
  resetHubsForTest,
  type LiveLike,
} from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { jpegSharpness, jpegSize } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";

const SELF_FILE = fileURLToPath(import.meta.url);
const ANDROID_ROOT = path.join(REPO_ROOT, "android-dat");
const SETTINGS_GRADLE_PATH = path.join(ANDROID_ROOT, "settings.gradle.kts");
const APP_BUILD_GRADLE_PATH = path.join(ANDROID_ROOT, "app", "build.gradle.kts");
const LIBS_VERSIONS_TOML_PATH = path.join(ANDROID_ROOT, "gradle", "libs.versions.toml");
const MANIFEST_PATH = path.join(ANDROID_ROOT, "app", "src", "main", "AndroidManifest.xml");
const RES_ROOT = path.join(ANDROID_ROOT, "app", "src", "main", "res");
const BRIDGE_JAVA_ROOT = path.join(
  ANDROID_ROOT,
  "app",
  "src",
  "main",
  "java",
  "app",
  "holdup",
  "bridge",
);
const MAIN_ACTIVITY_KT = path.join(BRIDGE_JAVA_ROOT, "MainActivity.kt");
const INGEST_CLIENT_KT = path.join(BRIDGE_JAVA_ROOT, "IngestClient.kt");
const YUV_ENCODER_KT = path.join(BRIDGE_JAVA_ROOT, "YuvJpegEncoder.kt");
const BRIDGE_PREFS_KT = path.join(BRIDGE_JAVA_ROOT, "BridgePreferences.kt");
const STREAMING_SERVICE_KT = path.join(BRIDGE_JAVA_ROOT, "StreamingForegroundService.kt");
const DAT_CONTROLLER_KT = path.join(BRIDGE_JAVA_ROOT, "DatBridgeController.kt");
const SERVER_INDEX_TS = path.join(REPO_ROOT, "server", "src", "index.ts");

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const SCHEME_SEP = ":" + SLASH + SLASH;
const LINE_COMMENT_TOKEN = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const XML_COMMENT_OPEN = "<" + "!--";
const XML_COMMENT_CLOSE = "--" + ">";
const EM_DASH = String.fromCharCode(0x2014);
const CO_AUTHORED_TOKEN = ["Co", "Authored", "By"].join("-");
const API_KEY_PREFIX = "AI" + "za";
const ANDROID_NS = `http${SCHEME_SEP}schemas.android.com/apk/res/android`;

type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};

function parseXmlAttributes(rawAttrs: string, contextLabel: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const trimmed = rawAttrs.trim();
  if (trimmed.length === 0) return attrs;

  const attrRegex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(trimmed)) !== null) {
    const gap = trimmed.slice(cursor, match.index).trim();
    assert.equal(gap, "", `${contextLabel}: unexpected XML attribute token '${gap}'`);
    const [, attrName, attrValue] = match;
    assert.equal(
      Object.prototype.hasOwnProperty.call(attrs, attrName),
      false,
      `${contextLabel}: duplicate XML attribute '${attrName}'`,
    );
    attrs[attrName] = attrValue;
    cursor = match.index + match[0].length;
  }

  const trailing = trimmed.slice(cursor).trim();
  assert.equal(trailing, "", `${contextLabel}: trailing XML attribute content '${trailing}'`);
  return attrs;
}

function parseXmlDocument(source: string, fileLabel: string): XmlNode {
  const prologMatch = /^\s*<\?xml\s+version="1\.0"\s+encoding="utf-8"\?>/i.exec(source);
  assert.ok(prologMatch, `${fileLabel}: missing UTF-8 XML 1.0 prolog`);

  let index = prologMatch[0].length;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  while (index < source.length) {
    const nextLt = source.indexOf("<", index);
    if (nextLt === -1) {
      assert.equal(source.slice(index).trim(), "", `${fileLabel}: unexpected trailing text`);
      break;
    }

    const chunk = source.slice(index, nextLt);
    if (stack.length > 0) {
      stack[stack.length - 1].text += chunk;
    } else {
      assert.equal(chunk.trim(), "", `${fileLabel}: unexpected text outside root`);
    }

    assert.equal(source.startsWith("<!", nextLt), false, `${fileLabel}: forbidden XML declaration or comment`);
    assert.equal(source.startsWith("<?", nextLt), false, `${fileLabel}: unexpected processing instruction`);

    const nextGt = source.indexOf(">", nextLt + 1);
    assert.notEqual(nextGt, -1, `${fileLabel}: unclosed XML tag`);
    const rawBody = source.slice(nextLt + 1, nextGt).trim();
    assert.ok(rawBody.length > 0, `${fileLabel}: empty XML tag`);

    if (rawBody.startsWith(SLASH)) {
      const closeTag = rawBody.slice(1).trim();
      const opened = stack.pop();
      assert.ok(opened, `${fileLabel}: closing tag </${closeTag}> with empty stack`);
      assert.equal(opened.tag, closeTag, `${fileLabel}: mismatched </${closeTag}> for <${opened.tag}>`);
      opened.text = opened.text.trim();
    } else {
      const selfClosing = rawBody.endsWith(SLASH);
      const inner = selfClosing ? rawBody.slice(0, -1).trim() : rawBody;
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(inner);
      assert.ok(nameMatch, `${fileLabel}: invalid tag <${rawBody}>`);
      const [, tagName, rawAttrs] = nameMatch;
      const node: XmlNode = {
        tag: tagName,
        attrs: parseXmlAttributes(rawAttrs, `${fileLabel}:<${tagName}>`),
        text: "",
        children: [],
      };

      if (stack.length === 0) {
        assert.equal(root, null, `${fileLabel}: multiple root elements`);
        root = node;
      } else {
        stack[stack.length - 1].children.push(node);
      }

      if (!selfClosing) {
        stack.push(node);
      }
    }

    index = nextGt + 1;
  }

  assert.equal(stack.length, 0, `${fileLabel}: unclosed tags ${stack.map((n) => n.tag).join(",")}`);
  assert.ok(root, `${fileLabel}: missing root element`);
  return root;
}

function findDescendants(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.tag === tag) out.push(child);
    findDescendants(child, tag, out);
  }
  return out;
}

type TomlLibraryEntry = {
  group: string;
  name: string;
  version?: string;
  versionRef?: string;
};

function parseLibsVersionsToml(source: string): {
  versions: Record<string, string>;
  libraries: Record<string, TomlLibraryEntry>;
} {
  const versions: Record<string, string> = {};
  const libraries: Record<string, TomlLibraryEntry> = {};
  let section = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const secMatch = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (secMatch) {
      section = secMatch[1];
      continue;
    }

    if (section === "versions") {
      const kv = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"$/.exec(line);
      assert.ok(kv, `Unexpected [versions] line in libs.versions.toml: ${line}`);
      versions[kv[1]] = kv[2];
    } else if (section === "libraries") {
      const libMatch = /^([A-Za-z0-9_-]+)\s*=\s*\{(.+)\}$/.exec(line);
      assert.ok(libMatch, `Unexpected [libraries] line in libs.versions.toml: ${line}`);
      const [, alias, body] = libMatch;
      const fields: Record<string, string> = {};
      const fieldRegex = /([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = fieldRegex.exec(body)) !== null) {
        fields[m[1]] = m[2];
      }
      assert.ok(fields.group, `Library '${alias}' missing group`);
      assert.ok(fields.name, `Library '${alias}' missing name`);
      libraries[alias] = {
        group: fields.group,
        name: fields.name,
        version: fields.version,
        versionRef: fields["version.ref"],
      };
    }
  }

  return { versions, libraries };
}

function resolveMavenCoordinate(
  catalog: ReturnType<typeof parseLibsVersionsToml>,
  alias: string,
): string {
  const entry = catalog.libraries[alias];
  assert.ok(entry, `libs.versions.toml missing library '${alias}'`);
  const resolvedVersion = entry.version ?? (entry.versionRef ? catalog.versions[entry.versionRef] : undefined);
  assert.ok(resolvedVersion, `Library '${alias}' missing resolved version`);
  return `${entry.group}:${entry.name}:${resolvedVersion}`;
}

function buildSof0Jpeg(width: number, height: number, scanBytes = 320): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  sof0[10] = 1; sof0[11] = 0x22; sof0[12] = 0;
  sof0[13] = 2; sof0[14] = 0x11; sof0[15] = 1;
  sof0[16] = 3; sof0[17] = 0x11; sof0[18] = 1;
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
  ]);
  const scan = Buffer.alloc(scanBytes);
  for (let i = 0; i < scanBytes; i++) {
    scan[i] = (i * 41 + 17) & 0x7f;
  }
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, sos, scan, eoi]);
}

function sanitizeServerUrlLikeAndroid(raw: string, maxLen = 256): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return "";
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || trimmed[i] === "\\") return "";
  }
  const withoutSlashes = trimmed.replace(/[/]+$/, "");
  if (withoutSlashes.length === 0) return "";
  const colonIdx = withoutSlashes.indexOf(":");
  if (colonIdx <= 0) return "";
  const scheme = withoutSlashes.slice(0, colonIdx).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "";
  const afterScheme = withoutSlashes.slice(scheme.length);
  if (afterScheme.length < 4 || !afterScheme.startsWith(SCHEME_SEP) || afterScheme[3] === SLASH) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(scheme + afterScheme);
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  if (!parsed.hostname) return "";
  if (parsed.port !== "") {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return "";
  }
  return scheme + afterScheme;
}

type BridgeDeviceStatePayload = {
  connected: boolean;
  worn: boolean;
  battery: number | null;
  streaming: boolean;
};

class SyntheticAndroidIngestClient {
  private baseServerUrl = "";
  private activeSessionCode: string | null = null;
  framesSent = 0;
  framesDropped = 0;
  stateUpdatesSent = 0;
  lastHttpCode = 0;
  lastError: string | null = null;

  constructor(
    private readonly frameEndpointPath: string,
    private readonly stateEndpointPath: string,
    private readonly frameMediaType: string,
    private readonly jsonMediaType: string,
    private readonly sessionQueryKey: string,
  ) {}

  configure(serverUrl: string, sessionCode = ""): void {
    this.baseServerUrl = serverUrl.trim().replace(/[/]+$/, "");
    const cleanSession = sessionCode.trim();
    this.activeSessionCode = cleanSession.length > 0 ? cleanSession : null;
  }

  buildEndpointUrl(endpointPath: string): URL | null {
    if (this.baseServerUrl.length === 0) return null;
    let url: URL;
    try {
      url = new URL(`${this.baseServerUrl}${SLASH}${endpointPath}`);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (this.activeSessionCode !== null) {
      url.searchParams.set(this.sessionQueryKey, this.activeSessionCode);
    }
    return url;
  }

  serializeState(state: BridgeDeviceStatePayload): string {
    const batteryJson = state.battery !== null ? String(state.battery) : "null";
    return `{"connected":${state.connected},"worn":${state.worn},"battery":${batteryJson},"streaming":${state.streaming}}`;
  }

  async submitFrame(jpegBytes: Uint8Array): Promise<boolean> {
    if (jpegBytes.byteLength === 0) {
      this.framesDropped += 1;
      return false;
    }
    const url = this.buildEndpointUrl(this.frameEndpointPath);
    if (url === null) {
      this.framesDropped += 1;
      this.lastHttpCode = 0;
      this.lastError = "Invalid or empty server URL";
      return false;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": this.frameMediaType },
      body: new Uint8Array(jpegBytes),
    });
    if (response.ok) {
      this.framesSent += 1;
      this.lastHttpCode = response.status;
      this.lastError = null;
      return true;
    }
    this.lastHttpCode = response.status;
    this.lastError = `HTTP ${response.status}`;
    return false;
  }

  async postState(state: BridgeDeviceStatePayload): Promise<void> {
    const url = this.buildEndpointUrl(this.stateEndpointPath);
    if (url === null) {
      this.lastHttpCode = 0;
      this.lastError = "Invalid or empty server URL";
      return;
    }
    const body = this.serializeState(state);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": this.jsonMediaType },
      body,
    });
    if (response.ok) {
      this.stateUpdatesSent += 1;
      this.lastHttpCode = response.status;
      this.lastError = null;
    } else {
      this.lastHttpCode = response.status;
      this.lastError = `HTTP ${response.status}`;
    }
  }
}

function makeStubLive(): LiveLike & { frame(data: string): void; frames: string[] } {
  const frames: string[] = [];
  return {
    active: true,
    frames,
    frame(data: string) {
      frames.push(data);
    },
    handleEvent() {},
    stop() {},
  };
}

function openWs(url: string) {
  const ws = new WebSocket(url);
  const queue: ServerMsg[] = [];
  const waiters: Array<(msg: ServerMsg) => void> = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as ServerMsg;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (timeoutMs = 2000): Promise<ServerMsg> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for WebSocket message on ${url}`)),
        timeoutMs,
      );
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };
  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  return { ws, ready, next, close };
}

let server: http.Server;
let baseUrl = "";
let wsBase = "";
let prevApiKey = "";

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http${SCHEME_SEP}127.0.0.1:${port}`;
  wsBase = `ws${SCHEME_SEP}127.0.0.1:${port}`;
});

beforeEach(() => {
  resetHubsForTest();
});

after(async () => {
  resetHubsForTest();
  env.apiKey = prevApiKey;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("buildBridgeDeepLink in web/src/pairing/links.ts matches AndroidManifest.xml intent-filter and MainActivity.kt parser", () => {
  const manifestRoot = parseXmlDocument(fs.readFileSync(MANIFEST_PATH, "utf8"), "AndroidManifest.xml");
  const mainActivitySrc = fs.readFileSync(MAIN_ACTIVITY_KT, "utf8");
  const bridgePrefsSrc = fs.readFileSync(BRIDGE_PREFS_KT, "utf8");
  const serverIndexSrc = fs.readFileSync(SERVER_INDEX_TS, "utf8");

  const applicationNodes = manifestRoot.children.filter((node) => node.tag === "application");
  assert.equal(applicationNodes.length, 1);
  const activities = applicationNodes[0].children.filter((node) => node.tag === "activity");
  const mainActivityNode = activities.find(
    (node) =>
      node.attrs["android:name"] === ".MainActivity" ||
      node.attrs["android:name"] === "app.holdup.bridge.MainActivity",
  );
  assert.ok(mainActivityNode, "AndroidManifest.xml must declare .MainActivity");
  assert.equal(mainActivityNode.attrs["android:exported"], "true");
  assert.equal(mainActivityNode.attrs["android:launchMode"], "singleTop");

  const intentFilters = mainActivityNode.children.filter((node) => node.tag === "intent-filter");
  const viewFilter = intentFilters.find((filter) =>
    filter.children.some(
      (child) => child.tag === "action" && child.attrs["android:name"] === "android.intent.action.VIEW",
    ),
  );
  assert.ok(viewFilter, ".MainActivity must declare an ACTION_VIEW intent-filter");

  const categories = viewFilter.children
    .filter((child) => child.tag === "category")
    .map((child) => child.attrs["android:name"]);
  assert.ok(categories.includes("android.intent.category.DEFAULT"));
  assert.ok(categories.includes("android.intent.category.BROWSABLE"));

  const dataNodes = viewFilter.children.filter((child) => child.tag === "data");
  assert.equal(dataNodes.length, 1);
  const manifestScheme = dataNodes[0].attrs["android:scheme"];
  const manifestHost = dataNodes[0].attrs["android:host"];
  assert.equal(manifestScheme, "holdupbridge");
  assert.equal(manifestHost, "connect");

  const ktSchemeMatch = /DEEP_LINK_SCHEME\s*=\s*"([^"]+)"/.exec(mainActivitySrc);
  const ktHostMatch = /DEEP_LINK_HOST\s*=\s*"([^"]+)"/.exec(mainActivitySrc);
  assert.ok(ktSchemeMatch, "MainActivity.kt must define DEEP_LINK_SCHEME");
  assert.ok(ktHostMatch, "MainActivity.kt must define DEEP_LINK_HOST");
  assert.equal(ktSchemeMatch[1], manifestScheme);
  assert.equal(ktHostMatch[1], manifestHost);

  const queriedParams = Array.from(
    mainActivitySrc.matchAll(/getQueryParameter\(\s*"([^"]+)"\s*\)/g),
    (m) => m[1],
  );
  assert.deepEqual(queriedParams, ["server", "session"]);
  assert.match(mainActivitySrc, /\boverride\s+fun\s+onNewIntent\s*\(/);
  assert.match(mainActivitySrc, /\bBridgePreferences\.sanitizeServerUrl\s*\(/);
  assert.match(mainActivitySrc, /\bBridgePreferences\.sanitizeSessionCode\s*\(/);
  assert.match(mainActivitySrc, /\bBridgePreferences\.saveEndpoint\s*\(/);
  assert.match(mainActivitySrc, /\bDatBridgeController\.updateEndpoint\s*\(/);
  assert.match(mainActivitySrc, /\bincomingIntent\.setData\(null\)/);

  const sessionRegexMatch = /SESSION_CODE_REGEX\s*=\s*Regex\("([^"]+)"\)/.exec(bridgePrefsSrc);
  assert.ok(sessionRegexMatch, "BridgePreferences.kt must define SESSION_CODE_REGEX");
  const androidSessionRe = new RegExp(sessionRegexMatch[1]);

  const demoOrigin = `https${SCHEME_SEP}demo.trycloudflare.com`;
  const deepLink = buildBridgeDeepLink(demoOrigin, "sess123");
  assert.equal(
    deepLink,
    `${manifestScheme}${SCHEME_SEP}${manifestHost}?server=${encodeURIComponent(demoOrigin)}&session=sess123`,
  );

  const parsedLink = new URL(deepLink);
  assert.equal(parsedLink.protocol, `${manifestScheme}:`);
  assert.equal(parsedLink.hostname, manifestHost);
  assert.equal(parsedLink.pathname === "" || parsedLink.pathname === SLASH, true);
  assert.deepEqual(Array.from(parsedLink.searchParams.keys()), queriedParams);
  assert.equal(parsedLink.searchParams.get("server"), demoOrigin);
  assert.equal(parsedLink.searchParams.get("session"), "sess123");
  assert.equal(sanitizeServerUrlLikeAndroid(parsedLink.searchParams.get("server")!), demoOrigin);
  assert.equal(androidSessionRe.test(parsedLink.searchParams.get("session")!), true);

  assert.match(serverIndexSrc, /sessionParam\s*&&\s*\/\^\[\\w-\]\{4,64\}\$\/\.test\(sessionParam\)/);
  assert.equal(/^[\w-]{4,64}$/.test("sess123"), true);

  const trailingOrigin = `  ${demoOrigin}${SLASH}${SLASH}  `;
  assert.equal(normalizeServerOrigin(trailingOrigin), demoOrigin);
  assert.equal(buildBridgeDeepLink(trailingOrigin, "  sess123  "), deepLink);

  const sessionlessLink = buildBridgeDeepLink(demoOrigin);
  const parsedSessionless = new URL(sessionlessLink);
  assert.equal(parsedSessionless.protocol, `${manifestScheme}:`);
  assert.equal(parsedSessionless.hostname, manifestHost);
  assert.deepEqual(Array.from(parsedSessionless.searchParams.keys()), ["server"]);
  assert.equal(parsedSessionless.searchParams.get("server"), demoOrigin);
  assert.equal(parsedSessionless.searchParams.get("session"), null);

  const hudUrl = buildHudUrl(demoOrigin, "sess123");
  assert.equal(hudUrl, `${demoOrigin}${SLASH}hud?session=sess123`);
  const metaGlassesLink = buildMetaWebAppDeepLink(hudUrl, "HoldUp");
  const parsedGlassesLink = new URL(metaGlassesLink);
  assert.equal(parsedGlassesLink.protocol, "fb-viewapp:");
  assert.equal(parsedGlassesLink.hostname, "web_app_deep_link");
  assert.equal(parsedGlassesLink.searchParams.get("appName"), "HoldUp");
  assert.equal(new URL(parsedGlassesLink.searchParams.get("appUrl")!).searchParams.get("session"), "sess123");
});

test("IngestClient.kt and YuvJpegEncoder.kt wire contracts replay cleanly against live startServer(0) /ingest/frame and /ingest/state", async () => {
  const ingestSrc = fs.readFileSync(INGEST_CLIENT_KT, "utf8");
  const yuvSrc = fs.readFileSync(YUV_ENCODER_KT, "utf8");
  const controllerSrc = fs.readFileSync(DAT_CONTROLLER_KT, "utf8");
  const serverSrc = fs.readFileSync(SERVER_INDEX_TS, "utf8");

  const minIntervalMatch = /minFrameIntervalMs\s*:\s*Long\s*=\s*(\d+)L/.exec(ingestSrc);
  assert.ok(minIntervalMatch, "IngestClient.kt must declare default minFrameIntervalMs");
  assert.ok(Number(minIntervalMatch[1]) >= 900, "IngestClient frame throttle must be >= 900ms");

  const endpointPaths = Array.from(
    ingestSrc.matchAll(/buildEndpointUrl\(\s*"([^"]+)"\s*\)/g),
    (m) => m[1],
  );
  assert.deepEqual(endpointPaths, ["ingest/frame", "ingest/state"]);

  const frameMediaMatch = /\.toRequestBody\(\s*"([^"]+)"\.toMediaType\(\)\s*\)/.exec(ingestSrc);
  assert.ok(frameMediaMatch, "IngestClient.kt must post frames with explicit media type");
  assert.equal(frameMediaMatch[1], "image/jpeg");

  const jsonMediaMatch = /JSON_MEDIA_TYPE\s*=\s*"([^"]+)"\.toMediaType\(\)/.exec(ingestSrc);
  assert.ok(jsonMediaMatch, "IngestClient.kt must define JSON_MEDIA_TYPE");
  assert.equal(jsonMediaMatch[1], "application/json; charset=utf-8");

  const sessionQueryMatch = /\.addQueryParameter\(\s*"([^"]+)"\s*,\s*session\s*\)/.exec(ingestSrc);
  assert.ok(sessionQueryMatch, "IngestClient.kt must bind session query parameter");
  assert.equal(sessionQueryMatch[1], "session");

  for (const stateField of ["connected", "worn", "battery", "streaming"]) {
    assert.match(ingestSrc, new RegExp(`\\\\"${stateField}\\\\"\\s*:`));
  }

  assert.match(yuvSrc, /\bfun\s+i420ToNv21\s*\(\s*buffer\s*:\s*ByteBuffer\s*,\s*width\s*:\s*Int\s*,\s*height\s*:\s*Int\s*\)\s*:\s*ByteArray\b/);
  assert.match(yuvSrc, /\bquality\s*:\s*Int\s*=\s*78\b/);
  assert.match(controllerSrc, /STREAM_FPS\s*=\s*2\b/);
  assert.match(controllerSrc, /MIN_ENCODE_INTERVAL_MS\s*=\s*960L\b/);
  assert.match(serverSrc, /app\.post\(\s*"\/ingest\/frame"/);
  assert.match(serverSrc, /app\.post\(\s*"\/ingest\/state"/);

  const deepLink = buildBridgeDeepLink(baseUrl, "sess123");
  const parsedDeepLink = new URL(deepLink);
  const resolvedServer = sanitizeServerUrlLikeAndroid(parsedDeepLink.searchParams.get("server")!);
  const resolvedSession = parsedDeepLink.searchParams.get("session")!;
  assert.equal(resolvedServer, baseUrl);
  assert.equal(resolvedSession, "sess123");

  const client = new SyntheticAndroidIngestClient(
    endpointPaths[0],
    endpointPaths[1],
    frameMediaMatch[1],
    jsonMediaMatch[1],
    sessionQueryMatch[1],
  );
  client.configure(resolvedServer, resolvedSession);

  assert.equal(
    client.buildEndpointUrl(endpointPaths[0])?.toString(),
    `${baseUrl}${SLASH}ingest${SLASH}frame?session=sess123`,
  );
  assert.equal(
    client.buildEndpointUrl(endpointPaths[1])?.toString(),
    `${baseUrl}${SLASH}ingest${SLASH}state?session=sess123`,
  );

  const otherLatest = getOrCreateHub("other-latest");
  const otherLive = makeStubLive();
  otherLatest.live = otherLive;
  markLatest(otherLatest);
  assert.equal(latestHub(), otherLatest);

  const liveWs = openWs(`${wsBase}${SLASH}live?session=sess123`);
  await liveWs.ready;
  const hudWs = openWs(`${wsBase}${SLASH}hud-ws?session=sess123`);
  await hudWs.ready;
  assert.deepEqual(await liveWs.next(), { type: "hud", connected: true });

  const pairedHub = getHub("sess123");
  assert.ok(pairedHub);
  const pairedStubLive = makeStubLive();
  pairedHub.live = pairedStubLive;

  try {
    await client.postState({
      connected: true,
      worn: true,
      battery: 84,
      streaming: true,
    });
    assert.equal(client.stateUpdatesSent, 1);
    assert.equal(client.lastHttpCode, 204);
    assert.equal(client.lastError, null);

    const expectedActiveDevice: DeviceState = {
      connected: true,
      worn: true,
      battery: 84,
      streaming: true,
      source: "glasses",
    };
    const [liveStateMsg, hudStateMsg] = await Promise.all([liveWs.next(), hudWs.next()]);
    assert.deepEqual(liveStateMsg, { type: "device", device: expectedActiveDevice });
    assert.deepEqual(hudStateMsg, { type: "device", device: expectedActiveDevice });
    assert.deepEqual(pairedHub.device, expectedActiveDevice);
    assert.equal(otherLatest.device, undefined);

    await client.postState({
      connected: true,
      worn: false,
      battery: null,
      streaming: false,
    });
    assert.equal(client.stateUpdatesSent, 2);
    assert.equal(client.lastHttpCode, 204);

    const expectedDoffedDevice: DeviceState = {
      connected: true,
      worn: false,
      battery: null,
      streaming: false,
      source: "glasses",
    };
    const [liveDoffMsg, hudDoffMsg] = await Promise.all([liveWs.next(), hudWs.next()]);
    assert.deepEqual(liveDoffMsg, { type: "device", device: expectedDoffedDevice });
    assert.deepEqual(hudDoffMsg, { type: "device", device: expectedDoffedDevice });

    const datFrameJpeg = buildSof0Jpeg(720, 1280, 480);
    assert.deepEqual(jpegSize(datFrameJpeg), { w: 720, h: 1280 });

    const frameAccepted = await client.submitFrame(datFrameJpeg);
    assert.equal(frameAccepted, true);
    assert.equal(client.framesSent, 1);
    assert.equal(client.lastHttpCode, 204);
    assert.equal(client.lastError, null);

    assert.equal(pairedHub.ring.length, 1);
    const storedFrame = pairedHub.ring.pick(1)[0];
    assert.equal(storedFrame.source, "glasses");
    assert.equal(storedFrame.bytes, datFrameJpeg.length);
    assert.equal(storedFrame.sharpness, jpegSharpness(datFrameJpeg));
    assert.equal(storedFrame.data, datFrameJpeg.toString("base64"));
    assert.deepEqual(pairedStubLive.frames, [datFrameJpeg.toString("base64")]);
    assert.equal(otherLatest.ring.length, 0);
    assert.deepEqual(otherLive.frames, []);

    const shortRejected = await client.submitFrame(new Uint8Array(64).fill(0xff));
    assert.equal(shortRejected, false);
    assert.equal(client.framesSent, 1);
    assert.equal(client.lastHttpCode, 400);
    assert.equal(client.lastError, "HTTP 400");

    const sessionlessDeepLink = new URL(buildBridgeDeepLink(baseUrl));
    client.configure(sessionlessDeepLink.searchParams.get("server")!, "");
    assert.equal(
      client.buildEndpointUrl(endpointPaths[0])?.toString(),
      `${baseUrl}${SLASH}ingest${SLASH}frame`,
    );
    const latestFrameAccepted = await client.submitFrame(datFrameJpeg);
    assert.equal(latestFrameAccepted, true);
    assert.equal(otherLatest.ring.length, 1);
    assert.equal(otherLatest.ring.pick(1)[0].source, "glasses");
    assert.equal(otherLive.frames.length, 1);
  } finally {
    await Promise.all([liveWs.close(), hudWs.close()]);
  }
});

test("libs.versions.toml, app/build.gradle.kts, and AndroidManifest.xml wire Meta Wearables DAT SDK 1.0.1 and security resources", () => {
  const catalogSrc = fs.readFileSync(LIBS_VERSIONS_TOML_PATH, "utf8");
  const appGradleSrc = fs.readFileSync(APP_BUILD_GRADLE_PATH, "utf8");
  const settingsGradleSrc = fs.readFileSync(SETTINGS_GRADLE_PATH, "utf8");
  const manifestSrc = fs.readFileSync(MANIFEST_PATH, "utf8");
  const serviceSrc = fs.readFileSync(STREAMING_SERVICE_KT, "utf8");

  const catalog = parseLibsVersionsToml(catalogSrc);
  assert.equal(catalog.versions.mwdat, "1.0.1");
  assert.equal(resolveMavenCoordinate(catalog, "mwdat-core"), "com.meta.wearable:mwdat-core:1.0.1");
  assert.equal(resolveMavenCoordinate(catalog, "mwdat-camera"), "com.meta.wearable:mwdat-camera:1.0.1");
  assert.ok(resolveMavenCoordinate(catalog, "junit").startsWith("junit:junit:"));

  assert.match(settingsGradleSrc, /\bmavenCentral\s*\(\s*\)/);
  assert.match(appGradleSrc, /namespace\s*=\s*"app\.holdup\.bridge"/);
  assert.match(appGradleSrc, /applicationId\s*=\s*"app\.holdup\.bridge"/);

  const minSdkMatch = /minSdk\s*=\s*(\d+)/.exec(appGradleSrc);
  assert.ok(minSdkMatch, "app/build.gradle.kts must set minSdk");
  assert.ok(Number(minSdkMatch[1]) >= 29, `DAT SDK requires minSdk >= 29, got ${minSdkMatch[1]}`);

  assert.match(appGradleSrc, /implementation\(\s*libs\.mwdat\.core\s*\)/);
  assert.match(appGradleSrc, /implementation\(\s*libs\.mwdat\.camera\s*\)/);
  assert.match(appGradleSrc, /testImplementation\(\s*libs\.junit\s*\)/);
  assert.match(appGradleSrc, /manifestPlaceholders\["mwdatApplicationId"\]/);
  assert.match(appGradleSrc, /manifestPlaceholders\["mwdatClientToken"\]/);
  assert.match(appGradleSrc, /\?:\s*"0"/);

  const manifestRoot = parseXmlDocument(manifestSrc, "AndroidManifest.xml");
  assert.equal(manifestRoot.tag, "manifest");
  assert.equal(manifestRoot.attrs["xmlns:android"], ANDROID_NS);

  const permissions = manifestRoot.children
    .filter((node) => node.tag === "uses-permission")
    .map((node) => node.attrs["android:name"]);

  for (const requiredPerm of [
    "android.permission.INTERNET",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
  ]) {
    assert.equal(
      permissions.includes(requiredPerm),
      true,
      `AndroidManifest.xml missing permission ${requiredPerm}`,
    );
  }

  const appNode = manifestRoot.children.find((node) => node.tag === "application");
  assert.ok(appNode, "AndroidManifest.xml must contain <application>");
  assert.equal(appNode.attrs["android:icon"], "@drawable/ic_launcher_foreground");
  assert.equal(appNode.attrs["android:theme"], "@style/Theme.HoldUpBridge");
  assert.equal(appNode.attrs["android:networkSecurityConfig"], "@xml/network_security_config");
  assert.equal(appNode.attrs["android:allowBackup"], "false");
  assert.notEqual(appNode.attrs["android:usesCleartextTraffic"], "true");

  assert.equal(fs.existsSync(path.join(RES_ROOT, "drawable", "ic_launcher_foreground.xml")), true);
  assert.equal(fs.existsSync(path.join(RES_ROOT, "values", "themes.xml")), true);
  assert.equal(fs.existsSync(path.join(RES_ROOT, "xml", "network_security_config.xml")), true);

  const metaData = new Map<string, string>();
  for (const node of findDescendants(appNode, "meta-data")) {
    if (node.attrs["android:name"] && node.attrs["android:value"]) {
      metaData.set(node.attrs["android:name"], node.attrs["android:value"]);
    }
  }
  assert.equal(metaData.get("com.meta.wearable.mwdat.APPLICATION_ID"), "${mwdatApplicationId}");
  assert.equal(metaData.get("com.meta.wearable.mwdat.CLIENT_TOKEN"), "${mwdatClientToken}");

  const serviceNode = appNode.children.find(
    (node) =>
      node.tag === "service" &&
      (node.attrs["android:name"] === ".StreamingForegroundService" ||
        node.attrs["android:name"] === "app.holdup.bridge.StreamingForegroundService"),
  );
  assert.ok(serviceNode, "AndroidManifest.xml must declare .StreamingForegroundService");
  assert.equal(serviceNode.attrs["android:exported"], "false");
  assert.equal(serviceNode.attrs["android:foregroundServiceType"], "connectedDevice");
  assert.match(serviceSrc, /ServiceInfo\.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/);
});

test("android-a11y-parity.test.ts contains zero comments, zero em dashes, zero keys, and zero co-author trailers", () => {
  const selfSource = fs.readFileSync(SELF_FILE, "utf8");
  const apiKeyRe = new RegExp(API_KEY_PREFIX + "[0-9A-Za-z_-]{20,}");
  const coAuthoredRe = new RegExp(CO_AUTHORED_TOKEN, "i");

  assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(XML_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(XML_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(EM_DASH), false);
  assert.equal(apiKeyRe.test(selfSource), false);
  assert.equal(coAuthoredRe.test(selfSource), false);
});
