export type EncodedFrame = {
  data: string;
  w: number;
  h: number;
  sharpness: number;
  ts: number;
};

export type LoadFixtureOptions = {
  fetchImpl?: typeof fetch;
  cache?: boolean;
};

type CachedFixtureEntry = {
  data: string;
  w: number;
  h: number;
  sharpness: number;
};

const DEFAULT_DIMENSION = 768;
const BYTES_PER_PIXEL_SCALE = 0.35;
const BASE64_CHUNK_BYTES = 8190;
const MAX_CACHE_ENTRIES = 8;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const fixtureCache = new Map<string, CachedFixtureEntry>();

function isSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

export function parseJpegDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      return null;
    }

    const marker = bytes[offset];
    offset += 1;

    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (offset + 1 >= bytes.length) {
      return null;
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2) {
      return null;
    }

    if (isSofMarker(marker)) {
      if (segmentLength < 7 || offset + 6 >= bytes.length) {
        return null;
      }
      const h = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const w = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (w <= 0 || h <= 0) {
        return null;
      }
      return { w, h };
    }

    offset += segmentLength;
  }

  return null;
}

export function estimateJpegByteSharpness(
  bytes: Uint8Array,
  dims?: { w: number; h: number } | null
): number {
  if (bytes.length === 0) {
    return 0;
  }

  const resolved = dims === undefined ? parseJpegDimensions(bytes) : dims;
  const validDims =
    resolved !== null &&
    Number.isFinite(resolved.w) &&
    Number.isFinite(resolved.h) &&
    resolved.w > 0 &&
    resolved.h > 0;

  const pixels = validDims
    ? resolved.w * resolved.h
    : DEFAULT_DIMENSION * DEFAULT_DIMENSION;

  const normalized = bytes.length / pixels / BYTES_PER_PIXEL_SCALE;
  return Math.max(0, Math.min(1, normalized));
}

function encodeBase64Fallback(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  while (i + 2 < bytes.length) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(
      BASE64_ALPHABET[(triplet >> 18) & 0x3f],
      BASE64_ALPHABET[(triplet >> 12) & 0x3f],
      BASE64_ALPHABET[(triplet >> 6) & 0x3f],
      BASE64_ALPHABET[triplet & 0x3f]
    );
    i += 3;
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out.push(
      BASE64_ALPHABET[(n >> 18) & 0x3f],
      BASE64_ALPHABET[(n >> 12) & 0x3f],
      "=="
    );
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(
      BASE64_ALPHABET[(n >> 18) & 0x3f],
      BASE64_ALPHABET[(n >> 12) & 0x3f],
      BASE64_ALPHABET[(n >> 6) & 0x3f],
      "="
    );
  }

  return out.join("");
}

export function uint8ToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const nodeBuffer = (
    globalThis as unknown as {
      Buffer?: {
        from(
          buffer: ArrayBufferLike,
          byteOffset: number,
          byteLength: number
        ): { toString(encoding: "base64"): string };
      };
    }
  ).Buffer;

  if (nodeBuffer && typeof nodeBuffer.from === "function") {
    return nodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }

  if (typeof globalThis.btoa === "function") {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
      chunks.push(globalThis.btoa(String.fromCharCode(...slice)));
    }
    return chunks.join("");
  }

  return encodeBase64Fallback(bytes);
}

export function clearFixtureCache(): void {
  fixtureCache.clear();
}

export async function loadFixtureFrame(
  fixtureUrl: string,
  opts?: { fetchImpl?: typeof fetch; cache?: boolean }
): Promise<EncodedFrame> {
  const useCache = opts?.cache !== false;

  if (useCache) {
    const cached = fixtureCache.get(fixtureUrl);
    if (cached !== undefined) {
      fixtureCache.delete(fixtureUrl);
      fixtureCache.set(fixtureUrl, cached);
      return {
        data: cached.data,
        w: cached.w,
        h: cached.h,
        sharpness: cached.sharpness,
        ts: Date.now()
      };
    }
  }

  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("Fetch API is unavailable");
  }

  const res = await fetchFn(fixtureUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch fixture ${fixtureUrl}: HTTP ${res.status}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const parsedDims = parseJpegDimensions(bytes);
  const w = parsedDims ? parsedDims.w : DEFAULT_DIMENSION;
  const h = parsedDims ? parsedDims.h : DEFAULT_DIMENSION;
  const sharpness = estimateJpegByteSharpness(bytes, { w, h });
  const data = uint8ToBase64(bytes);

  if (useCache) {
    if (fixtureCache.has(fixtureUrl)) {
      fixtureCache.delete(fixtureUrl);
    } else if (fixtureCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = fixtureCache.keys().next().value;
      if (oldestKey !== undefined) {
        fixtureCache.delete(oldestKey);
      }
    }
    fixtureCache.set(fixtureUrl, { data, w, h, sharpness });
  }

  return {
    data,
    w,
    h,
    sharpness,
    ts: Date.now()
  };
}
