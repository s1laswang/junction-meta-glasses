// BarcodeDetector wrapper (Chrome on Android/macOS; not in iOS Safari or Firefox).
type Detected = { rawValue: string; format: string };
type Detector = { detect(src: CanvasImageSource | ImageBitmapSource): Promise<Detected[]> };
type DetectorCtor = { new (opts?: { formats?: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

const Ctor: DetectorCtor | undefined = typeof window !== "undefined" ? (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector : undefined;

export const barcodeSupported = !!Ctor;

let detector: Detector | null = null;
async function get(): Promise<Detector | null> {
  if (!Ctor) return null;
  if (detector) return detector;
  const wanted = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "data_matrix", "qr_code"];
  let formats = wanted;
  try {
    const sup = (await Ctor.getSupportedFormats?.()) ?? wanted;
    formats = wanted.filter((f) => sup.includes(f));
  } catch {
    /* ignore */
  }
  detector = new Ctor({ formats });
  return detector;
}

/** All codes in view, with their format ("ean_13", "data_matrix", ...). */
export async function detectCodes(src: CanvasImageSource): Promise<Detected[]> {
  const d = await get();
  if (!d) return [];
  try {
    return await d.detect(src);
  } catch {
    return [];
  }
}

export const dataMatrixSupported = async () => {
  try {
    return !!Ctor && ((await Ctor.getSupportedFormats?.()) ?? []).includes("data_matrix");
  } catch {
    return false;
  }
};

export async function detectBarcode(src: CanvasImageSource): Promise<string | null> {
  const d = await get();
  if (!d) return null;
  try {
    const found = await d.detect(src);
    return found[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}
