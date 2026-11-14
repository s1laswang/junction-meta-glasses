type NodeBufferLike = {
  from(data: Uint8Array): { toString(encoding: "base64"): string };
  from(data: string, encoding: "base64"): Uint8Array;
};

function getNodeBuffer(): NodeBufferLike | undefined {
  return (globalThis as unknown as { Buffer?: NodeBufferLike }).Buffer;
}

export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const raw = samples[i];
    if (Number.isNaN(raw)) {
      out[i] = 0;
      continue;
    }
    const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw;
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

export function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i];
    out[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return out;
}

export function downsampleBuffer(
  input: Float32Array,
  inRate: number,
  outRate: number
): Float32Array {
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) {
    throw new RangeError("Sample rates must be finite positive numbers");
  }
  if (inRate === outRate) {
    return input;
  }
  if (input.length === 0) {
    return new Float32Array(0);
  }
  if (inRate < outRate) {
    const outLength = Math.max(1, Math.round((input.length * outRate) / inRate));
    const output = new Float32Array(outLength);
    const step = inRate / outRate;
    for (let i = 0; i < outLength; i += 1) {
      const pos = i * step;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[Math.min(idx, input.length - 1)];
      const s1 = input[Math.min(idx + 1, input.length - 1)];
      output[i] = s0 + (s1 - s0) * frac;
    }
    return output;
  }

  const outLength = Math.floor((input.length * outRate) / inRate);
  if (outLength <= 0) {
    return new Float32Array(0);
  }
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = (i * inRate) / outRate;
    const end = Math.min(input.length, ((i + 1) * inRate) / outRate);
    const firstIdx = Math.floor(start);
    const lastIdx = Math.floor(end);
    if (firstIdx >= input.length) {
      break;
    }
    if (firstIdx === lastIdx) {
      output[i] = input[firstIdx];
      continue;
    }
    const leadWeight = 1 - (start - firstIdx);
    let sum = input[firstIdx] * leadWeight;
    let totalWeight = leadWeight;
    for (let j = firstIdx + 1; j < lastIdx && j < input.length; j += 1) {
      sum += input[j];
      totalWeight += 1;
    }
    const tailWeight = end - lastIdx;
    if (tailWeight > 0 && lastIdx < input.length) {
      sum += input[lastIdx] * tailWeight;
      totalWeight += tailWeight;
    }
    output[i] = totalWeight > 0 ? sum / totalWeight : 0;
  }
  return output;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  if (pcm.length === 0) {
    return "";
  }
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i], true);
  }

  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }

  const nodeBuffer = getNodeBuffer();
  if (nodeBuffer) {
    return nodeBuffer.from(bytes).toString("base64");
  }
  return "";
}

export function base64ToPcm16(b64: string): Int16Array {
  const clean = b64.trim();
  if (!clean) {
    return new Int16Array(0);
  }

  let bytes: Uint8Array;
  if (typeof atob === "function") {
    const binary = atob(clean);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }
  } else {
    const nodeBuffer = getNodeBuffer();
    if (!nodeBuffer) {
      return new Int16Array(0);
    }
    const decoded = nodeBuffer.from(clean, "base64");
    bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  }

  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (sampleCount <= 0) {
    return new Int16Array(0);
  }
  const out = new Int16Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    if (Number.isNaN(v)) {
      continue;
    }
    if (!Number.isFinite(v)) {
      sumSq += 1;
      continue;
    }
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return Math.max(0, Math.min(1, rms));
}
