// Camera / mic permission and acquisition, with errors mapped to states the UI can explain.

export type PermState = "unknown" | "prompt" | "granted" | "denied" | "blocked" | "unavailable" | "insecure" | "in-use";

export type MediaProblem = { kind: "camera" | "mic"; state: PermState; message: string };

export function mediaSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

export async function queryPermission(name: "camera" | "microphone"): Promise<PermState> {
  if (!window.isSecureContext) return "insecure";
  if (!mediaSupported()) return "unavailable";
  try {
    const s = await navigator.permissions.query({ name: name as PermissionName });
    return s.state === "granted" ? "granted" : s.state === "denied" ? "blocked" : "prompt";
  } catch {
    return "unknown"; // Safari/Firefox may not support querying camera/mic
  }
}

export function classifyError(e: unknown): PermState {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "unavailable";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "in-use";
  if (name === "SecurityError") return "insecure";
  return "denied";
}

export function explain(kind: "camera" | "mic", s: PermState): string {
  const what = kind === "camera" ? "camera" : "microphone";
  switch (s) {
    case "denied":
      return `You said no to the ${what}. That's fine. You can turn it on any time.`;
    case "blocked":
      return `The ${what} is blocked for this site in your browser settings.`;
    case "unavailable":
      return `This device has no ${what} that HoldUp can use.`;
    case "in-use":
      return `Another app is using the ${what}. Close it and try again.`;
    case "insecure":
      return `The ${what} needs a secure (https) connection. Open HoldUp through its https link.`;
    default:
      return "";
  }
}

export async function getCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 15, max: 30 } },
  });
}

export async function getMic(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

/** Best guess at the current audio route (labels only exist after permission is granted). */
export async function audioRoute(): Promise<{ input: string; output: string; bluetooth: boolean }> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind: MediaDeviceKind) => devs.find((d) => d.kind === kind && d.deviceId === "default") ?? devs.find((d) => d.kind === kind);
    const input = pick("audioinput")?.label ?? "";
    const output = pick("audiooutput")?.label ?? "";
    const bluetooth = /bluetooth|airpods|ray-?ban|meta|headset|hands-?free|buds|bt/i.test(input + " " + output);
    return { input: input.replace(/^Default - /, ""), output: output.replace(/^Default - /, ""), bluetooth };
  } catch {
    return { input: "", output: "", bluetooth: false };
  }
}

export function platformHint(): "ios" | "android" | "desktop" {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}
