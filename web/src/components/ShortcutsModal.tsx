import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent
} from "react";
import { SHORTCUT_LEGEND, type KeydownHost, type ShortcutAction } from "../a11y/shortcuts.ts";
import { speakFallback } from "../audio/tts.ts";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";

export type ShortcutsModalProps = {
  open: boolean;
  lang: string;
  muted: boolean;
  onClose: () => void;
};

type GlassesControlItem = {
  id: string;
  gesture: string;
  label: string;
  detail: string;
};

type ModalCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  orientationHeading: string;
  playOrientationButton: string;
  mutedHint: string;
  playingStatus: string;
  shortcutsHeading: string;
  shortcutDescriptions: Record<ShortcutAction, string>;
  glassesHeading: string;
  glassesItems: readonly GlassesControlItem[];
  escapeHint: string;
  closeButton: string;
};

const ORIENTATION_SPEECH: Record<UiLocale, string> = {
  en: "Welcome to HoldUp, your hands-free label assistant. Press Space or use your glasses to start a check, hold a medicine box or food pack steady at chest height, and listen to the coaching cues until the label is clear. Once you hear the safety verdict, press L to log a dose or press R anytime to repeat the answer.",
  fi: "Tervetuloa HoldUpiin, kädet vapaana toimivaan etikettiavustajaasi. Aloita tarkistus välilyönnillä tai laseillasi, nosta lääkepakkaus tai ruokapakkaus vakaasti rinnan korkeudelle ja kuuntele ohjeita, kunnes etiketti näkyy selkeästi. Kun kuulet turvallisuusarvion, kirjaa annos painamalla L tai toista vastaus milloin tahansa painamalla R.",
  sv: "Välkommen till HoldUp, din handsfree-assistent för etiketter. Starta en kontroll med blanksteg eller dina glasögon, håll upp en medicinförpackning eller matförpackning stadigt i brösthöjd och lyssna på röstguidningen tills etiketten syns tydligt. När du hör säkerhetsbedömningen trycker du på L för att registrera dosen eller på R när som helst för att upprepa svaret."
};

const MODAL_COPY: Record<UiLocale, ModalCopy> = {
  en: {
    eyebrow: "Accessibility & Controls",
    title: "Keyboard & Gesture Guide",
    subtitle:
      "Use a keyboard, screen reader, or Meta Ray-Ban glasses with Neural Band gestures to check labels hands-free.",
    orientationHeading: "Spoken Audio Orientation",
    playOrientationButton: "Play Spoken Orientation",
    mutedHint: "Audio is muted. Unmute sound to hear the spoken orientation guide.",
    playingStatus: "Playing spoken orientation guide.",
    shortcutsHeading: "Keyboard Shortcuts",
    shortcutDescriptions: {
      toggle_check: "Start or stop live label check",
      snapshot_verify: "Capture and verify a single snapshot",
      offline_barcode: "Scan barcode offline against saved profile",
      log_dose: "Log dose for the matched medication",
      repeat: "Repeat the last spoken verdict or coaching cue",
      cycle_theme: "Cycle visual theme (dark, light, high-contrast)",
      open_privacy: "Open privacy and local data controls"
    },
    glassesHeading: "Meta Ray-Ban & Neural Band Controls",
    glassesItems: [
      {
        id: "capture-voice",
        gesture: "Capture / Voice",
        label: "Capture button / voice ask",
        detail:
          "Press the temple capture button or ask naturally by voice to start a guided label check."
      },
      {
        id: "thumb-swipe",
        gesture: "Left / Right",
        label: "Thumb swipe left/right",
        detail:
          "Swipe your thumb left or right on the Neural Band to move focus across HUD actions."
      },
      {
        id: "index-pinch",
        gesture: "Pinch / Enter",
        label: "Index pinch to confirm",
        detail:
          "Pinch index finger and thumb together (or press Enter) to select the focused action or confirm logging a dose."
      },
      {
        id: "system-back",
        gesture: "Back / Escape",
        label: "System back",
        detail:
          "Use the Neural Band system back gesture (or press Escape) to close overlays or stop an active check."
      }
    ],
    escapeHint: "Press Escape anytime to close this dialog.",
    closeButton: "Close"
  },
  fi: {
    eyebrow: "Saavutettavuus ja ohjaus",
    title: "Pikanäppäimet ja eleohjaus",
    subtitle:
      "Käytä näppäimistöä, ruudunlukijaa tai Meta Ray-Ban -laseja ja Neural Band -eleitä etikettien tarkistamiseen kädet vapaana.",
    orientationHeading: "Puhuttu ääniperehdytys",
    playOrientationButton: "Toista puhuttu opastus",
    mutedHint: "Ääni on mykistetty. Poista mykistys kuullaksesi puhutun opastuksen.",
    playingStatus: "Toistetaan puhuttua opastusta.",
    shortcutsHeading: "Pikanäppäimet",
    shortcutDescriptions: {
      toggle_check: "Aloita tai lopeta reaaliaikainen etiketin tarkistus",
      snapshot_verify: "Ota yksittäinen kuva ja tarkista etiketti",
      offline_barcode: "Lue viivakoodi ilman verkkoa tallennettua profiilia vasten",
      log_dose: "Kirjaa otettu annos tunnistetulle lääkkeelle",
      repeat: "Toista viimeisin puhuttu arvio tai ohje",
      cycle_theme: "Vaihda ulkoasuteemaa (tumma, vaalea, korkea kontrasti)",
      open_privacy: "Avaa tietosuoja ja paikallisten tietojen hallinta"
    },
    glassesHeading: "Meta Ray-Ban ja Neural Band -ohjaus",
    glassesItems: [
      {
        id: "capture-voice",
        gesture: "Capture / Voice",
        label: "Kuvauspainike tai äänikomento",
        detail:
          "Paina sangan kuvauspainiketta tai kysy äänellä aloittaaksesi ohjatun etiketin tarkistuksen."
      },
      {
        id: "thumb-swipe",
        gesture: "Left / Right",
        label: "Peukalon pyyhkäisy vasemmalle tai oikealle",
        detail:
          "Pyyhkäise peukalolla Neural Bandilla vasemmalle tai oikealle siirtääksesi kohdistusta HUD-valinnoissa."
      },
      {
        id: "index-pinch",
        gesture: "Pinch / Enter",
        label: "Etusormen nipistys vahvistaa",
        detail:
          "Nipistä etusormi ja peukalo yhteen (tai paina Enter) valitaksesi kohdistetun toiminnon tai kirjataksesi annoksen."
      },
      {
        id: "system-back",
        gesture: "Back / Escape",
        label: "Järjestelmän paluuele",
        detail:
          "Sulje ikkuna tai lopeta tarkistus Neural Bandin paluueleellä (tai painamalla Escape)."
      }
    ],
    escapeHint: "Sulje tämä valintaikkuna milloin tahansa painamalla Escape.",
    closeButton: "Sulje"
  },
  sv: {
    eyebrow: "Tillgänglighet och styrning",
    title: "Kortkommandon och gestguide",
    subtitle:
      "Använd tangentbord, skärmläsare eller Meta Ray-Ban-glasögon med Neural Band-gester för att kontrollera etiketter handsfree.",
    orientationHeading: "Talad ljudintroduktion",
    playOrientationButton: "Spela upp röstguide",
    mutedHint: "Ljudet är avstängt. Slå på ljudet för att höra röstguiden.",
    playingStatus: "Spelar upp talad röstguide.",
    shortcutsHeading: "Kortkommandon",
    shortcutDescriptions: {
      toggle_check: "Starta eller stoppa direkt etikettkontroll",
      snapshot_verify: "Ta och verifiera en enskild bild",
      offline_barcode: "Skanna streckkod offline mot sparad profil",
      log_dose: "Registrera tagen dos för matchat läkemedel",
      repeat: "Upprepa senaste talade bedömning eller rösttips",
      cycle_theme: "Växla färgtema (mörkt, ljust, hög kontrast)",
      open_privacy: "Öppna integritets- och lokala datakontroller"
    },
    glassesHeading: "Meta Ray-Ban och Neural Band-kontroller",
    glassesItems: [
      {
        id: "capture-voice",
        gesture: "Capture / Voice",
        label: "Kameraknapp eller röstfråga",
        detail:
          "Tryck på skalmens kameraknapp eller fråga med rösten för att starta en guidad etikettkontroll."
      },
      {
        id: "thumb-swipe",
        gesture: "Left / Right",
        label: "Tumsvep vänster eller höger",
        detail:
          "Svep tummen åt vänster eller höger på Neural Band för att flytta fokus mellan HUD-val."
      },
      {
        id: "index-pinch",
        gesture: "Pinch / Enter",
        label: "Pekfingernyp för att bekräfta",
        detail:
          "Nyp ihop pekfinger och tumme (eller tryck Enter) för att välja fokuserad åtgärd eller registrera en dos."
      },
      {
        id: "system-back",
        gesture: "Back / Escape",
        label: "Systembakåt",
        detail:
          "Använd bakåtgesten på Neural Band (eller tryck Escape) för att stänga dialogrutor eller stoppa kontrollen."
      }
    ],
    escapeHint: "Tryck Escape när som helst för att stänga dialogrutan.",
    closeButton: "Stäng"
  }
};

export function getOrientationSpeech(lang: string): string {
  const locale = normalizeLang(lang);
  return ORIENTATION_SPEECH[locale];
}

export async function playOrientationSpeech(lang: string, muted: boolean): Promise<void> {
  if (muted) {
    return;
  }
  await speakFallback(getOrientationSpeech(lang), {
    lang,
    preferServerTts: false
  });
}

export function bindEscapeToClose(
  onClose: () => void,
  options?: { enabled?: boolean; host?: KeydownHost | null }
): () => void {
  if (options?.enabled === false) {
    return () => {};
  }
  const host: KeydownHost | null =
    options?.host !== undefined
      ? options.host
      : typeof window !== "undefined"
        ? window
        : null;
  if (!host) {
    return () => {};
  }

  const listener = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented) {
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    }
  };

  host.addEventListener("keydown", listener);
  return () => {
    host.removeEventListener("keydown", listener);
  };
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1100,
  backgroundColor: "var(--bg-overlay, rgba(6, 9, 15, 0.86))",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "var(--space-4, 16px)",
  overflowY: "auto"
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "780px",
  margin: "auto",
  padding: "var(--space-6, 24px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "2px solid var(--border-strong, #6980a3)",
  boxShadow: "var(--shadow-lg, 0 16px 40px rgba(0, 0, 0, 0.56))",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5, 20px)"
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--accent, #5cc0ff)"
};

const titleStyle: CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: "var(--text-xl, 1.5rem)",
  lineHeight: 1.25,
  fontWeight: 800
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base, 1.125rem)",
  lineHeight: 1.5,
  color: "var(--text-secondary, #d8e1ee)"
};

const sectionCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-4, 16px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg, 1.25rem)",
  lineHeight: 1.3,
  fontWeight: 700
};

const orientationTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base, 1.125rem)",
  lineHeight: 1.55,
  color: "var(--text-primary, #f8fafc)"
};

const mutedNoteStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  fontWeight: 600,
  color: "var(--text-secondary, #d8e1ee)"
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)"
};

const shortcutRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3, 12px)",
  padding: "10px 12px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--bg-surface, #121926)",
  border: "1px solid var(--border-subtle, #2c3a52)"
};

const kbdStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "64px",
  minHeight: "36px",
  padding: "4px 10px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  color: "var(--text-primary, #f8fafc)",
  border: "2px solid var(--border-strong, #6980a3)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800,
  lineHeight: 1.2,
  flexShrink: 0
};

const shortcutDescStyle: CSSProperties = {
  fontSize: "var(--text-base, 1.125rem)",
  lineHeight: 1.4,
  color: "var(--text-primary, #f8fafc)",
  flex: "1 1 220px"
};

const glassesRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "12px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--bg-surface, #121926)",
  border: "1px solid var(--border-subtle, #2c3a52)"
};

const glassesHeaderRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)"
};

const gestureBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 10px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--accent-subtle, rgba(92, 192, 255, 0.16))",
  color: "var(--text-primary, #f8fafc)",
  border: "1.5px solid var(--accent, #5cc0ff)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 700,
  lineHeight: 1.2
};

const glassesDetailStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  lineHeight: 1.45,
  color: "var(--text-secondary, #d8e1ee)"
};

const playButtonStyle: CSSProperties = {
  minHeight: "56px",
  width: "100%",
  padding: "14px 20px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700
};

const footerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3, 12px)"
};

const closeButtonStyle: CSSProperties = {
  minHeight: "56px",
  minWidth: "132px",
  padding: "14px 22px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 700
};

const escapeHintStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm, 1rem)",
  color: "var(--text-secondary, #d8e1ee)"
};

const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0
};

export function ShortcutsModal(props: ShortcutsModalProps) {
  const { open, lang, muted, onClose } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    if (!open) {
      setStatusMessage("");
      return;
    }
    const previous =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, [open]);

  useEffect(() => bindEscapeToClose(onClose, { enabled: open }), [open, onClose]);

  if (!open) {
    return null;
  }

  const locale = normalizeLang(lang);
  const copy = MODAL_COPY[locale];
  const speechText = getOrientationSpeech(lang);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handlePlayOrientation = () => {
    if (muted) {
      setStatusMessage(copy.mutedHint);
      return;
    }
    setStatusMessage(copy.playingStatus);
    void playOrientationSpeech(lang, muted);
  };

  return (
    <div className="shortcuts-modal-backdrop" style={backdropStyle} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        aria-describedby="shortcuts-dialog-subtitle"
        tabIndex={-1}
        lang={locale}
        className="card shortcuts-modal"
        style={dialogStyle}
        onKeyDown={handleDialogKeyDown}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <p style={eyebrowStyle}>{copy.eyebrow}</p>
          <h2 id="shortcuts-dialog-title" style={titleStyle}>
            {copy.title}
          </h2>
          <p id="shortcuts-dialog-subtitle" style={subtitleStyle}>
            {copy.subtitle}
          </p>
        </header>

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          style={srOnlyStyle}
        >
          {statusMessage}
        </div>

        <section
          aria-labelledby="shortcuts-orientation-heading"
          className="shortcuts-orientation-section"
          style={sectionCardStyle}
        >
          <h3 id="shortcuts-orientation-heading" style={sectionHeadingStyle}>
            {copy.orientationHeading}
          </h3>
          <p style={orientationTextStyle}>{speechText}</p>
          <button
            type="button"
            data-action="play-orientation"
            className="btn btn-primary"
            disabled={muted}
            aria-disabled={muted}
            onClick={handlePlayOrientation}
            style={playButtonStyle}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={{ width: "22px", height: "22px", flexShrink: 0 }}
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
            </svg>
            <span>{copy.playOrientationButton}</span>
          </button>
          {muted ? (
            <p role="note" style={mutedNoteStyle}>
              {copy.mutedHint}
            </p>
          ) : null}
        </section>

        <section
          aria-labelledby="shortcuts-keyboard-heading"
          className="shortcuts-keyboard-section"
          style={sectionCardStyle}
        >
          <h3 id="shortcuts-keyboard-heading" style={sectionHeadingStyle}>
            {copy.shortcutsHeading}
          </h3>
          <ul style={listStyle}>
            {SHORTCUT_LEGEND.map((item) => (
              <li key={item.action} className="shortcut-legend-item" style={shortcutRowStyle}>
                <kbd className="shortcut-kbd" style={kbdStyle}>
                  {item.key}
                </kbd>
                <span style={shortcutDescStyle}>
                  {copy.shortcutDescriptions[item.action] ?? item.description}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="shortcuts-glasses-heading"
          className="shortcuts-glasses-section"
          style={sectionCardStyle}
        >
          <h3 id="shortcuts-glasses-heading" style={sectionHeadingStyle}>
            {copy.glassesHeading}
          </h3>
          <ul style={listStyle}>
            {copy.glassesItems.map((item) => (
              <li key={item.id} className="glasses-control-item" style={glassesRowStyle}>
                <div style={glassesHeaderRowStyle}>
                  <span className="badge" style={gestureBadgeStyle}>
                    {item.gesture}
                  </span>
                  <strong style={{ fontSize: "var(--text-base, 1.125rem)" }}>{item.label}</strong>
                </div>
                <p style={glassesDetailStyle}>{item.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <footer style={footerRowStyle}>
          <p style={escapeHintStyle}>{copy.escapeHint}</p>
          <button
            type="button"
            data-action="close-shortcuts"
            className="btn btn-secondary"
            onClick={onClose}
            style={closeButtonStyle}
          >
            {copy.closeButton}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ShortcutsModal;
