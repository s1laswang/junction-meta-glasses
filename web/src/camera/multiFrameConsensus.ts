export type CandidateFrame = {
  data: string;
  sharpness: number;
  ts: number;
  w?: number;
  h?: number;
};

export function selectBestFrames(
  frames: readonly CandidateFrame[],
  opts?: {
    maxFrames?: number;
    minGapMs?: number;
    minSharpness?: number;
    windowMs?: number;
    now?: number;
  }
): CandidateFrame[] {
  if (frames.length === 0) {
    return [];
  }

  const rawMaxFrames = opts?.maxFrames ?? 2;
  const maxFrames = Number.isFinite(rawMaxFrames) ? Math.floor(rawMaxFrames) : 2;
  if (maxFrames <= 0) {
    return [];
  }

  const rawMinGapMs = opts?.minGapMs ?? 350;
  const minGapMs = Number.isFinite(rawMinGapMs) ? Math.max(0, rawMinGapMs) : 350;

  const rawWindowMs = opts?.windowMs ?? 8000;
  const windowMs = Number.isFinite(rawWindowMs) ? Math.max(0, rawWindowMs) : 8000;

  const now = opts?.now !== undefined && Number.isFinite(opts.now) ? opts.now : Date.now();

  const indexed = frames
    .filter((frame) => Number.isFinite(frame.ts))
    .map((frame, index) => ({
      frame,
      index,
      sharpness: Number.isFinite(frame.sharpness) ? frame.sharpness : 0
    }))
    .sort((a, b) => a.frame.ts - b.frame.ts || a.index - b.index);

  if (indexed.length === 0) {
    return [];
  }

  let pool = indexed.filter((entry) => now - entry.frame.ts <= windowMs);
  if (pool.length < maxFrames) {
    pool = indexed.slice(-3);
  }

  if (opts?.minSharpness !== undefined && Number.isFinite(opts.minSharpness)) {
    const threshold = Math.max(0, opts.minSharpness);
    pool = pool.filter((entry) => entry.sharpness >= threshold);
    if (pool.length === 0) {
      return [];
    }
  }

  const bySharpness = [...pool].sort(
    (a, b) => b.sharpness - a.sharpness || b.frame.ts - a.frame.ts || a.index - b.index
  );

  const picked: typeof pool = [];
  const pickedIndices = new Set<number>();

  for (const candidate of bySharpness) {
    if (picked.length >= maxFrames) {
      break;
    }
    const spaced = picked.every(
      (chosen) => Math.abs(candidate.frame.ts - chosen.frame.ts) >= minGapMs
    );
    if (spaced) {
      picked.push(candidate);
      pickedIndices.add(candidate.index);
    }
  }

  if (picked.length < maxFrames) {
    for (const candidate of bySharpness) {
      if (picked.length >= maxFrames) {
        break;
      }
      if (!pickedIndices.has(candidate.index)) {
        picked.push(candidate);
        pickedIndices.add(candidate.index);
      }
    }
  }

  return picked
    .sort((a, b) => a.frame.ts - b.frame.ts || a.index - b.index)
    .map((entry) => entry.frame);
}

export function assessFrameReadiness(
  frames: readonly CandidateFrame[],
  minSharpness = 0.22
): { ready: boolean; bestSharpness: number; suggestedCue: "hold_still" | "ok" } {
  if (frames.length === 0) {
    return {
      ready: false,
      bestSharpness: 0,
      suggestedCue: "hold_still"
    };
  }

  const threshold = Number.isFinite(minSharpness) ? Math.max(0, minSharpness) : 0.22;
  let bestSharpness = 0;

  for (const frame of frames) {
    if (Number.isFinite(frame.sharpness) && frame.sharpness > bestSharpness) {
      bestSharpness = frame.sharpness;
    }
  }

  const ready = bestSharpness >= threshold;
  return {
    ready,
    bestSharpness,
    suggestedCue: ready ? "ok" : "hold_still"
  };
}
