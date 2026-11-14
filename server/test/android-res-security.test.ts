import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../src/env.ts";

process.env.HOLDUP_QUIET = "1";

const SELF_FILE = fileURLToPath(import.meta.url);
const RES_ROOT = path.join(REPO_ROOT, "android-dat", "app", "src", "main", "res");
const NETWORK_SECURITY_XML = path.join(RES_ROOT, "xml", "network_security_config.xml");
const THEMES_XML = path.join(RES_ROOT, "values", "themes.xml");
const LAUNCHER_FOREGROUND_XML = path.join(RES_ROOT, "drawable", "ic_launcher_foreground.xml");
const STRINGS_XML = path.join(RES_ROOT, "values", "strings.xml");
const BRIDGE_PREFS_TEST_KT = path.join(
  REPO_ROOT,
  "android-dat",
  "app",
  "src",
  "test",
  "java",
  "app",
  "holdup",
  "bridge",
  "BridgePreferencesTest.kt",
);

const LINE_COMMENT_TOKEN = "/" + "/";
const BLOCK_COMMENT_OPEN = "/" + "*";
const BLOCK_COMMENT_CLOSE = "*" + "/";
const XML_COMMENT_OPEN = "<" + "!--";
const XML_COMMENT_CLOSE = "--" + ">";
const SCHEME_SEP = ":" + "/" + "/";
const ANDROID_NS = `http${SCHEME_SEP}schemas.android.com/apk/res/android`;
const EM_DASH = String.fromCharCode(0x2014);
const API_KEY_PREFIX = "AI" + "za";

const LOCAL_DEV_CLEARTEXT_ALLOWLIST = new Set([
  "localhost",
  "127.0.0.1",
  "10.0.2.2",
  "local",
  "::1",
  "[::1]",
]);

type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};

function collectXmlFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectXmlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".xml")) {
      out.push(full);
    }
  }
  return out.sort();
}

function parseXmlAttributes(rawAttrs: string, contextLabel: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const trimmed = rawAttrs.trim();
  if (trimmed.length === 0) return attrs;

  const attrRegex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(trimmed)) !== null) {
    const gap = trimmed.slice(cursor, match.index).trim();
    assert.equal(
      gap,
      "",
      `${contextLabel}: unexpected token '${gap}' in XML attributes`,
    );
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
  assert.equal(
    trailing,
    "",
    `${contextLabel}: unparsed trailing XML attribute content '${trailing}'`,
  );
  return attrs;
}

function parseXmlDocument(source: string, fileLabel: string): XmlNode {
  const prologMatch = /^\s*<\?xml\s+version="1\.0"\s+encoding="utf-8"\?>/i.exec(source);
  assert.ok(prologMatch, `${fileLabel}: must start with UTF-8 XML 1.0 prolog`);

  let index = prologMatch[0].length;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  while (index < source.length) {
    const nextLt = source.indexOf("<", index);
    if (nextLt === -1) {
      const trailingText = source.slice(index).trim();
      assert.equal(trailingText, "", `${fileLabel}: unexpected trailing text outside root element`);
      break;
    }

    const textChunk = source.slice(index, nextLt);
    if (stack.length > 0) {
      stack[stack.length - 1].text += textChunk;
    } else {
      assert.equal(
        textChunk.trim(),
        "",
        `${fileLabel}: unexpected text outside root element`,
      );
    }

    assert.equal(
      source.startsWith("<!", nextLt),
      false,
      `${fileLabel}: DTD, ENTITY, CDATA, and XML comment constructs are forbidden`,
    );
    assert.equal(
      source.startsWith("<?", nextLt),
      false,
      `${fileLabel}: unexpected processing instruction after XML prolog`,
    );

    const nextGt = source.indexOf(">", nextLt + 1);
    assert.notEqual(nextGt, -1, `${fileLabel}: unclosed '<' tag`);
    const rawTagBody = source.slice(nextLt + 1, nextGt).trim();
    assert.ok(rawTagBody.length > 0, `${fileLabel}: empty XML tag`);

    if (rawTagBody.startsWith("/")) {
      const closeName = rawTagBody.slice(1).trim();
      assert.match(closeName, /^[A-Za-z_][A-Za-z0-9_.:-]*$/, `${fileLabel}: invalid closing tag </${closeName}>`);
      const opened = stack.pop();
      assert.ok(opened, `${fileLabel}: unexpected closing tag </${closeName}> with empty stack`);
      assert.equal(
        opened.tag,
        closeName,
        `${fileLabel}: mismatched closing tag </${closeName}> for <${opened.tag}>`,
      );
      opened.text = opened.text.trim();
    } else {
      const selfClosing = rawTagBody.endsWith("/");
      const inner = selfClosing ? rawTagBody.slice(0, -1).trim() : rawTagBody;
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(inner);
      assert.ok(nameMatch, `${fileLabel}: malformed opening tag <${rawTagBody}>`);
      const [, tagName, rawAttrs] = nameMatch;
      const node: XmlNode = {
        tag: tagName,
        attrs: parseXmlAttributes(rawAttrs, `${fileLabel}:<${tagName}>`),
        text: "",
        children: [],
      };

      if (stack.length === 0) {
        assert.equal(root, null, `${fileLabel}: multiple root XML elements are not allowed`);
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

  assert.equal(
    stack.length,
    0,
    `${fileLabel}: unclosed XML tags remaining: ${stack.map((n) => n.tag).join(", ")}`,
  );
  assert.ok(root, `${fileLabel}: missing root XML element`);
  return root;
}

function findDescendants(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.tag === tag) {
      out.push(child);
    }
    findDescendants(child, tag, out);
  }
  return out;
}

function hexRelativeLuminance(hexColor: string): number {
  const normalized = hexColor.replace(/^#/, "");
  const rgbHex = normalized.length === 8 ? normalized.slice(2) : normalized;
  assert.equal(rgbHex.length, 6, `Expected 6-digit RGB hex, got ${hexColor}`);
  const channels = [0, 2, 4].map((offset) => {
    const srgb = Number.parseInt(rgbHex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test("all android-dat/app/src/main/res XML files are well-formed UTF-8 with zero comments, zero em dashes, and zero secrets", () => {
  const requiredFiles = [
    NETWORK_SECURITY_XML,
    THEMES_XML,
    LAUNCHER_FOREGROUND_XML,
    STRINGS_XML,
  ];
  for (const filePath of requiredFiles) {
    assert.equal(
      fs.existsSync(filePath),
      true,
      `Missing required Android resource file: ${path.relative(REPO_ROOT, filePath)}`,
    );
  }

  const xmlFiles = collectXmlFiles(RES_ROOT);
  assert.ok(xmlFiles.length >= 4, `Expected at least 4 XML files in res/, found ${xmlFiles.length}`);

  for (const xmlPath of xmlFiles) {
    const rel = path.relative(REPO_ROOT, xmlPath);
    const source = fs.readFileSync(xmlPath, "utf8");

    assert.equal(source.includes(XML_COMMENT_OPEN), false, `${rel}: must contain zero XML comments`);
    assert.equal(source.includes(XML_COMMENT_CLOSE), false, `${rel}: must contain zero XML comment closers`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${rel}: must contain zero block comments`);
    assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${rel}: must contain zero block comment closers`);
    assert.equal(source.includes(EM_DASH), false, `${rel}: must contain zero em dashes`);
    assert.equal(source.includes(API_KEY_PREFIX), false, `${rel}: must contain zero API keys`);
    assert.equal(/<!DOCTYPE/i.test(source), false, `${rel}: must not declare DOCTYPE`);
    assert.equal(/<!ENTITY/i.test(source), false, `${rel}: must not declare XML entities`);

    const root = parseXmlDocument(source, rel);
    assert.ok(root.tag.length > 0);
  }
});

test("network_security_config.xml enforces cleartextTrafficPermitted=false on base-config and strictly local dev domains on domain-config", () => {
  const source = fs.readFileSync(NETWORK_SECURITY_XML, "utf8");
  const root = parseXmlDocument(source, "network_security_config.xml");

  assert.equal(root.tag, "network-security-config");
  assert.equal(root.attrs["xmlns:android"], ANDROID_NS);

  assert.equal(
    findDescendants(root, "debug-overrides").length,
    0,
    "network_security_config.xml must not include debug-overrides",
  );

  const baseConfigs = root.children.filter((node) => node.tag === "base-config");
  assert.equal(baseConfigs.length, 1, "Expected exactly one <base-config> element");
  const baseConfig = baseConfigs[0];
  assert.equal(
    baseConfig.attrs.cleartextTrafficPermitted,
    "false",
    "<base-config> must set cleartextTrafficPermitted=\"false\"",
  );

  const trustAnchors = baseConfig.children.filter((node) => node.tag === "trust-anchors");
  assert.equal(trustAnchors.length, 1, "<base-config> must declare <trust-anchors>");
  const certs = trustAnchors[0].children.filter((node) => node.tag === "certificates");
  assert.equal(certs.length, 1, "<trust-anchors> must trust exclusively system certificates");
  assert.equal(certs[0].attrs.src, "system");
  assert.notEqual(certs[0].attrs.overridePins, "true");

  const allCertificates = findDescendants(root, "certificates");
  for (const certNode of allCertificates) {
    assert.equal(
      certNode.attrs.src,
      "system",
      `Disallowed certificate trust source '${certNode.attrs.src}'`,
    );
  }

  const domainConfigs = findDescendants(root, "domain-config");
  assert.ok(domainConfigs.length >= 1, "Expected local dev <domain-config> block");

  const observedCleartextDomains: string[] = [];
  for (const domainConfig of domainConfigs) {
    const domains = domainConfig.children.filter((node) => node.tag === "domain");
    assert.ok(domains.length > 0, "<domain-config> must declare at least one <domain>");

    for (const domainNode of domains) {
      const host = domainNode.text.trim().toLowerCase();
      assert.ok(host.length > 0, "<domain> text must be non-empty");
      assert.ok(
        domainNode.attrs.includeSubdomains === "true" ||
          domainNode.attrs.includeSubdomains === "false",
        `<domain>${host}</domain> must explicitly set includeSubdomains="true" or "false"`,
      );

      if (domainConfig.attrs.cleartextTrafficPermitted !== "false") {
        assert.equal(
          domainConfig.attrs.cleartextTrafficPermitted,
          "true",
          "<domain-config> must explicitly specify cleartextTrafficPermitted",
        );
        assert.equal(
          LOCAL_DEV_CLEARTEXT_ALLOWLIST.has(host),
          true,
          `Non-local domain '${host}' must never permit cleartext HTTP`,
        );
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
          assert.equal(
            domainNode.attrs.includeSubdomains,
            "false",
            `IPv4 literal '${host}' must set includeSubdomains="false"`,
          );
        }
        observedCleartextDomains.push(host);
      }
    }
  }

  for (const requiredLocalHost of ["localhost", "127.0.0.1", "10.0.2.2"]) {
    assert.equal(
      observedCleartextDomains.includes(requiredLocalHost),
      true,
      `Expected '${requiredLocalHost}' in local dev cleartext domain-config`,
    );
  }
});

test("themes.xml defines #0B0F17 dark background and dark Material NoActionBar styles", () => {
  const source = fs.readFileSync(THEMES_XML, "utf8");
  const root = parseXmlDocument(source, "themes.xml");

  assert.equal(root.tag, "resources");

  const colors = new Map<string, string>();
  for (const node of root.children.filter((child) => child.tag === "color")) {
    assert.ok(node.attrs.name, "<color> must declare a name attribute");
    assert.match(node.text, /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/);
    colors.set(node.attrs.name, node.text.toUpperCase());
  }

  assert.equal(colors.get("holdup_window_background"), "#0B0F17");
  assert.equal(colors.get("ic_launcher_background"), "#0B0F17");
  assert.ok(colors.has("holdup_surface_background"));
  assert.ok(
    hexRelativeLuminance(colors.get("holdup_window_background")!) < 0.02,
    "#0B0F17 window background must be low-luminance dark",
  );

  const styles = new Map<string, XmlNode>();
  for (const node of root.children.filter((child) => child.tag === "style")) {
    assert.ok(node.attrs.name, "<style> must declare a name attribute");
    styles.set(node.attrs.name, node);
  }

  const bridgeTheme = styles.get("Theme.HoldUpBridge");
  assert.ok(bridgeTheme, "themes.xml must define Theme.HoldUpBridge");
  assert.match(bridgeTheme.attrs.parent ?? "", /Material\.NoActionBar$/);

  const themeItems = new Map<string, string>();
  for (const item of bridgeTheme.children.filter((child) => child.tag === "item")) {
    assert.ok(item.attrs.name, "<item> in Theme.HoldUpBridge must declare name");
    themeItems.set(item.attrs.name, item.text);
  }

  const resolveColorRef = (rawValue: string | undefined): string => {
    assert.ok(rawValue, "Expected theme color item to be defined");
    if (rawValue.startsWith("@color/")) {
      const colorKey = rawValue.slice("@color/".length);
      const resolved = colors.get(colorKey);
      assert.ok(resolved, `Theme references undefined @color/${colorKey}`);
      return resolved;
    }
    return rawValue.toUpperCase();
  };

  assert.equal(resolveColorRef(themeItems.get("android:windowBackground")), "#0B0F17");
  assert.equal(resolveColorRef(themeItems.get("android:colorBackground")), "#0B0F17");
  assert.equal(resolveColorRef(themeItems.get("android:statusBarColor")), "#0B0F17");
  assert.equal(resolveColorRef(themeItems.get("android:navigationBarColor")), "#0B0F17");
  assert.equal(resolveColorRef(themeItems.get("android:windowSplashScreenBackground")), "#0B0F17");
  assert.equal(themeItems.get("android:windowLightStatusBar"), "false");
  assert.equal(themeItems.get("android:windowLightNavigationBar"), "false");

  const aliasTheme = styles.get("Theme.HoldUp");
  assert.ok(aliasTheme, "themes.xml must define Theme.HoldUp");
  assert.equal(aliasTheme.attrs.parent, "Theme.HoldUpBridge");
});

test("ic_launcher_foreground.xml defines 108dp adaptive icon vector bounds and valid in-viewport paths", () => {
  const source = fs.readFileSync(LAUNCHER_FOREGROUND_XML, "utf8");
  const root = parseXmlDocument(source, "ic_launcher_foreground.xml");

  assert.equal(root.tag, "vector");
  assert.equal(root.attrs["xmlns:android"], ANDROID_NS);
  assert.equal(root.attrs["android:width"], "108dp");
  assert.equal(root.attrs["android:height"], "108dp");
  assert.equal(root.attrs["android:viewportWidth"], "108");
  assert.equal(root.attrs["android:viewportHeight"], "108");

  const paths = findDescendants(root, "path");
  assert.ok(paths.length >= 1, "ic_launcher_foreground.xml must contain vector <path> elements");

  for (const pathNode of paths) {
    const pathData = pathNode.attrs["android:pathData"] ?? "";
    assert.ok(pathData.trim().length > 0, "<path> must have non-empty android:pathData");
    assert.match(pathData.trim(), /^[Mm]/, "<path> pathData must begin with a move command");

    const numericTokens = pathData.match(/-?\d+(?:\.\d+)?/g) ?? [];
    assert.ok(numericTokens.length >= 2, "<path> pathData must contain numeric coordinates");
    for (const token of numericTokens) {
      const value = Number(token);
      assert.equal(Number.isFinite(value), true);
      assert.ok(
        value >= 0 && value <= 108,
        `Vector path numeric value ${value} falls outside 108x108 viewport bounds`,
      );
    }

    for (const colorAttr of ["android:fillColor", "android:strokeColor"]) {
      const rawColor = pathNode.attrs[colorAttr];
      if (rawColor !== undefined) {
        assert.match(
          rawColor,
          /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/,
          `Invalid hex color ${rawColor} on ${colorAttr}`,
        );
      }
    }
  }
});

test("strings.xml defines app_name and active-streaming notification strings", () => {
  const source = fs.readFileSync(STRINGS_XML, "utf8");
  const root = parseXmlDocument(source, "strings.xml");

  assert.equal(root.tag, "resources");

  const strings = new Map<string, string>();
  for (const node of root.children.filter((child) => child.tag === "string")) {
    assert.ok(node.attrs.name, "<string> must declare a name attribute");
    assert.ok(node.text.length > 0, `<string name="${node.attrs.name}"> must not be empty`);
    assert.doesNotMatch(node.text, /\b(?:TODO|FIXME|TBD)\b/i);
    strings.set(node.attrs.name, node.text);
  }

  assert.equal(strings.get("app_name"), "HoldUp Bridge");
  for (const requiredKey of [
    "app_name",
    "notification_channel_name",
    "notification_channel_description",
    "notification_title",
    "notification_body",
  ]) {
    const val = strings.get(requiredKey);
    assert.ok(val && val.length > 0, `strings.xml missing required string '${requiredKey}'`);
  }
});

test("BridgePreferencesTest.kt JUnit4 suite covers valid and hostile URL and session code vectors with zero comments", () => {
  assert.equal(fs.existsSync(BRIDGE_PREFS_TEST_KT), true, "BridgePreferencesTest.kt must exist");
  const ktSource = fs.readFileSync(BRIDGE_PREFS_TEST_KT, "utf8");
  const lines = ktSource.split(/\r?\n/);

  assert.equal(lines[0], "package app.holdup.bridge");
  assert.equal(ktSource.includes(EM_DASH), false);
  assert.equal(ktSource.includes(BLOCK_COMMENT_OPEN), false);
  assert.equal(ktSource.includes(BLOCK_COMMENT_CLOSE), false);
  assert.equal(ktSource.includes(API_KEY_PREFIX), false);
  for (const line of lines) {
    assert.equal(line.trim().startsWith(LINE_COMMENT_TOKEN), false);
  }

  assert.match(ktSource, /\bimport\s+org\.junit\.Test\b/);
  assert.match(ktSource, /\bclass\s+BridgePreferencesTest\b/);
  const testAnnotations = ktSource.match(/@Test\b/g) ?? [];
  assert.ok(testAnnotations.length >= 5, `Expected >= 5 @Test methods, got ${testAnnotations.length}`);

  assert.match(ktSource, /\bBridgePreferences\.sanitizeServerUrl\s*\(/);
  assert.match(ktSource, /\bBridgePreferences\.sanitizeSessionCode\s*\(/);

  const requiredVectors = [
    `https${SCHEME_SEP}demo.trycloudflare.com/`,
    `http${SCHEME_SEP}10.0.2.2:8787`,
    `http${SCHEME_SEP}192.168.1.20:8787/`,
    "javascript:alert(1)",
    `file:${"/" + "/" + "/"}etc/passwd`,
    `https${SCHEME_SEP}user:pass@evil.example`,
    ":0",
    ":70000",
    "MAX_SERVER_URL_LENGTH",
    "\"abc\"",
    "../etc/passwd",
  ];

  for (const vector of requiredVectors) {
    assert.equal(
      ktSource.includes(vector),
      true,
      `BridgePreferencesTest.kt must exercise vector: ${vector}`,
    );
  }
});

test("XML security parser rejects comments, XXE declarations, malformed tags, and self source stays comment-free", () => {
  const prolog = '<?xml version="1.0" encoding="utf-8"?>\n';

  assert.throws(() => parseXmlDocument("<resources />", "missing-prolog.xml"));
  assert.throws(() =>
    parseXmlDocument(`${prolog}<resources>${XML_COMMENT_OPEN} bad ${XML_COMMENT_CLOSE}</resources>`, "comment.xml"),
  );
  assert.throws(() =>
    parseXmlDocument(`${prolog}<!DOCTYPE resources><resources />`, "doctype.xml"),
  );
  assert.throws(() =>
    parseXmlDocument(`${prolog}<resources><string name="a">x</color></resources>`, "mismatch.xml"),
  );
  assert.throws(() =>
    parseXmlDocument(`${prolog}<resources><string name="a">x</resources>`, "unclosed.xml"),
  );
  assert.throws(() =>
    parseXmlDocument(`${prolog}<resources><string name="a" name="b">x</string></resources>`, "dup-attr.xml"),
  );

  const selfSource = fs.readFileSync(SELF_FILE, "utf8");
  const coAuthoredToken = ["Co", "Authored", "By"].join("-");
  assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(XML_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(XML_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(EM_DASH), false);
  assert.equal(selfSource.includes(API_KEY_PREFIX), false);
  assert.equal(new RegExp(coAuthoredToken, "i").test(selfSource), false);
});

