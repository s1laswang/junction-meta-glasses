import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../src/env.ts";

process.env.HOLDUP_QUIET = "1";

const SELF_FILE = fileURLToPath(import.meta.url);
const ANDROID_ROOT = path.join(REPO_ROOT, "android-dat");
const MANIFEST_PATH = path.join(ANDROID_ROOT, "app", "src", "main", "AndroidManifest.xml");
const APP_BUILD_GRADLE_PATH = path.join(ANDROID_ROOT, "app", "build.gradle.kts");
const ROOT_BUILD_GRADLE_PATH = path.join(ANDROID_ROOT, "build.gradle.kts");
const SETTINGS_GRADLE_PATH = path.join(ANDROID_ROOT, "settings.gradle.kts");
const GRADLE_PROPERTIES_PATH = path.join(ANDROID_ROOT, "gradle.properties");
const GRADLE_WRAPPER_PROPERTIES_PATH = path.join(
  ANDROID_ROOT,
  "gradle",
  "wrapper",
  "gradle-wrapper.properties",
);
const LIBS_VERSIONS_TOML_PATH = path.join(ANDROID_ROOT, "gradle", "libs.versions.toml");
const RES_ROOT = path.join(ANDROID_ROOT, "app", "src", "main", "res");
const NETWORK_SECURITY_XML_PATH = path.join(RES_ROOT, "xml", "network_security_config.xml");
const MAIN_JAVA_ROOT = path.join(
  ANDROID_ROOT,
  "app",
  "src",
  "main",
  "java",
  "app",
  "holdup",
  "bridge",
);
const TEST_JAVA_ROOT = path.join(
  ANDROID_ROOT,
  "app",
  "src",
  "test",
  "java",
  "app",
  "holdup",
  "bridge",
);
const GITIGNORE_PATH = path.join(REPO_ROOT, ".gitignore");

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const SCHEME_SEP = ":" + SLASH + SLASH;
const LINE_COMMENT_TOKEN = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const XML_COMMENT_OPEN = "<" + "!--";
const XML_COMMENT_CLOSE = "--" + ">";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const CO_AUTHORED_TOKEN = ["Co", "Authored", "By"].join("-");
const API_KEY_PREFIX = "AI" + "za";
const GHP_TOKEN_PREFIX = "gh" + "p_";
const GHO_TOKEN_PREFIX = "gh" + "o_";
const GHU_TOKEN_PREFIX = "gh" + "u_";
const GHS_TOKEN_PREFIX = "gh" + "s_";
const GHR_TOKEN_PREFIX = "gh" + "r_";
const GITHUB_PAT_PREFIX = "github" + "_pat_";
const AWS_KEY_PREFIX = "AK" + "IA";
const PRIVATE_KEY_MARKER = "BEGIN " + "PRIVATE KEY";
const RSA_PRIVATE_KEY_MARKER = "BEGIN RSA " + "PRIVATE KEY";
const ANDROID_NS = `http${SCHEME_SEP}schemas.android.com${SLASH}apk${SLASH}res${SLASH}android`;

const LOCAL_CLEARTEXT_HOST_ALLOWLIST = new Set([
  "localhost",
  "127.0.0.1",
  "10.0.2.2",
  "local",
  "::1",
  "[::1]",
]);

const FORBIDDEN_INVASIVE_PERMISSIONS = new Set([
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.READ_PHONE_STATE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.REQUEST_INSTALL_PACKAGES",
]);

const FOREGROUND_SERVICE_TYPE_PERMISSION_MAP: Record<string, string[]> = {
  connectedDevice: ["android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"],
  camera: ["android.permission.FOREGROUND_SERVICE_CAMERA", "android.permission.CAMERA"],
  microphone: ["android.permission.FOREGROUND_SERVICE_MICROPHONE", "android.permission.RECORD_AUDIO"],
  location: ["android.permission.FOREGROUND_SERVICE_LOCATION"],
  dataSync: ["android.permission.FOREGROUND_SERVICE_DATA_SYNC"],
  mediaPlayback: ["android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"],
  mediaProjection: ["android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"],
};

type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};

type TomlLibraryEntry = {
  group: string;
  name: string;
  version?: string;
  versionRef?: string;
};

type TomlPluginEntry = {
  id: string;
  version?: string;
  versionRef?: string;
};

type VersionCatalog = {
  versions: Record<string, string>;
  libraries: Record<string, TomlLibraryEntry>;
  plugins: Record<string, TomlPluginEntry>;
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
  assert.equal(source.includes(XML_COMMENT_OPEN), false, `${fileLabel}: XML comments are forbidden`);
  assert.equal(source.includes(XML_COMMENT_CLOSE), false, `${fileLabel}: XML comment closers are forbidden`);
  assert.equal(source.includes(EM_DASH), false, `${fileLabel}: em dashes are forbidden`);

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

    const chunk = source.slice(index, nextLt);
    if (stack.length > 0) {
      stack[stack.length - 1].text += chunk;
    } else {
      assert.equal(chunk.trim(), "", `${fileLabel}: unexpected text outside root element`);
    }

    assert.equal(source.startsWith("<!", nextLt), false, `${fileLabel}: DTD, ENTITY, CDATA, and comments are forbidden`);
    assert.equal(source.startsWith("<?", nextLt), false, `${fileLabel}: unexpected processing instruction`);

    const nextGt = source.indexOf(">", nextLt + 1);
    assert.notEqual(nextGt, -1, `${fileLabel}: unclosed XML '<' tag`);
    const rawBody = source.slice(nextLt + 1, nextGt).trim();
    assert.ok(rawBody.length > 0, `${fileLabel}: empty XML tag`);

    if (rawBody.startsWith(SLASH)) {
      const closeName = rawBody.slice(1).trim();
      assert.match(closeName, /^[A-Za-z_][A-Za-z0-9_.:-]*$/, `${fileLabel}: invalid closing tag`);
      const opened = stack.pop();
      assert.ok(opened, `${fileLabel}: closing tag for '${closeName}' with empty stack`);
      assert.equal(opened.tag, closeName, `${fileLabel}: mismatched closing tag '${closeName}' for '${opened.tag}'`);
      opened.text = opened.text.trim();
    } else {
      const selfClosing = rawBody.endsWith(SLASH);
      const inner = selfClosing ? rawBody.slice(0, -1).trim() : rawBody;
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(inner);
      assert.ok(nameMatch, `${fileLabel}: invalid opening tag <${rawBody}>`);
      const [, tagName, rawAttrs] = nameMatch;
      const node: XmlNode = {
        tag: tagName,
        attrs: parseXmlAttributes(rawAttrs, `${fileLabel}:<${tagName}>`),
        text: "",
        children: [],
      };

      if (stack.length === 0) {
        assert.equal(root, null, `${fileLabel}: multiple root elements are forbidden`);
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

  assert.equal(stack.length, 0, `${fileLabel}: unclosed tags remaining: ${stack.map((n) => n.tag).join(",")}`);
  assert.ok(root, `${fileLabel}: missing root element`);
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

function scanCodeForComments(source: string): { ok: boolean; sawComment: boolean; reason?: string } {
  const modeStack: Array<{ kind: "string" | "raw_string" | "template"; braceDepth: number }> = [];
  let sawComment = false;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const top = modeStack.at(-1);
    const mode = top ? top.kind : "code";
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (mode === "code" || mode === "template") {
      if (ch === SLASH && next === SLASH) {
        sawComment = true;
        i += 2;
        while (i < n && source[i] !== "\n") i += 1;
        continue;
      }
      if (ch === SLASH && next === STAR) {
        sawComment = true;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (source[i] === SLASH && source[i + 1] === STAR) {
            depth += 1;
            i += 2;
          } else if (source[i] === STAR && source[i + 1] === SLASH) {
            depth -= 1;
            i += 2;
          } else {
            i += 1;
          }
        }
        if (depth !== 0) {
          return { ok: false, sawComment, reason: "unterminated block comment" };
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
        i += 1;
        continue;
      }
      if (ch === "'") {
        i += 1;
        if (source[i] === "\\") i += 2;
        else i += 1;
        if (source[i] !== "'") {
          return { ok: false, sawComment, reason: "unterminated char literal" };
        }
        i += 1;
        continue;
      }
      if (ch === "{" && top && top.kind === "template") {
        top.braceDepth += 1;
        i += 1;
        continue;
      }
      if (ch === "}" && top && top.kind === "template") {
        top.braceDepth -= 1;
        if (top.braceDepth === 0) {
          modeStack.pop();
        }
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (mode === "string") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        modeStack.push({ kind: "template", braceDepth: 1 });
        i += 2;
        continue;
      }
      if (ch === '"') {
        modeStack.pop();
        i += 1;
        continue;
      }
      if (ch === "\n") {
        return { ok: false, sawComment, reason: "unterminated string literal" };
      }
      i += 1;
      continue;
    }

    if (mode === "raw_string") {
      if (ch === "$" && next === "{") {
        modeStack.push({ kind: "template", braceDepth: 1 });
        i += 2;
        continue;
      }
      if (ch === '"' && next === '"' && source[i + 2] === '"' && source[i + 3] !== '"') {
        modeStack.pop();
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
  }

  if (modeStack.length > 0) {
    return { ok: false, sawComment, reason: `unclosed ${modeStack.at(-1)?.kind}` };
  }
  return { ok: true, sawComment };
}

function assertZeroSecretsOrTokens(source: string, label: string): void {
  const secretPatterns: Array<{ name: string; re: RegExp }> = [
    { name: "Google API key", re: new RegExp(API_KEY_PREFIX + "[0-9A-Za-z_-]{20,}") },
    { name: "GitHub classic PAT", re: new RegExp(GHP_TOKEN_PREFIX + "[0-9A-Za-z]{20,}") },
    { name: "GitHub OAuth token", re: new RegExp(GHO_TOKEN_PREFIX + "[0-9A-Za-z]{20,}") },
    { name: "GitHub user token", re: new RegExp(GHU_TOKEN_PREFIX + "[0-9A-Za-z]{20,}") },
    { name: "GitHub server token", re: new RegExp(GHS_TOKEN_PREFIX + "[0-9A-Za-z]{20,}") },
    { name: "GitHub refresh token", re: new RegExp(GHR_TOKEN_PREFIX + "[0-9A-Za-z]{20,}") },
    { name: "GitHub fine-grained PAT", re: new RegExp(GITHUB_PAT_PREFIX + "[0-9A-Za-z_]{20,}") },
    { name: "AWS access key", re: new RegExp(AWS_KEY_PREFIX + "[0-9A-Z]{16}") },
    { name: "PEM private key", re: new RegExp(PRIVATE_KEY_MARKER) },
    { name: "RSA private key", re: new RegExp(RSA_PRIVATE_KEY_MARKER) },
  ];

  for (const { name, re } of secretPatterns) {
    assert.equal(re.test(source), false, `${label}: must not contain hardcoded ${name}`);
  }
}

function parseLibsVersionsToml(source: string): VersionCatalog {
  const versions: Record<string, string> = {};
  const libraries: Record<string, TomlLibraryEntry> = {};
  const plugins: Record<string, TomlPluginEntry> = {};
  let section = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    assert.equal(line.startsWith("#"), false, "libs.versions.toml must contain zero '#' comments");

    const sectionMatch = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    if (section === "versions") {
      const kv = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"$/.exec(line);
      assert.ok(kv, `Invalid [versions] entry in libs.versions.toml: ${line}`);
      versions[kv[1]] = kv[2];
    } else if (section === "libraries") {
      const libMatch = /^([A-Za-z0-9_-]+)\s*=\s*\{(.+)\}$/.exec(line);
      assert.ok(libMatch, `Invalid [libraries] entry in libs.versions.toml: ${line}`);
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
    } else if (section === "plugins") {
      const pluginMatch = /^([A-Za-z0-9_-]+)\s*=\s*\{(.+)\}$/.exec(line);
      assert.ok(pluginMatch, `Invalid [plugins] entry in libs.versions.toml: ${line}`);
      const [, alias, body] = pluginMatch;
      const fields: Record<string, string> = {};
      const fieldRegex = /([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = fieldRegex.exec(body)) !== null) {
        fields[m[1]] = m[2];
      }
      assert.ok(fields.id, `Plugin '${alias}' missing id`);
      plugins[alias] = {
        id: fields.id,
        version: fields.version,
        versionRef: fields["version.ref"],
      };
    } else {
      assert.fail(`Unexpected section '${section}' in libs.versions.toml`);
    }
  }

  return { versions, libraries, plugins };
}

function resolveLibraryCoordinate(catalog: VersionCatalog, alias: string): string {
  const entry = catalog.libraries[alias];
  assert.ok(entry, `libs.versions.toml missing library '${alias}'`);
  const version = entry.version ?? (entry.versionRef ? catalog.versions[entry.versionRef] : undefined);
  assert.ok(version, `Library '${alias}' missing resolved version`);
  return `${entry.group}:${entry.name}:${version}`;
}

function resolvePluginCoordinate(catalog: VersionCatalog, alias: string): string {
  const entry = catalog.plugins[alias];
  assert.ok(entry, `libs.versions.toml missing plugin '${alias}'`);
  const version = entry.version ?? (entry.versionRef ? catalog.versions[entry.versionRef] : undefined);
  assert.ok(version, `Plugin '${alias}' missing resolved version`);
  return `${entry.id}:${version}`;
}

function extractKotlinBalancedBlock(source: string, blockHeader: RegExp, label: string): string {
  const headerMatch = blockHeader.exec(source);
  assert.ok(headerMatch, `${label}: missing block matching ${blockHeader}`);
  const openBraceIdx = source.indexOf("{", headerMatch.index);
  assert.notEqual(openBraceIdx, -1, `${label}: missing opening '{' for ${blockHeader}`);

  let depth = 1;
  let idx = openBraceIdx + 1;
  while (idx < source.length && depth > 0) {
    if (source[idx] === "{") depth += 1;
    else if (source[idx] === "}") depth -= 1;
    idx += 1;
  }
  assert.equal(depth, 0, `${label}: unbalanced braces in ${blockHeader}`);
  return source.slice(openBraceIdx + 1, idx - 1);
}

function resolveDatGradleProperties(localProps: Record<string, string | undefined>): {
  mwdatApplicationId: string;
  mwdatClientToken: string;
  buildConfigAppId: string;
  buildConfigClientToken: string;
} {
  const resolveProp = (raw: string | undefined): string => {
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : "0";
  };
  const quoteForBuildConfig = (value: string): string => {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  };

  const mwdatApplicationId = resolveProp(localProps.mwdat_application_id);
  const mwdatClientToken = resolveProp(localProps.mwdat_client_token);
  return {
    mwdatApplicationId,
    mwdatClientToken,
    buildConfigAppId: quoteForBuildConfig(mwdatApplicationId),
    buildConfigClientToken: quoteForBuildConfig(mwdatClientToken),
  };
}

function substituteManifestPlaceholders(rawValue: string, placeholders: Record<string, string>): string {
  return rawValue.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_whole, key: string) => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(placeholders, key),
      true,
      `Unresolved AndroidManifest placeholder \${${key}}`,
    );
    return placeholders[key];
  });
}

function validateManifestPackagingContract(manifestRoot: XmlNode): void {
  assert.equal(manifestRoot.tag, "manifest", "Root tag must be <manifest>");
  assert.equal(manifestRoot.attrs["xmlns:android"], ANDROID_NS, "<manifest> must bind Android XML namespace");

  const permissionNodes = manifestRoot.children.filter((child) => child.tag === "uses-permission");
  const permissions: string[] = [];
  const permissionSet = new Set<string>();
  for (const node of permissionNodes) {
    const perm = node.attrs["android:name"];
    assert.ok(perm && perm.length > 0, "<uses-permission> must set non-empty android:name");
    assert.equal(permissionSet.has(perm), false, `Duplicate <uses-permission> '${perm}'`);
    assert.equal(
      FORBIDDEN_INVASIVE_PERMISSIONS.has(perm),
      false,
      `Disallowed over-privileged Android permission '${perm}'`,
    );
    permissionSet.add(perm);
    permissions.push(perm);
  }

  for (const requiredPerm of [
    "android.permission.INTERNET",
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.FOREGROUND_SERVICE",
  ]) {
    assert.equal(
      permissionSet.has(requiredPerm),
      true,
      `AndroidManifest.xml must declare '${requiredPerm}'`,
    );
  }

  const appNodes = manifestRoot.children.filter((child) => child.tag === "application");
  assert.equal(appNodes.length, 1, "AndroidManifest.xml must declare exactly one <application>");
  const appNode = appNodes[0];

  assert.equal(
    appNode.attrs["android:allowBackup"],
    "false",
    'AndroidManifest.xml must set android:allowBackup="false" to prevent cloud backup of pairing state',
  );
  assert.equal(
    appNode.attrs["android:networkSecurityConfig"],
    `@xml${SLASH}network_security_config`,
    "AndroidManifest.xml must bind @xml/network_security_config",
  );
  assert.notEqual(
    appNode.attrs["android:usesCleartextTraffic"],
    "true",
    "AndroidManifest.xml must never enable global cleartext HTTP",
  );
  assert.notEqual(
    appNode.attrs["android:debuggable"],
    "true",
    "AndroidManifest.xml must never hardcode android:debuggable=true",
  );
  assert.notEqual(
    appNode.attrs["android:testOnly"],
    "true",
    "AndroidManifest.xml must never hardcode android:testOnly=true",
  );

  const componentTags = new Set(["activity", "activity-alias", "service", "receiver", "provider"]);
  for (const child of appNode.children) {
    if (!componentTags.has(child.tag)) continue;
    const compName = child.attrs["android:name"] ?? "<unnamed>";
    const exportedAttr = child.attrs["android:exported"];
    assert.equal(
      exportedAttr === "true" || exportedAttr === "false",
      true,
      `Android 12+ requires explicit android:exported="true"|"false" on <${child.tag} android:name="${compName}">`,
    );
  }

  const metaData = new Map<string, string>();
  for (const node of appNode.children.filter((child) => child.tag === "meta-data")) {
    const name = node.attrs["android:name"];
    const value = node.attrs["android:value"];
    assert.ok(name && name.length > 0, "<meta-data> must declare android:name");
    assert.ok(value !== undefined && value.length > 0, `<meta-data android:name="${name}"> must declare android:value`);
    assert.equal(metaData.has(name), false, `Duplicate <meta-data android:name="${name}">`);
    metaData.set(name, value);
  }

  const appIdMeta = metaData.get("com.meta.wearable.mwdat.APPLICATION_ID");
  assert.ok(
    appIdMeta === "0" || appIdMeta === "${mwdatApplicationId}" || appIdMeta === "${mwdat_application_id}",
    `Expected Meta Wearables DAT APPLICATION_ID metadata ('0' or placeholder), got '${String(appIdMeta)}'`,
  );

  const activities = appNode.children.filter((child) => child.tag === "activity");
  const mainActivity = activities.find(
    (node) =>
      node.attrs["android:name"] === ".MainActivity" ||
      node.attrs["android:name"] === "app.holdup.bridge.MainActivity",
  );
  assert.ok(mainActivity, "AndroidManifest.xml must declare .MainActivity");
  assert.equal(mainActivity.attrs["android:exported"], "true", ".MainActivity must set android:exported=\"true\"");

  const intentFilters = mainActivity.children.filter((child) => child.tag === "intent-filter");
  const hasLauncherFilter = intentFilters.some((filter) => {
    const actions = filter.children
      .filter((c) => c.tag === "action")
      .map((c) => c.attrs["android:name"]);
    const categories = filter.children
      .filter((c) => c.tag === "category")
      .map((c) => c.attrs["android:name"]);
    return (
      actions.includes("android.intent.action.MAIN") &&
      categories.includes("android.intent.category.LAUNCHER")
    );
  });
  assert.equal(hasLauncherFilter, true, ".MainActivity must declare MAIN + LAUNCHER intent-filter");

  const deepLinkFilter = intentFilters.find((filter) =>
    filter.children.some(
      (c) => c.tag === "action" && c.attrs["android:name"] === "android.intent.action.VIEW",
    ),
  );
  assert.ok(deepLinkFilter, ".MainActivity must declare ACTION_VIEW deep-link intent-filter");

  const deepLinkCategories = deepLinkFilter.children
    .filter((c) => c.tag === "category")
    .map((c) => c.attrs["android:name"]);
  assert.equal(
    deepLinkCategories.includes("android.intent.category.DEFAULT"),
    true,
    "Deep-link intent-filter must include android.intent.category.DEFAULT",
  );
  assert.equal(
    deepLinkCategories.includes("android.intent.category.BROWSABLE"),
    true,
    "Deep-link intent-filter must include android.intent.category.BROWSABLE",
  );

  const dataNodes = deepLinkFilter.children.filter((c) => c.tag === "data");
  assert.ok(dataNodes.length >= 1, "Deep-link intent-filter must include <data> scheme/host");
  const hasConnectUri = dataNodes.some(
    (d) => d.attrs["android:scheme"] === "holdupbridge" && d.attrs["android:host"] === "connect",
  );
  assert.equal(
    hasConnectUri,
    true,
    `Deep-link intent-filter must bind holdupbridge${SCHEME_SEP}connect`,
  );

  const services = appNode.children.filter((child) => child.tag === "service");
  assert.ok(services.length >= 1, "AndroidManifest.xml must declare foreground streaming <service>");

  for (const svc of services) {
    const svcName = svc.attrs["android:name"] ?? "<unnamed-service>";
    assert.equal(
      svc.attrs["android:exported"],
      "false",
      `Foreground service '${svcName}' must set android:exported="false"`,
    );
    const rawFgsTypes = svc.attrs["android:foregroundServiceType"] ?? "";
    const fgsTypes = rawFgsTypes
      .split("|")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    assert.ok(
      fgsTypes.length >= 1,
      `Android 14/15 requires explicit android:foregroundServiceType on '${svcName}'`,
    );
    assert.equal(
      permissionSet.has("android.permission.FOREGROUND_SERVICE"),
      true,
      `Service '${svcName}' requires android.permission.FOREGROUND_SERVICE`,
    );

    for (const fgsType of fgsTypes) {
      const requiredForType = FOREGROUND_SERVICE_TYPE_PERMISSION_MAP[fgsType];
      assert.ok(
        requiredForType,
        `Service '${svcName}' declares unsupported foregroundServiceType '${fgsType}'`,
      );
      for (const typePerm of requiredForType) {
        assert.equal(
          permissionSet.has(typePerm),
          true,
          `Android 14/15 foregroundServiceType="${fgsType}" on '${svcName}' requires '${typePerm}'`,
        );
      }
    }
  }
}

function validateGradleSdkContract(params: {
  settingsGradle: string;
  appBuildGradle: string;
  catalog: VersionCatalog;
}): void {
  const { settingsGradle, appBuildGradle, catalog } = params;

  const pluginMgmtBlock = extractKotlinBalancedBlock(
    settingsGradle,
    /\bpluginManagement\b/,
    "settings.gradle.kts",
  );
  const pluginReposBlock = extractKotlinBalancedBlock(
    pluginMgmtBlock,
    /\brepositories\b/,
    "settings.gradle.kts:pluginManagement",
  );
  assert.match(pluginReposBlock, /\bgoogle\s*\(\s*\)/);
  assert.match(pluginReposBlock, /\bmavenCentral\s*\(\s*\)/);

  const depMgmtBlock = extractKotlinBalancedBlock(
    settingsGradle,
    /\bdependencyResolutionManagement\b/,
    "settings.gradle.kts",
  );
  assert.match(
    depMgmtBlock,
    /\brepositoriesMode\.set\(\s*RepositoriesMode\.FAIL_ON_PROJECT_REPOS\s*\)/,
    "settings.gradle.kts must enforce RepositoriesMode.FAIL_ON_PROJECT_REPOS",
  );
  const depReposBlock = extractKotlinBalancedBlock(
    depMgmtBlock,
    /\brepositories\b/,
    "settings.gradle.kts:dependencyResolutionManagement",
  );
  assert.match(depReposBlock, /\bgoogle\s*\(\s*\)/);
  assert.match(depReposBlock, /\bmavenCentral\s*\(\s*\)/);

  assert.equal(
    /maven\.pkg\.github\.com/i.test(settingsGradle) || /maven\.pkg\.github\.com/i.test(appBuildGradle),
    false,
    "Gradle scripts must use Maven Central without legacy GitHub Packages URLs",
  );
  assert.equal(
    /\bcredentials\s*\{/.test(settingsGradle) || /\bcredentials\s*\{/.test(appBuildGradle),
    false,
    "Gradle scripts must not declare repository credentials blocks",
  );
  assert.equal(
    /\b(?:GITHUB_TOKEN|gpr\.key|gpr\.user)\b/.test(settingsGradle + "\n" + appBuildGradle),
    false,
    "Gradle scripts must not reference GitHub Personal Access Token variables",
  );

  assertZeroSecretsOrTokens(settingsGradle, "settings.gradle.kts");
  assertZeroSecretsOrTokens(appBuildGradle, "app/build.gradle.kts");

  assert.equal(
    resolveLibraryCoordinate(catalog, "mwdat-core"),
    "com.meta.wearable:mwdat-core:1.0.1",
    "mwdat-core must resolve to com.meta.wearable:mwdat-core:1.0.1",
  );
  assert.equal(
    resolveLibraryCoordinate(catalog, "mwdat-camera"),
    "com.meta.wearable:mwdat-camera:1.0.1",
    "mwdat-camera must resolve to com.meta.wearable:mwdat-camera:1.0.1",
  );

  const junitCoord = resolveLibraryCoordinate(catalog, "junit");
  assert.match(
    junitCoord,
    /^junit:junit:4\.\d+\.\d+$/,
    `Expected JUnit4 dependency junit:junit:4.x.y, got ${junitCoord}`,
  );

  const minSdkMatch = /\bminSdk\s*=\s*(\d+)\b/.exec(appBuildGradle);
  const targetSdkMatch = /\btargetSdk\s*=\s*(\d+)\b/.exec(appBuildGradle);
  const compileSdkMatch = /\bcompileSdk\s*=\s*(\d+)\b/.exec(appBuildGradle);
  assert.ok(minSdkMatch, "app/build.gradle.kts must set minSdk");
  assert.ok(targetSdkMatch, "app/build.gradle.kts must set targetSdk");
  assert.ok(compileSdkMatch, "app/build.gradle.kts must set compileSdk");

  const minSdk = Number(minSdkMatch[1]);
  const targetSdk = Number(targetSdkMatch[1]);
  const compileSdk = Number(compileSdkMatch[1]);
  assert.ok(minSdk >= 29, `Meta Wearables DAT SDK requires minSdk >= 29, got ${minSdk}`);
  assert.ok(targetSdk >= 34, `Android 14/15 foreground service contract requires targetSdk >= 34, got ${targetSdk}`);
  assert.ok(compileSdk >= targetSdk, `compileSdk (${compileSdk}) must be >= targetSdk (${targetSdk})`);
  assert.ok(targetSdk >= minSdk, `targetSdk (${targetSdk}) must be >= minSdk (${minSdk})`);

  const dependenciesBlock = extractKotlinBalancedBlock(
    appBuildGradle,
    /\bdependencies\b/,
    "app/build.gradle.kts",
  );
  assert.match(
    dependenciesBlock,
    /\bimplementation\(\s*libs\.mwdat\.core\s*\)/,
    "app/build.gradle.kts must declare implementation(libs.mwdat.core)",
  );
  assert.match(
    dependenciesBlock,
    /\bimplementation\(\s*libs\.mwdat\.camera\s*\)/,
    "app/build.gradle.kts must declare implementation(libs.mwdat.camera)",
  );
  assert.match(
    dependenciesBlock,
    /\btestImplementation\(\s*libs\.junit\s*\)/,
    "app/build.gradle.kts must declare testImplementation(libs.junit)",
  );
}

function collectFilesRecursive(
  dir: string,
  predicate: (name: string, fullPath: string) => boolean,
  out: string[] = [],
): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
      collectFilesRecursive(full, predicate, out);
    } else if (entry.isFile() && predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out.sort();
}

test("AndroidManifest.xml enforces Android 14/15 permissions, foregroundServiceType, and wearable camera permission boundaries", () => {
  assert.equal(fs.existsSync(MANIFEST_PATH), true, "AndroidManifest.xml must exist");
  const manifestSrc = fs.readFileSync(MANIFEST_PATH, "utf8");
  const manifestRoot = parseXmlDocument(manifestSrc, "AndroidManifest.xml");

  validateManifestPackagingContract(manifestRoot);

  const declaredPermissions = manifestRoot.children
    .filter((node) => node.tag === "uses-permission")
    .map((node) => node.attrs["android:name"]);

  assert.deepEqual(declaredPermissions, [
    "android.permission.INTERNET",
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
  ]);

  const appNode = manifestRoot.children.find((node) => node.tag === "application")!;
  const serviceNode = appNode.children.find(
    (node) => node.tag === "service" && node.attrs["android:name"] === ".StreamingForegroundService",
  );
  assert.ok(serviceNode, "AndroidManifest.xml must declare .StreamingForegroundService");
  assert.equal(serviceNode.attrs["android:enabled"], "true");
  assert.equal(serviceNode.attrs["android:exported"], "false");
  assert.equal(serviceNode.attrs["android:foregroundServiceType"], "connectedDevice");

  const serviceKt = fs.readFileSync(path.join(MAIN_JAVA_ROOT, "StreamingForegroundService.kt"), "utf8");
  assert.match(serviceKt, /\bBuild\.VERSION_CODES\.UPSIDE_DOWN_CAKE\b/);
  assert.match(serviceKt, /\bServiceInfo\.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE\b/);
  assert.match(serviceKt, /\bNotification\.FOREGROUND_SERVICE_IMMEDIATE\b/);
  assert.match(serviceKt, /\bSTOP_FOREGROUND_REMOVE\b/);
  assert.match(serviceKt, /\bPowerManager\.PARTIAL_WAKE_LOCK\b/);
  assert.match(serviceKt, /\bWAKELOCK_TIMEOUT_MS\s*=\s*30L\s*\*\s*60L\s*\*\s*1000L\b/);

  const mainActivityKt = fs.readFileSync(path.join(MAIN_JAVA_ROOT, "MainActivity.kt"), "utf8");
  assert.match(mainActivityKt, /\bManifest\.permission\.BLUETOOTH_CONNECT\b/);
  assert.match(mainActivityKt, /\bManifest\.permission\.POST_NOTIFICATIONS\b/);
  assert.match(mainActivityKt, /\bBuild\.VERSION_CODES\.S\b/);
  assert.match(mainActivityKt, /\bBuild\.VERSION_CODES\.TIRAMISU\b/);

  const controllerKt = fs.readFileSync(path.join(MAIN_JAVA_ROOT, "DatBridgeController.kt"), "utf8");
  assert.match(controllerKt, /\bimport\s+com\.meta\.wearable\.dat\.core\.types\.Permission\b/);
  assert.match(controllerKt, /\bWearables\.checkPermissionStatus\(\s*Permission\.CAMERA\s*\)/);
  assert.match(controllerKt, /\bWearables\.RequestPermissionContract\s*\(\s*\)/);
});

test(`AndroidManifest.xml binds @xml/network_security_config, allowBackup=false, MainActivity holdupbridge${SCHEME_SEP}connect deep-link, and Developer Mode 0 metadata`, () => {
  const manifestRoot = parseXmlDocument(fs.readFileSync(MANIFEST_PATH, "utf8"), "AndroidManifest.xml");
  const appGradleSrc = fs.readFileSync(APP_BUILD_GRADLE_PATH, "utf8");
  const netSecRoot = parseXmlDocument(
    fs.readFileSync(NETWORK_SECURITY_XML_PATH, "utf8"),
    "network_security_config.xml",
  );

  const appNode = manifestRoot.children.find((node) => node.tag === "application")!;
  assert.equal(appNode.attrs["android:allowBackup"], "false");
  assert.equal(appNode.attrs["android:supportsRtl"], "true");
  assert.equal(appNode.attrs["android:networkSecurityConfig"], `@xml${SLASH}network_security_config`);
  assert.equal(appNode.attrs["android:icon"], `@drawable${SLASH}ic_launcher_foreground`);
  assert.equal(appNode.attrs["android:label"], `@string${SLASH}app_name`);
  assert.equal(appNode.attrs["android:theme"], `@style${SLASH}Theme.HoldUpBridge`);

  assert.equal(fs.existsSync(path.join(RES_ROOT, "drawable", "ic_launcher_foreground.xml")), true);
  assert.equal(fs.existsSync(path.join(RES_ROOT, "values", "strings.xml")), true);
  assert.equal(fs.existsSync(path.join(RES_ROOT, "values", "themes.xml")), true);
  assert.equal(fs.existsSync(NETWORK_SECURITY_XML_PATH), true);

  assert.equal(netSecRoot.tag, "network-security-config");
  assert.equal(findDescendants(netSecRoot, "debug-overrides").length, 0);
  const baseConfig = netSecRoot.children.find((node) => node.tag === "base-config");
  assert.ok(baseConfig);
  assert.equal(baseConfig.attrs.cleartextTrafficPermitted, "false");
  const certNodes = findDescendants(netSecRoot, "certificates");
  assert.equal(certNodes.length, 1);
  assert.equal(certNodes[0].attrs.src, "system");

  const domainConfigs = netSecRoot.children.filter((node) => node.tag === "domain-config");
  assert.equal(domainConfigs.length, 1);
  assert.equal(domainConfigs[0].attrs.cleartextTrafficPermitted, "true");
  const cleartextDomains = domainConfigs[0].children
    .filter((node) => node.tag === "domain")
    .map((node) => node.text.trim());
  for (const domain of cleartextDomains) {
    assert.equal(LOCAL_CLEARTEXT_HOST_ALLOWLIST.has(domain), true, `Unexpected cleartext domain '${domain}'`);
  }
  assert.deepEqual(cleartextDomains, ["localhost", "127.0.0.1", "10.0.2.2", "local"]);

  const mainActivityNode = appNode.children.find(
    (node) => node.tag === "activity" && node.attrs["android:name"] === ".MainActivity",
  );
  assert.ok(mainActivityNode);
  assert.equal(mainActivityNode.attrs["android:exported"], "true");
  assert.equal(mainActivityNode.attrs["android:launchMode"], "singleTop");

  const viewFilter = mainActivityNode.children
    .filter((node) => node.tag === "intent-filter")
    .find((filter) =>
      filter.children.some(
        (child) => child.tag === "action" && child.attrs["android:name"] === "android.intent.action.VIEW",
      ),
    );
  assert.ok(viewFilter);
  const categories = viewFilter.children
    .filter((child) => child.tag === "category")
    .map((child) => child.attrs["android:name"])
    .sort();
  assert.deepEqual(categories, [
    "android.intent.category.BROWSABLE",
    "android.intent.category.DEFAULT",
  ]);
  const dataNode = viewFilter.children.find((child) => child.tag === "data");
  assert.ok(dataNode);
  assert.equal(dataNode.attrs["android:scheme"], "holdupbridge");
  assert.equal(dataNode.attrs["android:host"], "connect");
  assert.equal(dataNode.attrs["android:pathPrefix"], undefined);

  for (const compNode of appNode.children.filter((n) => n.tag === "activity" || n.tag === "service")) {
    const rawName = compNode.attrs["android:name"];
    assert.ok(rawName && rawName.startsWith("."), `Component name '${rawName}' must be package-relative`);
    const ktFile = path.join(MAIN_JAVA_ROOT, `${rawName.slice(1)}.kt`);
    assert.equal(fs.existsSync(ktFile), true, `Missing Kotlin implementation for ${rawName}`);
  }

  assert.match(
    appGradleSrc,
    /localProperties\.getProperty\(\s*"mwdat_application_id"\s*\)\?\.trim\(\)\?\.takeIf\s*\{\s*it\.isNotEmpty\(\)\s*\}\s*\?:\s*"0"/,
  );
  assert.match(
    appGradleSrc,
    /localProperties\.getProperty\(\s*"mwdat_client_token"\s*\)\?\.trim\(\)\?\.takeIf\s*\{\s*it\.isNotEmpty\(\)\s*\}\s*\?:\s*"0"/,
  );
  assert.match(appGradleSrc, /manifestPlaceholders\["mwdatApplicationId"\]\s*=\s*mwdatApplicationId/);
  assert.match(appGradleSrc, /manifestPlaceholders\["mwdatClientToken"\]\s*=\s*mwdatClientToken/);

  const devModeResolved = resolveDatGradleProperties({});
  assert.equal(devModeResolved.mwdatApplicationId, "0");
  assert.equal(devModeResolved.mwdatClientToken, "0");
  assert.equal(devModeResolved.buildConfigAppId, '"0"');
  assert.equal(devModeResolved.buildConfigClientToken, '"0"');

  const blankPropsResolved = resolveDatGradleProperties({
    mwdat_application_id: "   ",
    mwdat_client_token: "\t\n",
  });
  assert.equal(blankPropsResolved.mwdatApplicationId, "0");
  assert.equal(blankPropsResolved.mwdatClientToken, "0");

  const customPropsResolved = resolveDatGradleProperties({
    mwdat_application_id: " 1234567890 ",
    mwdat_client_token: ' tok_"escaped"\\ok ',
  });
  assert.equal(customPropsResolved.mwdatApplicationId, "1234567890");
  assert.equal(customPropsResolved.buildConfigClientToken, '"tok_\\"escaped\\"\\\\ok"');

  const metaDataNodes = appNode.children.filter((node) => node.tag === "meta-data");
  const resolvedMeta = new Map<string, string>();
  for (const node of metaDataNodes) {
    resolvedMeta.set(
      node.attrs["android:name"],
      substituteManifestPlaceholders(node.attrs["android:value"], {
        mwdatApplicationId: devModeResolved.mwdatApplicationId,
        mwdatClientToken: devModeResolved.mwdatClientToken,
      }),
    );
  }
  assert.equal(resolvedMeta.get("com.meta.wearable.mwdat.APPLICATION_ID"), "0");
  assert.equal(resolvedMeta.get("com.meta.wearable.mwdat.CLIENT_TOKEN"), "0");
});

test("settings.gradle.kts, app/build.gradle.kts, and libs.versions.toml resolve Maven Central mwdat 1.0.1, minSdk >= 29, JUnit4, and zero PATs or secrets", () => {
  const settingsGradle = fs.readFileSync(SETTINGS_GRADLE_PATH, "utf8");
  const rootBuildGradle = fs.readFileSync(ROOT_BUILD_GRADLE_PATH, "utf8");
  const appBuildGradle = fs.readFileSync(APP_BUILD_GRADLE_PATH, "utf8");
  const catalogToml = fs.readFileSync(LIBS_VERSIONS_TOML_PATH, "utf8");
  const gradleProps = fs.readFileSync(GRADLE_PROPERTIES_PATH, "utf8");
  const wrapperProps = fs.readFileSync(GRADLE_WRAPPER_PROPERTIES_PATH, "utf8");

  const catalog = parseLibsVersionsToml(catalogToml);
  validateGradleSdkContract({ settingsGradle, appBuildGradle, catalog });

  assert.match(settingsGradle, /\brootProject\.name\s*=\s*"HoldUpBridge"/);
  assert.match(settingsGradle, /\binclude\(\s*":app"\s*\)/);

  assert.match(appBuildGradle, /\bnamespace\s*=\s*"app\.holdup\.bridge"/);
  assert.match(appBuildGradle, /\bapplicationId\s*=\s*"app\.holdup\.bridge"/);
  assert.match(appBuildGradle, /\bsourceCompatibility\s*=\s*JavaVersion\.VERSION_17\b/);
  assert.match(appBuildGradle, /\btargetCompatibility\s*=\s*JavaVersion\.VERSION_17\b/);
  assert.match(appBuildGradle, /\bJvmTarget\.fromTarget\(\s*"17"\s*\)/);
  assert.match(appBuildGradle, /\bcompose\s*=\s*true\b/);
  assert.match(appBuildGradle, /\bbuildConfig\s*=\s*true\b/);

  for (const pluginAlias of ["android-application", "kotlin-android", "kotlin-compose"]) {
    const coord = resolvePluginCoordinate(catalog, pluginAlias);
    assert.match(coord, /^[A-Za-z0-9_.]+:\d+\.\d+(?:\.\d+)?$/);
  }

  const combinedGradleScripts = `${rootBuildGradle}\n${appBuildGradle}`;
  const pluginRefs = Array.from(
    combinedGradleScripts.matchAll(/\blibs\.plugins\.([A-Za-z0-9_.]+)\b/g),
    (m) => m[1].replace(/\./g, "-"),
  );
  assert.ok(pluginRefs.length >= 3);
  for (const alias of pluginRefs) {
    assert.ok(catalog.plugins[alias], `Unresolved plugin catalog reference libs.plugins.${alias}`);
  }

  const libRefs = Array.from(
    appBuildGradle.matchAll(/\blibs\.(?!plugins\b)([A-Za-z0-9_.]+)\b/g),
    (m) => m[1].replace(/\./g, "-"),
  );
  assert.ok(libRefs.length >= 15);
  for (const alias of libRefs) {
    assert.ok(catalog.libraries[alias], `Unresolved library catalog reference '${alias}'`);
  }

  assert.match(gradleProps, /\bandroid\.useAndroidX=true\b/);
  assert.match(gradleProps, /\bandroid\.nonTransitiveRClass=true\b/);
  assert.match(
    wrapperProps,
    new RegExp(`distributionUrl=https\\\\:${SLASH}${SLASH}services\\.gradle\\.org${SLASH}distributions${SLASH}gradle-8\\.\\d+(?:\\.\\d+)?-bin\\.zip`),
  );
  assert.match(wrapperProps, /\bvalidateDistributionUrl=true\b/);

  const testKtFiles = collectFilesRecursive(TEST_JAVA_ROOT, (name) => name.endsWith("Test.kt"));
  assert.ok(testKtFiles.length >= 4, `Expected >= 4 JUnit4 Kotlin test suites, found ${testKtFiles.length}`);
  for (const ktPath of testKtFiles) {
    const ktSrc = fs.readFileSync(ktPath, "utf8");
    const rel = path.relative(REPO_ROOT, ktPath);
    assert.match(ktSrc, /\bimport\s+org\.junit\.Test\b/, `${rel}: must import org.junit.Test`);
    assert.match(ktSrc, /@Test\b/, `${rel}: must declare @Test cases`);
  }

  const gitignoreSrc = fs.readFileSync(GITIGNORE_PATH, "utf8");
  assert.match(gitignoreSrc, /^android-dat\/local\.properties$/m);

  const trackedLocalProps = execFileSync("git", ["ls-files", "--", "android-dat/local.properties"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  assert.equal(trackedLocalProps, "", "android-dat/local.properties must never be tracked by git");

  const keystoreFiles = collectFilesRecursive(
    ANDROID_ROOT,
    (name) => name.endsWith(".jks") || name.endsWith(".keystore") || name.endsWith(".p12"),
  );
  assert.deepEqual(keystoreFiles, [], "android-dat/ must not commit signing keystores");

  const allAndroidTextFiles = collectFilesRecursive(
    ANDROID_ROOT,
    (name) =>
      name.endsWith(".kts") ||
      name.endsWith(".kt") ||
      name.endsWith(".xml") ||
      name.endsWith(".toml") ||
      name.endsWith(".properties") ||
      name.endsWith(".mjs"),
  );
  assert.ok(allAndroidTextFiles.length >= 20);

  for (const filePath of allAndroidTextFiles) {
    const rel = path.relative(REPO_ROOT, filePath);
    const content = fs.readFileSync(filePath, "utf8");
    assertZeroSecretsOrTokens(content, rel);
    assert.equal(content.includes(EM_DASH), false, `${rel}: must not contain em dashes`);

    if (filePath.endsWith(".kts") || filePath.endsWith(".kt")) {
      const scan = scanCodeForComments(content);
      assert.equal(scan.ok, true, `${rel}: ${scan.reason ?? "source scan failed"}`);
      assert.equal(scan.sawComment, false, `${rel}: must contain zero Kotlin or Gradle comments`);
    }
  }
});

test("contract validators deterministically reject insecure manifests, broken Android 14/15 FGS types, PAT repos, and SDK downgrades", () => {
  const validManifestSrc = fs.readFileSync(MANIFEST_PATH, "utf8");

  assert.throws(() => {
    const badBackup = validManifestSrc.replace('android:allowBackup="false"', 'android:allowBackup="true"');
    validateManifestPackagingContract(parseXmlDocument(badBackup, "allow-backup.xml"));
  }, /allowBackup="false"/);

  assert.throws(() => {
    const missingNetSec = validManifestSrc.replace(
      `android:networkSecurityConfig="@xml${SLASH}network_security_config"`,
      `android:usesCleartextTraffic="true"`,
    );
    validateManifestPackagingContract(parseXmlDocument(missingNetSec, "cleartext.xml"));
  }, /network_security_config/);

  assert.throws(() => {
    const missingExported = validManifestSrc.replace('android:exported="true"', "");
    validateManifestPackagingContract(parseXmlDocument(missingExported, "missing-exported.xml"));
  }, /android:exported/);

  assert.throws(() => {
    const missingBrowsable = validManifestSrc.replace(
      `<category android:name="android.intent.category.BROWSABLE" />`,
      "",
    );
    validateManifestPackagingContract(parseXmlDocument(missingBrowsable, "missing-browsable.xml"));
  }, /BROWSABLE/);

  assert.throws(() => {
    const wrongDeepLink = validManifestSrc.replace('android:host="connect"', 'android:host="pair"');
    validateManifestPackagingContract(parseXmlDocument(wrongDeepLink, "wrong-deeplink.xml"));
  }, /holdupbridge/);

  assert.throws(() => {
    const missingFgsPerm = validManifestSrc.replace(
      `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />`,
      "",
    );
    validateManifestPackagingContract(parseXmlDocument(missingFgsPerm, "missing-fgs-connected.xml"));
  }, /FOREGROUND_SERVICE_CONNECTED_DEVICE/);

  assert.throws(() => {
    const cameraFgsWithoutPerms = validManifestSrc.replace(
      'android:foregroundServiceType="connectedDevice"',
      'android:foregroundServiceType="camera"',
    );
    validateManifestPackagingContract(parseXmlDocument(cameraFgsWithoutPerms, "camera-fgs-missing-perms.xml"));
  }, /FOREGROUND_SERVICE_CAMERA/);

  const cameraFgsValid = validManifestSrc
    .replace(
      `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />`,
      `<uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />`,
    )
    .replace('android:foregroundServiceType="connectedDevice"', 'android:foregroundServiceType="camera"');
  validateManifestPackagingContract(parseXmlDocument(cameraFgsValid, "camera-fgs-valid.xml"));

  assert.throws(() => {
    const exportedService = validManifestSrc.replace(
      'android:exported="false"',
      'android:exported="true"',
    );
    validateManifestPackagingContract(parseXmlDocument(exportedService, "exported-fgs.xml"));
  }, /exported="false"/);

  const settingsGradle = fs.readFileSync(SETTINGS_GRADLE_PATH, "utf8");
  const appBuildGradle = fs.readFileSync(APP_BUILD_GRADLE_PATH, "utf8");
  const catalog = parseLibsVersionsToml(fs.readFileSync(LIBS_VERSIONS_TOML_PATH, "utf8"));

  assert.throws(() => {
    validateGradleSdkContract({
      settingsGradle: settingsGradle.replace(/mavenCentral\(\)/g, ""),
      appBuildGradle,
      catalog,
    });
  }, /mavenCentral/);

  assert.throws(() => {
    const fakePat = GHP_TOKEN_PREFIX + "0123456789abcdefghij0123456789";
    validateGradleSdkContract({
      settingsGradle: `${settingsGradle}\nval token = "${fakePat}"`,
      appBuildGradle,
      catalog,
    });
  }, /GitHub classic PAT/);

  assert.throws(() => {
    validateGradleSdkContract({
      settingsGradle,
      appBuildGradle: appBuildGradle.replace("minSdk = 31", "minSdk = 28"),
      catalog,
    });
  }, /minSdk >= 29/);

  assert.throws(() => {
    validateGradleSdkContract({
      settingsGradle,
      appBuildGradle,
      catalog: {
        ...catalog,
        versions: { ...catalog.versions, mwdat: "1.0.0" },
      },
    });
  }, /1\.0\.1/);

  assert.throws(() => {
    validateGradleSdkContract({
      settingsGradle,
      appBuildGradle: appBuildGradle.replace("testImplementation(libs.junit)", ""),
      catalog,
    });
  }, /testImplementation\(libs\.junit\)/);
});

test("android-manifest-contract.test.ts contains zero comments, zero em dashes, zero secrets, and zero co-author trailers", () => {
  const selfSource = fs.readFileSync(SELF_FILE, "utf8");
  const coAuthoredRe = new RegExp(CO_AUTHORED_TOKEN, "i");

  assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false, "Self source must contain zero line comment tokens");
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false, "Self source must contain zero block comment openers");
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false, "Self source must contain zero block comment closers");
  assert.equal(selfSource.includes(XML_COMMENT_OPEN), false, "Self source must contain zero XML comment openers");
  assert.equal(selfSource.includes(XML_COMMENT_CLOSE), false, "Self source must contain zero XML comment closers");
  assert.equal(selfSource.includes(EM_DASH), false, "Self source must contain zero em dashes");
  assert.equal(selfSource.includes(EN_DASH), false, "Self source must contain zero en dashes");
  assert.equal(coAuthoredRe.test(selfSource), false, "Self source must contain zero co-author trailers");
  assertZeroSecretsOrTokens(selfSource, "android-manifest-contract.test.ts");
});
