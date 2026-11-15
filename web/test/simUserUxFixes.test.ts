import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMsg, Verdict } from "../../shared/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, "../src");

const storage = new Map<string, string>();
const localStorageShim = {
  get length() {
    return storage.size;
  },
  key(i: number) {
    return Array.from(storage.keys())[i] ?? null;
  },
  getItem(k: string) {
    return storage.has(k) ? storage.get(k)! : null;
  },
  setItem(k: string, v: string) {
    storage.set(k, String(v));
  },
  removeItem(k: string) {
    storage.delete(k);
  },
  clear() {
    storage.clear();
  },
};

Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "location", {
  value: { search: "", pathname: "/", hash: "", protocol: "https:", host: "localhost:5173", origin: "https://localhost:5173" },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: { language: "en-US", onLine: true, userAgent: "Mozilla/5.0", vibrate: () => true },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "document", {
  value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "window", {
  value: { isSecureContext: true, addEventListener() {}, removeEventListener() {}, speechSynthesis: { cancel() {}, speak() {} } },
  configurable: true,
  writable: true,
});

const mockMod = await import("../src/lib/mock.ts");
const storageMod = await import("../src/lib/storage.ts");

describe("WS3 simulated-user UX fixes (web/)", () => {
  test("UX-1: MockSocket preempts an already-running auto-started scenario when the user types a question after 1.6 s", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const ws = new mockMod.MockSocket();
    const msgs: ServerMsg[] = [];
    ws.onmessage = (ev: MessageEvent) => msgs.push(JSON.parse(String(ev.data)) as ServerMsg);

    try {
      t.mock.timers.tick(250);
      ws.send(
        JSON.stringify({
          type: "start",
          profile: storageMod.demoProfile(),
          lang: "en",
          voice: true,
          source: "phone",
        }),
      );

      // Advance 3,000 ms so the 1,600 ms auto-started scenario (idx=0, Amlodipine match) is already in flight
      t.mock.timers.tick(3_000);
      msgs.length = 0;

      // User now submits a specific question about ibuprofen (or nuts / scene)
      ws.send(JSON.stringify({ type: "text", text: "Can I take this Burana ibuprofen 400 mg?" }));
      t.mock.timers.tick(500);
      t.mock.timers.tick(12_500);

      const verdicts = msgs.filter((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict");
      assert.equal(verdicts.length, 1, "Preempted auto-scenario must not emit a stale Amlodipine verdict");
      assert.equal(verdicts[0].verdict.level, "warning");
      assert.match(verdicts[0].verdict.speech, /Ibuprofen/i);
    } finally {
      ws.close();
      t.mock.timers.tick(10);
      t.mock.timers.reset();
    }
  });

  test("UX-1b: pickScenario recognizes English, Finnish, and Swedish user questions and mockFetch(/api/verify) honors body.question", async (t) => {
    assert.equal(mockMod.pickScenario("Onko tämä iltalääkkeeni?"), 0);
    assert.equal(mockMod.pickScenario("Är det här min kvällsmedicin?"), 0);
    assert.equal(mockMod.pickScenario("Voinko ottaa Burana särkylääkkeen?"), 1);
    assert.equal(mockMod.pickScenario("Kan jag ta smärtstillande ibuprofen?"), 1);
    assert.equal(mockMod.pickScenario("Mikä on tämän metformin vahvuus?"), 2);
    assert.equal(mockMod.pickScenario("Vilken styrka har metformin?"), 2);
    assert.equal(mockMod.pickScenario("Sisältääkö tämä pähkinää tai mantelia?"), 3);
    assert.equal(mockMod.pickScenario("Innehåller kakan nötter eller mandel?"), 3);
    assert.equal(mockMod.pickScenario("Mikä näistä kolmesta on minun?"), 4);
    assert.equal(mockMod.pickScenario("Vilken av de tre är min?"), 4);
    assert.equal(mockMod.pickScenario("Mikä näistä kolmesta on minun?", false), undefined);

    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      const pIbu = mockMod.mockFetch("/api/verify", {
        profile: storageMod.demoProfile(),
        question: "Voinko ottaa Burana?",
      });
      t.mock.timers.tick(1_000);
      const vIbu = (await pIbu) as Verdict;
      assert.equal(vIbu.level, "warning");
      assert.match(vIbu.speech, /Ibuprofen/i);

      const pNuts = mockMod.mockFetch("/api/verify", {
        profile: storageMod.demoProfile(),
        question: "Does this snack have nuts?",
      });
      t.mock.timers.tick(1_000);
      const vNuts = (await pNuts) as Verdict;
      assert.equal(vNuts.level, "warning");
      assert.match(vNuts.speech, /hazelnuts/i);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("UX-2, UX-3, UX-4, UX-5: Checker 10s pre-auto-stop polite warning & pendingDm queue, Live Escape verdict dismissal, and Profile duplicate-tag announcement", () => {
    const checkerSrc = fs.readFileSync(path.join(WEB_SRC, "lib", "checker.ts"), "utf8");
    assert.ok(checkerSrc.includes("const AUTO_STOP_WARN_MS = 35_000;"), "Expected 35s pre-auto-stop warning constant");
    assert.ok(
      checkerSrc.includes('announce("Still watching. Camera turns off in 10 seconds if no label is seen.", "polite");'),
      "Expected polite 10s pre-auto-stop warning announcement",
    );
    assert.ok(
      checkerSrc.includes("private pendingDm: string | null = null;") &&
        checkerSrc.includes('this.live.send({ type: "datamatrix", raw: this.pendingDm, ts: Date.now() });'),
      "Expected pendingDm queue so pack codes scanned while /live is connecting are sent on open",
    );

    const liveSrc = fs.readFileSync(path.join(WEB_SRC, "screens", "Live.tsx"), "utf8");
    assert.ok(
      liveSrc.includes('if (e.key === "Escape" && s.verdict && !s.addProposal && !isTypingTarget(e.target) && !e.repeat)'),
      "Expected Escape shortcut to dismiss active VerdictCard on Live screen",
    );
    assert.ok(liveSrc.includes("checker.dismissVerdict();"));

    const profileSrc = fs.readFileSync(path.join(WEB_SRC, "screens", "Profile.tsx"), "utf8");
    assert.ok(
      profileSrc.includes("announce(`${t} is already in ${title}.`);"),
      "Expected duplicate-tag screen-reader announcement in Profile TagList",
    );

    const audioSrc = fs.readFileSync(path.join(WEB_SRC, "lib", "audio.ts"), "utf8");
    assert.equal(
      audioSrc.includes("await this.ctx.resume()"),
      false,
      "MicCapture.start and PcmPlayer.unlock must not hang checker.start() when AudioContext stays suspended",
    );
  });

  test("docs/SIM_USER_TESTS.md is prominently labeled SIMULATED, covers all 40 personas (P01-P40) with 95% CIs, and has zero em dashes", () => {
    const docPath = path.resolve(HERE, "../../docs/SIM_USER_TESTS.md");
    const md = fs.readFileSync(docPath, "utf8");
    assert.ok(md.includes("CRITICAL HONESTY DISCLOSURE (`SIMULATED`, NOT REAL USERS)"));
    assert.ok(md.includes("40 / 40 = 100.00%"));
    assert.ok(md.includes("Wilson"));
    assert.equal(md.includes("\u2014"), false, "docs/SIM_USER_TESTS.md must contain zero em dashes");
    for (let i = 1; i <= 40; i++) {
      const pid = `P${String(i).padStart(2, "0")}`;
      assert.ok(md.includes(`| **${pid}** |`), `Missing persona row ${pid} in docs/SIM_USER_TESTS.md`);
      assert.ok(md.includes(`- **\`${pid}\` `), `Missing persona transcript ${pid} in docs/SIM_USER_TESTS.md`);
    }
  });
});
