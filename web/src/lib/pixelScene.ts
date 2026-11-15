export type ScenePhase = "idle" | "coaching" | "checking" | "match" | "warning" | "unsure";

export interface PixelSceneState {
  mode: "blindfold" | "spot";
  phase: ScenePhase;
  blindfoldOn: boolean;
  score: number;
  total: number;
  lang: "en" | "fi" | "sv";
  cueText?: string;
  pharmacistBubble?: string;
  reducedMotion?: boolean;
}

export interface PixelSceneController {
  update(patch: Partial<PixelSceneState>): void;
  renderNow(): void;
  destroy(): void;
}

const SPRITE_BASE = "/blindfold/sprites";

export const BLINDFOLD_SPRITE_URLS = {
  judgeIdle: `${SPRITE_BASE}/judge_s.png`,
  judgeWalk1: `${SPRITE_BASE}/judge_walk1_s.png`,
  judgeWalk2: `${SPRITE_BASE}/judge_walk2_s.png`,
  blindfoldWearer: `${SPRITE_BASE}/blindfold_band_wearer.png`,
  pharmacistIdle: `${SPRITE_BASE}/pharmacist_s.png`,
  pharmacistWalk1: `${SPRITE_BASE}/pharmacist_walk1_s.png`,
  pharmacistWalk2: `${SPRITE_BASE}/pharmacist_walk2_s.png`,
  pharmacistWest: `${SPRITE_BASE}/pharmacist_w.png`,
  caregiverIdle: `${SPRITE_BASE}/caregiver_s.png`,
  caregiverWalk1: `${SPRITE_BASE}/caregiver_walk1_s.png`,
  caregiverWalk2: `${SPRITE_BASE}/caregiver_walk2_s.png`,
  counterTopL: `${SPRITE_BASE}/pharmacy_counter_top_l.png`,
  counterTopM: `${SPRITE_BASE}/pharmacy_counter_top_m.png`,
  counterTopR: `${SPRITE_BASE}/pharmacy_counter_top_r.png`,
  counterFrontL: `${SPRITE_BASE}/pharmacy_counter_front_l.png`,
  counterFrontM: `${SPRITE_BASE}/pharmacy_counter_front_m.png`,
  counterFrontR: `${SPRITE_BASE}/pharmacy_counter_front_r.png`,
  shelfWood: `${SPRITE_BASE}/shelf_wood_unit.png`,
  shelfBoxes1: `${SPRITE_BASE}/shelf_stocked_boxes_1.png`,
  shelfBoxes2: `${SPRITE_BASE}/shelf_stocked_boxes_2.png`,
  doorPharmacy: `${SPRITE_BASE}/door_glass_pharmacy.png`,
  doorHome: `${SPRITE_BASE}/door_wood_home.png`,
  amberBottle: `${SPRITE_BASE}/dispenser_amber_bottle.png`,
  bottleBlue: `${SPRITE_BASE}/bottle_round_blue.png`,
  vialGreen: `${SPRITE_BASE}/vial_tall_green.png`,
  mysteryBox: `${SPRITE_BASE}/mystery_box_question.png`,
  packFront: `${SPRITE_BASE}/package_label_front.png`,
  packSide: `${SPRITE_BASE}/package_label_side.png`,
  foodBox: `${SPRITE_BASE}/food_box_allergen_1.png`,
  heartFull: `${SPRITE_BASE}/heart_full.png`,
  heartEmpty: `${SPRITE_BASE}/heart_empty.png`,
  emoteQuestion: `${SPRITE_BASE}/emote_question.png`,
  emoteExclamation: `${SPRITE_BASE}/emote_exclamation.png`,
  emoteDanger: `${SPRITE_BASE}/emote_exclamations.png`,
  emoteCircle: `${SPRITE_BASE}/emote_circle.png`,
  emoteStar: `${SPRITE_BASE}/emote_star.png`,
  emoteIdea: `${SPRITE_BASE}/emote_idea.png`,
  emoteDots: `${SPRITE_BASE}/emote_dots3.png`,
  reticle: `${SPRITE_BASE}/reticle_glasses.png`,
  promptTurnLeft: `${SPRITE_BASE}/prompt_turn_left.png`,
  promptTurnUp: `${SPRITE_BASE}/prompt_turn_up.png`,
  handPoint: `${SPRITE_BASE}/hand_point.png`,
  handHold: `${SPRITE_BASE}/hand_hold_box.png`,
  panelMatch: `${SPRITE_BASE}/panel_green_match.png`,
  panelWarn: `${SPRITE_BASE}/panel_yellow_warn.png`,
  panelUnsure: `${SPRITE_BASE}/panel_blue_unsure.png`,
  panelDialog: `${SPRITE_BASE}/panel_cream_dialog.png`,
  panelCard: `${SPRITE_BASE}/panel_white_card.png`,
} as const;

type SpriteKey = keyof typeof BLINDFOLD_SPRITE_URLS;

const LOGICAL_W = 320;
const LOGICAL_H = 180;

const PALETTE = {
  ink: "#0b1018",
  night: "#09111e",
  wallTop: "#111927",
  wallMid: "#162030",
  wallLow: "#1c283b",
  surface: "#141b27",
  surface2: "#1c2535",
  border: "#33435b",
  borderLight: "#4c6282",
  cream: "#f5f2e9",
  muted: "#b3bdcc",
  accent: "#ffd23f",
  accentBright: "#fff3b0",
  accentShade: "#c99718",
  match: "#4fe3a2",
  matchDark: "#1d7a53",
  warning: "#ff9b52",
  warningDark: "#9e4b14",
  unsure: "#a3cbff",
  unsureDark: "#365c91",
  danger: "#ff5c77",
  dangerLight: "#ffb8c6",
  birchTop: "#e0ad79",
  birchMain: "#c58954",
  birchMid: "#9e6638",
  birchDark: "#6e4220",
  cabinetWhite: "#e8e6df",
  cabinetShade: "#b8c0cc",
  glassBlue: "#263a52",
  glassHighlight: "#56789c",
  sweaterTeal: "#296e7d",
  sweaterDark: "#194752",
  careGreen: "#2f855a",
  careDark: "#1e563a",
  skinLight: "#f2c29b",
  skinMid: "#d99d73",
  hairWarm: "#593724",
  hairHighlight: "#7d5036",
  hairSilver: "#cfd6e0",
  hairSlate: "#8b97a8",
  coatWhite: "#f2f0e8",
  coatShade: "#c5ced9",
  owlPlumage: "#735946",
  owlLight: "#a6856c",
  owlBelly: "#e8dfd1",
  leafGreen: "#3da873",
  leafDark: "#236947",
  amberBottle: "#c97428",
  amberGlow: "#f5a742",
  mugBlue: "#2f6db5",
} as const;

type LocaleCopy = {
  blindfoldMode: string;
  spotMode: string;
  offlineTag: string;
  pharmacySign: string;
  pharmacistTitle: string;
  idleBlindfold: string;
  idleSpot: string;
  coachingDefault: string;
  checkingLabel: string;
  matchBanner: string;
  warningBanner: string;
  unsureBanner: string;
  bubbleMatch: string;
  bubbleWarning: string;
  bubbleUnsure: string;
  ariaModeBlindfold: string;
  ariaModeSpot: string;
  ariaBlindfoldOn: string;
  ariaBlindfoldOff: string;
};

const COPY: Record<"en" | "fi" | "sv", LocaleCopy> = {
  en: {
    blindfoldMode: "BLINDFOLD",
    spotMode: "SPOT DANGER",
    offlineTag: "OFFLINE DEMO",
    pharmacySign: "PHARMACY",
    pharmacistTitle: "PHARMACIST",
    idleBlindfold: "CLOSE EYES - HOLD UP A BOX",
    idleSpot: "INSPECT THE PACK LABEL",
    coachingDefault: "TURN BOX SLOWLY INTO VIEW",
    checkingLabel: "READING LABEL...",
    matchBanner: "MATCH - SAFE TO TAKE",
    warningBanner: "WARNING - DO NOT TAKE",
    unsureBanner: "NOT SURE - NO DOSE GUESS",
    bubbleMatch: "MATCHED AGAINST YOUR LIST",
    bubbleWarning: "STOP! CHECK AVOID LIST",
    bubbleUnsure: "NOT SURE - ASK PHARMACIST",
    ariaModeBlindfold: "Blindfold Challenge",
    ariaModeSpot: "Spot the Danger",
    ariaBlindfoldOn: "blindfold on",
    ariaBlindfoldOff: "blindfold off",
  },
  fi: {
    blindfoldMode: "SOKKOTESTI",
    spotMode: "VAARANPAIKKA",
    offlineTag: "OFFLINE-DEMO",
    pharmacySign: "APTEEKKI",
    pharmacistTitle: "APTEEKKARI",
    idleBlindfold: "SULJE SILMÄT - NOSTA PAKKAUS",
    idleSpot: "TUTKI LÄÄKEPAKKAUS",
    coachingDefault: "KÄÄNNÄ PAKKAUSTA HITAASTI",
    checkingLabel: "LUETAAN ETIKETTIÄ...",
    matchBanner: "OIKEA LÄÄKE - TURVALLINEN",
    warningBanner: "VAROITUS - ÄLÄ OTA",
    unsureBanner: "EPÄVARMA - EI ARVAUSTA",
    bubbleMatch: "TARKISTETTU LISTASTASI",
    bubbleWarning: "SEIS! TARKISTA ESTOLISTA",
    bubbleUnsure: "EPÄVARMA - KYSY APTEEKISTA",
    ariaModeBlindfold: "Sokkotesti",
    ariaModeSpot: "Tunnista vaara",
    ariaBlindfoldOn: "side silmillä",
    ariaBlindfoldOff: "ilman sidettä",
  },
  sv: {
    blindfoldMode: "ÖGONBINDEL",
    spotMode: "HITTA FARAN",
    offlineTag: "OFFLINE-DEMO",
    pharmacySign: "APOTEK",
    pharmacistTitle: "APOTEKARE",
    idleBlindfold: "BLUNDA - HÅLL UPP PAKETET",
    idleSpot: "GRANSKA FÖRPACKNINGEN",
    coachingDefault: "VRID FÖRPACKNINGEN LÅNGSAMT",
    checkingLabel: "LÄSER ETIKETTEN...",
    matchBanner: "RÄTT LÄKEMEDEL - SÄKERT",
    warningBanner: "VARNING - TA INTE",
    unsureBanner: "OSÄKER - INGEN GISSNING",
    bubbleMatch: "KONTROLLERAD MOT DIN LISTA",
    bubbleWarning: "STOPP! SE UNDVIK-LISTAN",
    bubbleUnsure: "OSÄKER DOS - FRÅGA APOTEKET",
    ariaModeBlindfold: "Ögonbindelutmaning",
    ariaModeSpot: "Hitta faran",
    ariaBlindfoldOn: "ögonbindel på",
    ariaBlindfoldOff: "ögonbindel av",
  },
};

type GlyphDef = { w: number; rows: readonly [number, number, number, number, number] };

const g3 = (r0: number, r1: number, r2: number, r3: number, r4: number): GlyphDef => ({
  w: 3,
  rows: [r0, r1, r2, r3, r4],
});

const g4 = (r0: number, r1: number, r2: number, r3: number, r4: number): GlyphDef => ({
  w: 4,
  rows: [r0, r1, r2, r3, r4],
});

const g5 = (r0: number, r1: number, r2: number, r3: number, r4: number): GlyphDef => ({
  w: 5,
  rows: [r0, r1, r2, r3, r4],
});

const BITMAP_FONT: Record<string, GlyphDef> = {
  " ": g3(0, 0, 0, 0, 0),
  A: g4(6, 9, 15, 9, 9),
  B: g4(14, 9, 14, 9, 14),
  C: g4(7, 8, 8, 8, 7),
  D: g4(14, 9, 9, 9, 14),
  E: g4(15, 8, 14, 8, 15),
  F: g4(15, 8, 14, 8, 8),
  G: g4(7, 8, 11, 9, 7),
  H: g4(9, 9, 15, 9, 9),
  I: g3(7, 2, 2, 2, 7),
  J: g4(3, 1, 1, 9, 6),
  K: g4(9, 10, 12, 10, 9),
  L: g4(8, 8, 8, 8, 15),
  M: g5(17, 27, 21, 17, 17),
  N: g4(9, 13, 11, 9, 9),
  O: g4(6, 9, 9, 9, 6),
  P: g4(14, 9, 14, 8, 8),
  Q: g4(6, 9, 9, 10, 5),
  R: g4(14, 9, 14, 10, 9),
  S: g4(7, 8, 6, 1, 14),
  T: g3(7, 2, 2, 2, 2),
  U: g4(9, 9, 9, 9, 6),
  V: g5(17, 17, 17, 10, 4),
  W: g5(17, 17, 21, 27, 17),
  X: g4(9, 6, 6, 6, 9),
  Y: g5(17, 10, 4, 4, 4),
  Z: g4(15, 2, 4, 8, 15),
  "0": g4(6, 11, 9, 13, 6),
  "1": g3(2, 6, 2, 2, 7),
  "2": g4(14, 1, 6, 8, 15),
  "3": g4(14, 1, 6, 1, 14),
  "4": g4(9, 9, 15, 1, 1),
  "5": g4(15, 8, 14, 1, 14),
  "6": g4(7, 8, 14, 9, 6),
  "7": g4(15, 1, 2, 4, 4),
  "8": g4(6, 9, 6, 9, 6),
  "9": g4(6, 9, 7, 1, 14),
  ".": g3(0, 0, 0, 0, 2),
  ",": g3(0, 0, 0, 2, 4),
  ":": g3(0, 2, 0, 2, 0),
  "!": g3(2, 2, 2, 0, 2),
  "?": g4(14, 1, 6, 0, 4),
  "/": g4(1, 2, 4, 8, 8),
  "+": g3(0, 2, 7, 2, 0),
  "-": g3(0, 0, 7, 0, 0),
  "'": g3(2, 2, 0, 0, 0),
  "(": g3(2, 4, 4, 4, 2),
  ")": g3(4, 2, 2, 2, 4),
  "#": g5(10, 31, 10, 31, 10),
  "%": g4(9, 2, 4, 8, 9),
  "*": g3(0, 5, 2, 5, 0),
  "<": g3(1, 2, 4, 2, 1),
  ">": g3(4, 2, 1, 2, 4),
};

const SPRITE_COLOR_KEY: Record<string, string> = {
  k: PALETTE.ink,
  w: PALETTE.cream,
  m: PALETTE.muted,
  y: PALETTE.accent,
  Y: PALETTE.accentBright,
  o: PALETTE.accentShade,
  g: PALETTE.match,
  G: PALETTE.matchDark,
  a: PALETTE.warning,
  A: PALETTE.warningDark,
  u: PALETTE.unsure,
  r: PALETTE.danger,
  R: PALETTE.dangerLight,
  s: PALETTE.surface2,
  b: PALETTE.border,
  t: PALETTE.sweaterTeal,
  T: PALETTE.sweaterDark,
  v: PALETTE.careGreen,
  V: PALETTE.careDark,
  f: PALETTE.skinLight,
  F: PALETTE.skinMid,
  h: PALETTE.hairWarm,
  H: PALETTE.hairHighlight,
  c: PALETTE.coatWhite,
  C: PALETTE.coatShade,
  p: PALETTE.owlPlumage,
  P: PALETTE.owlLight,
  e: PALETTE.owlBelly,
  S: PALETTE.hairSilver,
  L: PALETTE.hairSlate,
  d: PALETTE.birchMain,
  D: PALETTE.birchDark,
  n: PALETTE.mugBlue,
};

const HEART_FULL_GRID = [
  ".kk...kk.",
  "kRRk.krrk",
  "kRRrkrrrk",
  "krrrrrrrk",
  "krrrrrrrk",
  ".krrrrrk.",
  "..krrrk..",
  "...krk...",
  "....k....",
];

const HEART_EMPTY_GRID = [
  ".kk...kk.",
  "kbbk.kbbk",
  "kbsskbssk",
  "ksssssssk",
  "ksssssssk",
  ".ksssssk.",
  "..ksssk..",
  "...ksk...",
  "....k....",
];

const OWL_IDLE_GRID = [
  "..kk........kk..",
  ".kPPk.kkkk.kPPk.",
  ".kppkkppppkkppk.",
  "..kppppppppppk..",
  ".kpyyyykkYYYYpk.",
  ".kywkkykkywkkyk.",
  ".kykkwykkykkwyk.",
  ".kpyyyykkYYYYpk.",
  ".kpppeeaeeepppk.",
  "kpppeeeeeeeepppk",
  "kppeewweewweeppk",
  "kppeeeeeeeeeeppk",
  ".kppeewweeweppk.",
  "..kpppeeeepppk..",
  "...kkkkkkkkkk...",
  "....kyk..kyk....",
];

const OWL_SPEAK_GRID = [
  "..kk........kk..",
  ".kPPk.kkkk.kPPk.",
  ".kppkkppppkkppk.",
  "..kppppppppppk..",
  ".kpyyyykkYYYYpk.",
  ".kywkkykkywkkyk.",
  ".kykkwykkykkwyk.",
  ".kpyyyykkYYYYpk.",
  ".kpppeaaaeepppk.",
  "kpppeeakkaeepppk",
  "kppeewwaawweppk.",
  "kppeeeeeeeeeeppk",
  ".kppeewweeweppk.",
  "..kpppeeeepppk..",
  "...kkkkkkkkkk...",
  "....kyk..kyk....",
];

const WEARER_GRID = [
  "....kkkkkkkk....",
  "..kkHHHHHHHHkk..",
  ".kHHhhhhhhhhHHk.",
  ".khhffffffffhhk.",
  ".khffwkffwkffhk.",
  ".khffkkffkkffhk.",
  ".khffffFFffffhk.",
  "..kffffkkffffk..",
  "...kkffffffkk...",
  "..kkttttttttkk..",
  ".ktttyyttttyyttk",
  ".ktttwyttttywttk",
  ".ktttttttttttttk",
  ".kttTTTTTTTTtttk",
  "..kffkttttkffk..",
  "...kk.kkkk.kk...",
];

const CAREGIVER_GRID = [
  "....kkkkkkkk....",
  "..kkhhhhhhhhkk..",
  ".khhhhhhhhhhhhk.",
  ".khhffffffffhhk.",
  ".khffwkffwkffhk.",
  ".khffkkffkkffhk.",
  ".khffffFFffffhk.",
  "..kffffkkffffk..",
  "...kkffffffkk...",
  "..kkvvvvvvvvkk..",
  ".kvvvwwvvvvwwvvk",
  ".kvvvvvvvvvvvvvk",
  ".kvvvVVVVVVvvvvk",
  ".kvvvVvvvvVvvvvk",
  "..kffkvvvvkffk..",
  "...kk.kkkk.kk...",
];

const PHARMACIST_GRID = [
  "....kkkkkkkk....",
  "..kkSSSSSSSSkk..",
  ".kSSLLLLLLLLSSk.",
  ".kLLffffffffLLk.",
  ".kLfuuffffuufLk.",
  ".kLfukffffkufLk.",
  ".kLffffkkffffLk.",
  "..kffffaaFFFFk..",
  "...kkfggggfkk...",
  "..kkccckkccckk..",
  ".kcccgckkccccck.",
  ".kccgggckcdddck.",
  ".kcccgckkcdwwdck",
  ".kCCCCCCkcdDDdck",
  "..kffkcccckffk..",
  "...kk.kkkk.kk...",
];

type SpriteEntry = {
  img: HTMLImageElement | null;
  status: "pending" | "loaded" | "failed";
  listeners: Set<() => void>;
};

const sharedSpritePool = new Map<SpriteKey, SpriteEntry>();

const DASH_PATTERN = new RegExp("[\\u2014\\u2013]", "g");

function sanitizeText(input: string): string {
  return input.replace(DASH_PATTERN, "-").trim();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function requestSprite(key: SpriteKey, onReady: () => void): HTMLImageElement | null {
  let rec = sharedSpritePool.get(key);
  if (!rec) {
    if (typeof Image !== "function") {
      return null;
    }
    const img = new Image();
    const created: SpriteEntry = {
      img,
      status: "pending",
      listeners: new Set<() => void>(),
    };
    sharedSpritePool.set(key, created);
    img.onload = () => {
      created.status = img.naturalWidth > 0 ? "loaded" : "failed";
      for (const fn of Array.from(created.listeners)) {
        fn();
      }
      created.listeners.clear();
    };
    img.onerror = () => {
      created.status = "failed";
      created.listeners.clear();
    };
    img.src = BLINDFOLD_SPRITE_URLS[key];
    if (img.complete && img.naturalWidth > 0) {
      created.status = "loaded";
    }
    rec = created;
  }
  if (rec.status === "loaded" && rec.img && rec.img.naturalWidth > 0) {
    return rec.img;
  }
  if (rec.status === "pending") {
    rec.listeners.add(onReady);
  }
  return null;
}

function drawSpriteOrFalse(
  ctx: CanvasRenderingContext2D,
  key: SpriteKey,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  onReady: () => void,
): boolean {
  if (typeof ctx.drawImage !== "function") return false;
  const img = requestSprite(key, onReady);
  if (!img) return false;
  ctx.drawImage(img, Math.floor(dx), Math.floor(dy), Math.floor(dw), Math.floor(dh));
  return true;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  grid: readonly string[],
  ox: number,
  oy: number,
  scale = 1,
): void {
  const s = Math.max(1, Math.floor(scale));
  const bx = Math.floor(ox);
  const by = Math.floor(oy);
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === "." || ch === " ") continue;
      const color = SPRITE_COLOR_KEY[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(bx + c * s, by + r * s, s, s);
    }
  }
}

function measurePixelText(rawText: string, scale = 1): number {
  const s = Math.max(1, Math.floor(scale));
  const clean = sanitizeText(rawText).toUpperCase();
  let width = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const base = ch === "Ä" || ch === "Å" ? "A" : ch === "Ö" ? "O" : ch;
    const glyph = BITMAP_FONT[base] ?? BITMAP_FONT["?"];
    width += (glyph.w + 1) * s;
  }
  return width > 0 ? width - s : 0;
}

function drawPixelText(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
): number {
  const s = Math.max(1, Math.floor(scale));
  const startX = Math.floor(x);
  const startY = Math.floor(y);
  const upper = sanitizeText(rawText).toUpperCase();
  ctx.fillStyle = color;
  let cursor = startX;
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    let base = ch;
    let diaeresis = false;
    let ring = false;
    if (ch === "Ä") {
      base = "A";
      diaeresis = true;
    } else if (ch === "Ö") {
      base = "O";
      diaeresis = true;
    } else if (ch === "Å") {
      base = "A";
      ring = true;
    }
    const glyph = BITMAP_FONT[base] ?? BITMAP_FONT["?"];
    if (diaeresis) {
      ctx.fillRect(cursor, startY - 2 * s, s, s);
      ctx.fillRect(cursor + (glyph.w - 1) * s, startY - 2 * s, s, s);
    } else if (ring) {
      ctx.fillRect(cursor + s, startY - 2 * s, 2 * s, s);
    }
    for (let row = 0; row < 5; row++) {
      const bits = glyph.rows[row];
      if (bits === 0) continue;
      for (let col = 0; col < glyph.w; col++) {
        if ((bits & (1 << (glyph.w - 1 - col))) !== 0) {
          ctx.fillRect(cursor + col * s, startY + row * s, s, s);
        }
      }
    }
    cursor += (glyph.w + 1) * s;
  }
  return cursor > startX ? cursor - startX - s : 0;
}

function wrapPixelLines(text: string, maxChars: number, maxLines: number): string[] {
  const clean = sanitizeText(text);
  if (!clean) return [];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const piece = word.length > maxChars ? word.slice(0, maxChars) : word;
    if (!current) {
      current = piece;
    } else if (current.length + 1 + piece.length <= maxChars) {
      current = `${current} ${piece}`;
    } else {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
      current = piece;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

function drawPhaseBadge(ctx: CanvasRenderingContext2D, phase: ScenePhase, cx: number, cy: number): void {
  const x = Math.floor(cx);
  const y = Math.floor(cy);
  if (phase === "match") {
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(x - 4, y - 4, 9, 9);
    ctx.fillStyle = PALETTE.match;
    ctx.fillRect(x - 3, y - 4, 7, 9);
    ctx.fillRect(x - 4, y - 3, 9, 7);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(x - 2, y, 1, 1);
    ctx.fillRect(x - 1, y + 1, 1, 1);
    ctx.fillRect(x, y, 1, 1);
    ctx.fillRect(x + 1, y - 1, 1, 1);
    ctx.fillRect(x + 2, y - 2, 1, 1);
    return;
  }
  if (phase === "warning") {
    ctx.fillStyle = PALETTE.warning;
    for (let r = 0; r < 8; r++) {
      const span = r + 1;
      const half = Math.floor(span / 2);
      ctx.fillRect(x - half, y - 4 + r, span + (span % 2 === 0 ? 1 : 0), 1);
    }
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(x, y - 2, 1, 3);
    ctx.fillRect(x, y + 2, 1, 1);
    return;
  }
  if (phase === "unsure") {
    ctx.fillStyle = PALETTE.unsure;
    for (let dy = -4; dy <= 4; dy++) {
      const span = 4 - Math.abs(dy);
      ctx.fillRect(x - span, y + dy, span * 2 + 1, 1);
    }
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(x - 1, y - 2, 3, 1);
    ctx.fillRect(x + 1, y - 1, 1, 1);
    ctx.fillRect(x, y, 1, 1);
    ctx.fillRect(x, y + 2, 1, 1);
    return;
  }
  ctx.fillStyle = phase === "coaching" || phase === "checking" ? PALETTE.accent : PALETTE.borderLight;
  ctx.fillRect(x - 3, y - 3, 7, 7);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(x - 2, y - 2, 5, 5);
  ctx.fillStyle = phase === "coaching" || phase === "checking" ? PALETTE.accent : PALETTE.muted;
  ctx.fillRect(x - 1, y, 3, 1);
}

function drawRoomBackdrop(
  ctx: CanvasRenderingContext2D,
  state: PixelSceneState,
  copy: LocaleCopy,
  elapsedSec: number,
  reducedMotion: boolean,
  highContrast: boolean,
  onReady: () => void,
): void {
  const counterY = 136;

  ctx.fillStyle = highContrast ? "#000000" : PALETTE.wallTop;
  ctx.fillRect(0, 20, LOGICAL_W, counterY - 20);
  if (!highContrast) {
    ctx.fillStyle = PALETTE.wallMid;
    ctx.fillRect(0, 62, LOGICAL_W, counterY - 62);
    ctx.fillStyle = PALETTE.wallLow;
    ctx.fillRect(0, 102, LOGICAL_W, counterY - 102);
    ctx.fillStyle = PALETTE.surface;
    ctx.fillRect(0, counterY - 6, LOGICAL_W, 6);
  }

  const wx = 8;
  const wy = 26;
  ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.birchDark;
  ctx.fillRect(wx - 2, wy - 2, 44, 50);
  ctx.fillStyle = PALETTE.birchMain;
  ctx.fillRect(wx - 1, wy - 1, 42, 48);
  ctx.fillStyle = PALETTE.night;
  ctx.fillRect(wx + 2, wy + 2, 36, 40);

  ctx.fillStyle = PALETTE.accentBright;
  ctx.fillRect(wx + 28, wy + 6, 5, 5);
  ctx.fillStyle = PALETTE.night;
  ctx.fillRect(wx + 30, wy + 6, 4, 4);

  const twinkle = reducedMotion ? 0 : Math.floor(elapsedSec * 2) % 2;
  ctx.fillStyle = twinkle === 0 ? PALETTE.cream : PALETTE.unsure;
  ctx.fillRect(wx + 7, wy + 8, 1, 1);
  ctx.fillRect(wx + 16, wy + 13, 1, 1);
  ctx.fillStyle = twinkle === 1 ? PALETTE.accent : PALETTE.cream;
  ctx.fillRect(wx + 11, wy + 20, 1, 1);
  ctx.fillRect(wx + 25, wy + 17, 1, 1);

  const snow = [
    [5, 6],
    [13, 23],
    [23, 11],
    [31, 27],
    [9, 32],
  ];
  ctx.fillStyle = PALETTE.cream;
  for (let i = 0; i < snow.length; i++) {
    const [sx, sy] = snow[i];
    const dy = reducedMotion ? sy : (sy + Math.floor(elapsedSec * (5 + i))) % 36;
    ctx.fillRect(wx + 3 + sx, wy + 3 + dy, 1, 1);
  }

  ctx.fillStyle = PALETTE.birchMain;
  ctx.fillRect(wx + 19, wy + 2, 2, 40);
  ctx.fillRect(wx + 2, wy + 21, 36, 2);

  for (let c = 0; c < 5; c++) {
    const h = 4 + (2 - Math.abs(2 - c)) * 2;
    const cx = wx + 12 + c * 4;
    const cy = wy + 42 - h;
    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(cx, cy + 2, 2, h - 2);
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(cx, cy, 2, 2);
  }
  ctx.fillStyle = PALETTE.birchTop;
  ctx.fillRect(wx - 3, wy + 44, 46, 3);

  const lx = 50;
  const ly = 20;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(lx + 9, ly, 2, 9);
  ctx.fillStyle = PALETTE.birchMain;
  ctx.fillRect(lx + 3, ly + 9, 14, 3);
  ctx.fillStyle = PALETTE.accent;
  ctx.fillRect(lx + 1, ly + 12, 18, 3);
  ctx.fillStyle = PALETTE.accentBright;
  ctx.fillRect(lx + 6, ly + 15, 8, 2);

  if (!highContrast) {
    ctx.fillStyle = state.phase === "match" ? "#1b2e2a" : "#1f2936";
    for (let r = 8; r < 68; r += 6) {
      const spread = Math.floor(r * 0.28);
      ctx.fillRect(lx + 4 - spread, ly + 18 + r, 12 + spread * 2, 1);
    }
  }

  const cabX = 72;
  const cabY = 28;
  if (!drawSpriteOrFalse(ctx, "doorHome", cabX, cabY + 6, 26, 38, onReady)) {
    ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.ink;
    ctx.fillRect(cabX, cabY, 26, 42);
    ctx.fillStyle = PALETTE.cabinetWhite;
    ctx.fillRect(cabX + 1, cabY + 1, 24, 40);
    ctx.fillStyle = PALETTE.matchDark;
    ctx.fillRect(cabX + 12, cabY + 3, 2, 6);
    ctx.fillRect(cabX + 10, cabY + 5, 6, 2);
    ctx.fillStyle = PALETTE.glassBlue;
    ctx.fillRect(cabX + 4, cabY + 11, 18, 25);
    ctx.fillStyle = PALETTE.amberBottle;
    ctx.fillRect(cabX + 6, cabY + 16, 4, 6);
    ctx.fillStyle = PALETTE.unsure;
    ctx.fillRect(cabX + 12, cabY + 15, 5, 7);
    ctx.fillStyle = PALETTE.warning;
    ctx.fillRect(cabX + 6, cabY + 28, 6, 6);
    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(cabX + 14, cabY + 27, 6, 7);
  }

  const signW = measurePixelText(copy.pharmacySign, 1) + 18;
  const signX = LOGICAL_W - signW - 10;
  ctx.fillStyle = highContrast ? "#000000" : PALETTE.surface;
  ctx.fillRect(signX, 22, signW, 12);
  ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.match;
  ctx.fillRect(signX, 22, signW, 1);
  ctx.fillRect(signX, 33, signW, 1);
  ctx.fillStyle = PALETTE.match;
  ctx.fillRect(signX + 6, 25, 2, 6);
  ctx.fillRect(signX + 4, 27, 6, 2);
  drawPixelText(ctx, copy.pharmacySign, signX + 13, 26, PALETTE.match, 1);

  const sx = 224;
  const drewShelves =
    drawSpriteOrFalse(ctx, "shelfBoxes1", sx + 2, 38, 26, 26, onReady) &&
    drawSpriteOrFalse(ctx, "shelfBoxes2", sx + 30, 38, 26, 26, onReady) &&
    drawSpriteOrFalse(ctx, "shelfWood", sx + 58, 38, 26, 26, onReady);

  if (!drewShelves) {
    for (let sIdx = 0; sIdx < 2; sIdx++) {
      const rowY = 50 + sIdx * 22;
      ctx.fillStyle = PALETTE.birchMain;
      ctx.fillRect(sx, rowY, 88, 3);
      ctx.fillStyle = PALETTE.birchDark;
      ctx.fillRect(sx, rowY + 3, 88, 2);
      ctx.fillStyle = PALETTE.cream;
      ctx.fillRect(sx + 5, rowY - 10, 10, 10);
      ctx.fillStyle = sIdx === 0 ? PALETTE.match : PALETTE.mugBlue;
      ctx.fillRect(sx + 5, rowY - 8, 10, 2);
      ctx.fillStyle = PALETTE.unsure;
      ctx.fillRect(sx + 19, rowY - 11, 9, 11);
      ctx.fillStyle = PALETTE.amberBottle;
      ctx.fillRect(sx + 32, rowY - 9, 6, 9);
      ctx.fillStyle = PALETTE.cream;
      ctx.fillRect(sx + 42, rowY - 11, 12, 11);
      ctx.fillStyle = sIdx === 0 ? PALETTE.warning : PALETTE.danger;
      ctx.fillRect(sx + 42, rowY - 11, 12, 3);
      ctx.fillStyle = PALETTE.sweaterTeal;
      ctx.fillRect(sx + 58, rowY - 9, 10, 9);
      ctx.fillStyle = PALETTE.leafGreen;
      ctx.fillRect(sx + 73, rowY - 10, 10, 6);
      ctx.fillStyle = PALETTE.birchDark;
      ctx.fillRect(sx + 74, rowY - 4, 8, 4);
    }
  }

  drawSpriteOrFalse(ctx, "doorPharmacy", 292, 68, 22, 30, onReady);
}

function drawCharacters(
  ctx: CanvasRenderingContext2D,
  state: PixelSceneState,
  copy: LocaleCopy,
  elapsedSec: number,
  reducedMotion: boolean,
  highContrast: boolean,
  onReady: () => void,
): void {
  const counterY = 136;
  const animStep = reducedMotion ? 0 : Math.floor(elapsedSec * 4) % 2;
  const celebrateBob = !reducedMotion && state.phase === "match" ? (animStep === 0 ? -2 : 0) : 0;

  const cgX = 8;
  const cgY = counterY - 34;
  const cgKey: SpriteKey =
    !reducedMotion && state.phase === "match"
      ? animStep === 0
        ? "caregiverWalk1"
        : "caregiverWalk2"
      : "caregiverIdle";
  if (!drawSpriteOrFalse(ctx, cgKey, cgX, cgY + celebrateBob, 28, 28, onReady)) {
    drawGrid(ctx, CAREGIVER_GRID, cgX, cgY + celebrateBob, 2);
  }
  if (state.phase === "match") {
    if (!drawSpriteOrFalse(ctx, "emoteCircle", cgX + 6, cgY - 16, 16, 16, onReady)) {
      drawPhaseBadge(ctx, "match", cgX + 14, cgY - 8);
    }
  }

  const wrX = 44;
  const wrY = counterY - 36 + celebrateBob;
  const wrKey: SpriteKey =
    !reducedMotion && (state.phase === "coaching" || state.phase === "checking")
      ? animStep === 0
        ? "judgeWalk1"
        : "judgeWalk2"
      : state.blindfoldOn
        ? "blindfoldWearer"
        : "judgeIdle";
  if (!drawSpriteOrFalse(ctx, wrKey, wrX, wrY, 32, 32, onReady)) {
    drawGrid(ctx, WEARER_GRID, wrX, wrY, 2);
  }

  if (state.blindfoldOn) {
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(wrX + 4, wrY + 7, 24, 7);
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(wrX + 5, wrY + 7, 22, 1);
    ctx.fillRect(wrX + 5, wrY + 13, 22, 1);
    ctx.fillStyle = PALETTE.surface2;
    ctx.fillRect(wrX + 5, wrY + 8, 22, 5);
    ctx.fillStyle = PALETTE.borderLight;
    ctx.fillRect(wrX + 8, wrY + 9, 5, 2);
    ctx.fillRect(wrX + 18, wrY + 9, 5, 2);
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(wrX + 1, wrY + 9, 3, 3);
  }

  const boxX = wrX + 31;
  const boxY = wrY + 8 + (state.phase === "coaching" && !reducedMotion ? animStep * 2 : 0);
  const packSpriteKey: SpriteKey =
    state.phase === "match"
      ? "packFront"
      : state.phase === "unsure" || state.phase === "coaching"
        ? "packSide"
        : state.phase === "warning"
          ? "foodBox"
          : "mysteryBox";

  if (!drawSpriteOrFalse(ctx, packSpriteKey, boxX, boxY, 18, 18, onReady)) {
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(boxX, boxY, 14, 16);
    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(boxX + 1, boxY + 1, 12, 14);
    ctx.fillStyle =
      state.phase === "match"
        ? PALETTE.match
        : state.phase === "warning"
          ? PALETTE.warning
          : state.phase === "unsure"
            ? PALETTE.unsure
            : PALETTE.accent;
    ctx.fillRect(boxX + 1, boxY + 1, 12, 4);
    ctx.fillStyle = PALETTE.mugBlue;
    ctx.fillRect(boxX + 3, boxY + 7, 8, 2);
  }

  if (state.mode === "spot") {
    drawSpriteOrFalse(ctx, "handPoint", boxX + 2, boxY + 14, 14, 14, onReady);
  } else if (state.phase === "coaching" || state.phase === "checking") {
    drawSpriteOrFalse(ctx, "handHold", boxX - 4, boxY + 12, 14, 14, onReady);
  }

  const pharmacistStepped =
    state.phase === "warning" ||
    state.phase === "unsure" ||
    Boolean(state.pharmacistBubble && state.pharmacistBubble.trim());
  const phX = pharmacistStepped ? 228 : 264;
  const phY = counterY - 36;
  const phKey: SpriteKey = pharmacistStepped
    ? !reducedMotion && animStep === 1
      ? "pharmacistWalk1"
      : "pharmacistWest"
    : "pharmacistIdle";

  if (!drawSpriteOrFalse(ctx, phKey, phX, phY, 32, 32, onReady)) {
    drawGrid(ctx, PHARMACIST_GRID, phX, phY, 2);
  }

  const rawBubble =
    state.pharmacistBubble !== undefined
      ? sanitizeText(state.pharmacistBubble)
      : state.phase === "warning"
        ? copy.bubbleWarning
        : state.phase === "unsure"
          ? copy.bubbleUnsure
          : state.phase === "match"
            ? copy.bubbleMatch
            : "";

  if (rawBubble) {
    const lines = wrapPixelLines(rawBubble, 17, 3);
    if (lines.length > 0) {
      const bx = 216;
      const by = 21;
      const bw = 98;
      const bh = 15 + lines.length * 8;
      const borderCol =
        state.phase === "warning"
          ? PALETTE.warning
          : state.phase === "unsure"
            ? PALETTE.unsure
            : state.phase === "match"
              ? PALETTE.match
              : PALETTE.accent;

      ctx.fillStyle = PALETTE.ink;
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = highContrast ? "#ffffff" : borderCol;
      ctx.fillRect(bx, by, bw, bh);
      if (!highContrast) {
        drawSpriteOrFalse(ctx, "panelDialog", bx + 1, by + 1, bw - 2, bh - 2, onReady);
      }
      ctx.fillStyle = highContrast ? "#000000" : PALETTE.cream;
      ctx.fillRect(bx + 2, by + 2, bw - 4, bh - 4);

      const tailX = clamp(phX + 12, bx + 8, bx + bw - 12);
      ctx.fillStyle = highContrast ? "#ffffff" : borderCol;
      ctx.fillRect(tailX, by + bh, 6, 4);
      ctx.fillStyle = highContrast ? "#000000" : PALETTE.cream;
      ctx.fillRect(tailX + 1, by + bh - 1, 4, 3);

      drawPhaseBadge(ctx, state.phase, bx + 8, by + 8);
      drawPixelText(
        ctx,
        copy.pharmacistTitle,
        bx + 15,
        by + 5,
        highContrast ? PALETTE.accent : PALETTE.ink,
        1,
      );

      const textCol = highContrast ? "#ffffff" : PALETTE.ink;
      for (let i = 0; i < lines.length; i++) {
        drawPixelText(ctx, lines[i], bx + 5, by + 14 + i * 8, textCol, 1);
      }
    }
  }
}

function drawCounterAndCenterStage(
  ctx: CanvasRenderingContext2D,
  state: PixelSceneState,
  copy: LocaleCopy,
  elapsedSec: number,
  reducedMotion: boolean,
  highContrast: boolean,
  onReady: () => void,
): void {
  const counterY = 136;

  ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.ink;
  ctx.fillRect(0, counterY - 1, LOGICAL_W, 1);
  ctx.fillStyle = PALETTE.birchTop;
  ctx.fillRect(0, counterY, LOGICAL_W, 2);
  ctx.fillStyle = PALETTE.birchMain;
  ctx.fillRect(0, counterY + 2, LOGICAL_W, 6);
  ctx.fillStyle = PALETTE.birchMid;
  for (let gx = 8; gx < LOGICAL_W; gx += 28) {
    ctx.fillRect(gx, counterY + 4, 12, 1);
  }
  ctx.fillStyle = PALETTE.birchDark;
  ctx.fillRect(0, counterY + 8, LOGICAL_W, 2);
  ctx.fillStyle = PALETTE.surface;
  ctx.fillRect(0, counterY + 10, LOGICAL_W, LOGICAL_H - counterY - 10);

  const tileTopL = requestSprite("counterTopL", onReady);
  const tileTopM = requestSprite("counterTopM", onReady);
  const tileTopR = requestSprite("counterTopR", onReady);
  const tileFrontL = requestSprite("counterFrontL", onReady);
  const tileFrontM = requestSprite("counterFrontM", onReady);
  const tileFrontR = requestSprite("counterFrontR", onReady);

  if (
    typeof ctx.drawImage === "function" &&
    tileTopL &&
    tileTopM &&
    tileTopR &&
    tileFrontL &&
    tileFrontM &&
    tileFrontR
  ) {
    ctx.drawImage(tileTopL, 0, counterY, 16, 16);
    ctx.drawImage(tileFrontL, 0, counterY + 16, 16, 16);
    for (let tx = 16; tx < LOGICAL_W - 16; tx += 16) {
      ctx.drawImage(tileTopM, tx, counterY, 16, 16);
      ctx.drawImage(tileFrontM, tx, counterY + 16, 16, 16);
    }
    ctx.drawImage(tileTopR, LOGICAL_W - 16, counterY, 16, 16);
    ctx.drawImage(tileFrontR, LOGICAL_W - 16, counterY + 16, 16, 16);
  } else {
    for (let px = 8; px + 56 < LOGICAL_W; px += 64) {
      ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.border;
      ctx.fillRect(px, counterY + 14, 56, 24);
      ctx.fillStyle = PALETTE.surface2;
      ctx.fillRect(px + 2, counterY + 16, 52, 20);
      ctx.fillStyle = PALETTE.accentShade;
      ctx.fillRect(px + 24, counterY + 19, 8, 2);
    }
  }

  if (!drawSpriteOrFalse(ctx, "amberBottle", 296, counterY - 16, 16, 16, onReady)) {
    ctx.fillStyle = PALETTE.amberBottle;
    ctx.fillRect(299, counterY - 11, 7, 11);
    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(299, counterY - 7, 7, 4);
  }
  drawSpriteOrFalse(ctx, "bottleBlue", 280, counterY - 15, 15, 15, onReady);
  drawSpriteOrFalse(ctx, "vialGreen", 92, counterY - 15, 15, 15, onReady);

  const vx = 104;
  const vy = 42;
  const vw = 108;
  const vh = 88;
  const hx = vx - 4;
  const hy = vy - 10;
  const hw = vw + 8;
  const hh = vh + 14;

  const rimColor =
    state.phase === "match"
      ? PALETTE.match
      : state.phase === "warning"
        ? PALETTE.warning
        : state.phase === "unsure"
          ? PALETTE.unsure
          : state.phase === "coaching" || state.phase === "checking"
            ? PALETTE.accent
            : highContrast
              ? "#ffffff"
              : PALETTE.borderLight;

  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(hx + 28, hy + hh, hw - 56, counterY - (hy + hh) + 2);
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(hx + 20, counterY - 3, hw - 40, 4);

  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(hx - 1, hy - 1, hw + 2, hh + 2);
  ctx.fillStyle = rimColor;
  ctx.fillRect(hx, hy, hw, hh);
  ctx.fillStyle = PALETTE.surface2;
  ctx.fillRect(hx + 1, hy + 1, hw - 2, hh - 2);

  ctx.fillStyle = PALETTE.surface;
  ctx.fillRect(hx + 3, hy + 2, hw - 6, 7);
  ctx.fillStyle = rimColor;
  ctx.fillRect(hx + 5, hy + 4, 3, 3);

  const stageTitle = state.mode === "spot" ? copy.spotMode : copy.blindfoldMode;
  drawPixelText(ctx, stageTitle, hx + 11, hy + 3, PALETTE.cream, 1);
  drawPhaseBadge(ctx, state.phase, hx + hw - 8, hy + 5);

  ctx.fillStyle = PALETTE.night;
  ctx.fillRect(vx, vy, vw, vh);

  const panelKey: SpriteKey | null =
    state.phase === "match"
      ? "panelMatch"
      : state.phase === "warning"
        ? "panelWarn"
        : state.phase === "unsure"
          ? "panelUnsure"
          : state.mode === "spot"
            ? "panelCard"
            : null;
  if (panelKey && !highContrast) {
    drawSpriteOrFalse(ctx, panelKey, vx + 6, vy + 8, vw - 12, vh - 16, onReady);
    ctx.fillStyle = PALETTE.night;
    ctx.fillRect(vx + 10, vy + 12, vw - 20, vh - 24);
  }

  ctx.fillStyle = PALETTE.surface;
  for (let gy = vy + 12; gy < vy + vh - 6; gy += 10) {
    ctx.fillRect(vx + 6, gy, vw - 12, 1);
  }

  if (!reducedMotion && state.phase === "checking") {
    const scanY = vy + 10 + (Math.floor(elapsedSec * 36) % (vh - 20));
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(vx + 8, scanY, vw - 16, 2);
  }

  ctx.fillStyle = rimColor;
  const bl = 7;
  ctx.fillRect(vx + 3, vy + 3, bl, 2);
  ctx.fillRect(vx + 3, vy + 3, 2, bl);
  ctx.fillRect(vx + vw - 3 - bl, vy + 3, bl, 2);
  ctx.fillRect(vx + vw - 5, vy + 3, 2, bl);
  ctx.fillRect(vx + 3, vy + vh - 5, bl, 2);
  ctx.fillRect(vx + 3, vy + vh - 3 - bl, 2, bl);
  ctx.fillRect(vx + vw - 3 - bl, vy + vh - 5, bl, 2);
  ctx.fillRect(vx + vw - 5, vy + vh - 3 - bl, 2, bl);

  const centerEmoteKey: SpriteKey | null =
    state.phase === "match"
      ? "emoteCircle"
      : state.phase === "warning"
        ? "emoteDanger"
        : state.phase === "unsure"
          ? "emoteQuestion"
          : state.phase === "checking"
            ? "emoteDots"
            : state.phase === "coaching"
              ? "emoteIdea"
              : "reticle";

  if (centerEmoteKey) {
    if (!drawSpriteOrFalse(ctx, centerEmoteKey, vx + Math.floor(vw / 2) - 8, vy + 14, 16, 16, onReady)) {
      drawPhaseBadge(ctx, state.phase, vx + Math.floor(vw / 2), vy + 22);
    }
  }

  const headline =
    state.phase === "match"
      ? copy.matchBanner
      : state.phase === "warning"
        ? copy.warningBanner
        : state.phase === "unsure"
          ? copy.unsureBanner
          : state.phase === "checking"
            ? copy.checkingLabel
            : state.phase === "coaching"
              ? sanitizeText(state.cueText || copy.coachingDefault)
              : state.mode === "spot"
                ? copy.idleSpot
                : copy.idleBlindfold;

  const headLines = wrapPixelLines(headline, 18, 2);
  const headlineCol =
    state.phase === "match"
      ? PALETTE.match
      : state.phase === "warning"
        ? PALETTE.warning
        : state.phase === "unsure"
          ? PALETTE.unsure
          : PALETTE.cream;

  for (let i = 0; i < headLines.length; i++) {
    const lw = measurePixelText(headLines[i], 1);
    drawPixelText(
      ctx,
      headLines[i],
      vx + Math.floor((vw - lw) / 2),
      vy + 36 + i * 9,
      headlineCol,
      1,
    );
  }

  const activeCue = sanitizeText(state.cueText ?? "");
  if (activeCue || state.phase === "coaching") {
    const cueBanner = (activeCue || copy.coachingDefault).slice(0, 20);
    const cueW = Math.min(vw - 8, measurePixelText(cueBanner, 1) + 18);
    const cueX = vx + Math.floor((vw - cueW) / 2);
    const cueY = vy + vh - 17;
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(cueX, cueY, cueW, 12);
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(cueX, cueY, cueW, 1);
    ctx.fillRect(cueX, cueY + 11, cueW, 1);

    const arrowShift = !reducedMotion && Math.floor(elapsedSec * 4) % 2 === 1 ? 1 : 0;
    if (!drawSpriteOrFalse(ctx, "promptTurnLeft", cueX + 2 + arrowShift, cueY + 1, 10, 10, onReady)) {
      drawPixelText(ctx, ">", cueX + 3 + arrowShift, cueY + 4, PALETTE.accent, 1);
    }
    drawPixelText(ctx, cueBanner, cueX + 13, cueY + 4, PALETTE.accent, 1);
  }

  const owlX = hx + 2;
  const owlY = hy - 12;
  const owlSpeaking =
    state.phase === "coaching" ||
    state.phase === "checking" ||
    state.phase === "match" ||
    state.phase === "warning" ||
    state.phase === "unsure";
  const mouthOpen = owlSpeaking && (reducedMotion || Math.floor(elapsedSec * 8) % 2 === 0);
  drawGrid(ctx, mouthOpen ? OWL_SPEAK_GRID : OWL_IDLE_GRID, owlX, owlY, 1);
  if (owlSpeaking) {
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(owlX - 3, owlY + 5, 1, 3);
    ctx.fillRect(owlX - 5, owlY + 4, 1, 5);
  }
}

function drawHudBar(
  ctx: CanvasRenderingContext2D,
  state: PixelSceneState,
  copy: LocaleCopy,
  elapsedSec: number,
  reducedMotion: boolean,
  highContrast: boolean,
  onReady: () => void,
): void {
  ctx.fillStyle = highContrast ? "#000000" : PALETTE.ink;
  ctx.fillRect(0, 0, LOGICAL_W, 19);
  ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.border;
  ctx.fillRect(0, 19, LOGICAL_W, 1);

  const modeBadge = state.mode === "spot" ? copy.spotMode : copy.blindfoldMode;
  const modeW = measurePixelText(modeBadge, 1) + 9;
  ctx.fillStyle = PALETTE.surface2;
  ctx.fillRect(4, 3, modeW, 13);
  ctx.fillStyle = PALETTE.accent;
  ctx.fillRect(4, 3, 2, 13);
  drawPixelText(ctx, modeBadge, 9, 7, PALETTE.accent, 1);

  const offlineW = measurePixelText(copy.offlineTag, 1) + 6;
  const offlineX = 8 + modeW;
  ctx.fillStyle = highContrast ? "#000000" : PALETTE.surface;
  ctx.fillRect(offlineX, 4, offlineW, 11);
  ctx.fillStyle = highContrast ? "#ffffff" : PALETTE.borderLight;
  ctx.fillRect(offlineX, 4, offlineW, 1);
  ctx.fillRect(offlineX, 14, offlineW, 1);
  drawPixelText(ctx, copy.offlineTag, offlineX + 3, 7, PALETTE.cream, 1);

  const safeTotal = Math.max(0, Math.floor(Number.isFinite(state.total) ? state.total : 5));
  const safeScore = clamp(Math.floor(Number.isFinite(state.score) ? state.score : 0), 0, Math.max(safeTotal, 0));
  const heartSlots = clamp(safeTotal || 5, 1, 5);
  const heartsW = heartSlots * 11;
  const heartsStartX = LOGICAL_W - heartsW - 5;

  const ratioLabel = `${safeScore}/${safeTotal}`;
  const ratioW = measurePixelText(ratioLabel, 1);
  drawPixelText(ctx, ratioLabel, heartsStartX - ratioW - 4, 7, PALETTE.cream, 1);

  const filledHearts =
    safeTotal > 0 ? clamp(Math.round((safeScore / safeTotal) * heartSlots), 0, heartSlots) : 0;

  for (let i = 0; i < heartSlots; i++) {
    const isFilled = i < filledHearts;
    const hx = heartsStartX + i * 11;
    const lift =
      !reducedMotion && isFilled && state.phase === "match" && i === filledHearts - 1
        ? Math.floor((Math.sin(elapsedSec * 6) + 1) * 0.5)
        : 0;
    const hy = 5 - lift;
    const spriteKey: SpriteKey = isFilled ? "heartFull" : "heartEmpty";
    if (!drawSpriteOrFalse(ctx, spriteKey, hx, hy, 9, 9, onReady)) {
      drawGrid(ctx, isFilled ? HEART_FULL_GRID : HEART_EMPTY_GRID, hx, hy, 1);
    }
  }
}

function buildAriaDescription(state: PixelSceneState): string {
  const copy = COPY[state.lang] ?? COPY.en;
  const modeStr = state.mode === "spot" ? copy.ariaModeSpot : copy.ariaModeBlindfold;
  const blindfoldStr = state.blindfoldOn ? copy.ariaBlindfoldOn : copy.ariaBlindfoldOff;
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(state.total) ? state.total : 5));
  const safeScore = clamp(Math.floor(Number.isFinite(state.score) ? state.score : 0), 0, Math.max(safeTotal, 0));
  return `${copy.offlineTag}: ${modeStr}, ${blindfoldStr}, ${state.phase}, ${safeScore}/${safeTotal}`;
}

export function mountPixelScene(
  canvas: HTMLCanvasElement,
  initial: PixelSceneState,
): PixelSceneController {
  const hasExplicitSize =
    typeof canvas.width === "number" &&
    typeof canvas.height === "number" &&
    canvas.width > 0 &&
    canvas.height > 0 &&
    !(canvas.width === 300 && canvas.height === 150);

  if (!hasExplicitSize) {
    canvas.width = LOGICAL_W;
    canvas.height = LOGICAL_H;
  }

  if (canvas.style) {
    canvas.style.imageRendering = "pixelated";
  }

  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
  }

  let state: PixelSceneState = { ...initial };
  let destroyed = false;
  let rafId: number | null = null;
  let lastTs: number | null = null;
  let elapsedSec = 0;

  const reducedMotionMql =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  const highContrastMql =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-contrast: more)")
      : null;

  function isReducedMotion(): boolean {
    if (typeof state.reducedMotion === "boolean") {
      return state.reducedMotion;
    }
    return Boolean(reducedMotionMql?.matches);
  }

  function isHighContrast(): boolean {
    return Boolean(highContrastMql?.matches);
  }

  function canRunLoop(): boolean {
    if (destroyed) return false;
    if (isReducedMotion()) return false;
    if (typeof requestAnimationFrame !== "function") return false;
    if (typeof document !== "undefined" && document.hidden) return false;
    return true;
  }

  function syncAria(): void {
    if (typeof canvas.setAttribute !== "function") return;
    if (typeof canvas.getAttribute === "function" && !canvas.getAttribute("role")) {
      canvas.setAttribute("role", "img");
    }
    canvas.setAttribute("aria-label", buildAriaDescription(state));
  }

  const onSpriteReady = () => {
    if (destroyed) return;
    if (rafId === null) {
      drawCurrentFrame();
    }
  };

  function drawCurrentFrame(): void {
    if (destroyed || !ctx) return;
    const targetW = canvas.width > 0 ? canvas.width : LOGICAL_W;
    const targetH = canvas.height > 0 ? canvas.height : LOGICAL_H;
    const reduced = isReducedMotion();
    const hc = isHighContrast();
    const copy = COPY[state.lang] ?? COPY.en;
    const t = reduced ? 0 : elapsedSec;

    ctx.imageSmoothingEnabled = false;
    if (typeof ctx.clearRect === "function") {
      ctx.clearRect(0, 0, targetW, targetH);
    }

    const scaled = targetW !== LOGICAL_W || targetH !== LOGICAL_H;
    if (scaled && typeof ctx.save === "function" && typeof ctx.scale === "function") {
      ctx.save();
      ctx.scale(targetW / LOGICAL_W, targetH / LOGICAL_H);
    }

    drawRoomBackdrop(ctx, state, copy, t, reduced, hc, onSpriteReady);
    drawCharacters(ctx, state, copy, t, reduced, hc, onSpriteReady);
    drawCounterAndCenterStage(ctx, state, copy, t, reduced, hc, onSpriteReady);
    drawHudBar(ctx, state, copy, t, reduced, hc, onSpriteReady);

    if (scaled && typeof ctx.restore === "function") {
      ctx.restore();
    }
  }

  function stopLoop(): void {
    if (rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
    lastTs = null;
  }

  function stepFrame(ts: number): void {
    rafId = null;
    if (!canRunLoop()) {
      lastTs = null;
      return;
    }
    const dt = lastTs === null ? 0 : clamp((ts - lastTs) / 1000, 0, 0.1);
    lastTs = ts;
    elapsedSec += dt;
    drawCurrentFrame();
    if (canRunLoop()) {
      rafId = requestAnimationFrame(stepFrame);
    }
  }

  function syncLoop(): void {
    if (canRunLoop()) {
      if (rafId === null) {
        rafId = requestAnimationFrame(stepFrame);
      }
    } else {
      stopLoop();
    }
  }

  const onEnvChange = () => {
    if (destroyed) return;
    drawCurrentFrame();
    syncLoop();
  };

  reducedMotionMql?.addEventListener?.("change", onEnvChange);
  highContrastMql?.addEventListener?.("change", onEnvChange);
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onEnvChange);
  }

  syncAria();
  drawCurrentFrame();
  syncLoop();

  return {
    update(patch: Partial<PixelSceneState>): void {
      if (destroyed) return;
      state = { ...state, ...patch };
      syncAria();
      drawCurrentFrame();
      syncLoop();
    },
    renderNow(): void {
      if (destroyed) return;
      drawCurrentFrame();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      reducedMotionMql?.removeEventListener?.("change", onEnvChange);
      highContrastMql?.removeEventListener?.("change", onEnvChange);
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onEnvChange);
      }
    },
  };
}
