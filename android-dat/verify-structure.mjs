import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EM_DASH = String.fromCharCode(0x2014);
const XML_COMMENT_OPEN = String.fromCharCode(60, 33, 45, 45);
const XML_COMMENT_CLOSE = String.fromCharCode(45, 45, 62);

function checkXmlClean(relLabel, content, errors) {
  if (content.includes(XML_COMMENT_OPEN) || content.includes(XML_COMMENT_CLOSE)) {
    errors.push(`${relLabel}: contains forbidden XML comment`);
  }
  if (content.includes(EM_DASH)) {
    errors.push(`${relLabel}: contains forbidden em-dash`);
  }
}

function resolveRootDir(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }
  }
  return SCRIPT_DIR;
}

function collectFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".gradle" || entry.name === "build" || entry.name === ".idea" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, predicate, out);
    } else if (entry.isFile() && predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

function checkKotlinBraces(source) {
  const stack = [];
  let braceDepth = 0;
  let sawComment = false;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const top = stack.at(-1);
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
        let commentDepth = 1;
        while (i < n && commentDepth > 0) {
          if (source[i] === "/" && source[i + 1] === "*") {
            commentDepth++;
            i += 2;
          } else if (source[i] === "*" && source[i + 1] === "/") {
            commentDepth--;
            i += 2;
          } else {
            i++;
          }
        }
        if (commentDepth !== 0) {
          return { ok: false, reason: "unterminated block comment", sawComment };
        }
        continue;
      }
      if (ch === '"' && next === '"' && source[i + 2] === '"') {
        stack.push({ kind: "raw_string" });
        i += 3;
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "string" });
        i++;
        continue;
      }
      if (ch === "'") {
        i++;
        if (source[i] === "\\") i += 2;
        else i++;
        if (source[i] === "'") i++;
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        if (top && top.kind === "template") top.depth++;
        i++;
        continue;
      }
      if (ch === "}") {
        braceDepth--;
        if (braceDepth < 0) {
          return { ok: false, reason: "unexpected closing brace }", sawComment };
        }
        if (top && top.kind === "template") {
          top.depth--;
          if (top.depth === 0) stack.pop();
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
        braceDepth++;
        stack.push({ kind: "template", depth: 1 });
        i += 2;
        continue;
      }
      if (ch === '"') {
        stack.pop();
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
        braceDepth++;
        stack.push({ kind: "template", depth: 1 });
        i += 2;
        continue;
      }
      if (ch === '"' && next === '"' && source[i + 2] === '"' && source[i + 3] !== '"') {
        stack.pop();
        i += 3;
        continue;
      }
      i++;
      continue;
    }
  }

  if (stack.length > 0) {
    return { ok: false, reason: `unclosed ${stack.at(-1).kind}`, sawComment };
  }
  if (braceDepth !== 0) {
    return { ok: false, reason: `unbalanced braces (remaining depth ${braceDepth})`, sawComment };
  }
  return { ok: true, sawComment };
}

function validateAndroidProject(rootDir) {
  const manifestPath = path.join(rootDir, "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) {
    console.log("SKIP: android-dat pending merge");
    return { skipped: true, errors: [] };
  }

  const errors = [];
  const manifest = fs.readFileSync(manifestPath, "utf8");

  if (!/(?:\.|app\.holdup\.bridge\.)MainActivity\b/.test(manifest)) {
    errors.push("AndroidManifest.xml missing .MainActivity declaration");
  }
  if (!/(?:\.|app\.holdup\.bridge\.)StreamingForegroundService\b/.test(manifest)) {
    errors.push("AndroidManifest.xml missing .StreamingForegroundService declaration");
  }
  const hasLiteralDeepLink = manifest.includes("holdupbridge://connect");
  const hasXmlDeepLink =
    /android:scheme\s*=\s*"holdupbridge"/.test(manifest) &&
    /android:host\s*=\s*"connect"/.test(manifest);
  if (!hasLiteralDeepLink && !hasXmlDeepLink) {
    errors.push("AndroidManifest.xml missing holdupbridge://connect deep-link intent-filter");
  }
  if (!/android:icon\s*=\s*"@drawable\/ic_launcher_foreground"/.test(manifest)) {
    errors.push('AndroidManifest.xml missing android:icon="@drawable/ic_launcher_foreground"');
  }
  if (!/android:theme\s*=\s*"@style\/Theme\.HoldUpBridge"/.test(manifest)) {
    errors.push('AndroidManifest.xml missing android:theme="@style/Theme.HoldUpBridge"');
  }
  if (!/android:networkSecurityConfig\s*=\s*"@xml\/network_security_config"/.test(manifest)) {
    errors.push('AndroidManifest.xml missing android:networkSecurityConfig="@xml/network_security_config"');
  }
  if (/android:usesCleartextTraffic\s*=\s*"true"/.test(manifest)) {
    errors.push('AndroidManifest.xml must not enable global android:usesCleartextTraffic="true"');
  }

  const iconPath = path.join(rootDir, "app", "src", "main", "res", "drawable", "ic_launcher_foreground.xml");
  if (!fs.existsSync(iconPath)) {
    errors.push("Missing app/src/main/res/drawable/ic_launcher_foreground.xml");
  } else {
    const iconXml = fs.readFileSync(iconPath, "utf8");
    if (!/<vector\b/.test(iconXml) || !/<path\b/.test(iconXml)) {
      errors.push("ic_launcher_foreground.xml missing <vector> or <path> definition");
    }
  }

  const themesPath = path.join(rootDir, "app", "src", "main", "res", "values", "themes.xml");
  if (!fs.existsSync(themesPath)) {
    errors.push("Missing app/src/main/res/values/themes.xml");
  } else {
    const themesXml = fs.readFileSync(themesPath, "utf8");
    if (!/<style\s+name\s*=\s*"Theme\.HoldUpBridge"/.test(themesXml)) {
      errors.push("themes.xml missing Theme.HoldUpBridge style definition");
    }
  }

  const netSecPath = path.join(rootDir, "app", "src", "main", "res", "xml", "network_security_config.xml");
  if (!fs.existsSync(netSecPath)) {
    errors.push("Missing app/src/main/res/xml/network_security_config.xml");
  } else {
    const netSecXml = fs.readFileSync(netSecPath, "utf8");
    if (!/<network-security-config\b/.test(netSecXml)) {
      errors.push("network_security_config.xml missing <network-security-config> root");
    }
    if (!/<base-config\b[^>]*\bcleartextTrafficPermitted\s*=\s*"false"/.test(netSecXml)) {
      errors.push('network_security_config.xml missing <base-config cleartextTrafficPermitted="false">');
    }
    if (!/<domain-config\b[^>]*\bcleartextTrafficPermitted\s*=\s*"true"/.test(netSecXml)) {
      errors.push('network_security_config.xml missing <domain-config cleartextTrafficPermitted="true">');
    }
  }

  const xmlFiles = collectFiles(path.join(rootDir, "app", "src", "main"), (name) => name.endsWith(".xml"));
  for (const xmlFile of xmlFiles) {
    const relXml = path.relative(rootDir, xmlFile);
    const xmlContent = fs.readFileSync(xmlFile, "utf8");
    checkXmlClean(relXml, xmlContent, errors);
  }

  const gradleFiles = collectFiles(
    rootDir,
    (name) =>
      name === "build.gradle.kts" ||
      name === "build.gradle" ||
      name === "settings.gradle.kts" ||
      name === "settings.gradle" ||
      name === "libs.versions.toml" ||
      name === "gradle.properties",
  );
  if (gradleFiles.length === 0) {
    errors.push("No Gradle build files found under android-dat");
  } else {
    const combinedGradle = gradleFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    if (!combinedGradle.includes("mwdat-core")) {
      errors.push("Gradle configuration missing mwdat-core dependency");
    }
    if (!combinedGradle.includes("mwdat-camera")) {
      errors.push("Gradle configuration missing mwdat-camera dependency");
    }
    if (!/\b1\.0\.1\b/.test(combinedGradle)) {
      errors.push("Gradle configuration missing DAT SDK version 1.0.1");
    }
    const inlineVersions = [...combinedGradle.matchAll(/mwdat-(?:core|camera):([0-9][0-9A-Za-z.-]*)/g)].map((m) => m[1]);
    for (const ver of inlineVersions) {
      if (ver !== "1.0.1") {
        errors.push(`Expected mwdat inline dependency version 1.0.1, got ${ver}`);
      }
    }
    const catalogVersions = [...combinedGradle.matchAll(/\bmwdat(?:Version)?\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const ver of catalogVersions) {
      if (ver !== "1.0.1") {
        errors.push(`Expected mwdat catalog/variable version 1.0.1, got ${ver}`);
      }
    }
    if (!/\bjunit\b/.test(combinedGradle)) {
      errors.push("Gradle configuration missing junit dependency");
    }
  }

  const bridgePrefsPath = path.join(
    rootDir,
    "app",
    "src",
    "main",
    "java",
    "app",
    "holdup",
    "bridge",
    "BridgePreferences.kt",
  );
  if (!fs.existsSync(bridgePrefsPath)) {
    errors.push("Missing app/src/main/java/app/holdup/bridge/BridgePreferences.kt");
  } else {
    const prefsSrc = fs.readFileSync(bridgePrefsPath, "utf8");
    if (!/\bobject\s+BridgePreferences\b/.test(prefsSrc)) {
      errors.push("BridgePreferences.kt missing 'object BridgePreferences' declaration");
    }
  }

  const bridgeContractTestPath = path.join(
    rootDir,
    "app",
    "src",
    "test",
    "java",
    "app",
    "holdup",
    "bridge",
    "BridgeContractTest.kt",
  );
  if (!fs.existsSync(bridgeContractTestPath)) {
    errors.push("Missing app/src/test/java/app/holdup/bridge/BridgeContractTest.kt");
  } else {
    const testSrc = fs.readFileSync(bridgeContractTestPath, "utf8");
    if (!/\bclass\s+BridgeContractTest\b/.test(testSrc) || !/@Test\b/.test(testSrc)) {
      errors.push("BridgeContractTest.kt missing BridgeContractTest @Test suite");
    }
  }

  const ktFiles = collectFiles(rootDir, (name) => name.endsWith(".kt"));
  if (ktFiles.length === 0) {
    errors.push("No Kotlin (.kt) source files found under android-dat");
  } else {
    let sawExactRootPackage = false;
    for (const ktFile of ktFiles) {
      const rel = path.relative(rootDir, ktFile);
      const src = fs.readFileSync(ktFile, "utf8");
      if (!/^\s*package\s+app\.holdup\.bridge(?:\.[A-Za-z_]\w*)*(?:\s*;)?\s*$/m.test(src)) {
        errors.push(`${rel}: missing 'package app.holdup.bridge' declaration`);
      }
      if (/^\s*package\s+app\.holdup\.bridge(?:\s*;)?\s*$/m.test(src)) {
        sawExactRootPackage = true;
      }
      if (src.includes(EM_DASH)) {
        errors.push(`${rel}: contains forbidden em-dash`);
      }
      const braceCheck = checkKotlinBraces(src);
      if (!braceCheck.ok) {
        errors.push(`${rel}: ${braceCheck.reason}`);
      }
      if (braceCheck.sawComment) {
        errors.push(`${rel}: contains forbidden Kotlin comment`);
      }
    }
    if (!sawExactRootPackage) {
      errors.push("No .kt file declares root 'package app.holdup.bridge'");
    }
  }

  return { skipped: false, errors, ktCount: ktFiles.length };
}

const t0 = Date.now();
const rootDir = resolveRootDir(process.argv.slice(2));
const result = validateAndroidProject(rootDir);

if (result.skipped) {
  process.exit(0);
}

if (result.errors.length > 0) {
  for (const err of result.errors) {
    console.error(`FAIL android-dat: ${err}`);
  }
  process.exit(1);
}

console.log(`PASS android-dat structure verified: ${result.ktCount} Kotlin files, manifest, resources, network-security-config, tests, deep-link, and mwdat 1.0.1 (${Date.now() - t0} ms)`);
