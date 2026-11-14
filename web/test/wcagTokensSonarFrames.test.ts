import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sonar } from "../src/lib/sonar.ts";
import {
  FrameRing,
  captureFrame,
  laplacianVariance,
  normaliseSharpness,
  policyForRtt,
  shouldSend,
  type CapturedFrame,
} from "../src/lib/frames.ts";

const stylesPath = new URL("../src/styles.css", import.meta.url);
const rawStyles = readFileSync(stylesPath, "utf8");
const stripCommentsPattern = new RegExp("\\/\\*[\\s\\S]*?\\*\\/", "g");
const cleanStyles = rawStyles.replace(stripCommentsPattern, "");

function extractBlock(css: string, header: RegExp): string {
  const match = header.exec(css);
  assert.ok(match, `Expected CSS block matching ${String(header)}`);
  const openIdx = css.indexOf("{", match.index);
  assert.ok(openIdx >= 0, `Expected opening brace for ${String(header)}`);
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIdx + 1, i);
    }
  }
  assert.fail(`Unclosed CSS block for ${String(header)}`);
}

function parseCustomProperties(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const propPattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = propPattern.exec(block)) !== null) {
    vars[`--${match[1]}`] = match[2].trim();
  }
  return vars;
}

function hexToRgb(hex: string): [number, number, number] {
  const trimmed = hex.trim().replace(/^#/, "");
  if (trimmed.length === 3) {
    return [
      Number.parseInt(trimmed[0] + trimmed[0], 16),
      Number.parseInt(trimmed[1] + trimmed[1], 16),
      Number.parseInt(trimmed[2] + trimmed[2], 16),
    ];
  }
  assert.equal(trimmed.length, 6, `Expected 3-digit or 6-digit hex color, got ${hex}`);
  return [
    Number.parseInt(trimmed.slice(0, 2), 16),
    Number.parseInt(trimmed.slice(2, 4), 16),
    Number.parseInt(trimmed.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function remToPx(remValue: string): number {
  const m = /^([0-9.]+)rem$/.exec(remValue.trim());
  assert.ok(m, `Expected rem unit, got ${remValue}`);
  return Number.parseFloat(m[1]) * 16;
}

function pxToNumber(pxValue: string): number {
  const m = /^(-?[0-9.]+)px$/.exec(pxValue.trim());
  assert.ok(m, `Expected px unit, got ${pxValue}`);
  return Number.parseFloat(m[1]);
}

function approxEqual(actual: number, expected: number, epsilon = 1e-9, label = "value") {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected} (+/- ${epsilon}), got ${actual}`,
  );
}

type ParamCall = {
  method: "setTargetAtTime" | "setValueAtTime" | "linearRampToValueAtTime" | "exponentialRampToValueAtTime" | "cancelScheduledValues";
  value?: number;
  time: number;
  timeConstant?: number;
};

class MockAudioParam {
  value = 0;
  calls: ParamCall[] = [];

  setTargetAtTime(target: number, startTime: number, timeConstant: number) {
    this.value = target;
    this.calls.push({ method: "setTargetAtTime", value: target, time: startTime, timeConstant });
  }

  setValueAtTime(value: number, startTime: number) {
    this.value = value;
    this.calls.push({ method: "setValueAtTime", value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number) {
    this.value = value;
    this.calls.push({ method: "linearRampToValueAtTime", value, time: endTime });
  }

  exponentialRampToValueAtTime(value: number, endTime: number) {
    this.value = value;
    this.calls.push({ method: "exponentialRampToValueAtTime", value, time: endTime });
  }

  cancelScheduledValues(startTime: number) {
    this.calls.push({ method: "cancelScheduledValues", time: startTime });
  }
}

class MockConnectableNode {
  connectedTo: unknown[] = [];

  connect<T>(destination: T): T {
    this.connectedTo.push(destination);
    return destination;
  }
}

class MockOscillatorNode extends MockConnectableNode {
  type: OscillatorType = "sine";
  frequency = new MockAudioParam();
  startedAt: number[] = [];
  stoppedAt: number[] = [];

  start(when = 0) {
    this.startedAt.push(when);
  }

  stop(when = 0) {
    this.stoppedAt.push(when);
  }
}

class MockBiquadFilterNode extends MockConnectableNode {
  type: BiquadFilterType = "lowpass";
  frequency = new MockAudioParam();
}

class MockGainNode extends MockConnectableNode {
  gain = new MockAudioParam();
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static initialState: AudioContextState = "running";
  static throwOnConstruct = false;

  state: AudioContextState = MockAudioContext.initialState;
  currentTime = 1.25;
  destination = { kind: "destination" };
  oscillators: MockOscillatorNode[] = [];
  filters: MockBiquadFilterNode[] = [];
  gains: MockGainNode[] = [];
  resumeCount = 0;

  constructor() {
    if (MockAudioContext.throwOnConstruct) {
      throw new Error("AudioContext blocked");
    }
    MockAudioContext.instances.push(this);
  }

  createOscillator(): OscillatorNode {
    const node = new MockOscillatorNode();
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    const node = new MockBiquadFilterNode();
    this.filters.push(node);
    return node as unknown as BiquadFilterNode;
  }

  createGain(): GainNode {
    const node = new MockGainNode();
    this.gains.push(node);
    return node as unknown as GainNode;
  }

  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = "running";
  }
}

function installMockAudioWindow(): () => void {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const previousWindow = g.window;
  MockAudioContext.instances = [];
  MockAudioContext.initialState = "running";
  MockAudioContext.throwOnConstruct = false;
  g.window = { AudioContext: MockAudioContext };
  return () => {
    MockAudioContext.instances = [];
    MockAudioContext.initialState = "running";
    MockAudioContext.throwOnConstruct = false;
    if (hadWindow) g.window = previousWindow;
    else delete g.window;
  };
}

function makeFrame(overrides: Partial<CapturedFrame> = {}): CapturedFrame {
  return {
    data: "ZmFrZS1qcGVn",
    w: 768,
    h: 576,
    sharpness: 0.75,
    raw: 450,
    ts: 10_000,
    ...overrides,
  };
}

test("WCAG 2.2 AA/AAA contrast proof on default :root dark palette in styles.css", () => {
  const rootBlock = extractBlock(cleanStyles, /(?:^|\n):root\s*\{/);
  const root = parseCustomProperties(rootBlock);

  assert.match(rootBlock, /color-scheme\s*:\s*dark\s*;/);

  for (const bgToken of ["--bg", "--surface", "--surface-2"] as const) {
    const textRatio = contrastRatio(root["--text"], root[bgToken]);
    assert.ok(
      textRatio >= 7.0,
      `Expected --text (${root["--text"]}) on ${bgToken} (${root[bgToken]}) >= 7.0:1 AAA, got ${textRatio.toFixed(2)}:1`,
    );

    const mutedRatio = contrastRatio(root["--muted"], root[bgToken]);
    assert.ok(
      mutedRatio >= 4.5,
      `Expected --muted (${root["--muted"]}) on ${bgToken} (${root[bgToken]}) >= 4.5:1 AA, got ${mutedRatio.toFixed(2)}:1`,
    );
  }

  const accentOnBg = contrastRatio(root["--accent"], root["--bg"]);
  assert.ok(accentOnBg >= 7.0, `Expected --accent on --bg >= 7.0:1 AAA, got ${accentOnBg.toFixed(2)}:1`);

  const onAccentRatio = contrastRatio(root["--on-accent"], root["--accent"]);
  assert.ok(onAccentRatio >= 7.0, `Expected --on-accent on --accent >= 7.0:1 AAA, got ${onAccentRatio.toFixed(2)}:1`);

  for (const verdictToken of ["--match", "--warning", "--unsure"] as const) {
    for (const surfaceToken of ["--bg", "--surface"] as const) {
      const ratio = contrastRatio(root[verdictToken], root[surfaceToken]);
      assert.ok(
        ratio >= 4.5,
        `Expected ${verdictToken} (${root[verdictToken]}) on ${surfaceToken} (${root[surfaceToken]}) >= 4.5:1 AA, got ${ratio.toFixed(2)}:1`,
      );
    }
  }
});

test("WCAG 2.2 AAA contrast proof on @media (prefers-contrast: more) palette in styles.css", () => {
  const rootVars = parseCustomProperties(extractBlock(cleanStyles, /(?:^|\n):root\s*\{/));
  const hcMediaBlock = extractBlock(cleanStyles, /@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)\s*\{/);
  const hcOverrides = parseCustomProperties(extractBlock(hcMediaBlock, /:root\s*\{/));
  const hc = { ...rootVars, ...hcOverrides };

  assert.equal(hcOverrides["--bg"], "#000");
  assert.equal(hcOverrides["--text"], "#fff");

  const textOnBg = contrastRatio(hc["--text"], hc["--bg"]);
  assert.equal(textOnBg, 21);

  const mutedOnBg = contrastRatio(hc["--muted"], hc["--bg"]);
  assert.ok(mutedOnBg >= 14.0, `Expected high-contrast --muted on --bg >= 14:1, got ${mutedOnBg.toFixed(2)}:1`);

  for (const token of ["--accent", "--match", "--warning", "--unsure"] as const) {
    const ratio = contrastRatio(hc[token], hc["--bg"]);
    assert.ok(
      ratio >= 7.0,
      `Expected high-contrast ${token} (${hc[token]}) on --bg >= 7.0:1 AAA, got ${ratio.toFixed(2)}:1`,
    );
  }

  const onAccentInHc = contrastRatio(hc["--on-accent"], hc["--accent"]);
  assert.ok(onAccentInHc >= 7.0, `Expected --on-accent on high-contrast --accent >= 7.0:1 AAA, got ${onAccentInHc.toFixed(2)}:1`);

  const borderOnBg = contrastRatio(hc["--border"], hc["--bg"]);
  assert.equal(borderOnBg, 21);
});

test("Low-vision typography, 56px AAA targets, focus-visible ring, skip-link, and prefers-reduced-motion in styles.css", () => {
  assert.match(cleanStyles, /@import\s+"@fontsource\/atkinson-hyperlegible-next\/400\.css";/);
  assert.match(cleanStyles, /@import\s+"@fontsource\/atkinson-hyperlegible-mono\/500\.css";/);

  const root = parseCustomProperties(extractBlock(cleanStyles, /(?:^|\n):root\s*\{/));
  assert.match(root["--font"], /^"Atkinson Hyperlegible Next"/);
  assert.match(root["--mono"], /^"Atkinson Hyperlegible Mono"/);

  assert.equal(root["--t-base"], "1.125rem");
  const basePx = remToPx(root["--t-base"]);
  const mdPx = remToPx(root["--t-md"]);
  const lgPx = remToPx(root["--t-lg"]);
  const xlPx = remToPx(root["--t-xl"]);
  const xxlPx = remToPx(root["--t-xxl"]);
  assert.equal(basePx, 18);
  assert.ok(basePx >= 16);
  assert.ok(basePx < mdPx && mdPx < lgPx && lgPx < xlPx && xlPx < xxlPx);

  assert.equal(root["--tap"], "56px");
  const tapPx = pxToNumber(root["--tap"]);
  assert.ok(tapPx >= 44, "Expected --tap >= 44px for WCAG 2.5.5 AAA");
  assert.ok(tapPx >= 24, "Expected --tap >= 24px for WCAG 2.5.8 AA");

  const btnBlock = extractBlock(cleanStyles, /\.btn\s*\{/);
  assert.match(btnBlock, /min-height\s*:\s*var\(--tap\)\s*;/);

  const bigBtnBlock = extractBlock(cleanStyles, /\.bigbtn\s*\{/);
  assert.ok(pxToNumber((/min-height\s*:\s*([^;]+);/.exec(bigBtnBlock) ?? [])[1] ?? "0px") >= 56);

  const focusVisibleBlock = extractBlock(cleanStyles, /(?:^|\n):focus-visible\s*\{/);
  assert.match(focusVisibleBlock, /outline\s*:\s*3px\s+solid\s+var\(--accent\)\s*;/);
  assert.match(focusVisibleBlock, /outline-offset\s*:\s*3px\s*;/);

  const skipBlock = extractBlock(cleanStyles, /(?:^|\n)\.skip\s*\{/);
  assert.match(skipBlock, /top\s*:\s*-100px\s*;/);
  assert.match(skipBlock, /background\s*:\s*var\(--accent\)\s*;/);
  assert.match(skipBlock, /color\s*:\s*var\(--on-accent\)\s*;/);

  const skipFocusBlock = extractBlock(cleanStyles, /\.skip:focus\s*\{/);
  assert.match(skipFocusBlock, /top\s*:\s*var\(--s2\)\s*;/);

  const warningVerdictBlock = extractBlock(cleanStyles, /\.verdict\.warning\s*\{/);
  assert.match(warningVerdictBlock, /border-style\s*:\s*double\s*;/);
  const unsureVerdictBlock = extractBlock(cleanStyles, /\.verdict\.unsure\s*\{/);
  assert.match(unsureVerdictBlock, /border-style\s*:\s*dashed\s*;/);

  const reducedMotionBlock = extractBlock(cleanStyles, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/);
  assert.match(reducedMotionBlock, /animation\s*:\s*none\s*!important\s*;/);
  assert.match(reducedMotionBlock, /transition\s*:\s*none\s*!important\s*;/);
  assert.match(reducedMotionBlock, /scroll-behavior\s*:\s*auto\s*!important\s*;/);
});

test("Sonar maps readiness [0, 0.5, 1] to [220, 440, 660] Hz with clamping, 1200 Hz lowpass filter, and peak gain <= 0.09", (t) => {
  const restoreWindow = installMockAudioWindow();
  const sonar = new Sonar();
  t.after(() => {
    sonar.stop();
    restoreWindow();
  });

  sonar.set(0.5);
  assert.equal(sonar.active, false);

  MockAudioContext.initialState = "suspended";
  sonar.unlock();
  assert.equal(MockAudioContext.instances.length, 1);
  const ctx = MockAudioContext.instances[0];
  assert.equal(ctx.resumeCount, 1);

  sonar.set(0);
  assert.equal(sonar.active, true);
  assert.equal(ctx.oscillators.length, 1);
  assert.equal(ctx.filters.length, 1);
  assert.equal(ctx.gains.length, 1);

  const osc = ctx.oscillators[0];
  const lp = ctx.filters[0];
  const gain = ctx.gains[0];

  assert.equal(osc.type, "sine");
  assert.equal(lp.type, "lowpass");
  assert.equal(lp.frequency.value, 1200);
  assert.deepEqual(osc.connectedTo, [lp]);
  assert.deepEqual(lp.connectedTo, [gain]);
  assert.deepEqual(gain.connectedTo, [ctx.destination]);
  assert.equal(osc.startedAt.length, 1);

  assert.equal(osc.frequency.calls.at(-1)?.value, 220);
  approxEqual(gain.gain.calls.at(-1)?.value ?? -1, 0.35 * 0.09, 1e-9, "default gain");
  assert.ok((gain.gain.calls.at(-1)?.value ?? 1) <= 0.09);

  sonar.set(0.5);
  assert.equal(osc.frequency.calls.at(-1)?.value, 440);

  sonar.set(1);
  assert.equal(osc.frequency.calls.at(-1)?.value, 660);

  sonar.set(-2);
  assert.equal(osc.frequency.calls.at(-1)?.value, 220);

  sonar.set(4.5);
  assert.equal(osc.frequency.calls.at(-1)?.value, 660);

  sonar.volume = 1;
  sonar.set(0.5);
  approxEqual(gain.gain.calls.at(-1)?.value ?? -1, 0.09, 1e-9, "max volume gain");
  assert.ok((gain.gain.calls.at(-1)?.value ?? 1) <= 0.09);

  sonar.volume = 5;
  sonar.set(0.5);
  approxEqual(gain.gain.calls.at(-1)?.value ?? -1, 0.09, 1e-9, "clamped high volume gain");
  assert.ok((gain.gain.calls.at(-1)?.value ?? 1) <= 0.09);

  sonar.volume = -1;
  sonar.set(0.5);
  assert.equal(gain.gain.calls.at(-1)?.value, 0);
});

test("Sonar duck(true) cuts gain to 25% (0.25x) and suppresses 990 Hz readiness ticks while assistant speaks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const restoreWindow = installMockAudioWindow();
  const sonar = new Sonar();
  t.after(() => {
    sonar.stop();
    restoreWindow();
  });

  sonar.unlock();
  const ctx = MockAudioContext.instances[0];
  sonar.volume = 0.8;
  sonar.set(0.85);

  const mainGain = ctx.gains[0];
  const unduckedGain = 0.8 * 0.09;
  approxEqual(mainGain.gain.calls.at(-1)?.value ?? -1, unduckedGain, 1e-9, "unducked gain");
  assert.equal(ctx.oscillators.length, 1);

  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 2);
  const tickOsc = ctx.oscillators[1];
  const tickGain = ctx.gains[1];
  assert.equal(tickOsc.type, "triangle");
  assert.equal(tickOsc.frequency.value, 990);
  approxEqual(
    tickGain.gain.calls.find((c) => c.method === "linearRampToValueAtTime")?.value ?? -1,
    0.8 * 0.08,
    1e-9,
    "tick peak gain",
  );

  sonar.duck(true);
  approxEqual(mainGain.gain.calls.at(-1)?.value ?? -1, unduckedGain * 0.25, 1e-9, "ducked 0.25x gain");

  sonar.set(0.92);
  approxEqual(mainGain.gain.calls.at(-1)?.value ?? -1, unduckedGain * 0.25, 1e-9, "ducked gain after set");

  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 2, "Expected 990 Hz tick to be suppressed while ducked");

  sonar.duck(false);
  approxEqual(mainGain.gain.calls.at(-1)?.value ?? -1, unduckedGain, 1e-9, "restored unducked gain");

  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 3, "Expected 990 Hz tick to resume when unducked");

  sonar.set(0.6);
  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 3, "Expected tick interval cleared once readiness drops below 0.8");
});

test("Sonar stop() and 1500 ms idle timeout clear timers, cancel scheduled values, and ramp gain to 0", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const restoreWindow = installMockAudioWindow();
  const sonar = new Sonar();
  t.after(() => {
    sonar.stop();
    restoreWindow();
  });

  sonar.unlock();
  const ctx = MockAudioContext.instances[0];
  sonar.set(0.9);
  const firstOsc = ctx.oscillators[0];
  const firstGain = ctx.gains[0];
  assert.equal(sonar.active, true);

  sonar.stop();
  assert.equal(sonar.active, false);
  assert.ok(firstGain.gain.calls.some((c) => c.method === "cancelScheduledValues" && c.time === ctx.currentTime));
  assert.deepEqual(firstGain.gain.calls.at(-1), {
    method: "setTargetAtTime",
    value: 0,
    time: ctx.currentTime,
    timeConstant: 0.08,
  });
  assert.deepEqual(firstOsc.stoppedAt, [ctx.currentTime + 0.5]);

  t.mock.timers.tick(5_000);
  assert.equal(ctx.oscillators.length, 1, "Expected zero leaked tick or idle timers after stop()");

  sonar.set(0.4);
  assert.equal(sonar.active, true);
  const secondGain = ctx.gains[1];
  t.mock.timers.tick(1_500);
  assert.equal(sonar.active, false, "Expected Sonar to auto-stop after 1500 ms idle");
  assert.equal(secondGain.gain.calls.at(-1)?.value, 0);

  MockAudioContext.throwOnConstruct = true;
  const blockedSonar = new Sonar();
  blockedSonar.unlock();
  blockedSonar.set(0.8);
  blockedSonar.duck(true);
  blockedSonar.stop();
  assert.equal(blockedSonar.active, false);
});

test("policyForRtt maps normal, slow, and very-slow RTT tiers with monotonically reduced capture cost", () => {
  const fromNull = policyForRtt(null);
  const normal = policyForRtt(120);
  const normalEdge = policyForRtt(699);
  const slow = policyForRtt(700);
  const slowEdge = policyForRtt(1499);
  const verySlow = policyForRtt(1500);
  const extremeRtt = policyForRtt(3200);

  assert.deepEqual(fromNull, { fps: 1, quality: 0.7, longSide: 768, tier: "normal" });
  assert.deepEqual(normal, { fps: 1, quality: 0.7, longSide: 768, tier: "normal" });
  assert.deepEqual(normalEdge, normal);
  assert.deepEqual(slow, { fps: 0.5, quality: 0.6, longSide: 768, tier: "slow" });
  assert.deepEqual(slowEdge, slow);
  assert.deepEqual(verySlow, { fps: 0.33, quality: 0.5, longSide: 640, tier: "very-slow" });
  assert.deepEqual(extremeRtt, verySlow);

  assert.ok(normal.fps > slow.fps && slow.fps > verySlow.fps);
  assert.ok(normal.quality > slow.quality && slow.quality > verySlow.quality);
  assert.ok(normal.longSide >= slow.longSide && slow.longSide > verySlow.longSide);
  assert.ok(normal.longSide > verySlow.longSide);
});

test("FrameRing bounds RAM capacity, filters stale frames, ranks sharpest first, and clear() wipes buffer to 0", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 50_000 });

  const defaultRing = new FrameRing();
  for (let i = 0; i < 14; i++) {
    defaultRing.push(
      makeFrame({
        data: `frame-${i}`,
        sharpness: (i + 1) / 20,
        ts: 49_000 + i * 50,
      }),
    );
  }

  const retained = defaultRing.sharpest(20, 60_000);
  assert.equal(retained.length, 8);
  assert.equal(retained[0].data, "frame-13");
  assert.equal(retained.at(-1)?.data, "frame-6");

  const smallRing = new FrameRing(3);
  smallRing.push(makeFrame({ data: "stale-sharp", sharpness: 0.99, ts: 40_000 }));
  smallRing.push(makeFrame({ data: "fresh-mid", sharpness: 0.55, ts: 46_000 }));
  smallRing.push(makeFrame({ data: "fresh-best", sharpness: 0.88, ts: 47_000 }));

  const freshTop2 = smallRing.sharpest(2, 8_000);
  assert.deepEqual(
    freshTop2.map((f) => f.data),
    ["fresh-best", "fresh-mid"],
  );

  smallRing.push(makeFrame({ data: "fresh-low", sharpness: 0.35, ts: 48_000 }));
  assert.equal(smallRing.sharpest(10, 60_000).length, 3);
  assert.ok(!smallRing.sharpest(10, 60_000).some((f) => f.data === "stale-sharp"));

  smallRing.clear();
  defaultRing.clear();
  assert.equal(smallRing.sharpest(10, 60_000).length, 0);
  assert.equal(defaultRing.sharpest(10, 60_000).length, 0);
});

test("shouldSend enforces 0.6x sharpness and maxGapMs anti-starvation gating, and normaliseSharpness stays in [0, 1)", () => {
  const blurryFirst = makeFrame({ sharpness: 0.1, ts: 1_000 });
  assert.equal(shouldSend(blurryFirst, null), true);

  const lastSharp = makeFrame({ sharpness: 0.5, ts: 10_000 });
  const tooBlurrySoon = makeFrame({ sharpness: 0.29, ts: 11_200 });
  const exactThresholdSoon = makeFrame({ sharpness: 0.3, ts: 11_200 });
  const sharperSoon = makeFrame({ sharpness: 0.82, ts: 11_200 });

  assert.equal(shouldSend(tooBlurrySoon, lastSharp), false);
  assert.equal(shouldSend(exactThresholdSoon, lastSharp), true);
  assert.equal(shouldSend(sharperSoon, lastSharp), true);

  const blurryAtExactGap = makeFrame({ sharpness: 0.05, ts: 13_000 });
  const blurryPastGap = makeFrame({ sharpness: 0.05, ts: 13_001 });
  assert.equal(shouldSend(blurryAtExactGap, lastSharp, 3_000), false);
  assert.equal(shouldSend(blurryPastGap, lastSharp, 3_000), true);
  assert.equal(shouldSend(makeFrame({ sharpness: 0.05, ts: 11_501 }), lastSharp, 1_500), true);

  assert.equal(normaliseSharpness(0), 0);
  assert.equal(normaliseSharpness(150), 0.5);
  assert.ok(normaliseSharpness(600) > normaliseSharpness(150));
  assert.ok(normaliseSharpness(100_000) < 1);
  assert.equal(laplacianVariance({} as CanvasImageSource, 320, 240), 0);
  assert.equal(captureFrame({ readyState: 4, videoWidth: 640, videoHeight: 480 } as HTMLVideoElement), null);
});
