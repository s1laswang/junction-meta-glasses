export type QrErrorCorrectionLevel = "L" | "M";

export type QrSvgOptions = {
  size?: number;
  margin?: number;
  fg?: string;
  bg?: string;
  title?: string;
};

type VersionSpec = {
  version: number;
  ecCodewordsPerBlock: number;
  group1Blocks: number;
  group1DataCodewords: number;
  group2Blocks: number;
  group2DataCodewords: number;
  alignmentCenters: readonly number[];
};

const VERSION_SPECS: Record<QrErrorCorrectionLevel, readonly VersionSpec[]> = {
  L: [
    { version: 1, ecCodewordsPerBlock: 7, group1Blocks: 1, group1DataCodewords: 19, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [] },
    { version: 2, ecCodewordsPerBlock: 10, group1Blocks: 1, group1DataCodewords: 34, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 18] },
    { version: 3, ecCodewordsPerBlock: 15, group1Blocks: 1, group1DataCodewords: 55, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 22] },
    { version: 4, ecCodewordsPerBlock: 20, group1Blocks: 1, group1DataCodewords: 80, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 26] },
    { version: 5, ecCodewordsPerBlock: 26, group1Blocks: 1, group1DataCodewords: 108, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 30] },
    { version: 6, ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 68, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 34] },
    { version: 7, ecCodewordsPerBlock: 20, group1Blocks: 2, group1DataCodewords: 78, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 22, 38] },
    { version: 8, ecCodewordsPerBlock: 24, group1Blocks: 2, group1DataCodewords: 97, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 24, 42] },
    { version: 9, ecCodewordsPerBlock: 30, group1Blocks: 2, group1DataCodewords: 116, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 26, 46] },
    { version: 10, ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 68, group2Blocks: 2, group2DataCodewords: 69, alignmentCenters: [6, 28, 50] }
  ],
  M: [
    { version: 1, ecCodewordsPerBlock: 10, group1Blocks: 1, group1DataCodewords: 16, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [] },
    { version: 2, ecCodewordsPerBlock: 16, group1Blocks: 1, group1DataCodewords: 28, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 18] },
    { version: 3, ecCodewordsPerBlock: 26, group1Blocks: 1, group1DataCodewords: 44, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 22] },
    { version: 4, ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 32, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 26] },
    { version: 5, ecCodewordsPerBlock: 24, group1Blocks: 2, group1DataCodewords: 43, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 30] },
    { version: 6, ecCodewordsPerBlock: 16, group1Blocks: 4, group1DataCodewords: 27, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 34] },
    { version: 7, ecCodewordsPerBlock: 18, group1Blocks: 4, group1DataCodewords: 31, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 22, 38] },
    { version: 8, ecCodewordsPerBlock: 22, group1Blocks: 2, group1DataCodewords: 38, group2Blocks: 2, group2DataCodewords: 39, alignmentCenters: [6, 24, 42] },
    { version: 9, ecCodewordsPerBlock: 22, group1Blocks: 3, group1DataCodewords: 36, group2Blocks: 2, group2DataCodewords: 37, alignmentCenters: [6, 26, 46] },
    { version: 10, ecCodewordsPerBlock: 26, group1Blocks: 4, group1DataCodewords: 43, group2Blocks: 1, group2DataCodewords: 44, alignmentCenters: [6, 28, 50] }
  ]
};

const EC_FORMAT_BITS: Record<QrErrorCorrectionLevel, number> = {
  L: 0b01,
  M: 0b00
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value = (value << 1) ^ ((value & 0x80) !== 0 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsGenerator(degree: number): Uint8Array {
  let poly: Uint8Array<ArrayBufferLike> = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const root = GF_EXP[i];
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly.subarray(1);
}

function computeRsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const generator = buildRsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j += 1) {
        remainder[j] ^= gfMul(generator[j], factor);
      }
    }
  }
  return remainder;
}

function totalDataCodewords(spec: VersionSpec): number {
  return (
    spec.group1Blocks * spec.group1DataCodewords +
    spec.group2Blocks * spec.group2DataCodewords
  );
}

function selectVersionSpec(byteLength: number, ecLevel: QrErrorCorrectionLevel): VersionSpec {
  const table = VERSION_SPECS[ecLevel];
  for (const spec of table) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const requiredBits = 4 + countBits + byteLength * 8;
    const availableBits = totalDataCodewords(spec) * 8;
    if (requiredBits <= availableBits) {
      return spec;
    }
  }
  throw new RangeError(
    `QR payload of ${byteLength} UTF-8 bytes exceeds Version 10-${ecLevel} capacity`
  );
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function encodeDataCodewords(payload: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBytesCount = totalDataCodewords(spec);
  const dataBitCapacity = dataBytesCount * 8;
  const countBits = spec.version <= 9 ? 8 : 16;
  const bits: number[] = [];

  appendBits(bits, 0b0100, 4);
  appendBits(bits, payload.length, countBits);
  for (let i = 0; i < payload.length; i += 1) {
    appendBits(bits, payload[i], 8);
  }

  const terminatorLength = Math.min(4, dataBitCapacity - bits.length);
  appendBits(bits, 0, terminatorLength);

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const out = new Uint8Array(dataBytesCount);
  const encodedByteCount = bits.length / 8;
  for (let i = 0; i < encodedByteCount; i += 1) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) {
      value = (value << 1) | bits[i * 8 + b];
    }
    out[i] = value;
  }

  let padToggle = 0;
  for (let i = encodedByteCount; i < dataBytesCount; i += 1) {
    out[i] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }

  return out;
}

function interleaveCodewords(dataCodewords: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const block = dataCodewords.subarray(offset, offset + spec.group1DataCodewords);
    offset += spec.group1DataCodewords;
    dataBlocks.push(block);
    ecBlocks.push(computeRsRemainder(block, spec.ecCodewordsPerBlock));
  }

  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const block = dataCodewords.subarray(offset, offset + spec.group2DataCodewords);
    offset += spec.group2DataCodewords;
    dataBlocks.push(block);
    ecBlocks.push(computeRsRemainder(block, spec.ecCodewordsPerBlock));
  }

  const totalBlocks = dataBlocks.length;
  const maxDataLength = Math.max(spec.group1DataCodewords, spec.group2DataCodewords);
  const totalLength = dataCodewords.length + totalBlocks * spec.ecCodewordsPerBlock;
  const result = new Uint8Array(totalLength);
  let cursor = 0;

  for (let col = 0; col < maxDataLength; col += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      if (col < dataBlocks[b].length) {
        result[cursor] = dataBlocks[b][col];
        cursor += 1;
      }
    }
  }

  for (let col = 0; col < spec.ecCodewordsPerBlock; col += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      result[cursor] = ecBlocks[b][col];
      cursor += 1;
    }
  }

  return result;
}

function createSquareGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => Array<boolean>(size).fill(false));
}

function cloneSquareGrid(grid: boolean[][]): boolean[][] {
  return grid.map((row) => row.slice());
}

function setFunctionModule(
  modules: boolean[][],
  isFunction: boolean[][],
  row: number,
  col: number,
  dark: boolean
): void {
  modules[row][col] = dark;
  isFunction[row][col] = true;
}

function placeFinderWithSeparator(
  modules: boolean[][],
  isFunction: boolean[][],
  topRow: number,
  leftCol: number
): void {
  const size = modules.length;
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = topRow + dr;
      const c = leftCol + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) {
        continue;
      }
      const inFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      const dark = inFinder && dist !== 2;
      setFunctionModule(modules, isFunction, r, c, dark);
    }
  }
}

function placeAlignmentPattern(
  modules: boolean[][],
  isFunction: boolean[][],
  centerRow: number,
  centerCol: number
): void {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFunctionModule(modules, isFunction, centerRow + dr, centerCol + dc, dist !== 1);
    }
  }
}

function computeFormatBits(ecLevel: QrErrorCorrectionLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(
  modules: boolean[][],
  isFunction: boolean[][],
  ecLevel: QrErrorCorrectionLevel,
  mask: number
): void {
  const size = modules.length;
  const bits = computeFormatBits(ecLevel, mask);
  const bitAt = (idx: number): boolean => ((bits >>> idx) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) {
    setFunctionModule(modules, isFunction, i, 8, bitAt(i));
  }
  setFunctionModule(modules, isFunction, 7, 8, bitAt(6));
  setFunctionModule(modules, isFunction, 8, 8, bitAt(7));
  setFunctionModule(modules, isFunction, 8, 7, bitAt(8));
  for (let i = 9; i < 15; i += 1) {
    setFunctionModule(modules, isFunction, 8, 14 - i, bitAt(i));
  }

  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(modules, isFunction, 8, size - 1 - i, bitAt(i));
  }
  for (let i = 8; i < 15; i += 1) {
    setFunctionModule(modules, isFunction, size - 15 + i, 8, bitAt(i));
  }

  setFunctionModule(modules, isFunction, size - 8, 8, true);
}

function computeVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  }
  return (version << 12) | rem;
}

function drawVersionBits(
  modules: boolean[][],
  isFunction: boolean[][],
  version: number
): void {
  if (version < 7) {
    return;
  }
  const size = modules.length;
  const bits = computeVersionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(modules, isFunction, b, a, dark);
    setFunctionModule(modules, isFunction, a, b, dark);
  }
}

function placeFunctionPatterns(
  modules: boolean[][],
  isFunction: boolean[][],
  spec: VersionSpec,
  ecLevel: QrErrorCorrectionLevel
): void {
  const size = modules.length;

  placeFinderWithSeparator(modules, isFunction, 0, 0);
  placeFinderWithSeparator(modules, isFunction, 0, size - 7);
  placeFinderWithSeparator(modules, isFunction, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunctionModule(modules, isFunction, 6, i, dark);
    setFunctionModule(modules, isFunction, i, 6, dark);
  }

  const centers = spec.alignmentCenters;
  for (const cr of centers) {
    for (const cc of centers) {
      const overlapsTopLeft = cr === 6 && cc === 6;
      const overlapsTopRight = cr === 6 && cc === size - 7;
      const overlapsBottomLeft = cr === size - 7 && cc === 6;
      if (!overlapsTopLeft && !overlapsTopRight && !overlapsBottomLeft) {
        placeAlignmentPattern(modules, isFunction, cr, cc);
      }
    }
  }

  drawFormatBits(modules, isFunction, ecLevel, 0);
  drawVersionBits(modules, isFunction, spec.version);
}

function placeCodewordBits(
  modules: boolean[][],
  isFunction: boolean[][],
  codewords: Uint8Array
): void {
  const size = modules.length;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const col = right - dx;
        if (!isFunction[row][col]) {
          let dark = false;
          if (bitIndex < totalBits) {
            const byte = codewords[bitIndex >>> 3];
            dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex += 1;
          }
          modules[row][col] = dark;
        }
      }
    }
    upward = !upward;
  }
}

function shouldInvertForMask(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(
  baseModules: boolean[][],
  isFunction: boolean[][],
  ecLevel: QrErrorCorrectionLevel,
  mask: number
): boolean[][] {
  const size = baseModules.length;
  const candidate = cloneSquareGrid(baseModules);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!isFunction[r][c] && shouldInvertForMask(mask, r, c)) {
        candidate[r][c] = !candidate[r][c];
      }
    }
  }
  drawFormatBits(candidate, isFunction, ecLevel, mask);
  return candidate;
}

function scoreLineRunsAndPatterns(line: readonly boolean[]): number {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;

  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLength += 1;
      if (runLength === 5) {
        penalty += 3;
      } else if (runLength > 5) {
        penalty += 1;
      }
    } else {
      runColor = line[i];
      runLength = 1;
    }
  }

  let windowBits = 0;
  for (let i = 0; i < line.length; i += 1) {
    windowBits = ((windowBits << 1) & 0x7ff) | (line[i] ? 1 : 0);
    if (i >= 10 && (windowBits === 0x5d0 || windowBits === 0x05d)) {
      penalty += 40;
    }
  }

  return penalty;
}

function computePenaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let penalty = 0;

  for (let r = 0; r < size; r += 1) {
    penalty += scoreLineRunsAndPatterns(modules[r]);
  }

  const colBuffer = Array<boolean>(size).fill(false);
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r < size; r += 1) {
      colBuffer[r] = modules[r][c];
    }
    penalty += scoreLineRunsAndPatterns(colBuffer);
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = modules[r][c];
      if (
        color === modules[r][c + 1] &&
        color === modules[r + 1][c] &&
        color === modules[r + 1][c + 1]
      ) {
        penalty += 3;
      }
    }
  }

  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        darkCount += 1;
      }
    }
  }

  const totalModules = size * size;
  const balanceSteps = Math.max(
    0,
    Math.ceil(Math.abs(darkCount * 20 - totalModules * 10) / totalModules) - 1
  );
  penalty += balanceSteps * 10;

  return penalty;
}

export function encodeQrMatrix(
  text: string,
  ecLevel: QrErrorCorrectionLevel = "L"
): boolean[][] {
  const utf8Bytes = new TextEncoder().encode(text);
  const spec = selectVersionSpec(utf8Bytes.length, ecLevel);
  const size = 21 + 4 * (spec.version - 1);

  const dataCodewords = encodeDataCodewords(utf8Bytes, spec);
  const allCodewords = interleaveCodewords(dataCodewords, spec);

  const baseModules = createSquareGrid(size);
  const isFunction = createSquareGrid(size);

  placeFunctionPatterns(baseModules, isFunction, spec, ecLevel);
  placeCodewordBits(baseModules, isFunction, allCodewords);

  let bestMatrix: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(baseModules, isFunction, ecLevel, mask);
    const penalty = computePenaltyScore(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate;
    }
  }

  return bestMatrix ?? baseModules;
}

const EM_DASH_CHAR = String.fromCharCode(0x2014);

function escapeXml(value: string): string {
  return value
    .replaceAll(EM_DASH_CHAR, "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function encodeQrSvg(text: string, opts?: QrSvgOptions): string {
  const matrix = encodeQrMatrix(text);
  const moduleCount = matrix.length;

  const size =
    opts?.size !== undefined && Number.isFinite(opts.size) && opts.size > 0
      ? Math.round(opts.size)
      : 256;
  const margin =
    opts?.margin !== undefined && Number.isFinite(opts.margin) && opts.margin >= 0
      ? Math.floor(opts.margin)
      : 4;
  const fg = opts?.fg && opts.fg.trim().length > 0 ? opts.fg.trim() : "#000000";
  const bg = opts?.bg && opts.bg.trim().length > 0 ? opts.bg.trim() : "#ffffff";
  const rawTitle = opts?.title && opts.title.trim().length > 0 ? opts.title.trim() : "QR code";

  const escapedTitle = escapeXml(rawTitle);
  const escapedFg = escapeXml(fg);
  const escapedBg = escapeXml(bg);
  const viewSize = moduleCount + margin * 2;

  const pathSegments: string[] = [];
  for (let r = 0; r < moduleCount; r += 1) {
    let c = 0;
    while (c < moduleCount) {
      if (!matrix[r][c]) {
        c += 1;
        continue;
      }
      let runWidth = 1;
      while (c + runWidth < moduleCount && matrix[r][c + runWidth]) {
        runWidth += 1;
      }
      pathSegments.push(`M${c + margin} ${r + margin}h${runWidth}v1h-${runWidth}z`);
      c += runWidth;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapedTitle}" width="${size}" height="${size}" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><title>${escapedTitle}</title><rect width="${viewSize}" height="${viewSize}" fill="${escapedBg}"/><path d="${pathSegments.join("")}" fill="${escapedFg}"/></svg>`;
}
