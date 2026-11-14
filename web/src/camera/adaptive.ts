export type AdaptiveProfile = {
  targetFps: number;
  intervalMs: number;
  jpegQuality: number;
  maxDim: number;
};

export function computeAdaptiveParams(rttMs: number | null, online = true): AdaptiveProfile {
  if (!online) {
    return {
      targetFps: 0,
      intervalMs: 2000,
      jpegQuality: 0.6,
      maxDim: 512
    };
  }

  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 250) {
    return {
      targetFps: 1.0,
      intervalMs: 1000,
      jpegQuality: 0.78,
      maxDim: 768
    };
  }

  if (rttMs <= 650) {
    return {
      targetFps: 0.75,
      intervalMs: 1333,
      jpegQuality: 0.64,
      maxDim: 640
    };
  }

  return {
    targetFps: 0.5,
    intervalMs: 2000,
    jpegQuality: 0.5,
    maxDim: 512
  };
}
