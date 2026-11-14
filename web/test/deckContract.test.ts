type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  existsSync(path: URL | string): boolean;
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

type VmModule = {
  runInNewContext(code: string, contextObject: Record<string, unknown>): unknown;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";
const nodeVmSpec: string = "node:vm";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { existsSync, readFileSync } = (await import(nodeFsSpec)) as FsModule;
const vm = (await import(nodeVmSpec)) as VmModule;

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const DOUBLE_SLASH = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const HTML_COMMENT_OPEN = "\x3c!--";
const HTML_COMMENT_CLOSE = "--\x3e";
const HTTP_SCHEME = "http:" + DOUBLE_SLASH;
const HTTPS_SCHEME = "https:" + DOUBLE_SLASH;
const WS_SCHEME = "ws:" + DOUBLE_SLASH;
const WSS_SCHEME = "wss:" + DOUBLE_SLASH;
const FILE_ORIGIN = "file:" + DOUBLE_SLASH + SLASH + "deck" + SLASH + "index.html";
const HTTPS_ORIGIN = "https:" + DOUBLE_SLASH + "holdup.local" + SLASH + "deck" + SLASH;
const HOLDUP_RX_URI = "holdup:" + DOUBLE_SLASH + "rx";
const EM_DASH = "\u2014";
const MDASH_ENTITY = "&" + "mdash;";
const DEC_MDASH = "&#" + "8212;";
const HEX_MDASH = "&#x" + "2014;";
const API_KEY_RE = new RegExp("AI" + "za[0-9A-Za-z_-]{20,}");

const deckHtmlUrl = new URL("../../deck/index.html", import.meta.url);
const deckCssUrl = new URL("../../deck/deck.css", import.meta.url);
const deckJsUrl = new URL("../../deck/deck.js", import.meta.url);
const combinedSummaryUrl = new URL("../../eval/combined_summary.json", import.meta.url);
const selfTestUrl = new URL("./deckContract.test.ts", import.meta.url);

type ListenerFn = (event?: Record<string, unknown>) => void;

class MockClassList {
  private readonly tokens = new Set<string>();

  constructor(initial = "") {
    for (const part of initial.trim().split(/\s+/)) {
      if (part) this.tokens.add(part);
    }
  }

  add(...names: string[]): void {
    for (const name of names) {
      if (name) this.tokens.add(name);
    }
  }

  remove(...names: string[]): void {
    for (const name of names) {
      this.tokens.delete(name);
    }
  }

  contains(name: string): boolean {
    return this.tokens.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.tokens.has(name)) {
        this.tokens.delete(name);
        return false;
      }
      this.tokens.add(name);
      return true;
    }
    if (force) {
      this.tokens.add(name);
      return true;
    }
    this.tokens.delete(name);
    return false;
  }

  toString(): string {
    return [...this.tokens].join(" ");
  }
}

class MockStyle {
  transform = "";
  readonly props: Record<string, string> = {};

  setProperty(key: string, value: string): void {
    this.props[key] = value;
  }
}

class MockElement {
  tagName: string;
  id = "";
  type = "";
  title = "";
  textContent = "";
  isContentEditable = false;
  clientWidth = 320;
  parentNode: MockElement | null = null;
  children: MockElement[] = [];
  classList: MockClassList;
  focused = false;
  requestFullscreen?: () => Promise<void>;
  readonly style = new MockStyle();
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, ListenerFn[]>();

  constructor(tagName: string, className = "") {
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList(className);
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList = new MockClassList(value);
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(value: string) {
    this.children = [];
    this.textContent = value;
  }

  setAttribute(name: string, value: string): void {
    const str = String(value);
    if (name === "id") {
      this.id = str;
    } else if (name === "class") {
      this.className = str;
      return;
    }
    this.attrs.set(name, str);
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }

  hasAttribute(name: string): boolean {
    if (name === "id") return this.id.length > 0;
    if (name === "class") return this.className.length > 0;
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    if (name === "id") {
      this.id = "";
    }
    this.attrs.delete(name);
  }

  appendChild(child: MockElement): MockElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement): MockElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  cloneNode(deep = false): MockElement {
    const copy = new MockElement(this.tagName, this.className);
    copy.id = this.id;
    copy.type = this.type;
    copy.title = this.title;
    copy.textContent = this.textContent;
    copy.clientWidth = this.clientWidth;
    for (const [k, v] of this.attrs.entries()) {
      copy.setAttribute(k, v);
    }
    if (deep) {
      for (const child of this.children) {
        copy.appendChild(child.cloneNode(true));
      }
    }
    return copy;
  }

  addEventListener(event: string, fn: ListenerFn): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  dispatch(event: string, payload: Record<string, unknown> = {}): void {
    const list = this.listeners.get(event) ?? [];
    for (const fn of list) {
      fn(payload);
    }
  }

  click(): void {
    this.dispatch("click", { target: this });
  }

  focus(): void {
    this.focused = true;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 1440, height: 820 };
  }

  private matchesSimpleSelector(selector: string): boolean {
    const trimmed = selector.trim();
    if (!trimmed) return false;
    if (trimmed === "[id]") return this.id.length > 0;
    const evalMatch = /^\[data-eval-field="([^"]+)"\]$/.exec(trimmed);
    if (evalMatch) {
      return this.getAttribute("data-eval-field") === evalMatch[1];
    }
    if (trimmed.startsWith(".")) {
      return this.classList.contains(trimmed.slice(1));
    }
    if (trimmed.startsWith("#")) {
      return this.id === trimmed.slice(1);
    }
    return this.tagName === trimmed.toUpperCase();
  }

  querySelectorAll(selectorGroup: string): MockElement[] {
    const selectors = selectorGroup.split(",").map((s) => s.trim()).filter(Boolean);
    const matches: MockElement[] = [];
    const visit = (node: MockElement) => {
      for (const child of node.children) {
        if (selectors.some((sel) => child.matchesSimpleSelector(sel))) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selectorGroup: string): MockElement | null {
    return this.querySelectorAll(selectorGroup)[0] ?? null;
  }
}

type ParsedSlideMeta = {
  slideNumber: number;
  title: string;
  isActive: boolean;
  ariaHidden: string | null;
  eyebrowNum: string;
  noteTiming: string;
  noteCue: string;
  noteBody: string;
  evalFields: Array<{ field: string; initialText: string }>;
};

function parseSlidesFromHtml(html: string): ParsedSlideMeta[] {
  const slideRegex = /<section\b([^>]*\bclass="[^"]*\bslide\b[^"]*"[^>]*)>([\s\S]*?)<\/section>/gi;
  const parsed: ParsedSlideMeta[] = [];
  let match: RegExpExecArray | null;
  while ((match = slideRegex.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const numMatch = /\bdata-slide="(\d+)"/i.exec(attrs);
    const titleMatch = /\bdata-title="([^"]+)"/i.exec(attrs);
    const classMatch = /\bclass="([^"]+)"/i.exec(attrs);
    const ariaHiddenMatch = /\baria-hidden="([^"]+)"/i.exec(attrs);
    const eyebrowMatch = /<span\s+class="eyebrow-num">([^<]+)<\/span>/i.exec(body);
    const noteMatch = /<aside\s+class="presenter-note"\s+data-timing="([^"]+)"\s+data-cue="([^"]+)">([\s\S]*?)<\/aside>/i.exec(
      body
    );

    const evalFields: Array<{ field: string; initialText: string }> = [];
    const evalRe = /data-eval-field="([^"]+)"[^>]*>([^<]*)</gi;
    let evalMatch: RegExpExecArray | null;
    while ((evalMatch = evalRe.exec(body)) !== null) {
      evalFields.push({
        field: evalMatch[1],
        initialText: evalMatch[2].trim()
      });
    }

    const classTokens = (classMatch?.[1] ?? "").trim().split(/\s+/);
    parsed.push({
      slideNumber: Number(numMatch?.[1] ?? 0),
      title: titleMatch?.[1] ?? "",
      isActive: classTokens.includes("is-active"),
      ariaHidden: ariaHiddenMatch?.[1] ?? null,
      eyebrowNum: (eyebrowMatch?.[1] ?? "").trim(),
      noteTiming: noteMatch?.[1] ?? "",
      noteCue: noteMatch?.[2] ?? "",
      noteBody: (noteMatch?.[3] ?? "").trim(),
      evalFields
    });
  }
  return parsed;
}

type DeckHarnessOptions = {
  protocol?: string;
  hash?: string;
  fetchImpl?: (url: string, init?: Record<string, unknown>) => unknown;
  initialEvalData?: Record<string, unknown>;
};

type HoldUpDeckApi = {
  goToSlide(idx: number, skipHash?: boolean): void;
  next(): void;
  prev(): void;
  setNotesOpen(open: boolean): void;
  setOverviewOpen(open: boolean): void;
  getCurrentIndex(): number;
  getTotalSlides(): number;
  ready?: Promise<Record<string, unknown>>;
};

function createDeckHarness(slidesMeta: ParsedSlideMeta[], options: DeckHarnessOptions = {}) {
  const deckJsSource = readFileSync(deckJsUrl, "utf8");
  const rootEl = new MockElement("html");
  const bodyEl = new MockElement("body");
  rootEl.appendChild(bodyEl);

  const byId = new Map<string, MockElement>();
  const registerId = (el: MockElement, id: string): MockElement => {
    el.setAttribute("id", id);
    byId.set(id, el);
    return el;
  };

  const liveRegion = registerId(new MockElement("div", "sr-only"), "deck-live-region");
  const stageShell = registerId(new MockElement("main", "stage-shell"), "stage-shell");
  const deckStage = new MockElement("div", "deck-stage");
  stageShell.appendChild(deckStage);
  bodyEl.appendChild(liveRegion);
  bodyEl.appendChild(stageShell);

  const slideElements: MockElement[] = [];
  for (const meta of slidesMeta) {
    const slideEl = new MockElement("section", meta.isActive ? "slide is-active" : "slide");
    slideEl.setAttribute("data-slide", String(meta.slideNumber));
    slideEl.setAttribute("data-title", meta.title);
    if (meta.ariaHidden !== null) {
      slideEl.setAttribute("aria-hidden", meta.ariaHidden);
    }

    const canvasEl = new MockElement("div", "slide-canvas");
    const sampleIdChild = new MockElement("svg", "svg-responsive");
    sampleIdChild.setAttribute("id", `svg-slide-${meta.slideNumber}`);
    canvasEl.appendChild(sampleIdChild);

    for (const ef of meta.evalFields) {
      const span = new MockElement("span");
      span.setAttribute("data-eval-field", ef.field);
      span.textContent = ef.initialText;
      canvasEl.appendChild(span);
    }

    const noteEl = new MockElement("aside", "presenter-note");
    noteEl.setAttribute("data-timing", meta.noteTiming);
    noteEl.setAttribute("data-cue", meta.noteCue);
    noteEl.textContent = meta.noteBody;

    slideEl.appendChild(canvasEl);
    slideEl.appendChild(noteEl);
    deckStage.appendChild(slideEl);
    slideElements.push(slideEl);
  }

  const notesDrawer = registerId(new MockElement("section", "notes-drawer"), "notes-drawer");
  notesDrawer.setAttribute("data-open", "false");
  const notesHeader = registerId(new MockElement("div", "notes-header-row"), "notes-header");
  const notesBody = registerId(new MockElement("p", "notes-body-text"), "notes-body");
  const timerReadout = registerId(new MockElement("span", "timer-readout"), "timer-readout");
  timerReadout.textContent = "00:00";
  const btnTimerToggle = registerId(new MockElement("button", "chrome-btn"), "btn-timer-toggle");
  btnTimerToggle.textContent = "Start";
  const btnTimerReset = registerId(new MockElement("button", "chrome-btn"), "btn-timer-reset");
  btnTimerReset.textContent = "Reset";
  notesDrawer.appendChild(notesHeader);
  notesDrawer.appendChild(notesBody);
  notesDrawer.appendChild(timerReadout);
  notesDrawer.appendChild(btnTimerToggle);
  notesDrawer.appendChild(btnTimerReset);
  bodyEl.appendChild(notesDrawer);

  const counterEl = registerId(new MockElement("span", "slide-counter"), "slide-counter");
  const progressRail = registerId(new MockElement("nav", "progress-rail"), "progress-rail");
  const btnPrev = registerId(new MockElement("button", "chrome-btn"), "btn-prev");
  const btnNext = registerId(new MockElement("button", "chrome-btn"), "btn-next");
  const btnGrid = registerId(new MockElement("button", "chrome-btn"), "btn-grid");
  btnGrid.setAttribute("aria-pressed", "false");
  const btnNotes = registerId(new MockElement("button", "chrome-btn"), "btn-notes");
  btnNotes.setAttribute("aria-pressed", "false");
  const btnFullscreen = registerId(new MockElement("button", "chrome-btn"), "btn-fullscreen");
  btnFullscreen.setAttribute("aria-pressed", "false");
  const btnPrint = registerId(new MockElement("button", "chrome-btn"), "btn-print");
  bodyEl.appendChild(counterEl);
  bodyEl.appendChild(progressRail);
  bodyEl.appendChild(btnPrev);
  bodyEl.appendChild(btnNext);
  bodyEl.appendChild(btnGrid);
  bodyEl.appendChild(btnNotes);
  bodyEl.appendChild(btnFullscreen);
  bodyEl.appendChild(btnPrint);

  const overviewModal = registerId(new MockElement("div", "overview-modal"), "overview-modal");
  overviewModal.setAttribute("data-open", "false");
  const btnCloseOverview = registerId(new MockElement("button", "chrome-btn"), "btn-close-overview");
  const overviewGrid = registerId(new MockElement("div", "overview-grid"), "overview-grid");
  overviewModal.appendChild(btnCloseOverview);
  overviewModal.appendChild(overviewGrid);
  bodyEl.appendChild(overviewModal);

  const docListeners = new Map<string, ListenerFn[]>();
  const winListeners = new Map<string, ListenerFn[]>();
  const intervals = new Map<number, () => void>();
  let nextTimerId = 1;
  let printCount = 0;
  let fullscreenElement: MockElement | null = null;
  const locationState = {
    protocol: options.protocol ?? "file:",
    href: options.protocol === "https:" ? HTTPS_ORIGIN : FILE_ORIGIN,
    hash: options.hash ?? ""
  };
  const replacedHashes: string[] = [];

  rootEl.requestFullscreen = () => {
    fullscreenElement = rootEl;
    return Promise.resolve();
  };

  const documentObj: Record<string, unknown> = {
    readyState: "complete",
    documentElement: rootEl,
    get fullscreenElement() {
      return fullscreenElement;
    },
    exitFullscreen() {
      fullscreenElement = null;
      return Promise.resolve();
    },
    getElementById(id: string) {
      return byId.get(id) ?? null;
    },
    querySelectorAll(selector: string) {
      return rootEl.querySelectorAll(selector);
    },
    createElement(tag: string) {
      return new MockElement(tag);
    },
    addEventListener(event: string, fn: ListenerFn) {
      const list = docListeners.get(event) ?? [];
      list.push(fn);
      docListeners.set(event, list);
    }
  };

  const windowObj: Record<string, unknown> = {
    location: locationState,
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        locationState.hash = url;
        replacedHashes.push(url);
      }
    },
    HOLDUP_EVAL_DATA: options.initialEvalData,
    fetch: options.fetchImpl,
    print() {
      printCount += 1;
    },
    requestAnimationFrame(cb: () => void) {
      cb();
      return 1;
    },
    setInterval(cb: () => void) {
      const id = nextTimerId++;
      intervals.set(id, cb);
      return id;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
    addEventListener(event: string, fn: ListenerFn) {
      const list = winListeners.get(event) ?? [];
      list.push(fn);
      winListeners.set(event, list);
    }
  };

  const vmContext: Record<string, unknown> = {
    window: windowObj,
    document: documentObj,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Promise,
    parseInt,
    isFinite
  };

  vm.runInNewContext(deckJsSource, vmContext);

  return {
    rootEl,
    byId,
    slideElements,
    locationState,
    replacedHashes,
    getPrintCount: () => printCount,
    tickIntervals(steps = 1) {
      for (let s = 0; s < steps; s++) {
        for (const cb of [...intervals.values()]) {
          cb();
        }
      }
    },
    getActiveIntervalCount: () => intervals.size,
    dispatchDoc(event: string, payload: Record<string, unknown> = {}) {
      for (const fn of docListeners.get(event) ?? []) {
        fn(payload);
      }
    },
    dispatchWin(event: string, payload: Record<string, unknown> = {}) {
      for (const fn of winListeners.get(event) ?? []) {
        fn(payload);
      }
    },
    sendKey(key: string, extra: Record<string, unknown> = {}): boolean {
      let prevented = false;
      const ev: Record<string, unknown> = {
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: bodyEl,
        preventDefault() {
          prevented = true;
        },
        ...extra
      };
      for (const fn of docListeners.get("keydown") ?? []) {
        fn(ev);
      }
      return prevented;
    },
    getApi(): HoldUpDeckApi {
      return windowObj.HoldUpDeck as HoldUpDeckApi;
    },
    getEvalData(): Record<string, unknown> {
      return windowObj.HOLDUP_EVAL_DATA as Record<string, unknown>;
    },
    updateEvalData(patch: Record<string, unknown>): Record<string, unknown> {
      const fn = windowObj.updateHoldUpEvalData as (p: Record<string, unknown>) => Record<string, unknown>;
      return fn(patch);
    },
    readEvalFieldValues(field: string): string[] {
      return rootEl.querySelectorAll(`[data-eval-field="${field}"]`).map((el) => el.textContent);
    }
  };
}

test("deck/index.html, deck/deck.css, and deck/deck.js exist with all 12 slides, inline SVG diagrams, presenter notes, and 21-suite + 475-test proof", () => {
  assert.equal(existsSync(deckHtmlUrl), true, "deck/index.html must exist");
  assert.equal(existsSync(deckCssUrl), true, "deck/deck.css must exist");
  assert.equal(existsSync(deckJsUrl), true, "deck/deck.js must exist");

  const html = readFileSync(deckHtmlUrl, "utf8");
  assert.match(html, /^<!DOCTYPE html>\s*<html\s+lang="en">/i);
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/deck\.css"\s*\/?>/i);
  assert.match(html, /<script\s+src="\.\/deck\.js"><\/script>/i);

  const svgTags = [...html.matchAll(/<svg\b([^>]*)>/gi)].map((m) => m[1]);
  assert.equal(svgTags.length, 7, "deck/index.html must contain 7 inline SVG graphics");
  const diagramSvgs = svgTags.filter((attrs) => /\brole="img"/i.test(attrs));
  assert.equal(diagramSvgs.length, 6, "deck/index.html must contain 6 accessible role=img SVG diagrams");
  for (const diagramAttrs of diagramSvgs) {
    assert.match(diagramAttrs, /\bviewBox="[^"]+"/i);
    assert.match(diagramAttrs, /\baria-label="[^"]{20,}"/i);
  }

  for (const expectedMetricSnippet of [
    "475 / 475",
    "176 server + 285 web + 14 eval",
    "21 suites",
    "100% (60 / 60)",
    "100% (29 / 29)",
    "100% (89 / 89)",
    "2738.8 ms",
    "1.17 ms",
    "1.78 ms",
    "EN/FI/SV WAV TTS"
  ]) {
    assert.equal(
      html.includes(expectedMetricSnippet),
      true,
      `deck/index.html missing expected 21-suite / 475-test snippet: ${expectedMetricSnippet}`
    );
  }

  const slides = parseSlidesFromHtml(html);
  assert.equal(slides.length, 12, "deck/index.html must contain exactly 12 slides");

  const expectedTitles = [
    "HoldUp: Hold it up. Know it is the right one.",
    "The Everyday Moment: 8 PM, Three Identical Pill Boxes",
    "Why First-Person Meta AI Glasses Change Everything",
    "How HoldUp Works: 5-Step Safety Loop",
    "Zero Silent Guessing (STRENGTH_MIN_CONF = 0.80)",
    "One Backend, Three Thin Clients",
    "Best Use of Google Gemini API",
    "Engineered for Real-World Failure: 6-Tier Resilience",
    "Consent, Privacy & Accessibility for All Abilities",
    "Measured Calibration & Safety Proof",
    "Plausible Pilot & Unit Economics",
    "HoldUp: Independence in Sight, Hands Free"
  ];

  slides.forEach((slide, idx) => {
    const expectedNum = idx + 1;
    const padded = expectedNum < 10 ? `0${expectedNum}` : String(expectedNum);
    assert.equal(slide.slideNumber, expectedNum, `Slide index ${idx} must have data-slide="${expectedNum}"`);
    assert.equal(slide.title, expectedTitles[idx]);
    assert.equal(slide.eyebrowNum, `${padded} / 12`);
    assert.equal(slide.isActive, idx === 0, "Only Slide 1 should be initially active");
    assert.equal(slide.ariaHidden, idx === 0 ? null : "true");
    assert.ok(slide.noteTiming.length > 0, `Slide ${expectedNum} must include presenter timing`);
    assert.ok(slide.noteCue.length > 0, `Slide ${expectedNum} must include presenter cue`);
    assert.ok(slide.noteBody.length >= 40, `Slide ${expectedNum} must include presenter notes`);
  });

  for (const requiredId of [
    "deck-live-region",
    "stage-shell",
    "notes-drawer",
    "notes-header",
    "notes-body",
    "timer-readout",
    "btn-timer-toggle",
    "btn-timer-reset",
    "btn-prev",
    "slide-counter",
    "btn-next",
    "progress-rail",
    "btn-grid",
    "btn-notes",
    "btn-fullscreen",
    "btn-print",
    "overview-modal",
    "btn-close-overview",
    "overview-grid"
  ]) {
    assert.match(html, new RegExp(`\\bid="${requiredId}"`), `deck/index.html missing #${requiredId}`);
  }
});

test("deck/index.html, deck/deck.css, deck/deck.js, and deckContract.test.ts contain zero external URLs, zero comments, and zero em dashes", () => {
  const html = readFileSync(deckHtmlUrl, "utf8");
  const css = readFileSync(deckCssUrl, "utf8");
  const js = readFileSync(deckJsUrl, "utf8");
  const selfSource = readFileSync(selfTestUrl, "utf8");

  for (const [label, content] of [
    ["deck/index.html", html],
    ["deck/deck.css", css],
    ["deck/deck.js", js],
    ["web/test/deckContract.test.ts", selfSource]
  ] as const) {
    assert.equal(content.toLowerCase().includes(HTTP_SCHEME), false, `${label} must contain zero http URLs`);
    assert.equal(content.toLowerCase().includes(HTTPS_SCHEME), false, `${label} must contain zero https URLs`);
    assert.equal(content.toLowerCase().includes(WS_SCHEME), false, `${label} must contain zero ws URLs`);
    assert.equal(content.toLowerCase().includes(WSS_SCHEME), false, `${label} must contain zero wss URLs`);
    assert.equal(content.includes(HTML_COMMENT_OPEN), false, `${label} must contain zero HTML comment openings`);
    assert.equal(content.includes(HTML_COMMENT_CLOSE), false, `${label} must contain zero HTML comment closings`);
    assert.equal(content.includes(BLOCK_COMMENT_OPEN), false, `${label} must contain zero block comment openings`);
    assert.equal(content.includes(BLOCK_COMMENT_CLOSE), false, `${label} must contain zero block comment closings`);
    assert.equal(content.includes(EM_DASH), false, `${label} must contain zero em dashes`);
    assert.equal(content.toLowerCase().includes(MDASH_ENTITY), false, `${label} must contain zero mdash entities`);
    assert.equal(content.toLowerCase().includes(DEC_MDASH), false, `${label} must contain zero decimal mdash entities`);
    assert.equal(content.toLowerCase().includes(HEX_MDASH), false, `${label} must contain zero hex mdash entities`);
    assert.equal(API_KEY_RE.test(content), false, `${label} must contain zero leaked API keys`);
  }

  assert.equal(css.includes(DOUBLE_SLASH), false, "deck/deck.css must contain zero double-slash tokens");
  assert.equal(js.includes(DOUBLE_SLASH), false, "deck/deck.js must contain zero double-slash line comments");
  assert.equal(
    selfSource.includes(DOUBLE_SLASH),
    false,
    "web/test/deckContract.test.ts must contain zero double-slash line comments"
  );

  const htmlWithoutRxScheme = html.split(HOLDUP_RX_URI).join("holdup-rx");
  assert.equal(
    htmlWithoutRxScheme.includes(DOUBLE_SLASH),
    false,
    "deck/index.html must contain zero double-slash tokens outside holdup custom QR URI"
  );

  const linkHrefs = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  assert.deepEqual(linkHrefs, ["./deck.css"]);

  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  assert.deepEqual(scriptSrcs, ["./deck.js"]);
  assert.equal(/<img\b/i.test(html), false, "deck/index.html must contain zero img tags and use inline SVG");
  assert.equal(/<image\b/i.test(html), false, "deck/index.html must contain zero SVG image tags");
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, "deck/index.html must not embed inline scripts");
  assert.equal(/<style\b/i.test(html), false, "deck/index.html must not embed inline style blocks");
  assert.doesNotMatch(css, /@import\b/i, "deck/deck.css must not use @import");
  assert.doesNotMatch(css, /url\s*\(/i, "deck/deck.css must not load external url() assets");
});

test("deck/deck.css enforces 16:9 1600x900 stage canvas, pure #000000 waveguide tokens, reduced-motion, and @media print rules", () => {
  const css = readFileSync(deckCssUrl, "utf8");

  assert.match(css, /@page\s*\{\s*size:\s*16in\s+9in;\s*margin:\s*0;\s*\}/i);
  assert.match(css, /--stage-w:\s*1600px;/);
  assert.match(css, /--stage-h:\s*900px;/);
  assert.match(css, /--bg-waveguide:\s*#000000;/i);
  assert.match(css, /print-color-adjust:\s*exact;/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /@media\s+print\s*\{/i);

  const printBlockIdx = css.indexOf("@media print");
  assert.ok(printBlockIdx > 0, "Expected @media print block in deck/deck.css");
  const printBlock = css.slice(printBlockIdx);

  assert.match(printBlock, /\.deck-chrome[\s\S]*?display:\s*none\s*!important;/i);
  assert.match(printBlock, /\.notes-drawer[\s\S]*?display:\s*none\s*!important;/i);
  assert.match(printBlock, /\.overview-modal[\s\S]*?display:\s*none\s*!important;/i);
  assert.match(printBlock, /\.slide\s*\{[\s\S]*?width:\s*16in\s*!important;[\s\S]*?height:\s*9in\s*!important;/i);
  assert.match(printBlock, /break-after:\s*page;/i);
  assert.match(printBlock, /\.slide:last-of-type\s*\{[\s\S]*?break-after:\s*auto;/i);
  assert.match(printBlock, /\.slide-canvas\s*\{[\s\S]*?transform:\s*scale\(0\.96\)\s*!important;/i);
});

test("deck/deck.js supports keyboard, buttons, presenter notes + timer, 12-slide overview grid, touch swipe, fullscreen, hash routing, and print", async () => {
  const slidesMeta = parseSlidesFromHtml(readFileSync(deckHtmlUrl, "utf8"));
  const harness = createDeckHarness(slidesMeta, { protocol: "file:", hash: "#slide-3" });
  const api = harness.getApi();

  assert.equal(api.getTotalSlides(), 12);
  assert.equal(api.getCurrentIndex(), 2, "Initial #slide-3 hash should activate slide index 2");
  assert.equal(harness.byId.get("slide-counter")?.textContent, "03 / 12");
  assert.match(harness.byId.get("deck-live-region")?.textContent ?? "", /^Slide 3 of 12:/);

  const progressRail = harness.byId.get("progress-rail");
  const overviewGrid = harness.byId.get("overview-grid");
  assert.equal(progressRail?.children.length, 12, "Progress rail must render 12 segment buttons");
  assert.equal(overviewGrid?.children.length, 12, "Overview grid must render 12 slide tiles");

  for (const tile of overviewGrid?.children ?? []) {
    assert.equal(tile.querySelectorAll("[id]").length, 0, "Cloned overview thumbnails must strip duplicate IDs");
    assert.equal(
      tile.querySelectorAll(".presenter-note").length,
      0,
      "Cloned overview thumbnails must strip presenter notes"
    );
  }

  assert.equal(harness.sendKey("ArrowRight"), true);
  assert.equal(api.getCurrentIndex(), 3);
  assert.equal(harness.replacedHashes.at(-1), "#slide-4");

  assert.equal(harness.sendKey(" "), true);
  assert.equal(api.getCurrentIndex(), 4);

  const buttonTarget = new MockElement("button");
  assert.equal(harness.sendKey(" ", { target: buttonTarget }), false, "Space on focused button must not hijack click");
  assert.equal(api.getCurrentIndex(), 4);

  const inputTarget = new MockElement("input");
  assert.equal(harness.sendKey("ArrowRight", { target: inputTarget }), false, "Interactive inputs must ignore hotkeys");
  assert.equal(api.getCurrentIndex(), 4);

  assert.equal(harness.sendKey("ArrowLeft"), true);
  assert.equal(api.getCurrentIndex(), 3);

  assert.equal(harness.sendKey("End"), true);
  assert.equal(api.getCurrentIndex(), 11);
  assert.equal(harness.byId.get("slide-counter")?.textContent, "12 / 12");
  assert.equal(harness.sendKey("PageDown"), true);
  assert.equal(api.getCurrentIndex(), 11, "Next at Slide 12 must clamp cleanly");

  assert.equal(harness.sendKey("Home"), true);
  assert.equal(api.getCurrentIndex(), 0);
  assert.equal(harness.sendKey("PageUp"), true);
  assert.equal(api.getCurrentIndex(), 0, "Prev at Slide 1 must clamp cleanly");

  harness.byId.get("btn-next")?.click();
  assert.equal(api.getCurrentIndex(), 1);
  harness.byId.get("btn-prev")?.click();
  assert.equal(api.getCurrentIndex(), 0);

  progressRail?.children[9]?.click();
  assert.equal(api.getCurrentIndex(), 9);
  assert.equal(progressRail?.children[9]?.getAttribute("aria-current"), "step");
  assert.equal(harness.slideElements[9]?.classList.contains("is-active"), true);
  assert.equal(harness.slideElements[9]?.hasAttribute("aria-hidden"), false);
  assert.equal(harness.slideElements[0]?.getAttribute("aria-hidden"), "true");

  assert.equal(harness.sendKey("n"), true);
  assert.equal(harness.byId.get("notes-drawer")?.getAttribute("data-open"), "true");
  assert.equal(harness.byId.get("btn-notes")?.getAttribute("aria-pressed"), "true");
  assert.match(harness.byId.get("notes-header")?.textContent ?? "", /SLIDE 10 \/ 12[\s\S]*BEAT[\s\S]*CUE:/);
  assert.ok((harness.byId.get("notes-body")?.textContent ?? "").includes("0.0138"));

  const timerToggle = harness.byId.get("btn-timer-toggle");
  const timerReset = harness.byId.get("btn-timer-reset");
  const timerReadout = harness.byId.get("timer-readout");
  timerToggle?.click();
  assert.equal(timerToggle?.textContent, "Pause");
  assert.equal(harness.getActiveIntervalCount(), 1);
  harness.tickIntervals(65);
  assert.equal(timerReadout?.textContent, "01:05");
  timerToggle?.click();
  assert.equal(timerToggle?.textContent, "Start");
  assert.equal(harness.getActiveIntervalCount(), 0);
  timerReset?.click();
  assert.equal(timerReadout?.textContent, "00:00");

  assert.equal(harness.sendKey("g"), true);
  assert.equal(harness.byId.get("overview-modal")?.getAttribute("data-open"), "true");
  assert.equal(harness.byId.get("btn-grid")?.getAttribute("aria-pressed"), "true");
  assert.equal(harness.sendKey("ArrowRight"), false, "Arrow keys must not advance background slide while overview open");
  assert.equal(api.getCurrentIndex(), 9);

  overviewGrid?.children[5]?.click();
  assert.equal(api.getCurrentIndex(), 5);
  assert.equal(harness.byId.get("overview-modal")?.getAttribute("data-open"), "false");

  harness.byId.get("btn-grid")?.click();
  assert.equal(harness.byId.get("overview-modal")?.getAttribute("data-open"), "true");
  assert.equal(harness.sendKey("Escape"), true);
  assert.equal(harness.byId.get("overview-modal")?.getAttribute("data-open"), "false");
  assert.equal(harness.byId.get("notes-drawer")?.getAttribute("data-open"), "true");
  assert.equal(harness.sendKey("Escape"), true);
  assert.equal(harness.byId.get("notes-drawer")?.getAttribute("data-open"), "false");

  const stageShell = harness.byId.get("stage-shell");
  stageShell?.dispatch("touchstart", { touches: [{ clientX: 500, clientY: 300 }] });
  stageShell?.dispatch("touchend", { changedTouches: [{ clientX: 390, clientY: 305 }] });
  assert.equal(api.getCurrentIndex(), 6, "Left swipe should advance one slide");
  stageShell?.dispatch("touchstart", { touches: [{ clientX: 390, clientY: 305 }] });
  stageShell?.dispatch("touchend", { changedTouches: [{ clientX: 510, clientY: 300 }] });
  assert.equal(api.getCurrentIndex(), 5, "Right swipe should go back one slide");

  assert.equal(harness.sendKey("f"), true);
  harness.dispatchDoc("fullscreenchange");
  assert.equal(harness.byId.get("btn-fullscreen")?.getAttribute("aria-pressed"), "true");
  harness.byId.get("btn-fullscreen")?.click();
  harness.dispatchDoc("fullscreenchange");
  assert.equal(harness.byId.get("btn-fullscreen")?.getAttribute("aria-pressed"), "false");

  harness.locationState.hash = "#slide-11";
  harness.dispatchWin("hashchange");
  assert.equal(api.getCurrentIndex(), 10);

  harness.byId.get("btn-print")?.click();
  assert.equal(harness.getPrintCount(), 1);
});

test("deck/deck.js syncs all 21 suites, Wave-6 metrics, and 475 tests, and hydrates /api/eval-summary while keeping static numbers on file: or offline", async () => {
  const slidesMeta = parseSlidesFromHtml(readFileSync(deckHtmlUrl, "utf8"));
  const realCombined = JSON.parse(readFileSync(combinedSummaryUrl, "utf8")) as Record<string, unknown>;

  let fileFetchCalls = 0;
  const fileHarness = createDeckHarness(slidesMeta, {
    protocol: "file:",
    fetchImpl: () => {
      fileFetchCalls += 1;
      return Promise.reject(new Error("file protocol must never call fetch"));
    }
  });
  await fileHarness.getApi().ready;
  assert.equal(fileFetchCalls, 0, "file: protocol must never invoke fetch");

  const defaultData = fileHarness.getEvalData();
  assert.equal(defaultData.confident_wrong_dose_count, 0);
  assert.equal(defaultData.false_safe_allergen_count, 0);
  assert.equal(defaultData.pii_leak_count, 0);
  assert.equal(defaultData.ece, 0.0138);
  assert.equal(defaultData.total_suites_compiled, 21);
  assert.equal((defaultData.suites_present as string[]).length, 9);
  assert.equal((defaultData.extended_suites_present as string[]).length, 6);
  assert.equal((defaultData.wave6_suites_present as string[]).length, 6);
  assert.equal(defaultData.extended_cases_evaluated, 60);
  assert.equal(defaultData.wave6_cases_evaluated, 29);
  assert.equal(defaultData.combined_stress_cases_evaluated, 89);
  assert.equal(defaultData.combined_stress_verdict_summary, "100% (89 / 89)");
  assert.equal(defaultData.e2e_verify_to_hud_p50_ms, 2738.8);
  assert.equal(defaultData.loopback_ingest_frame_p50_ms, 1.17);
  assert.equal(defaultData.loopback_hud_replay_p50_ms, 1.78);
  assert.equal(defaultData.tts_wav_summary, "6 / 6");
  assert.equal(defaultData.unit_tests_passing, "475 / 475");
  assert.equal(defaultData.server_tests_passing, 176);
  assert.equal(defaultData.web_tests_passing, 285);
  assert.equal(defaultData.eval_tests_passing, 14);

  assert.deepEqual(fileHarness.readEvalFieldValues("ece"), ["0.0138", "0.0138"]);
  assert.deepEqual(fileHarness.readEvalFieldValues("live_first_audio_ms"), ["582 ms", "582 ms"]);
  assert.deepEqual(fileHarness.readEvalFieldValues("extended_verdict_summary"), ["100% (60 / 60)", "100% (60 / 60)"]);
  assert.deepEqual(fileHarness.readEvalFieldValues("wave6_verdict_summary"), ["100% (29 / 29)", "100% (29 / 29)"]);
  assert.deepEqual(
    fileHarness.readEvalFieldValues("combined_stress_verdict_summary"),
    ["100% (89 / 89)", "100% (89 / 89)"]
  );
  assert.deepEqual(fileHarness.readEvalFieldValues("loopback_ingest_frame_p50_ms"), ["1.17 ms", "1.17 ms"]);
  assert.deepEqual(fileHarness.readEvalFieldValues("loopback_hud_replay_p50_ms"), ["1.78 ms", "1.78 ms"]);
  assert.deepEqual(fileHarness.readEvalFieldValues("tts_wav_summary"), ["6 / 6", "6 / 6"]);
  assert.deepEqual(fileHarness.readEvalFieldValues("total_suites_compiled"), ["21", "21", "21", "21"]);
  assert.deepEqual(
    fileHarness.readEvalFieldValues("e2e_verify_to_hud_p50_ms"),
    ["2738.8 ms", "2738.8 ms", "2738.8 ms", "2738.8 ms"]
  );
  assert.deepEqual(
    fileHarness.readEvalFieldValues("unit_tests_passing"),
    ["475 / 475", "475 / 475", "475 / 475", "475 / 475", "475 / 475", "475 / 475"]
  );
  assert.deepEqual(fileHarness.readEvalFieldValues("suite_sync_status"), [
    "HOLDUP_EVAL_DATA synced: 98.1% core (52/53) + 100% (89 / 89) stress/Wave-6 (21 suites)",
    "HOLDUP_EVAL_DATA synced: 98.1% core (52/53) + 100% (89 / 89) stress/Wave-6 (21 suites)"
  ]);

  const syncedReal = fileHarness.updateEvalData(realCombined);
  assert.equal(syncedReal.confident_wrong_dose_count, 0);
  assert.equal(syncedReal.false_safe_allergen_count, 0);
  assert.equal(syncedReal.pii_leak_count, 0);
  assert.equal(syncedReal.total_suites_compiled, 21);
  assert.equal(syncedReal.combined_stress_cases_evaluated, 89);
  assert.equal(syncedReal.e2e_verify_to_hud_p50_ms, 2738.8);
  assert.equal(syncedReal.loopback_ingest_frame_p50_ms, 1.17);
  assert.equal(syncedReal.loopback_hud_replay_p50_ms, 1.78);

  const requestedUrls: string[] = [];
  const liveSummary = {
    ...realCombined,
    total_verdict_matches: 53,
    total_label_cases_evaluated: 53,
    overall_verdict_accuracy: 1.0,
    calibration: {
      ...(realCombined.calibration as Record<string, unknown>),
      ece: 0.0112,
      brier_score: 0.0004,
      n_items: 20
    },
    wave6_summary: {
      ...(realCombined.wave6_summary as Record<string, unknown>),
      label_and_fusion_cases_evaluated: 30,
      label_and_fusion_verdict_matches: 30,
      label_and_fusion_verdict_accuracy: 1.0,
      e2e_verify_to_hud_p50_ms: 2610.4,
      loopback_ingest_frame_p50_ms: 1.05,
      loopback_hud_replay_p50_ms: 1.52
    },
    live_probe: {
      ...(realCombined.live_probe as Record<string, unknown>),
      primary_first_audio_ms: 540
    }
  };

  const httpsHarness = createDeckHarness(slidesMeta, {
    protocol: "https:",
    fetchImpl: (url: string) => {
      requestedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, summary: liveSummary })
      });
    }
  });
  await httpsHarness.getApi().ready;

  assert.deepEqual(requestedUrls, ["/api/eval-summary"]);
  assert.equal(httpsHarness.getEvalData().ece, 0.0112);
  assert.equal(httpsHarness.getEvalData().calibration_items, 20);
  assert.equal(httpsHarness.getEvalData().live_first_audio_ms, 540);
  assert.equal(httpsHarness.getEvalData().confident_wrong_dose_count, 0);
  assert.equal(httpsHarness.getEvalData().wave6_cases_evaluated, 30);
  assert.equal(httpsHarness.getEvalData().combined_stress_cases_evaluated, 90);
  assert.equal(httpsHarness.getEvalData().e2e_verify_to_hud_p50_ms, 2610.4);
  assert.equal(httpsHarness.getEvalData().loopback_ingest_frame_p50_ms, 1.05);
  assert.equal(httpsHarness.getEvalData().loopback_hud_replay_p50_ms, 1.52);
  assert.deepEqual(httpsHarness.readEvalFieldValues("ece"), ["0.0112", "0.0112"]);
  assert.deepEqual(httpsHarness.readEvalFieldValues("brier_score"), ["0.0004", "0.0004"]);
  assert.deepEqual(httpsHarness.readEvalFieldValues("calibration_items"), ["20", "20"]);
  assert.deepEqual(httpsHarness.readEvalFieldValues("live_first_audio_ms"), ["540 ms", "540 ms"]);
  assert.deepEqual(
    httpsHarness.readEvalFieldValues("overall_verdict_summary"),
    ["100.0% (53 / 53)", "100.0% (53 / 53)"]
  );
  assert.deepEqual(
    httpsHarness.readEvalFieldValues("combined_stress_verdict_summary"),
    ["100% (90 / 90)", "100% (90 / 90)"]
  );
  assert.deepEqual(
    httpsHarness.readEvalFieldValues("e2e_verify_to_hud_p50_ms"),
    ["2610.4 ms", "2610.4 ms", "2610.4 ms", "2610.4 ms"]
  );
  assert.deepEqual(httpsHarness.readEvalFieldValues("loopback_ingest_frame_p50_ms"), ["1.05 ms", "1.05 ms"]);
  assert.deepEqual(httpsHarness.readEvalFieldValues("loopback_hud_replay_p50_ms"), ["1.52 ms", "1.52 ms"]);

  let offlineFetchCalls = 0;
  const offlineHarness = createDeckHarness(slidesMeta, {
    protocol: "http:",
    fetchImpl: () => {
      offlineFetchCalls += 1;
      return Promise.reject(new Error("offline network failure"));
    }
  });
  await offlineHarness.getApi().ready;
  assert.equal(offlineFetchCalls, 1);
  assert.equal(offlineHarness.getEvalData().ece, 0.0138);
  assert.equal(offlineHarness.getEvalData().total_suites_compiled, 21);
  assert.deepEqual(offlineHarness.readEvalFieldValues("ece"), ["0.0138", "0.0138"]);
  assert.deepEqual(
    offlineHarness.readEvalFieldValues("overall_verdict_summary"),
    ["98.1% (52 / 53)", "98.1% (52 / 53)"]
  );

  const emptySummaryHarness = createDeckHarness(slidesMeta, {
    protocol: "http:",
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: false, summary: null })
      })
  });
  await emptySummaryHarness.getApi().ready;
  assert.equal(emptySummaryHarness.getEvalData().ece, 0.0138);
  assert.deepEqual(
    emptySummaryHarness.readEvalFieldValues("confident_wrong_dose_count"),
    ["0", "0", "0", "0"]
  );
});
