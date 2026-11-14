function lumaAt(rgba: Uint8ClampedArray, offset: number): number {
  return (77 * rgba[offset] + 150 * rgba[offset + 1] + 29 * rgba[offset + 2]) >> 8;
}

export function computeSharpness(rgba: Uint8ClampedArray, width: number, height: number): number {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 3 || h < 3) {
    return 0;
  }
  if (rgba.length < w * h * 4) {
    return 0;
  }

  const stride = w * h > 256 * 256 ? 2 : 1;
  const rowBytes = w * 4;
  let sumSq = 0;
  let count = 0;

  if (stride === 1) {
    for (let y = 1; y < h - 1; y += 1) {
      const rowOffset = y * rowBytes;
      const upRowOffset = rowOffset - rowBytes;
      const downRowOffset = rowOffset + rowBytes;
      let left = lumaAt(rgba, rowOffset);
      let center = lumaAt(rgba, rowOffset + 4);
      for (let x = 1; x < w - 1; x += 1) {
        const right = lumaAt(rgba, rowOffset + (x + 1) * 4);
        const up = lumaAt(rgba, upRowOffset + x * 4);
        const down = lumaAt(rgba, downRowOffset + x * 4);
        const lap = 4 * center - left - right - up - down;
        const gx = right - left;
        const gy = down - up;
        sumSq += lap * lap + 0.25 * (gx * gx + gy * gy);
        count += 1;
        left = center;
        center = right;
      }
    }
  } else {
    for (let y = 1; y < h - 1; y += 2) {
      const rowOffset = y * rowBytes;
      const upRowOffset = rowOffset - rowBytes;
      const downRowOffset = rowOffset + rowBytes;
      let left = lumaAt(rgba, rowOffset);
      for (let x = 1; x < w - 1; x += 2) {
        const xBytes = x * 4;
        const center = lumaAt(rgba, rowOffset + xBytes);
        const right = lumaAt(rgba, rowOffset + xBytes + 4);
        const up = lumaAt(rgba, upRowOffset + xBytes);
        const down = lumaAt(rgba, downRowOffset + xBytes);
        const lap = 4 * center - left - right - up - down;
        const gx = right - left;
        const gy = down - up;
        sumSq += lap * lap + 0.25 * (gx * gx + gy * gy);
        count += 1;
        left = right;
      }
    }
  }

  if (count === 0) {
    return 0;
  }

  const meanSq = sumSq / count;
  const normalized = meanSq / (meanSq + 576);
  return Math.max(0, Math.min(1, normalized));
}
