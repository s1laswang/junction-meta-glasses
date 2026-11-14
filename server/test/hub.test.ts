import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type { DeviceState, LabelRead, ServerMsg, Verdict } from "../../shared/types.ts";
import {
  addHud,
  getOrCreateHub,
  hasHud,
  hubStats,
  hudTarget,
  latestHub,
  markLatest,
  resetHubsForTest,
  safeSend,
  setDevice,
} from "../src/hub.ts";

type MockSocket = {
  ws: WebSocket;
  sent: ServerMsg[];
  close: () => void;
};

function createMockWs(readyState = 1): MockSocket {
  const sent: ServerMsg[] = [];
  const closeListeners: Array<() => void> = [];
  const raw = {
    readyState,
    send(data: string) {
      sent.push(JSON.parse(data) as ServerMsg);
    },
    on(event: string, cb: () => void) {
      if (event === "close") closeListeners.push(cb);
      return raw;
    },
  };
  return {
    ws: raw as unknown as WebSocket,
    sent,
    close() {
      raw.readyState = 3;
      for (const cb of closeListeners) cb();
    },
  };
}

function sampleVerdict(): Verdict {
  const emptyField = { value: null, confidence: 0 };
  const read: LabelRead = {
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.95 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: emptyField,
    expiry: emptyField,
    allergens: { value: null, confidence: 0 },
    barcode: emptyField,
    readability: 0.95,
  };
  return {
    level: "match",
    headline: "Amlodipine 5 mg: match",
    speech: "Amlodipine 5 mg, your evening pill.",
    read,
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
  };
}

const sampleDevice: DeviceState = {
  connected: true,
  worn: true,
  battery: 82,
  streaming: true,
  source: "glasses",
};

beforeEach(() => {
  resetHubsForTest();
});

test("explicit ?session= HUD connect and disconnect emits hud connected true then false to phone clients", () => {
  const hub = getOrCreateHub("sess-explicit");
  const phone = createMockWs();
  hub.clients.add(phone.ws);
  assert.equal(hasHud(hub), false);

  const hud1 = createMockWs();
  addHud(hud1.ws, "sess-explicit");
  assert.equal(hasHud(hub), true);
  assert.deepEqual(phone.sent, [{ type: "hud", connected: true }]);
  assert.deepEqual(hud1.sent, []);

  const hud2 = createMockWs();
  addHud(hud2.ws, "sess-explicit");
  assert.equal(hasHud(hub), true);
  assert.deepEqual(phone.sent.at(-1), { type: "hud", connected: true });

  hud1.close();
  assert.equal(hasHud(hub), true);
  assert.deepEqual(phone.sent.at(-1), { type: "hud", connected: true });

  hud2.close();
  assert.equal(hasHud(hub), false);
  assert.deepEqual(phone.sent.at(-1), { type: "hud", connected: false });
});

test("floating session-less HUD receives orphan device before markLatest, then replays state and notifies phone on markLatest", () => {
  setDevice(sampleDevice);
  const hud = createMockWs();
  addHud(hud.ws);
  assert.deepEqual(hud.sent, [{ type: "device", device: sampleDevice }]);

  const updatedDevice: DeviceState = { ...sampleDevice, battery: 75 };
  setDevice(updatedDevice);
  assert.deepEqual(hud.sent.at(-1), { type: "device", device: updatedDevice });

  hud.sent.length = 0;

  const hub = getOrCreateHub("sess-live");
  const phone = createMockWs();
  hub.clients.add(phone.ws);

  const statusMsg: ServerMsg = { type: "status", live: "open" };
  const coachMsg: ServerMsg = { type: "coach", cue: "hold_still", text: "Hold it steady" };
  const verdict = sampleVerdict();
  const verdictMsg: ServerMsg = { type: "verdict", verdict };
  hub.emit(statusMsg);
  hub.emit(coachMsg);
  hub.emit(verdictMsg);
  assert.deepEqual(hud.sent, []);

  phone.sent.length = 0;
  markLatest(hub);

  assert.equal(latestHub(), hub);
  assert.equal(hudTarget(), hub);
  assert.equal(hasHud(hub), true);
  assert.deepEqual(hud.sent, [
    statusMsg,
    { type: "device", device: updatedDevice },
    coachMsg,
    verdictMsg,
  ]);
  assert.deepEqual(phone.sent, [{ type: "hud", connected: true }]);

  hud.close();
  assert.equal(hasHud(hub), false);
  assert.deepEqual(phone.sent.at(-1), { type: "hud", connected: false });
});

test("switching markLatest from session A to session B updates HUD connection flags on both A and B", () => {
  const hubA = getOrCreateHub("session-a");
  const phoneA = createMockWs();
  hubA.clients.add(phoneA.ws);

  const hubB = getOrCreateHub("session-b");
  const phoneB = createMockWs();
  hubB.clients.add(phoneB.ws);

  markLatest(hubA);
  assert.deepEqual(phoneA.sent, [{ type: "hud", connected: false }]);

  const floating = createMockWs();
  addHud(floating.ws);
  assert.equal(hasHud(hubA), true);
  assert.equal(hasHud(hubB), false);
  assert.deepEqual(phoneA.sent.at(-1), { type: "hud", connected: true });

  const statusB: ServerMsg = { type: "status", live: "open", detail: "ready" };
  hubB.emit(statusB);
  phoneA.sent.length = 0;
  phoneB.sent.length = 0;
  floating.sent.length = 0;

  markLatest(hubB);
  assert.equal(hasHud(hubA), false);
  assert.equal(hasHud(hubB), true);
  assert.deepEqual(phoneA.sent, [{ type: "hud", connected: false }]);
  assert.deepEqual(phoneB.sent, [{ type: "hud", connected: true }]);
  assert.deepEqual(floating.sent, [statusB]);

  floating.sent.length = 0;
  hubA.emit({ type: "coach", cue: "closer", text: "Closer" });
  assert.deepEqual(floating.sent, []);
  const coachB: ServerMsg = { type: "coach", cue: "ok", text: "Readable" };
  hubB.emit(coachB);
  assert.deepEqual(floating.sent, [coachB]);

  const explicitB = createMockWs();
  addHud(explicitB.ws, "session-b");
  phoneA.sent.length = 0;
  phoneB.sent.length = 0;

  markLatest(hubA);
  assert.equal(hasHud(hubA), true);
  assert.equal(hasHud(hubB), true);
  assert.deepEqual(phoneA.sent, [{ type: "hud", connected: true }]);
  assert.deepEqual(phoneB.sent, [{ type: "hud", connected: true }]);
});

test("late-joining HUD receives replayed lastStatus, device, lastCoach, and lastVerdict", () => {
  const hub = getOrCreateHub("sess-late");
  markLatest(hub);

  const statusMsg: ServerMsg = { type: "status", live: "open" };
  const deviceMsg: ServerMsg = { type: "device", device: sampleDevice };
  const coachMsg: ServerMsg = { type: "coach", cue: "rotate_left", text: "Turn it left" };
  const verdictMsg: ServerMsg = { type: "verdict", verdict: sampleVerdict() };

  hub.emit(statusMsg);
  hub.emit(deviceMsg);
  hub.emit({ type: "transcript", role: "assistant", text: "Checking label", final: true });
  hub.emit(coachMsg);
  hub.emit(verdictMsg);

  const explicitHud = createMockWs();
  addHud(explicitHud.ws, "sess-late");
  assert.deepEqual(explicitHud.sent, [statusMsg, deviceMsg, coachMsg, verdictMsg]);

  const floatingHud = createMockWs();
  addHud(floatingHud.ws);
  assert.deepEqual(floatingHud.sent, [statusMsg, deviceMsg, coachMsg, verdictMsg]);

  const latePhone = createMockWs();
  hub.replayClient(latePhone.ws);
  assert.deepEqual(latePhone.sent, [deviceMsg, { type: "hud", connected: true }]);
});

test("resetHubsForTest isolates state and safeSend ignores closed sockets", () => {
  const hub = getOrCreateHub("sess-reset");
  const floating = createMockWs();
  addHud(floating.ws);
  markLatest(hub);
  assert.equal(hubStats().sessions, 1);
  assert.equal(hubStats().floatingHuds, 1);

  resetHubsForTest();
  assert.deepEqual(hubStats(), { sessions: 0, latest: null, floatingHuds: 0 });
  assert.equal(latestHub(), undefined);

  const closed = createMockWs(3);
  safeSend(closed.ws, JSON.stringify({ type: "pong", t: 1 }));
  assert.deepEqual(closed.sent, []);
});
