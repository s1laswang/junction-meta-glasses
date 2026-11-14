import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../src/env.ts";

process.env.HOLDUP_QUIET = "1";

const SELF_FILE = fileURLToPath(import.meta.url);
const RES_ROOT = path.join(REPO_ROOT, "android-dat", "app", "src", "main", "res");
const EN_STRINGS_XML = path.join(RES_ROOT, "values", "strings.xml");
const FI_STRINGS_XML = path.join(RES_ROOT, "values-fi", "strings.xml");
const SV_STRINGS_XML = path.join(RES_ROOT, "values-sv", "strings.xml");
const BRIDGE_SCREEN_KT = path.join(
  REPO_ROOT,
  "android-dat",
  "app",
  "src",
  "main",
  "java",
  "app",
  "holdup",
  "bridge",
  "BridgeScreen.kt",
);

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const LINE_COMMENT_TOKEN = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const XML_COMMENT_OPEN = "<" + "!--";
const XML_COMMENT_CLOSE = "--" + ">";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const API_KEY_PREFIX = "AI" + "za";
const CO_AUTHORED_TOKEN = ["Co", "Authored", "By"].join("-");

type LocaleCode = "en" | "fi" | "sv";

const LOCALE_FILES: Record<LocaleCode, string> = {
  en: EN_STRINGS_XML,
  fi: FI_STRINGS_XML,
  sv: SV_STRINGS_XML,
};

type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};

function assertCleanSource(source: string, label: string): void {
  assert.equal(source.includes(XML_COMMENT_OPEN), false, `${label}: forbidden XML comment open`);
  assert.equal(source.includes(XML_COMMENT_CLOSE), false, `${label}: forbidden XML comment close`);
  assert.equal(source.includes(LINE_COMMENT_TOKEN), false, `${label}: forbidden line comment token`);
  assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label}: forbidden block comment open`);
  assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label}: forbidden block comment close`);
  assert.equal(source.includes(EM_DASH), false, `${label}: forbidden em dash`);
  assert.equal(source.includes(EN_DASH), false, `${label}: forbidden en dash`);
  assert.equal(source.includes(API_KEY_PREFIX), false, `${label}: forbidden API key prefix`);
  assert.equal(new RegExp(CO_AUTHORED_TOKEN, "i").test(source), false, `${label}: forbidden trailer`);
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
    assert.equal(gap, "", `${contextLabel}: unexpected token '${gap}' in XML attributes`);
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
  assertCleanSource(source, fileLabel);
  const prologMatch = /^\s*<\?xml\s+version="1\.0"\s+encoding="utf-8"\?>/i.exec(source);
  assert.ok(prologMatch, `${fileLabel}: must begin with UTF-8 XML 1.0 prolog`);

  let index = prologMatch[0].length;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  while (index < source.length) {
    const nextLt = source.indexOf("<", index);
    if (nextLt === -1) {
      assert.equal(source.slice(index).trim(), "", `${fileLabel}: unexpected trailing text`);
      break;
    }

    const textChunk = source.slice(index, nextLt);
    if (stack.length > 0) {
      stack[stack.length - 1].text += textChunk;
    } else {
      assert.equal(textChunk.trim(), "", `${fileLabel}: unexpected text outside <resources>`);
    }

    assert.equal(
      source.startsWith("<!", nextLt),
      false,
      `${fileLabel}: DTD, ENTITY, CDATA, and XML comments are forbidden`,
    );
    assert.equal(
      source.startsWith("<?", nextLt),
      false,
      `${fileLabel}: unexpected processing instruction after XML prolog`,
    );

    const nextGt = source.indexOf(">", nextLt + 1);
    assert.notEqual(nextGt, -1, `${fileLabel}: unclosed XML '<' tag`);
    const rawTagBody = source.slice(nextLt + 1, nextGt).trim();
    assert.ok(rawTagBody.length > 0, `${fileLabel}: empty XML tag`);

    if (rawTagBody.startsWith(SLASH)) {
      const closeName = rawTagBody.slice(1).trim();
      assert.match(closeName, /^[A-Za-z_][A-Za-z0-9_.:-]*$/, `${fileLabel}: invalid closing tag`);
      const opened = stack.pop();
      assert.ok(opened, `${fileLabel}: unexpected closing tag for ${closeName}`);
      assert.equal(opened.tag, closeName, `${fileLabel}: mismatched closing tag ${closeName}`);
      opened.text = opened.text.trim();
    } else {
      const selfClosing = rawTagBody.endsWith(SLASH);
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
        assert.equal(root, null, `${fileLabel}: multiple root XML elements are forbidden`);
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

  assert.equal(stack.length, 0, `${fileLabel}: unclosed XML tags remaining`);
  assert.ok(root, `${fileLabel}: missing root XML element`);
  return root;
}

function parseAndroidStringsMap(source: string, fileLabel: string): Map<string, string> {
  const root = parseXmlDocument(source, fileLabel);
  assert.equal(root.tag, "resources", `${fileLabel}: root element must be <resources>`);
  assert.equal(
    Object.keys(root.attrs).length,
    0,
    `${fileLabel}: <resources> should not carry unexpected attributes`,
  );

  const map = new Map<string, string>();
  for (const child of root.children) {
    assert.equal(child.tag, "string", `${fileLabel}: unexpected child element <${child.tag}>`);
    assert.equal(child.children.length, 0, `${fileLabel}: <string> must contain plain text only`);
    const key = child.attrs.name ?? "";
    assert.match(key, /^[a-z][a-z0-9_]*$/, `${fileLabel}: invalid Android string key '${key}'`);
    assert.equal(map.has(key), false, `${fileLabel}: duplicate <string name="${key}">`);
    assert.ok(child.text.length > 0, `${fileLabel}: <string name="${key}"> must be non-empty`);
    assert.doesNotMatch(child.text, /\b(?:TODO|FIXME|TBD)\b/i, `${fileLabel}:${key} has placeholder marker`);
    assert.equal(
      /(?<!\\)['"]/.test(child.text),
      false,
      `${fileLabel}:${key} contains unescaped AAPT2 quote or apostrophe`,
    );
    map.set(key, child.text);
  }

  assert.ok(map.size > 0, `${fileLabel}: must declare at least one <string>`);
  return map;
}

function extractPositionalPlaceholders(value: string, label: string): string[] {
  const tokens: string[] = [];
  let idx = 0;
  while (idx < value.length) {
    if (value[idx] !== "%") {
      idx += 1;
      continue;
    }
    const specMatch = /^%([1-4])\$s/.exec(value.slice(idx));
    assert.ok(
      specMatch,
      `${label}: invalid or non-positional '%' format token near '${value.slice(idx, idx + 8)}'`,
    );
    tokens.push(specMatch[0]);
    idx += specMatch[0].length;
  }
  return tokens;
}

function verifyStringCatalogParity(catalogs: Record<LocaleCode, Map<string, string>>): void {
  const enKeys = [...catalogs.en.keys()];
  const fiKeys = [...catalogs.fi.keys()];
  const svKeys = [...catalogs.sv.keys()];

  assert.deepEqual(
    [...fiKeys].sort(),
    [...enKeys].sort(),
    "values-fi/strings.xml key set must match values/strings.xml 1:1",
  );
  assert.deepEqual(
    [...svKeys].sort(),
    [...enKeys].sort(),
    "values-sv/strings.xml key set must match values/strings.xml 1:1",
  );
  assert.deepEqual(
    fiKeys,
    enKeys,
    "values-fi/strings.xml key ordering should mirror values/strings.xml",
  );
  assert.deepEqual(
    svKeys,
    enKeys,
    "values-sv/strings.xml key ordering should mirror values/strings.xml",
  );

  for (const key of enKeys) {
    const enVal = catalogs.en.get(key)!;
    const fiVal = catalogs.fi.get(key)!;
    const svVal = catalogs.sv.get(key)!;

    const enSpecs = extractPositionalPlaceholders(enVal, `en.${key}`);
    const fiSpecs = extractPositionalPlaceholders(fiVal, `fi.${key}`);
    const svSpecs = extractPositionalPlaceholders(svVal, `sv.${key}`);

    assert.deepEqual(
      [...fiSpecs].sort(),
      [...enSpecs].sort(),
      `fi.${key} positional format specifiers must match en.${key}`,
    );
    assert.deepEqual(
      [...svSpecs].sort(),
      [...enSpecs].sort(),
      `sv.${key} positional format specifiers must match en.${key}`,
    );
  }
}

function formatPositional(template: string, args: string[]): string {
  return template.replace(/%([1-4])\$s/g, (_full, pos) => {
    const idx = Number(pos) - 1;
    assert.ok(idx >= 0 && idx < args.length, `Missing format argument %${pos}$s`);
    return args[idx];
  });
}

function loadLocaleCatalogs(): Record<LocaleCode, Map<string, string>> {
  for (const [locale, filePath] of Object.entries(LOCALE_FILES) as [LocaleCode, string][]) {
    assert.equal(
      fs.existsSync(filePath),
      true,
      `Missing Android resource file for '${locale}': ${path.relative(REPO_ROOT, filePath)}`,
    );
  }
  return {
    en: parseAndroidStringsMap(fs.readFileSync(EN_STRINGS_XML, "utf8"), "values/strings.xml"),
    fi: parseAndroidStringsMap(fs.readFileSync(FI_STRINGS_XML, "utf8"), "values-fi/strings.xml"),
    sv: parseAndroidStringsMap(fs.readFileSync(SV_STRINGS_XML, "utf8"), "values-sv/strings.xml"),
  };
}

test("values/strings.xml, values-fi/strings.xml, and values-sv/strings.xml parse cleanly with 1:1 key set equality", () => {
  const catalogs = loadLocaleCatalogs();
  verifyStringCatalogParity(catalogs);

  assert.ok(catalogs.en.size >= 19, `Expected at least 19 Android strings, got ${catalogs.en.size}`);
  assert.equal(catalogs.en.get("app_name"), "HoldUp Bridge");
  assert.equal(catalogs.fi.get("app_name"), "HoldUp Bridge");
  assert.equal(catalogs.sv.get("app_name"), "HoldUp Bridge");

  const bridgeKt = fs.readFileSync(BRIDGE_SCREEN_KT, "utf8");
  const referencedKeys = Array.from(
    bridgeKt.matchAll(/\bR\.string\.([a-z][a-z0-9_]*)\b/g),
    (m) => m[1],
  );
  assert.ok(referencedKeys.length >= 13, "Expected BridgeScreen.kt to reference TalkBack R.string.* keys");

  for (const refKey of new Set(referencedKeys)) {
    assert.equal(catalogs.en.has(refKey), true, `values/strings.xml missing R.string.${refKey}`);
    assert.equal(catalogs.fi.has(refKey), true, `values-fi/strings.xml missing R.string.${refKey}`);
    assert.equal(catalogs.sv.has(refKey), true, `values-sv/strings.xml missing R.string.${refKey}`);
  }
});

test("every localized string preserves exact %1$s..%4$s positional placeholder parity and formats cleanly", () => {
  const catalogs = loadLocaleCatalogs();

  const expectedPlaceholders: Record<string, string[]> = {
    cd_glasses_status: ["%1$s", "%2$s", "%3$s", "%4$s"],
    cd_error_alert: ["%1$s"],
    cd_status_row: ["%1$s", "%2$s"],
  };

  for (const key of catalogs.en.keys()) {
    const expected = expectedPlaceholders[key] ?? [];
    for (const locale of ["en", "fi", "sv"] as const) {
      const actual = extractPositionalPlaceholders(catalogs[locale].get(key)!, `${locale}.${key}`);
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        `${locale}.${key} expected placeholders ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  for (const locale of ["en", "fi", "sv"] as const) {
    const statusRendered = formatPositional(catalogs[locale].get("cd_glasses_status")!, [
      "Ray-Ban Meta",
      "Connected / Worn",
      "84%",
      "Streaming",
    ]);
    assert.equal(/%[1-4]\$s/.test(statusRendered), false);
    assert.equal((statusRendered.match(/%/g) ?? []).length, 1);
    assert.equal(statusRendered.includes("Ray-Ban Meta"), true);
    assert.equal(statusRendered.includes("Connected / Worn"), true);
    assert.equal(statusRendered.includes("84%"), true);
    assert.equal(statusRendered.includes("Streaming"), true);

    const errRendered = formatPositional(catalogs[locale].get("cd_error_alert")!, ["HTTP 503"]);
    assert.equal(errRendered.includes("%"), false);
    assert.equal(errRendered.includes("HTTP 503"), true);

    const rowRendered = formatPositional(catalogs[locale].get("cd_status_row")!, ["Battery", "84%"]);
    assert.equal(rowRendered, "Battery: 84%");
  }
});

test("Finnish and Swedish TalkBack descriptions and streaming notifications are non-empty, genuinely localized, and orthographically native", () => {
  const catalogs = loadLocaleCatalogs();

  const cdKeys = [...catalogs.en.keys()].filter((key) => key.startsWith("cd_"));
  const notificationKeys = [...catalogs.en.keys()].filter((key) => key.startsWith("notification_"));
  assert.ok(cdKeys.length >= 14, `Expected >= 14 TalkBack cd_* keys, got ${cdKeys.length}`);
  assert.equal(notificationKeys.length, 4, "Expected 4 active-streaming notification_* keys");

  for (const key of [...notificationKeys, ...cdKeys]) {
    const enVal = catalogs.en.get(key)!.trim();
    const fiVal = catalogs.fi.get(key)!.trim();
    const svVal = catalogs.sv.get(key)!.trim();

    assert.ok(enVal.length > 0, `en.${key} must be non-empty`);
    assert.ok(fiVal.length > 0, `fi.${key} must be non-empty`);
    assert.ok(svVal.length > 0, `sv.${key} must be non-empty`);

    if (key === "cd_status_row") {
      assert.equal(enVal, "%1$s: %2$s");
      assert.equal(fiVal, "%1$s: %2$s");
      assert.equal(svVal, "%1$s: %2$s");
      continue;
    }

    assert.notEqual(fiVal, enVal, `fi.${key} must be translated from English`);
    assert.notEqual(svVal, enVal, `sv.${key} must be translated from English`);
    assert.notEqual(fiVal, svVal, `fi.${key} must be distinct from sv.${key}`);
  }

  for (const locale of ["en", "fi", "sv"] as const) {
    const proseValues = [...catalogs[locale].entries()]
      .filter(([key]) => key.startsWith("cd_") && key !== "cd_status_row")
      .map(([, val]) => val);
    const uniqueValues = new Set(proseValues);
    assert.equal(
      uniqueValues.size,
      proseValues.length,
      `${locale}: every TalkBack cd_* control must have a distinct spoken description`,
    );
  }

  const fiCombined = [...catalogs.fi.values()].join(" ");
  const svCombined = [...catalogs.sv.values()].join(" ");
  assert.match(fiCombined, /[äöÄÖ]/, "values-fi/strings.xml should use native UTF-8 Finnish diacritics");
  assert.match(svCombined, /[åäöÅÄÖ]/, "values-sv/strings.xml should use native UTF-8 Swedish diacritics");
  assert.match(catalogs.fi.get("cd_streaming_active")!, /RAM/i);
  assert.match(catalogs.sv.get("cd_streaming_active")!, /RAM/i);
  assert.match(catalogs.fi.get("cd_streaming_active")!, /LED/i);
  assert.match(catalogs.sv.get("cd_streaming_active")!, /LED/i);
});

test("i18n XML parser and parity verifier reject comments, dashes, missing keys, and mismatched placeholders, and self source is clean", () => {
  const prolog = '<?xml version="1.0" encoding="utf-8"?>\n';

  assert.throws(() =>
    parseAndroidStringsMap(
      `${prolog}<resources>${XML_COMMENT_OPEN} comment ${XML_COMMENT_CLOSE}<string name="app_name">HoldUp Bridge</string></resources>`,
      "bad-comment.xml",
    ),
  );
  assert.throws(() =>
    parseAndroidStringsMap(
      `${prolog}<resources><string name="app_name">HoldUp ${EM_DASH} Bridge</string></resources>`,
      "bad-emdash.xml",
    ),
  );
  assert.throws(() =>
    parseAndroidStringsMap(
      `${prolog}<resources><string name="app_name">HoldUp ${EN_DASH} Bridge</string></resources>`,
      "bad-endash.xml",
    ),
  );
  assert.throws(() => extractPositionalPlaceholders("Status: %s", "non-positional"));
  assert.throws(() => extractPositionalPlaceholders("Battery 85% full", "unescaped-percent"));

  const baseMap = new Map<string, string>([
    ["app_name", "HoldUp Bridge"],
    ["cd_glasses_status", "Glasses status: %1$s, %2$s, battery %3$s, stream %4$s"],
  ]);
  const missingKeyMap = new Map<string, string>([["app_name", "HoldUp Bridge"]]);
  const badSpecMap = new Map<string, string>([
    ["app_name", "HoldUp Bridge"],
    ["cd_glasses_status", "Lasien tila: %1$s, %2$s, akku %3$s"],
  ]);

  assert.throws(() =>
    verifyStringCatalogParity({ en: baseMap, fi: missingKeyMap, sv: baseMap }),
  );
  assert.throws(() =>
    verifyStringCatalogParity({ en: baseMap, fi: badSpecMap, sv: baseMap }),
  );

  for (const xmlPath of Object.values(LOCALE_FILES)) {
    const raw = fs.readFileSync(xmlPath, "utf8");
    assertCleanSource(raw, path.relative(REPO_ROOT, xmlPath));
  }

  const selfSource = fs.readFileSync(SELF_FILE, "utf8");
  assertCleanSource(selfSource, path.relative(REPO_ROOT, SELF_FILE));
});
