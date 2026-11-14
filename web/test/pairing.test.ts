import {
  buildBridgeDeepLink,
  buildHudUrl,
  buildMetaWebAppDeepLink,
  normalizeServerOrigin
} from "../src/pairing/links.ts";
import { encodeQrMatrix, encodeQrSvg } from "../src/pairing/qrSvg.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotThrow(fn: () => unknown, message?: string): void;
  throws(fn: () => unknown, error?: RegExp | ErrorConstructor): void;
}

const testModuleId = String("node:test");
const assertModuleId = String("node:assert/strict");
const { test } = (await import(testModuleId)) as { test: TestFn };
const { default: assert } = (await import(assertModuleId)) as { default: StrictAssert };

const EM_DASH = String.fromCharCode(0x2014);
const DEMO_ORIGIN = "https://demo-example.trycloudflare.com";

const FINDER_7X7: readonly (readonly boolean[])[] = [
  [true, true, true, true, true, true, true],
  [true, false, false, false, false, false, true],
  [true, false, true, true, true, false, true],
  [true, false, true, true, true, false, true],
  [true, false, true, true, true, false, true],
  [true, false, false, false, false, false, true],
  [true, true, true, true, true, true, true]
];

function assertFinderAt(matrix: boolean[][], topRow: number, leftCol: number): void {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      assert.equal(
        matrix[topRow + r][leftCol + c],
        FINDER_7X7[r][c],
        `finder mismatch at (${topRow + r}, ${leftCol + c})`
      );
    }
  }
}

function assertSeparators(matrix: boolean[][]): void {
  const n = matrix.length;
  for (let i = 0; i < 8; i += 1) {
    assert.equal(matrix[7][i], false);
    assert.equal(matrix[i][7], false);
    assert.equal(matrix[7][n - 8 + i], false);
    assert.equal(matrix[i][n - 8], false);
    assert.equal(matrix[n - 8][i], false);
    assert.equal(matrix[n - 8 + i][7], false);
  }
}

const ALIGNMENT_BY_VERSION: Record<number, readonly number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

const BLOCK_SPEC_L: Record<number, { ec: number; g1: [number, number]; g2: [number, number] }> = {
  1: { ec: 7, g1: [1, 19], g2: [0, 0] },
  2: { ec: 10, g1: [1, 34], g2: [0, 0] },
  3: { ec: 15, g1: [1, 55], g2: [0, 0] },
  4: { ec: 20, g1: [1, 80], g2: [0, 0] },
  5: { ec: 26, g1: [1, 108], g2: [0, 0] },
  6: { ec: 18, g1: [2, 68], g2: [0, 0] },
  7: { ec: 20, g1: [2, 78], g2: [0, 0] },
  8: { ec: 24, g1: [2, 97], g2: [0, 0] },
  9: { ec: 30, g1: [2, 116], g2: [0, 0] },
  10: { ec: 18, g1: [2, 68], g2: [2, 69] }
};

function gfPow2(exp: number): number {
  let v = 1;
  const steps = ((exp % 255) + 255) % 255;
  for (let i = 0; i < steps; i += 1) {
    v = (v << 1) ^ ((v & 0x80) !== 0 ? 0x11d : 0);
  }
  return v;
}

function gfMultiply(a: number, b: number): number {
  let res = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if ((y & 1) !== 0) {
      res ^= x;
    }
    x = (x << 1) ^ ((x & 0x80) !== 0 ? 0x11d : 0);
    y >>>= 1;
  }
  return res;
}

function bchRemainder(poly: number, generator: number, generatorDegree: number): number {
  let rem = poly;
  for (let bit = 30; bit >= generatorDegree; bit -= 1) {
    if (((rem >>> bit) & 1) !== 0) {
      rem ^= generator << (bit - generatorDegree);
    }
  }
  return rem;
}

function decodeQrMatrixLevelL(matrix: boolean[][]): string {
  const n = matrix.length;
  assert.equal((n - 21) % 4, 0);
  const version = (n - 21) / 4 + 1;
  assert.ok(version >= 1 && version <= 10);

  let formatCopy1 = 0;
  const copy1Coords: Array<[number, number]> = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]
  ];
  for (let i = 0; i < 15; i += 1) {
    const [r, c] = copy1Coords[i];
    if (matrix[r][c]) {
      formatCopy1 |= 1 << i;
    }
  }

  let formatCopy2 = 0;
  for (let i = 0; i < 8; i += 1) {
    if (matrix[8][n - 1 - i]) {
      formatCopy2 |= 1 << i;
    }
  }
  for (let i = 8; i < 15; i += 1) {
    if (matrix[n - 15 + i][8]) {
      formatCopy2 |= 1 << i;
    }
  }

  assert.equal(formatCopy1, formatCopy2, "both 15-bit format info regions must match");
  const unmaskedFormat = formatCopy1 ^ 0x5412;
  assert.equal(bchRemainder(unmaskedFormat, 0x537, 10), 0, "format BCH(15,5) syndrome must be 0");

  const formatData = unmaskedFormat >>> 10;
  const ecIndicator = formatData >>> 3;
  const mask = formatData & 0b111;
  assert.equal(ecIndicator, 0b01, "expected Level L format indicator 01");

  if (version >= 7) {
    let versionCopy1 = 0;
    let versionCopy2 = 0;
    for (let i = 0; i < 18; i += 1) {
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      if (matrix[b][a]) versionCopy1 |= 1 << i;
      if (matrix[a][b]) versionCopy2 |= 1 << i;
    }
    assert.equal(versionCopy1, versionCopy2, "both 18-bit version info regions must match");
    assert.equal(bchRemainder(versionCopy1, 0x1f25, 12), 0, "version BCH(18,6) syndrome must be 0");
    assert.equal(versionCopy1 >>> 12, version);
  }

  const isFunc = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const markBox = (r0: number, c0: number, h: number, w: number) => {
    for (let dr = 0; dr < h; dr += 1) {
      for (let dc = 0; dc < w; dc += 1) {
        isFunc[r0 + dr][c0 + dc] = true;
      }
    }
  };
  markBox(0, 0, 9, 9);
  markBox(0, n - 8, 9, 8);
  markBox(n - 8, 0, 8, 9);

  for (let i = 8; i < n - 8; i += 1) {
    isFunc[6][i] = true;
    isFunc[i][6] = true;
  }

  for (const cr of ALIGNMENT_BY_VERSION[version]) {
    for (const cc of ALIGNMENT_BY_VERSION[version]) {
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === n - 7) || (cr === n - 7 && cc === 6)) {
        continue;
      }
      markBox(cr - 2, cc - 2, 5, 5);
    }
  }

  if (version >= 7) {
    markBox(0, n - 11, 6, 3);
    markBox(n - 11, 0, 3, 6);
  }

  const invertMask = (r: number, c: number): boolean => {
    if (mask === 0) return (r + c) % 2 === 0;
    if (mask === 1) return r % 2 === 0;
    if (mask === 2) return c % 3 === 0;
    if (mask === 3) return (r + c) % 3 === 0;
    if (mask === 4) return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    if (mask === 5) return ((r * c) % 2) + ((r * c) % 3) === 0;
    if (mask === 6) return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  };

  const rawBits: number[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step += 1) {
      const r = upward ? n - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        if (!isFunc[r][c]) {
          const bit = matrix[r][c] !== invertMask(r, c) ? 1 : 0;
          rawBits.push(bit);
        }
      }
    }
    upward = !upward;
  }

  const spec = BLOCK_SPEC_L[version];
  const blockLengths: number[] = [];
  for (let i = 0; i < spec.g1[0]; i += 1) blockLengths.push(spec.g1[1]);
  for (let i = 0; i < spec.g2[0]; i += 1) blockLengths.push(spec.g2[1]);
  const totalData = blockLengths.reduce((a, b) => a + b, 0);
  const totalCodewords = totalData + blockLengths.length * spec.ec;

  const codewords = new Uint8Array(totalCodewords);
  for (let i = 0; i < totalCodewords; i += 1) {
    let val = 0;
    for (let b = 0; b < 8; b += 1) {
      val = (val << 1) | rawBits[i * 8 + b];
    }
    codewords[i] = val;
  }

  for (let remIdx = totalCodewords * 8; remIdx < rawBits.length; remIdx += 1) {
    assert.equal(rawBits[remIdx], 0, "remainder bits must be 0");
  }

  const dataBlocks = blockLengths.map((len) => new Uint8Array(len));
  const ecBlocks = blockLengths.map(() => new Uint8Array(spec.ec));
  const maxLen = Math.max(...blockLengths);
  let idx = 0;
  for (let col = 0; col < maxLen; col += 1) {
    for (let b = 0; b < blockLengths.length; b += 1) {
      if (col < blockLengths[b]) {
        dataBlocks[b][col] = codewords[idx];
        idx += 1;
      }
    }
  }
  for (let col = 0; col < spec.ec; col += 1) {
    for (let b = 0; b < blockLengths.length; b += 1) {
      ecBlocks[b][col] = codewords[idx];
      idx += 1;
    }
  }

  for (let b = 0; b < blockLengths.length; b += 1) {
    const fullBlock = new Uint8Array(dataBlocks[b].length + spec.ec);
    fullBlock.set(dataBlocks[b], 0);
    fullBlock.set(ecBlocks[b], dataBlocks[b].length);
    for (let s = 0; s < spec.ec; s += 1) {
      let syndrome = 0;
      const root = gfPow2(s);
      for (const byte of fullBlock) {
        syndrome = gfMultiply(syndrome, root) ^ byte;
      }
      assert.equal(syndrome, 0, `RS syndrome ${s} on block ${b} must equal 0`);
    }
  }

  const dataStreamBits: number[] = [];
  for (const block of dataBlocks) {
    for (const byte of block) {
      for (let b = 7; b >= 0; b -= 1) {
        dataStreamBits.push((byte >>> b) & 1);
      }
    }
  }

  const readBits = (start: number, len: number): number => {
    let out = 0;
    for (let i = 0; i < len; i += 1) {
      out = (out << 1) | dataStreamBits[start + i];
    }
    return out;
  };

  const mode = readBits(0, 4);
  assert.equal(mode, 0b0100, "expected byte mode indicator 0100");
  const countBits = version <= 9 ? 8 : 16;
  const byteCount = readBits(4, countBits);
  const payload = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i += 1) {
    payload[i] = readBits(4 + countBits + i * 8, 8);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

test("encodeQrMatrix selects Versions 1..10 with 21 + 4*(v-1) dimensions, finder patterns, separators, and timing patterns", () => {
  const versionSamples: Array<[number, number]> = [
    [1, 12],
    [2, 24],
    [3, 45],
    [4, 70],
    [5, 96],
    [6, 125],
    [7, 148],
    [8, 180],
    [9, 220],
    [10, 265]
  ];

  for (const [expectedVersion, length] of versionSamples) {
    const seed = `${DEMO_ORIGIN}/hud?p=${"a".repeat(length)}`;
    const text = seed.slice(0, length);
    assert.equal(text.length, length);

    const matrix = encodeQrMatrix(text);
    const expectedSize = 21 + 4 * (expectedVersion - 1);
    assert.equal(matrix.length, expectedSize, `expected v${expectedVersion} size ${expectedSize}`);
    for (const row of matrix) {
      assert.equal(row.length, expectedSize);
    }

    assertFinderAt(matrix, 0, 0);
    assertFinderAt(matrix, 0, expectedSize - 7);
    assertFinderAt(matrix, expectedSize - 7, 0);
    assertSeparators(matrix);

    for (let i = 8; i < expectedSize - 8; i += 1) {
      const expectedTiming = i % 2 === 0;
      assert.equal(matrix[6][i], expectedTiming, `row 6 timing mismatch at col ${i}`);
      assert.equal(matrix[i][6], expectedTiming, `col 6 timing mismatch at row ${i}`);
    }

    assert.equal(matrix[expectedSize - 8][8], true, "dark module must be true");
    assert.equal(decodeQrMatrixLevelL(matrix), text);
  }
});

test("encodeQrMatrix handles 220-character tunnel URLs, UTF-8 text, and pairing links without throwing", () => {
  const baseTunnel = `${DEMO_ORIGIN}/hud?session=hup-4k9m&token=`;
  const url220 = baseTunnel + "x".repeat(220 - baseTunnel.length);
  assert.equal(url220.length, 220);

  let matrix220: boolean[][] = [];
  assert.doesNotThrow(() => {
    matrix220 = encodeQrMatrix(url220);
  });
  assert.equal(matrix220.length, 53);
  assert.equal(decodeQrMatrixLevelL(matrix220), url220);

  const url270 = baseTunnel + "y".repeat(270 - baseTunnel.length);
  assert.equal(url270.length, 270);
  const matrix270 = encodeQrMatrix(url270);
  assert.equal(matrix270.length, 57);
  assert.equal(decodeQrMatrixLevelL(matrix270), url270);

  const utf8Sample = "Yliopiston Apteekki Töölö, Åbo & Äänekoski";
  const utf8Matrix = encodeQrMatrix(utf8Sample);
  assert.equal(decodeQrMatrixLevelL(utf8Matrix), utf8Sample);

  const emptyMatrix = encodeQrMatrix("");
  assert.equal(emptyMatrix.length, 21);
  assert.equal(decodeQrMatrixLevelL(emptyMatrix), "");

  assert.throws(() => encodeQrMatrix("z".repeat(272)), RangeError);
});

test("encodeQrSvg emits accessible crisp SVG with single <path>, quiet zone margin, and zero em dashes", () => {
  const bridgeUri = buildBridgeDeepLink(DEMO_ORIGIN, "hup-9k2m");
  const svg = encodeQrSvg(bridgeUri);

  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.endsWith("</svg>"));
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="QR code"/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.equal((svg.match(/<path\b/g) ?? []).length, 1);
  assert.equal(svg.includes(EM_DASH), false);

  const matrix = encodeQrMatrix(bridgeUri);
  const margin = 3;
  const customSvg = encodeQrSvg(bridgeUri, {
    size: 192,
    margin,
    fg: "#112233",
    bg: "#fafafa",
    title: `Scan ${EM_DASH} Bridge <QR>`
  });

  const expectedView = matrix.length + margin * 2;
  assert.ok(customSvg.includes(`width="192" height="192"`));
  assert.ok(customSvg.includes(`viewBox="0 0 ${expectedView} ${expectedView}"`));
  assert.ok(customSvg.includes(`fill="#112233"`));
  assert.ok(customSvg.includes(`fill="#fafafa"`));
  assert.ok(customSvg.includes(`aria-label="Scan - Bridge &lt;QR&gt;"`));
  assert.equal(customSvg.includes(EM_DASH), false);
  assert.equal((customSvg.match(/<path\b/g) ?? []).length, 1);

  const reconstructed = Array.from({ length: matrix.length }, () =>
    Array<boolean>(matrix.length).fill(false)
  );
  const pathMatch = /<path d="([^"]+)"/.exec(customSvg);
  assert.ok(pathMatch !== null);
  const cmdRegex = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  for (const m of (pathMatch ? pathMatch[1] : "").matchAll(cmdRegex)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const w = Number(m[3]);
    assert.ok(x >= margin && x + w <= matrix.length + margin);
    assert.ok(y >= margin && y < matrix.length + margin);
    for (let dx = 0; dx < w; dx += 1) {
      reconstructed[y - margin][x - margin + dx] = true;
    }
  }
  assert.deepEqual(reconstructed, matrix);
});

test("normalizeServerOrigin, buildBridgeDeepLink, buildHudUrl, and buildMetaWebAppDeepLink encode pairing URLs accurately", () => {
  assert.equal(normalizeServerOrigin(DEMO_ORIGIN), DEMO_ORIGIN);
  assert.equal(normalizeServerOrigin(`${DEMO_ORIGIN}/`), DEMO_ORIGIN);
  assert.equal(normalizeServerOrigin(`  ${DEMO_ORIGIN}///  `), DEMO_ORIGIN);

  assert.equal(
    buildBridgeDeepLink(`${DEMO_ORIGIN}/`),
    "holdupbridge://connect?server=https%3A%2F%2Fdemo-example.trycloudflare.com"
  );
  assert.equal(
    buildBridgeDeepLink(`${DEMO_ORIGIN}/`, "hup-4k9m"),
    "holdupbridge://connect?server=https%3A%2F%2Fdemo-example.trycloudflare.com&session=hup-4k9m"
  );
  assert.equal(
    buildBridgeDeepLink(DEMO_ORIGIN, "   "),
    "holdupbridge://connect?server=https%3A%2F%2Fdemo-example.trycloudflare.com"
  );
  assert.equal(
    buildBridgeDeepLink(DEMO_ORIGIN, "a b&c"),
    "holdupbridge://connect?server=https%3A%2F%2Fdemo-example.trycloudflare.com&session=a%20b%26c"
  );

  const hudDefault = buildHudUrl(`${DEMO_ORIGIN}/`);
  assert.equal(hudDefault, "https://demo-example.trycloudflare.com/hud");

  const hudWithSession = buildHudUrl(`${DEMO_ORIGIN}/`, "hup-4k9m");
  assert.equal(
    hudWithSession,
    "https://demo-example.trycloudflare.com/hud?session=hup-4k9m"
  );
  assert.equal(buildHudUrl(DEMO_ORIGIN, "  "), "https://demo-example.trycloudflare.com/hud");

  assert.equal(
    buildMetaWebAppDeepLink(hudDefault),
    "fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=https%3A%2F%2Fdemo-example.trycloudflare.com%2Fhud"
  );
  assert.equal(
    buildMetaWebAppDeepLink(hudWithSession),
    "fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=https%3A%2F%2Fdemo-example.trycloudflare.com%2Fhud%3Fsession%3Dhup-4k9m"
  );
  assert.equal(
    buildMetaWebAppDeepLink(hudWithSession, "HoldUp HUD"),
    "fb-viewapp://web_app_deep_link?appName=HoldUp%20HUD&appUrl=https%3A%2F%2Fdemo-example.trycloudflare.com%2Fhud%3Fsession%3Dhup-4k9m"
  );

  for (const link of [
    buildBridgeDeepLink(DEMO_ORIGIN, "hup-4k9m"),
    hudDefault,
    hudWithSession,
    buildMetaWebAppDeepLink(hudWithSession)
  ]) {
    assert.equal(link.includes(EM_DASH), false);
    const svg = encodeQrSvg(link);
    assert.equal(svg.includes(EM_DASH), false);
    assert.equal(decodeQrMatrixLevelL(encodeQrMatrix(link)), link);
  }
});
