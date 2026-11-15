import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT = String.fromCharCode(47, 42);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");

const SECRET_PREFIXES = [
  ["AIza", "Sy"].join(""),
  ["AQ.", "Ab"].join(""),
  ["sk_", "live_"].join(""),
  ["sk_", "test_"].join(""),
];

type HudPixelBudget = {
  width: number;
  height: number;
  totalPixels: number;
  pureBlackPixels: number;
  pureBlackRatio: number;
  nearBlackPixels: number;
  nearBlackRatio: number;
  litPixels: number;
  litRatio: number;
  meanLuminance: number;
};

type HudStateEntry = {
  label: string;
  url: string;
  cardClass: string;
  headline: string;
  viewport: {
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
    horizontalOverflow: boolean;
    verticalOverflow: boolean;
  };
  bounds: {
    cardFitsViewport: boolean;
    buttonsFitViewport: boolean;
    minActionButtonHeightPx: number;
    speakButtonHeightPx: number;
  };
  computedBackgrounds: {
    html: string;
    body: string;
    card: string;
    actionButtonsAllPureBlack: boolean;
  };
  pixelBudget: HudPixelBudget;
  axe: {
    violations: Array<{
      id: string;
      impact: string | null;
      help: string;
      nodes: number;
    }>;
    violationNodes: number;
    passes: number;
    incomplete: number;
  };
};

type HudSimulatorAuditReport = {
  tool: string;
  tags: string;
  browserArgs: string[];
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    totalPixels: number;
  };
  base: string;
  when: string;
  allChecksPassed: boolean;
  totalViolationNodes: number;
  consoleErrorCount: number;
  pageErrorCount: number;
  stateCount: number;
  manifestAndHead: {
    hudBareRedirect: {
      status: number;
      location: string;
      redirectsToTrailingSlash: boolean;
    };
    hudIndex: {
      status: number;
      contentType: string;
      cacheControl: string;
    };
    wearablesManifest: {
      url: string;
      status: number;
      contentType: string;
      bytes: number;
      maxBytes: number;
      version: number;
      name: string;
      description: string;
      themeColor: string;
      iconType: string;
      iconSrc: string;
      resolvedIconPath: string;
    };
    icons: {
      iconMono: {
        status: number;
        contentType: string;
        maxBytes: number;
        bytes: number;
        width: number;
        height: number;
        transparentCorners: boolean;
        pureWhiteMask: boolean;
        transparentPixels: number;
        maskPixels: number;
      };
      icon96: {
        status: number;
        contentType: string;
        exceeds52x52: boolean;
        bytes: number;
        width: number;
        height: number;
        transparentCorners: boolean;
      };
    };
    head: {
      lang: string;
      charset: string;
      viewport: string;
      zoomRestricted: boolean;
      mrbdWebAppCapable: string;
      applicationName: string;
      themeColor: string;
      title: string;
      faviconHref: string;
      faviconSizes: string;
      faviconType: string;
      svgFaviconCount: number;
    };
  };
  hudWsFanout: {
    sessionId: string;
    floatingHudAttachedWithoutSessionParam: boolean;
    phoneNotifiedHudConnected: boolean;
    ingestStateStatus: number;
    glassesStatusRendered: {
      camera: string;
      battery: string;
    };
    realtimeCoachDelivered: boolean;
    realtimeVerdictDelivered: boolean;
    lateJoinReplay: {
      explicitSessionParam: string;
      replayedVerdictHeadline: string;
      replayedCamera: string;
      replayedBattery: string;
    };
    hudEventsForwardedToPhone: string[];
    mockModeStandalone: {
      connected: boolean;
      consoleErrors: number;
      pageErrors: number;
    };
  };
  spatialNavigation: {
    enabledFlag: string;
    positiveTabIndexCount: number;
    allButtonsNativeTag: boolean;
    focusRingStyle: {
      outlineWidthPx: number;
      outlineStyle: string;
      outlineColor: string;
      outlineOffsetPx: number;
    };
    autoFocusOnMatchWithMedId: string;
    autoFocusOnWarningWithoutMedId: string;
    autoFocusOnUnsureWithoutMedId: string;
    enabledTraversal: {
      keys: string[];
      visited: string[];
      reachesAllFourControls: boolean;
    };
    disabledButtonSkip: {
      takeItDisabledWhenUnmatched: boolean;
      fromRepeatArrowRight: string;
      fromDismissArrowLeft: string;
    };
    enterSingleActivation: {
      speakToggleEnterOnce: {
        before: string;
        afterFirstEnter: string;
        afterSecondEnter: string;
      };
      repeatToast: string;
      logDoseToast: string;
      dismissReturnsToIdle: boolean;
    };
    historyAndBackGesture: {
      consecutiveVerdictsEmitted: number;
      historyDelta: number;
      maxAllowedHistoryEntries: number;
      systemBackDismissesToIdle: boolean;
    };
  };
  additiveBlackPixelBudget: {
    minPureBlackRatioRequired: number;
    maxLitRatioAllowed: number;
    observedMinPureBlackRatio: number;
    observedMaxLitRatio: number;
    observedMaxMeanLuminance: number;
    allStatesPureBlackCanvas: boolean;
    allStatesZeroOverflow: boolean;
  };
  states: HudStateEntry[];
};

function repoPath(relPath: string): string {
  return path.join(REPO_DIR, relPath);
}

function readRepoText(relPath: string): string {
  return fs.readFileSync(repoPath(relPath), "utf8");
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.subarray(0, 8).equals(pngSig), true);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  assert.equal(bitDepth, 8);
  assert.equal(interlace, 0);
  assert.equal(colorType === 2 || colorType === 6, true);

  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  assert.ok(inflated.length >= height * stride);

  const rgba = Buffer.alloc(width * height * 4);
  let prevRow: Uint8Array = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * stride];
    const recon: Uint8Array = new Uint8Array(rowBytes);
    const rowStart = y * stride + 1;

    for (let i = 0; i < rowBytes; i++) {
      const raw = inflated[rowStart + i];
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prevRow[i];
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0;

      if (filterType === 0) recon[i] = raw;
      else if (filterType === 1) recon[i] = (raw + left) & 0xff;
      else if (filterType === 2) recon[i] = (raw + up) & 0xff;
      else if (filterType === 3) recon[i] = (raw + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) recon[i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else assert.fail(`Unsupported PNG filter ${filterType}`);
    }

    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const src = x * bpp;
      rgba[dst] = recon[src];
      rgba[dst + 1] = recon[src + 1];
      rgba[dst + 2] = recon[src + 2];
      rgba[dst + 3] = bpp === 4 ? recon[src + 3] : 255;
    }

    prevRow = recon;
  }

  return { width, height, rgba };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

describe("Ray-Ban Display HUD 600x600 simulator audit evidence contract", () => {
  test("docs/evidence/hud-600x600-simulator-audit.json passes all checks with 0 WCAG 2.2 A+AA violations and 0 console/page errors", () => {
    const report = JSON.parse(readRepoText("docs/evidence/hud-600x600-simulator-audit.json")) as HudSimulatorAuditReport;
    const hudSpec = readRepoText("docs/HUD_SPEC.md");

    assert.match(hudSpec, /600\s*\u00d7\s*600,\s*additive/i);
    assert.equal(hudSpec.includes("--enable-spatial-navigation"), true);

    assert.equal(report.tool, "playwright-chromium + @axe-core/playwright");
    assert.equal(report.tags, "WCAG 2.0/2.1/2.2 A+AA");
    assert.deepEqual(report.browserArgs, ["--enable-spatial-navigation"]);
    assert.deepEqual(report.viewport, {
      width: 600,
      height: 600,
      deviceScaleFactor: 1,
      totalPixels: 360000,
    });
    assert.equal(report.viewport.width * report.viewport.height, report.viewport.totalPixels);
    assert.equal(Number.isNaN(Date.parse(report.when)), false);
    assert.equal(report.allChecksPassed, true);
    assert.equal(report.totalViolationNodes, 0);
    assert.equal(report.consoleErrorCount, 0);
    assert.equal(report.pageErrorCount, 0);
    assert.equal(report.stateCount, 8);
    assert.equal(report.states.length, report.stateCount);
  });

  test("manifest, /hud redirect, HTML head metadata, and PNG icon masks match on-disk web/public/hud assets", () => {
    const report = JSON.parse(readRepoText("docs/evidence/hud-600x600-simulator-audit.json")) as HudSimulatorAuditReport;
    const mh = report.manifestAndHead;

    assert.equal(mh.hudBareRedirect.status, 301);
    assert.equal(mh.hudBareRedirect.location, "/hud/");
    assert.equal(mh.hudBareRedirect.redirectsToTrailingSlash, true);

    assert.equal(mh.hudIndex.status, 200);
    assert.equal(mh.hudIndex.contentType.includes("text/html"), true);
    assert.equal(mh.hudIndex.cacheControl, "no-cache");

    const diskManifestBuf = fs.readFileSync(repoPath("web/public/hud/.well-known/meta-wearables-manifest.json"));
    const diskManifest = JSON.parse(diskManifestBuf.toString("utf8")) as {
      version: number;
      name: string;
      description: string;
      appearance: { theme_color: string; icon: { src: string; type: string } };
    };

    assert.equal(mh.wearablesManifest.status, 200);
    assert.equal(mh.wearablesManifest.contentType.includes("application/json"), true);
    assert.equal(mh.wearablesManifest.bytes, diskManifestBuf.length);
    assert.ok(mh.wearablesManifest.bytes <= mh.wearablesManifest.maxBytes);
    assert.equal(mh.wearablesManifest.maxBytes, 65536);
    assert.equal(mh.wearablesManifest.version, diskManifest.version);
    assert.equal(mh.wearablesManifest.version, 1);
    assert.equal(mh.wearablesManifest.name, diskManifest.name);
    assert.equal(mh.wearablesManifest.name, "HoldUp");
    assert.equal(mh.wearablesManifest.description, diskManifest.description);
    assert.equal(mh.wearablesManifest.themeColor, diskManifest.appearance.theme_color);
    assert.equal(mh.wearablesManifest.iconType, "monochrome");
    assert.equal(mh.wearablesManifest.iconSrc, "../icon-mono.png");
    assert.equal(mh.wearablesManifest.resolvedIconPath, "/hud/icon-mono.png");

    const monoBuf = fs.readFileSync(repoPath("web/public/hud/icon-mono.png"));
    const monoDecoded = decodePngRgba(monoBuf);
    let transparentCount = 0;
    let maskCount = 0;
    let pureWhite = true;
    for (let i = 0; i < monoDecoded.rgba.length; i += 4) {
      const a = monoDecoded.rgba[i + 3];
      if (a === 0) {
        transparentCount++;
      } else {
        maskCount++;
        if (monoDecoded.rgba[i] !== 255 || monoDecoded.rgba[i + 1] !== 255 || monoDecoded.rgba[i + 2] !== 255) {
          pureWhite = false;
        }
      }
    }

    assert.equal(mh.icons.iconMono.status, 200);
    assert.equal(mh.icons.iconMono.contentType, "image/png");
    assert.equal(mh.icons.iconMono.bytes, monoBuf.length);
    assert.ok(mh.icons.iconMono.bytes <= mh.icons.iconMono.maxBytes);
    assert.equal(mh.icons.iconMono.maxBytes, 2097152);
    assert.equal(mh.icons.iconMono.width, monoDecoded.width);
    assert.equal(mh.icons.iconMono.height, monoDecoded.height);
    assert.equal(mh.icons.iconMono.width, 128);
    assert.equal(mh.icons.iconMono.height, 128);
    assert.equal(mh.icons.iconMono.transparentCorners, true);
    assert.equal(mh.icons.iconMono.pureWhiteMask, true);
    assert.equal(pureWhite, true);
    assert.equal(mh.icons.iconMono.transparentPixels, transparentCount);
    assert.equal(mh.icons.iconMono.maskPixels, maskCount);
    assert.equal(
      mh.icons.iconMono.transparentPixels + mh.icons.iconMono.maskPixels,
      mh.icons.iconMono.width * mh.icons.iconMono.height,
    );

    const icon96Buf = fs.readFileSync(repoPath("web/public/hud/icon-96.png"));
    const icon96Decoded = decodePngRgba(icon96Buf);
    assert.equal(mh.icons.icon96.status, 200);
    assert.equal(mh.icons.icon96.contentType, "image/png");
    assert.equal(mh.icons.icon96.bytes, icon96Buf.length);
    assert.equal(mh.icons.icon96.width, icon96Decoded.width);
    assert.equal(mh.icons.icon96.height, icon96Decoded.height);
    assert.equal(mh.icons.icon96.width, 96);
    assert.equal(mh.icons.icon96.height, 96);
    assert.equal(mh.icons.icon96.exceeds52x52, true);
    assert.equal(mh.icons.icon96.transparentCorners, true);

    assert.deepEqual(mh.head, {
      lang: "en",
      charset: "utf-8",
      viewport: "width=device-width, initial-scale=1",
      zoomRestricted: false,
      mrbdWebAppCapable: "yes",
      applicationName: "HoldUp",
      themeColor: "#000000",
      title: "HoldUp",
      faviconHref: "/hud/icon-96.png",
      faviconSizes: "96x96",
      faviconType: "image/png",
      svgFaviconCount: 0,
    });
  });

  test("HUD WebSocket fan-out, /ingest/state glasses telemetry, late-join replay, phone event forwarding, and ?mock=1 pass end to end", () => {
    const report = JSON.parse(readRepoText("docs/evidence/hud-600x600-simulator-audit.json")) as HudSimulatorAuditReport;
    const fanout = report.hudWsFanout;

    assert.equal(fanout.sessionId, "SIMHUD01");
    assert.equal(fanout.floatingHudAttachedWithoutSessionParam, true);
    assert.equal(fanout.phoneNotifiedHudConnected, true);
    assert.equal(fanout.ingestStateStatus, 204);
    assert.deepEqual(fanout.glassesStatusRendered, {
      camera: "glasses camera",
      battery: "glasses 82%",
    });
    assert.equal(fanout.realtimeCoachDelivered, true);
    assert.equal(fanout.realtimeVerdictDelivered, true);
    assert.deepEqual(fanout.lateJoinReplay, {
      explicitSessionParam: "SIMHUD01",
      replayedVerdictHeadline: "Amlodipine 5 mg",
      replayedCamera: "glasses camera",
      replayedBattery: "glasses 82%",
    });
    assert.deepEqual(fanout.hudEventsForwardedToPhone, ["repeat", "log_dose", "dismiss"]);
    assert.deepEqual(fanout.mockModeStandalone, {
      connected: true,
      consoleErrors: 0,
      pageErrors: 0,
    });
  });

  test("Chromium --enable-spatial-navigation arrow traversal, disabled-button skip, single-Enter activation, and System Back budget pass", () => {
    const report = JSON.parse(readRepoText("docs/evidence/hud-600x600-simulator-audit.json")) as HudSimulatorAuditReport;
    const nav = report.spatialNavigation;

    assert.equal(nav.enabledFlag, "--enable-spatial-navigation");
    assert.equal(nav.positiveTabIndexCount, 0);
    assert.equal(nav.allButtonsNativeTag, true);
    assert.deepEqual(nav.focusRingStyle, {
      outlineWidthPx: 3,
      outlineStyle: "solid",
      outlineColor: "rgb(255, 210, 63)",
      outlineOffsetPx: 3,
    });

    assert.equal(nav.autoFocusOnMatchWithMedId, "I took it");
    assert.equal(nav.autoFocusOnWarningWithoutMedId, "Repeat");
    assert.equal(nav.autoFocusOnUnsureWithoutMedId, "Repeat");

    assert.deepEqual(nav.enabledTraversal.keys, [
      "ArrowLeft",
      "ArrowRight",
      "ArrowRight",
      "ArrowDown",
      "ArrowUp",
    ]);
    assert.equal(nav.enabledTraversal.reachesAllFourControls, true);
    for (const ctrl of ["Repeat", "I took it", "Dismiss", "Speak off"]) {
      assert.equal(nav.enabledTraversal.visited.includes(ctrl), true, `Expected spatial nav to reach "${ctrl}"`);
    }

    assert.deepEqual(nav.disabledButtonSkip, {
      takeItDisabledWhenUnmatched: true,
      fromRepeatArrowRight: "Dismiss",
      fromDismissArrowLeft: "Repeat",
    });

    assert.deepEqual(nav.enterSingleActivation, {
      speakToggleEnterOnce: {
        before: "false",
        afterFirstEnter: "true",
        afterSecondEnter: "false",
      },
      repeatToast: "Repeating",
      logDoseToast: "Dose logged",
      dismissReturnsToIdle: true,
    });

    assert.equal(nav.historyAndBackGesture.consecutiveVerdictsEmitted, 4);
    assert.equal(nav.historyAndBackGesture.historyDelta, 1);
    assert.equal(nav.historyAndBackGesture.maxAllowedHistoryEntries, 5);
    assert.ok(nav.historyAndBackGesture.historyDelta <= nav.historyAndBackGesture.maxAllowedHistoryEntries);
    assert.equal(nav.historyAndBackGesture.systemBackDismissesToIdle, true);
  });

  test("all 8 HUD states satisfy additive >= 75% pure-black pixel budget, zero 600x600 overflow, >= 48px/44px button targets, and 0 axe violations", () => {
    const report = JSON.parse(readRepoText("docs/evidence/hud-600x600-simulator-audit.json")) as HudSimulatorAuditReport;
    const budget = report.additiveBlackPixelBudget;

    assert.equal(budget.minPureBlackRatioRequired, 0.75);
    assert.equal(budget.maxLitRatioAllowed, 0.25);
    assert.equal(budget.allStatesPureBlackCanvas, true);
    assert.equal(budget.allStatesZeroOverflow, true);
    assert.ok(budget.observedMinPureBlackRatio >= budget.minPureBlackRatioRequired);
    assert.ok(budget.observedMaxLitRatio <= budget.maxLitRatioAllowed);
    assert.ok(budget.observedMaxMeanLuminance < 0.15);

    const expectedStates: Array<{ label: string; cardClass: string; headline: string }> = [
      { label: "hud: idle", cardClass: "hud-card idle-card", headline: "Hold it up." },
      { label: "hud: coach cue", cardClass: "hud-card cue-card", headline: "Turn it left" },
      { label: "hud: verdict warning", cardClass: "hud-card verdict-card", headline: "Ibuprofen: not on your list" },
      { label: "hud: verdict unsure", cardClass: "hud-card verdict-card", headline: "Can't read the strength" },
      { label: "hud: verdict allergen", cardClass: "hud-card verdict-card", headline: "Contains hazelnuts" },
      { label: "hud: verdict scene", cardClass: "hud-card scene-card", headline: "Your evening pill: on the right" },
      { label: "hud: verdict match", cardClass: "hud-card verdict-card", headline: "Amlodipine 5 mg" },
      { label: "hud: stale verdict", cardClass: "hud-card verdict-card stale", headline: "Amlodipine 5 mg" },
    ];

    assert.deepEqual(
      report.states.map((s) => ({ label: s.label, cardClass: s.cardClass, headline: s.headline })),
      expectedStates,
    );

    const pureBlackRatios: number[] = [];
    const litRatios: number[] = [];
    const meanLuminances: number[] = [];

    for (const state of report.states) {
      assert.deepEqual(state.viewport, {
        width: 600,
        height: 600,
        scrollWidth: 600,
        scrollHeight: 600,
        horizontalOverflow: false,
        verticalOverflow: false,
      });

      assert.equal(state.bounds.cardFitsViewport, true, `${state.label} card must fit 600x600`);
      assert.equal(state.bounds.buttonsFitViewport, true, `${state.label} buttons must fit 600x600`);
      assert.equal(state.bounds.minActionButtonHeightPx, 60);
      assert.ok(state.bounds.minActionButtonHeightPx >= 48);
      assert.equal(state.bounds.speakButtonHeightPx, 44);
      assert.ok(state.bounds.speakButtonHeightPx >= 44);

      assert.deepEqual(state.computedBackgrounds, {
        html: "rgb(0, 0, 0)",
        body: "rgb(0, 0, 0)",
        card: "rgb(0, 0, 0)",
        actionButtonsAllPureBlack: true,
      });

      const pb = state.pixelBudget;
      assert.equal(pb.width, 600);
      assert.equal(pb.height, 600);
      assert.equal(pb.totalPixels, 360000);
      assert.equal(pb.pureBlackPixels + pb.litPixels, pb.totalPixels);
      assert.ok(pb.nearBlackPixels >= pb.pureBlackPixels);
      assert.equal(pb.pureBlackRatio, round4(pb.pureBlackPixels / pb.totalPixels));
      assert.equal(pb.litRatio, round4(pb.litPixels / pb.totalPixels));
      assert.ok(pb.pureBlackRatio >= 0.75, `${state.label} pureBlackRatio ${pb.pureBlackRatio} < 0.75`);
      assert.ok(pb.litRatio <= 0.25, `${state.label} litRatio ${pb.litRatio} > 0.25`);

      pureBlackRatios.push(pb.pureBlackRatio);
      litRatios.push(pb.litRatio);
      meanLuminances.push(pb.meanLuminance);

      assert.deepEqual(state.axe.violations, [], `${state.label} must have 0 axe violations`);
      assert.equal(state.axe.violationNodes, 0);
      assert.ok(state.axe.passes >= 15, `${state.label} expected >= 15 axe rule passes, got ${state.axe.passes}`);
    }

    assert.equal(budget.observedMinPureBlackRatio, Math.min(...pureBlackRatios));
    assert.equal(budget.observedMaxLitRatio, Math.max(...litRatios));
    assert.equal(budget.observedMaxMeanLuminance, Math.max(...meanLuminances));
  });

  test("scripts/hud-simulator-audit.mjs, evidence JSON, and contract test enforce strict hygiene without comments, em dashes, or secrets", () => {
    const scriptText = readRepoText("scripts/hud-simulator-audit.mjs");
    assert.equal(scriptText.includes("--enable-spatial-navigation"), true);
    assert.equal(scriptText.includes("@axe-core/playwright"), true);
    assert.equal(scriptText.includes("meta-wearables-manifest.json"), true);

    const targets = [
      "scripts/hud-simulator-audit.mjs",
      "docs/evidence/hud-600x600-simulator-audit.json",
      "web/test/hudSimulatorAuditContract.test.ts",
    ];

    for (const relPath of targets) {
      const text = readRepoText(relPath);
      if (relPath !== "docs/evidence/hud-600x600-simulator-audit.json") {
        assert.equal(text.includes(LINE_COMMENT), false, `${relPath} must have zero line comments`);
        assert.equal(text.includes(BLOCK_COMMENT), false, `${relPath} must have zero block comments`);
        assert.equal(text.includes(HTML_COMMENT), false, `${relPath} must have zero HTML comments`);
      }
      assert.equal(text.includes(EM_DASH), false, `${relPath} must have zero em dashes`);
      assert.equal(text.includes(ESCAPED_EM_DASH), false, `${relPath} must have zero escaped em dashes`);
      for (const prefix of SECRET_PREFIXES) {
        assert.equal(text.includes(prefix), false, `${relPath} must not contain secret prefix "${prefix}"`);
      }
    }
  });
});
