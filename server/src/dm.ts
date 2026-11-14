// Server-side DataMatrix decode (zxing-wasm, local wasm, no CDN). Used for glasses frames only (the phone
// decodes its own camera with BarcodeDetector). Throttled per session and self-disabling when it is slow.
import fs from "node:fs";
import { createRequire } from "node:module";
import type { Gs1Code } from "../../shared/types.ts";
import { parseGs1 } from "./gs1.ts";
import { errSummary, log } from "./log.ts";

let ready: Promise<typeof import("zxing-wasm/reader")> | undefined;
function zx() {
  ready ??= (async () => {
    const mod = await import("zxing-wasm/reader");
    const require = createRequire(import.meta.url);
    const wasm = fs.readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    mod.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
    return mod;
  })();
  return ready;
}

export const DM = { minGapMs: 1500, slowMs: 150, backoffMs: 10_000 };

/** Decode GS1 DataMatrix codes from a JPEG. Returns parsed codes (never logs their content). */
export async function decodeDataMatrix(jpeg: Buffer): Promise<{ codes: Gs1Code[]; ms: number }> {
  const t = Date.now();
  try {
    const { readBarcodes } = await zx();
    const res = await readBarcodes(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), {
      formats: ["DataMatrix"], tryHarder: false, tryRotate: true, tryInvert: false, maxNumberOfSymbols: 2,
    });
    const codes = res.filter((r) => r.isValid).map((r) => parseGs1(r.text)).filter((c): c is Gs1Code => !!c);
    return { codes, ms: Date.now() - t };
  } catch (e) {
    log("dm.error", { err: errSummary(e) });
    return { codes: [], ms: Date.now() - t };
  }
}

/** Per-session throttle: at most one decode per minGapMs; a decode slower than slowMs pauses decoding for backoffMs. */
export class DmThrottle {
  private nextAt = 0;
  private busy = false;
  async maybe(jpeg: Buffer, onCode: (c: Gs1Code) => void) {
    const now = Date.now();
    if (this.busy || now < this.nextAt) return;
    this.busy = true;
    try {
      const { codes, ms } = await decodeDataMatrix(jpeg);
      this.nextAt = Date.now() + (ms > DM.slowMs ? DM.backoffMs : DM.minGapMs);
      if (codes.length) { log("dm_decoded", { n: codes.length, ms, src: "glasses" }); codes.forEach(onCode); }
    } finally { this.busy = false; }
  }
}
