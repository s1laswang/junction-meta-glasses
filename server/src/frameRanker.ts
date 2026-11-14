export type JpegHeaderInfo = {
  w: number;
  h: number;
  hasDqt: boolean;
  hasSos: boolean;
  scanBytes: number;
};

export type FrameOpticalQuality = {
  score: number;
  sharpness: number;
  glarePenalty: number;
  validJpeg: boolean;
  width: number;
  height: number;
};

type ParsedJpegScan = JpegHeaderInfo & {
  extremeBytes: number;
  maxHighRun: number;
  maxFlatRun: number;
};

const BYTES_PER_PIXEL_SCALE = 0.35;
const MIN_HEALTHY_BPP = 0.32;
const EXTREME_RATIO_FLOOR = 0.18;
const EXTREME_RATIO_SPAN = 0.5;
const RUN_FLOOR = 8;
const RUN_SPAN = 24;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function isStandaloneMarker(marker: number): boolean {
  return (
    marker === 0xd8 ||
    marker === 0xd9 ||
    (marker >= 0xd0 && marker <= 0xd7) ||
    marker === 0x01 ||
    marker === 0x00
  );
}

function isSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function inspectJpeg(buf: Buffer): ParsedJpegScan | undefined {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return undefined;
  }

  let i = 2;
  let w = 0;
  let h = 0;
  let hasSof = false;
  let hasDqt = false;
  let hasSos = false;
  let sawEoi = false;
  let scanBytes = 0;
  let extremeBytes = 0;
  let maxHighRun = 0;
  let maxFlatRun = 0;

  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }

    while (i + 1 < buf.length && buf[i + 1] === 0xff) {
      i++;
    }
    if (i + 1 >= buf.length) {
      return undefined;
    }

    const marker = buf[i + 1];
    if (marker === 0xd9) {
      sawEoi = true;
      break;
    }
    if (isStandaloneMarker(marker)) {
      i += 2;
      continue;
    }

    if (i + 4 > buf.length) {
      return undefined;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) {
      return undefined;
    }

    if (marker === 0xdb) {
      hasDqt = true;
    } else if (isSofMarker(marker)) {
      if (len < 7) {
        return undefined;
      }
      const segH = buf.readUInt16BE(i + 5);
      const segW = buf.readUInt16BE(i + 7);
      if (segW === 0 || segH === 0) {
        return undefined;
      }
      if (!hasSof) {
        w = segW;
        h = segH;
        hasSof = true;
      }
    } else if (marker === 0xda) {
      hasSos = true;
      let s = i + 2 + len;
      let terminated = false;
      let curHighRun = 0;
      let curFlatRun = 0;
      let prevByte = -1;

      while (s < buf.length) {
        const b = buf[s];
        if (b !== 0xff) {
          scanBytes++;
          if (b >= 0xf0 || b <= 0x03) extremeBytes++;
          if (b >= 0xf0) {
            curHighRun++;
            if (curHighRun > maxHighRun) maxHighRun = curHighRun;
          } else {
            curHighRun = 0;
          }
          if (b === prevByte) {
            curFlatRun++;
            if (curFlatRun > maxFlatRun) maxFlatRun = curFlatRun;
          } else {
            curFlatRun = 1;
            prevByte = b;
          }
          s++;
          continue;
        }

        let k = s + 1;
        while (k < buf.length && buf[k] === 0xff) {
          k++;
        }
        if (k >= buf.length) {
          return undefined;
        }
        const next = buf[k];
        if (next === 0x00) {
          scanBytes++;
          extremeBytes++;
          curHighRun++;
          if (curHighRun > maxHighRun) maxHighRun = curHighRun;
          if (prevByte === 0xff) {
            curFlatRun++;
            if (curFlatRun > maxFlatRun) maxFlatRun = curFlatRun;
          } else {
            curFlatRun = 1;
            prevByte = 0xff;
          }
          s = k + 1;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          curHighRun = 0;
          curFlatRun = 0;
          prevByte = -1;
          s = k + 1;
          continue;
        }
        terminated = true;
        s = k - 1;
        break;
      }

      if (!terminated) {
        return undefined;
      }
      i = s;
      continue;
    }

    i += 2 + len;
  }

  if (!hasSof || w === 0 || h === 0 || !sawEoi) {
    return undefined;
  }

  return {
    w,
    h,
    hasDqt,
    hasSos,
    scanBytes,
    extremeBytes,
    maxHighRun,
    maxFlatRun,
  };
}

export function parseJpegHeader(buf: Buffer): JpegHeaderInfo | undefined {
  const parsed = inspectJpeg(buf);
  if (!parsed) return undefined;
  return {
    w: parsed.w,
    h: parsed.h,
    hasDqt: parsed.hasDqt,
    hasSos: parsed.hasSos,
    scanBytes: parsed.scanBytes,
  };
}

export function scoreFrameOpticalQuality(buf: Buffer): FrameOpticalQuality {
  const parsed = inspectJpeg(buf);
  if (!parsed) {
    return {
      score: 0,
      sharpness: 0,
      glarePenalty: 0,
      validJpeg: false,
      width: 0,
      height: 0,
    };
  }

  if (!parsed.hasSos || parsed.scanBytes <= 0) {
    return {
      score: 0,
      sharpness: 0,
      glarePenalty: 0,
      validJpeg: false,
      width: parsed.w,
      height: parsed.h,
    };
  }

  const px = parsed.w * parsed.h;
  const sharpness = clamp01(parsed.scanBytes / px / BYTES_PER_PIXEL_SCALE);
  const bpp = (parsed.scanBytes * 8) / px;
  const lowBppPenalty = bpp < MIN_HEALTHY_BPP ? clamp01((MIN_HEALTHY_BPP - bpp) / MIN_HEALTHY_BPP) : 0;

  const extremeRatio = parsed.extremeBytes / parsed.scanBytes;
  const extremePenalty =
    extremeRatio > EXTREME_RATIO_FLOOR
      ? clamp01((extremeRatio - EXTREME_RATIO_FLOOR) / EXTREME_RATIO_SPAN)
      : 0;
  const highRunPenalty =
    parsed.maxHighRun > RUN_FLOOR ? clamp01((parsed.maxHighRun - RUN_FLOOR) / RUN_SPAN) : 0;
  const flatRunPenalty =
    parsed.maxFlatRun > RUN_FLOOR ? clamp01((parsed.maxFlatRun - RUN_FLOOR) / RUN_SPAN) : 0;
  const clipPenalty = Math.max(extremePenalty, highRunPenalty, flatRunPenalty);

  const glarePenalty = clamp01(1 - (1 - lowBppPenalty) * (1 - clipPenalty));
  const dqtWeight = parsed.hasDqt ? 1 : 0.95;
  const score = clamp01(sharpness * (1 - glarePenalty) * dqtWeight);

  return {
    score,
    sharpness,
    glarePenalty,
    validJpeg: true,
    width: parsed.w,
    height: parsed.h,
  };
}

function stripDataUrlPrefix(input: string): string {
  if (!input.startsWith("data:")) return input;
  const comma = input.indexOf(",");
  return comma >= 0 ? input.slice(comma + 1) : input;
}

export function rankBase64Frames(frames: string[], maxPick = 2): string[] {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  if (!Number.isFinite(maxPick)) return [];
  const limit = Math.floor(maxPick);
  if (limit <= 0) return [];

  const candidates: { raw: string; score: number; validJpeg: boolean; index: number }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const raw = frames[i];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const payload = stripDataUrlPrefix(trimmed);
    const quality = scoreFrameOpticalQuality(Buffer.from(payload, "base64"));
    candidates.push({
      raw,
      score: quality.score,
      validJpeg: quality.validJpeg,
      index: i,
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.validJpeg) - Number(a.validJpeg) ||
      b.index - a.index,
  );

  return candidates.slice(0, limit).map((c) => c.raw);
}
