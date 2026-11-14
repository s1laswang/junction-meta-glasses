import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
  let i = 0;
  const n = source.length;

  while (i < n) {
    const top = stack.at(-1);
    const mode = top ? top.kind : "code";
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (mode === "code" || mode === "template") {
      if (ch === "/" && next === "/") {
        i += 2;
        while (i < n && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
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
          return { ok: false, reason: "unterminated block comment" };
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
          return { ok: false, reason: "unexpected closing brace }" };
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
        return { ok: false, reason: "unterminated string literal" };
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
    return { ok: false, reason: `unclosed ${stack.at(-1).kind}` };
  }
  if (braceDepth !== 0) {
    return { ok: false, reason: `unbalanced braces (remaining depth ${braceDepth})` };
  }
  return { ok: true };
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
      const braceCheck = checkKotlinBraces(src);
      if (!braceCheck.ok) {
        errors.push(`${rel}: ${braceCheck.reason}`);
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

console.log(`PASS android-dat structure verified: ${result.ktCount} Kotlin files, manifest, deep-link, and mwdat 1.0.1 (${Date.now() - t0} ms)`);
