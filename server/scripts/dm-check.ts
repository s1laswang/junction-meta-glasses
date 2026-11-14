// DataMatrix round trip: write a GS1 DataMatrix PNG (zxing-wasm writer, local wasm) and/or decode JPEGs with the
// server decoder, printing timings. Usage:
//   tsx scripts/dm-check.ts write out.png "(01)09501101530003(17)270831(10)AB12C(21)SN1"
//   tsx scripts/dm-check.ts read a.jpg [b.jpg ...]
import fs from "node:fs";
import { createRequire } from "node:module";
import { decodeDataMatrix } from "../src/dm.ts";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "write") {
  const [out, text] = rest;
  const full = await import("zxing-wasm/full");
  const wasm = fs.readFileSync(createRequire(import.meta.url).resolve("zxing-wasm/full/zxing_full.wasm"));
  full.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer } });
  const r = await full.writeBarcode(text, { format: "DataMatrix", options: "gs1", scale: 10 } as any);
  if (!r.image) throw new Error("no image");
  fs.writeFileSync(out, Buffer.from(await r.image.arrayBuffer()));
  console.log("wrote", out);
} else {
  for (const f of rest) {
    const buf = fs.readFileSync(f);
    for (let i = 0; i < 3; i++) {
      const { codes, ms } = await decodeDataMatrix(buf);
      console.log(f.split("/").pop(), `run${i}`, `${ms} ms`, JSON.stringify(codes.map((c) => ({ gtin: c.gtin, expiry: c.expiry, batch: !!c.batch, serial: !!c.serial }))));
    }
  }
}
