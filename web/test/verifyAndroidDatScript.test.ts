type AndroidDatAuditReport = {
  ok: boolean;
  mainKtCount: number;
  testKtCount: number;
  stringKeyCount: number;
  errors: string[];
};

type VerifyAndroidDatModule = {
  MIN_LOCALIZED_STRING_KEYS: number;
  MIN_MAIN_KT_FILES: number;
  MIN_TEST_KT_FILES: number;
  auditAndroidDatBridge: (repoRoot?: string) => AndroidDatAuditReport;
  extractAndroidStringMap: (xmlSource: string) => Map<string, string>;
  extractPlaceholders: (value: string) => string[];
};

const scriptSpec = new URL("../../scripts/verify-android-dat.mjs", import.meta.url).href;
const {
  MIN_LOCALIZED_STRING_KEYS,
  MIN_MAIN_KT_FILES,
  MIN_TEST_KT_FILES,
  auditAndroidDatBridge,
  extractAndroidStringMap,
  extractPlaceholders
} = (await import(scriptSpec)) as VerifyAndroidDatModule;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
}

interface OsModule {
  tmpdir(): string;
}

interface PathModule {
  join(...parts: string[]): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";
const nodeOsSpec: string = "node:os";
const nodePathSpec: string = "node:path";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync, mkdtempSync, rmSync } = (await import(nodeFsSpec)) as FsModule;
const { tmpdir } = (await import(nodeOsSpec)) as OsModule;
const { join } = (await import(nodePathSpec)) as PathModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

test("auditAndroidDatBridge passes against live repository with >= lower bounds on Kotlin and TalkBack counts", () => {
  const report = auditAndroidDatBridge();
  assert.equal(report.ok, true, `Expected clean audit, got errors: ${report.errors.join("; ")}`);
  assert.ok(report.mainKtCount >= MIN_MAIN_KT_FILES);
  assert.ok(report.testKtCount >= MIN_TEST_KT_FILES);
  assert.ok(report.stringKeyCount >= MIN_LOCALIZED_STRING_KEYS);
  assert.deepEqual(report.errors, []);
});

test("extractAndroidStringMap and extractPlaceholders parse positional TalkBack format slots deterministically", () => {
  const sampleXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<resources>",
    '    <string name="app_name">HoldUp Bridge</string>',
    '    <string name="cd_glasses_status">Glasses: %1$s, %2$s, battery %3$s, stream %4$s</string>',
    "</resources>"
  ].join("\n");

  const parsed = extractAndroidStringMap(sampleXml);
  assert.equal(parsed.size, 2);
  assert.equal(parsed.get("app_name"), "HoldUp Bridge");
  assert.deepEqual(extractPlaceholders(parsed.get("cd_glasses_status") ?? ""), [
    "%1$s",
    "%2$s",
    "%3$s",
    "%4$s"
  ]);
});

test("auditAndroidDatBridge reports missing android-dat directory cleanly without throwing", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "holdup-dat-empty-"));
  try {
    const report = auditAndroidDatBridge(emptyDir);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("android-dat directory is missing")));
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("verify-android-dat script and test contain zero comments and zero em or en dashes", () => {
  const scriptSrc = readFileSync(
    new URL("../../scripts/verify-android-dat.mjs", import.meta.url),
    "utf8"
  );
  const testSrc = readFileSync(new URL("./verifyAndroidDatScript.test.ts", import.meta.url), "utf8");

  for (const src of [scriptSrc, testSrc]) {
    assert.equal(src.includes(LINE_COMMENT), false);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false);
    assert.equal(src.includes(EM_DASH), false);
    assert.equal(src.includes(EN_DASH), false);
  }
});
