export type LocalCommandIntent =
  | { kind: "log_dose" | "repeat" | "stop" | "scan_barcode" }
  | { kind: "question"; text: string };

type CommandKind = Exclude<LocalCommandIntent["kind"], "question">;

const COURTESY_WORDS = new Set(["please", "plz", "kiitos", "tack", "snalla"]);

const NEGATION_WORDS = new Set([
  "not",
  "no",
  "never",
  "dont",
  "didnt",
  "havent",
  "hasnt",
  "cant",
  "wont",
  "shouldnt",
  "en",
  "ei",
  "ala",
  "alkaa",
  "eika",
  "inte",
  "ej",
  "aldrig"
]);

const QUESTION_START_WORDS = new Set([
  "did",
  "do",
  "does",
  "have",
  "has",
  "had",
  "am",
  "is",
  "are",
  "was",
  "were",
  "can",
  "could",
  "should",
  "would",
  "will",
  "may",
  "might",
  "what",
  "which",
  "when",
  "where",
  "who",
  "why",
  "how",
  "onko",
  "olenko",
  "otinko",
  "voinko",
  "saanko",
  "pitaisiko",
  "pitaako",
  "mika",
  "mita",
  "milloin",
  "koska",
  "kuinka",
  "miten",
  "miksi",
  "kuka",
  "missa",
  "har",
  "hade",
  "ar",
  "var",
  "kan",
  "kunde",
  "ska",
  "skulle",
  "vill",
  "far",
  "vad",
  "vilken",
  "vilket",
  "vilka",
  "nar",
  "varfor",
  "hur",
  "vem"
]);

const COMMAND_PHRASES: Record<CommandKind, ReadonlySet<string>> = {
  log_dose: new Set([
    "i took it",
    "i took it now",
    "i just took it",
    "ive taken it",
    "i have taken it",
    "took it",
    "took it now",
    "dose taken",
    "pill taken",
    "i took the pill",
    "i took my pill",
    "i took the dose",
    "i took my dose",
    "i took the medicine",
    "i took my medicine",
    "i took the medication",
    "i took my medication",
    "took the pill",
    "took my pill",
    "took the dose",
    "took my dose",
    "log dose",
    "log the dose",
    "log my dose",
    "log this dose",
    "log dose taken",
    "log it",
    "mark as taken",
    "mark it as taken",
    "mark dose as taken",
    "mark taken",
    "mark it taken",
    "record dose",
    "record the dose",
    "otin sen",
    "otin sen nyt",
    "otin sen jo",
    "otin jo sen",
    "mina otin sen",
    "ma otin sen",
    "otin laakkeen",
    "mina otin laakkeen",
    "ma otin laakkeen",
    "otin laakkeeni",
    "otin pillerin",
    "otin tabletin",
    "otin annoksen",
    "otin taman",
    "otin iltalaakkeen",
    "otin aamulaakkeen",
    "annos otettu",
    "laake otettu",
    "kirjaa annos",
    "kirjaa otettu annos",
    "kirjaa annos otetuksi",
    "kirjaa otetuksi",
    "kirjaa se",
    "kirjaa laake",
    "merkitse otetuksi",
    "jag tog den",
    "jag tog det",
    "jag tog den nu",
    "jag tog den precis",
    "jag tog medicinen",
    "jag tog tabletten",
    "jag tog pillret",
    "jag tog dosen",
    "jag har tagit den",
    "jag har tagit det",
    "jag har tagit medicinen",
    "tog den",
    "tog det",
    "dos tagen",
    "dosen tagen",
    "logga dos",
    "logga dosen",
    "logga den",
    "registrera dos",
    "registrera dosen",
    "registrera tagen dos",
    "markera som tagen"
  ]),
  repeat: new Set([
    "repeat",
    "repeat that",
    "repeat it",
    "repeat answer",
    "repeat the answer",
    "repeat last",
    "repeat last answer",
    "say again",
    "say that again",
    "say it again",
    "read again",
    "read that again",
    "read it again",
    "one more time",
    "toista",
    "toista se",
    "toista vastaus",
    "toista viimeinen",
    "toista viimeisin",
    "toista viimeisin vastaus",
    "sano uudelleen",
    "sano se uudelleen",
    "sano uudestaan",
    "sano se uudestaan",
    "lue uudelleen",
    "lue uudestaan",
    "upprepa",
    "upprepa det",
    "upprepa svaret",
    "upprepa senaste svaret",
    "sag igen",
    "sag det igen",
    "ta det igen",
    "las igen",
    "las det igen"
  ]),
  stop: new Set([
    "stop",
    "stop camera",
    "stop the camera",
    "stop check",
    "stop the check",
    "stop checking",
    "stop session",
    "turn off camera",
    "camera off",
    "cancel",
    "cancel check",
    "lopeta",
    "lopeta tarkistus",
    "lopeta kamera",
    "pysayta",
    "pysayta kamera",
    "pysayta tarkistus",
    "peruuta",
    "sulje kamera",
    "kamera pois",
    "kamera pois paalta",
    "stopp",
    "stoppa",
    "stoppa kameran",
    "stoppa kontroll",
    "stoppa kontrollen",
    "avbryt",
    "avbryt kontroll",
    "avbryt kontrollen",
    "stang av kameran",
    "kamera av"
  ]),
  scan_barcode: new Set([
    "scan barcode",
    "scan the barcode",
    "scan barcode offline",
    "check barcode",
    "check the barcode",
    "read barcode",
    "read the barcode",
    "barcode scan",
    "lue viivakoodi",
    "lue viivakoodi ilman verkkoa",
    "skannaa viivakoodi",
    "tarkista viivakoodi",
    "skanna streckkod",
    "skanna streckkoden",
    "skanna streckkod offline",
    "las streckkod",
    "las streckkoden",
    "kontrollera streckkod",
    "kontrollera streckkoden",
    "kolla streckkod",
    "kolla streckkoden"
  ])
};

export function normalizeIntentPhrase(raw: string): string {
  const folded = raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’ʼ`]/g, "")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!folded) {
    return "";
  }

  const tokens = folded.split(" ");
  while (tokens.length > 1 && COURTESY_WORDS.has(tokens[0])) {
    tokens.shift();
  }
  while (tokens.length > 1 && COURTESY_WORDS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

export function parseLocalIntent(raw: string): LocalCommandIntent {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("?") || trimmed.includes("¿")) {
    return { kind: "question", text: trimmed };
  }

  const normalized = normalizeIntentPhrase(trimmed);
  if (!normalized) {
    return { kind: "question", text: trimmed };
  }

  const tokens = normalized.split(" ");
  if (QUESTION_START_WORDS.has(tokens[0]) || tokens.some((token) => NEGATION_WORDS.has(token))) {
    return { kind: "question", text: trimmed };
  }

  if (tokens[0] === "tog" && tokens[1] === "jag") {
    return { kind: "question", text: trimmed };
  }

  const order: readonly CommandKind[] = ["log_dose", "repeat", "stop", "scan_barcode"];
  for (const kind of order) {
    if (COMMAND_PHRASES[kind].has(normalized)) {
      return { kind };
    }
  }

  return { kind: "question", text: trimmed };
}
