import {
  assessFrameReadiness,
  selectBestFrames,
  type CandidateFrame
} from "../src/camera/multiFrameConsensus.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;
type StrictAssert = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
};

const nodeTestSpecifier = "node:test";
const nodeAssertSpecifier = "node:assert/strict";
const { test } = (await import(nodeTestSpecifier)) as { test: TestFn };
const assert = (await import(nodeAssertSpecifier)) as StrictAssert;

function mkFrame(
  data: string,
  sharpness: number,
  ts: number,
  dims?: { w?: number; h?: number }
): CandidateFrame {
  return dims ? { data, sharpness, ts, ...dims } : { data, sharpness, ts };
}

test("selectBestFrames handles empty inputs, non-positive maxFrames, and preserves dimensions", () => {
  assert.deepEqual(selectBestFrames([]), []);

  const single = mkFrame("only", 0.76, 5000, { w: 768, h: 576 });
  assert.deepEqual(selectBestFrames([single], { maxFrames: 0, now: 5200 }), []);
  assert.deepEqual(selectBestFrames([single], { maxFrames: -2, now: 5200 }), []);

  const picked = selectBestFrames([single], { now: 5200 });
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.data, "only");
  assert.equal(picked[0]?.w, 768);
  assert.equal(picked[0]?.h, 576);
});

test("selectBestFrames enforces minGapMs temporal diversity and backfills when all frames cluster", () => {
  const handheldFrames: readonly CandidateFrame[] = [
    mkFrame("side_panel", 0.72, 10_000),
    mkFrame("front_a", 0.89, 10_750),
    mkFrame("front_b", 0.94, 10_800)
  ];

  const diverse = selectBestFrames(handheldFrames, { now: 11_000 });
  assert.deepEqual(
    diverse.map((f) => f.data),
    ["side_panel", "front_b"]
  );

  const exactGapFrames: readonly CandidateFrame[] = [
    mkFrame("early_lower", 0.65, 9_000),
    mkFrame("gap_350", 0.85, 10_000),
    mkFrame("peak", 0.95, 10_350)
  ];
  assert.deepEqual(
    selectBestFrames(exactGapFrames, { now: 10_500 }).map((f) => f.data),
    ["gap_350", "peak"]
  );

  const subGapFrames: readonly CandidateFrame[] = [
    mkFrame("early_spaced", 0.65, 9_000),
    mkFrame("gap_349", 0.85, 10_001),
    mkFrame("peak", 0.95, 10_350)
  ];
  assert.deepEqual(
    selectBestFrames(subGapFrames, { now: 10_500 }).map((f) => f.data),
    ["early_spaced", "peak"]
  );

  const sandwichFrames: readonly CandidateFrame[] = [
    mkFrame("t0", 0.96, 10_000),
    mkFrame("t200_mid", 0.88, 10_200),
    mkFrame("t400", 0.91, 10_400),
    mkFrame("t900", 0.74, 10_900)
  ];
  assert.deepEqual(
    selectBestFrames(sandwichFrames, { maxFrames: 3, minGapMs: 350, now: 11_000 }).map(
      (f) => f.data
    ),
    ["t0", "t400", "t900"]
  );

  const clustered: readonly CandidateFrame[] = [
    mkFrame("c1", 0.61, 5_000),
    mkFrame("c2", 0.93, 5_050),
    mkFrame("c3", 0.84, 5_110)
  ];
  assert.deepEqual(
    selectBestFrames(clustered, { maxFrames: 2, minGapMs: 350, now: 5_500 }).map((f) => f.data),
    ["c2", "c3"]
  );
});

test("selectBestFrames filters by windowMs and falls back to latest 3 when window is underfilled", () => {
  const frames: readonly CandidateFrame[] = [
    mkFrame("stale_sharpest", 0.99, 1_000),
    mkFrame("stale_second", 0.95, 2_000),
    mkFrame("mid_a", 0.82, 4_000),
    mkFrame("mid_b", 0.55, 5_000),
    mkFrame("recent_only", 0.77, 10_500)
  ];

  const enoughInWindow = selectBestFrames(frames, {
    maxFrames: 2,
    windowMs: 8_000,
    now: 11_000
  });
  assert.deepEqual(
    enoughInWindow.map((f) => f.data),
    ["mid_a", "recent_only"]
  );

  const onlyOneInWindow = selectBestFrames(frames, {
    maxFrames: 2,
    windowMs: 3_000,
    now: 11_000
  });
  assert.deepEqual(
    onlyOneInWindow.map((f) => f.data),
    ["mid_a", "recent_only"]
  );

  const allStale = selectBestFrames(frames, {
    maxFrames: 2,
    windowMs: 8_000,
    now: 30_000
  });
  assert.deepEqual(
    allStale.map((f) => f.data),
    ["mid_a", "recent_only"]
  );
});

test("selectBestFrames returns chronological order regardless of input order and respects minSharpness", () => {
  const unsorted: CandidateFrame[] = [
    mkFrame("t3000", 0.97, 13_000),
    mkFrame("t1000", 0.83, 11_000),
    mkFrame("t2000", 0.79, 12_000),
    mkFrame("t1500_blur", 0.12, 11_500)
  ];
  const snapshotBefore = unsorted.map((f) => f.data);

  const selected = selectBestFrames(unsorted, { maxFrames: 3, now: 13_500 });
  assert.deepEqual(
    selected.map((f) => f.data),
    ["t1000", "t2000", "t3000"]
  );
  assert.ok(selected[0]!.ts < selected[1]!.ts && selected[1]!.ts < selected[2]!.ts);
  assert.deepEqual(
    unsorted.map((f) => f.data),
    snapshotBefore
  );

  const filteredSharp = selectBestFrames(
    [mkFrame("sharp_one", 0.81, 10_000), mkFrame("blur_two", 0.14, 10_600)],
    { maxFrames: 2, minSharpness: 0.22, now: 11_000 }
  );
  assert.deepEqual(
    filteredSharp.map((f) => f.data),
    ["sharp_one"]
  );

  const noneAboveThreshold = selectBestFrames(
    [mkFrame("b1", 0.09, 10_000), mkFrame("b2", 0.18, 10_600)],
    { maxFrames: 2, minSharpness: 0.22, now: 11_000 }
  );
  assert.deepEqual(noneAboveThreshold, []);
});

test("assessFrameReadiness evaluates default and custom sharpness thresholds", () => {
  assert.deepEqual(assessFrameReadiness([]), {
    ready: false,
    bestSharpness: 0,
    suggestedCue: "hold_still"
  });

  assert.deepEqual(assessFrameReadiness([], 0), {
    ready: false,
    bestSharpness: 0,
    suggestedCue: "hold_still"
  });

  assert.deepEqual(
    assessFrameReadiness([mkFrame("blur_a", 0.08, 1_000), mkFrame("blur_b", 0.219, 1_500)]),
    {
      ready: false,
      bestSharpness: 0.219,
      suggestedCue: "hold_still"
    }
  );

  assert.deepEqual(assessFrameReadiness([mkFrame("at_threshold", 0.22, 1_000)]), {
    ready: true,
    bestSharpness: 0.22,
    suggestedCue: "ok"
  });

  assert.deepEqual(
    assessFrameReadiness([
      mkFrame("low", 0.11, 1_000),
      mkFrame("sharp", 0.68, 1_400),
      mkFrame("mid", 0.34, 1_800)
    ]),
    {
      ready: true,
      bestSharpness: 0.68,
      suggestedCue: "ok"
    }
  );

  assert.deepEqual(assessFrameReadiness([mkFrame("mid", 0.35, 1_000)], 0.45), {
    ready: false,
    bestSharpness: 0.35,
    suggestedCue: "hold_still"
  });

  assert.deepEqual(assessFrameReadiness([mkFrame("high", 0.45, 1_000)], 0.45), {
    ready: true,
    bestSharpness: 0.45,
    suggestedCue: "ok"
  });
});
