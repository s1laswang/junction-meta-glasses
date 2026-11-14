import React, { useId, useState, type CSSProperties, type FormEvent } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { TranscriptEntry, TransportMode } from "../types.ts";

export type ConversationBarProps = {
  transcripts: readonly TranscriptEntry[];
  mode: TransportMode;
  disabled?: boolean;
  lang: string;
  onSubmitQuestion: (question: string) => void;
};

export const MAX_VISIBLE_TRANSCRIPTS = 8;

type ConversationCopy = {
  heading: string;
  quickGroupLabel: string;
  quickQuestions: readonly [string, string, string, string];
  inputLabel: string;
  inputPlaceholder: string;
  inputHintByMode: Record<TransportMode, string>;
  modeBadge: Record<TransportMode, string>;
  askButton: string;
  transcriptLabel: string;
  emptyTranscript: string;
  streamingBadge: string;
};

const COPY_BY_LOCALE: Record<UiLocale, ConversationCopy> = {
  en: {
    heading: "Ask HoldUp or Tap a Quick Check",
    quickGroupLabel: "Quick label questions",
    quickQuestions: [
      "Is this my evening pill?",
      "Does this contain nuts?",
      "What strength is this?",
      "Is it still in date?"
    ],
    inputLabel: "Ask a question or type a command",
    inputPlaceholder: "Ask about a pill, strength, allergen, or type 'I took it'",
    inputHintByMode: {
      live: "Live mode: sends your question to the active voice and camera session, or runs local commands like 'I took it'.",
      snapshot: "Snapshot mode: checks a single photo with your question and speaks the verified answer.",
      offline: "Local Intent mode: runs offline commands like 'scan barcode', 'I took it', or 'repeat'."
    },
    modeBadge: {
      live: "Live Mode",
      snapshot: "Snapshot Mode",
      offline: "Local Intent Mode"
    },
    askButton: "Ask",
    transcriptLabel: "Recent conversation transcript",
    emptyTranscript: "No questions yet. Tap a quick question above, speak, or type below.",
    streamingBadge: "Speaking"
  },
  fi: {
    heading: "Kysy HoldUpilta tai valitse pikakysymys",
    quickGroupLabel: "Pikakysymykset etiketistä",
    quickQuestions: [
      "Onko tämä iltalääkkeeni?",
      "Sisältääkö tämä pähkinää?",
      "Mikä vahvuus tämä on?",
      "Onko päiväys vielä voimassa?"
    ],
    inputLabel: "Kirjoita kysymys tai komento",
    inputPlaceholder: "Kysy lääkkeestä, vahvuudesta, allergeenista tai kirjoita 'otin sen'",
    inputHintByMode: {
      live: "Reaaliaikatila: lähettää kysymyksen käynnissä olevaan istuntoon tai suorittaa paikallisen komennon.",
      snapshot: "Yksittäiskuvatila: tarkistaa kuvan kysymykselläsi ja lukee vastauksen ääneen.",
      offline: "Paikallinen komentotila: suorittaa komennot kuten 'lue viivakoodi', 'otin sen' tai 'toista' ilman verkkoa."
    },
    modeBadge: {
      live: "Reaaliaikatila",
      snapshot: "Yksittäiskuvatila",
      offline: "Paikallinen tila"
    },
    askButton: "Kysy",
    transcriptLabel: "Viimeisin keskustelu",
    emptyTranscript: "Ei vielä kysymyksiä. Valitse pikakysymys yltä, puhu tai kirjoita alle.",
    streamingBadge: "Kesken"
  },
  sv: {
    heading: "Fråga HoldUp eller välj en snabbfråga",
    quickGroupLabel: "Snabbfrågor om etiketten",
    quickQuestions: [
      "Är det här min kvällsmedicin?",
      "Innehåller det här nötter?",
      "Vilken styrka är det här?",
      "Är datumet fortfarande giltigt?"
    ],
    inputLabel: "Skriv en fråga eller ett kommando",
    inputPlaceholder: "Fråga om medicin, styrka, allergener eller skriv 'jag tog den'",
    inputHintByMode: {
      live: "Direktläge: skickar din fråga till aktiv röst- och kamerasession eller kör lokala kommandon.",
      snapshot: "Stillbildsläge: kontrollerar en bild med din fråga och läser upp svaret.",
      offline: "Lokalt kommandoläge: kör kommandon som 'skanna streckkod', 'jag tog den' eller 'upprepa' offline."
    },
    modeBadge: {
      live: "Direktläge",
      snapshot: "Stillbildsläge",
      offline: "Lokalt läge"
    },
    askButton: "Fråga",
    transcriptLabel: "Senaste samtal",
    emptyTranscript: "Inga frågor ännu. Välj en snabbfråga ovan, tala eller skriv nedan.",
    streamingBadge: "Pågår"
  }
};

export function getQuickQuestions(lang: string): readonly [string, string, string, string] {
  const locale = normalizeLang(lang);
  return COPY_BY_LOCALE[locale].quickQuestions;
}

export function selectRollingTranscripts(
  transcripts: readonly TranscriptEntry[],
  limit: number = MAX_VISIBLE_TRANSCRIPTS
): TranscriptEntry[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_VISIBLE_TRANSCRIPTS;
  return transcripts.slice(-safeLimit);
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2, 8px)"
};

const CHIP_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2, 8px)"
};

const CHIP_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  padding: "10px 16px",
  borderRadius: "var(--radius-pill, 9999px)",
  fontWeight: 700,
  fontSize: "var(--text-sm, 1rem)",
  textAlign: "left"
};

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)"
};

const INPUT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2, 8px)",
  alignItems: "stretch"
};

const TEXT_INPUT_STYLE: CSSProperties = {
  minHeight: "56px",
  flex: "1 1 240px"
};

const SUBMIT_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "104px",
  paddingInline: "22px",
  fontWeight: 800,
  flex: "0 0 auto"
};

const TRANSCRIPT_REGION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)",
  padding: "var(--space-3, 12px)",
  borderRadius: "var(--radius-md, 12px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "1px solid var(--border-subtle, #2c3a52)"
};

const TRANSCRIPT_LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 8px)"
};

export function ConversationBar(props: ConversationBarProps) {
  const { transcripts, mode, disabled = false, lang, onSubmitQuestion } = props;
  const uid = useId();
  const [draft, setDraft] = useState("");

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const isDisabled = Boolean(disabled);
  const visibleTranscripts = selectRollingTranscripts(transcripts, MAX_VISIBLE_TRANSCRIPTS);

  const headingId = `${uid}-conversation-heading`;
  const inputId = `${uid}-question-input`;
  const hintId = `${uid}-mode-hint`;

  const handleChipClick = (question: string) => {
    if (isDisabled) {
      return;
    }
    onSubmitQuestion(question);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isDisabled) {
      return;
    }
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }
    onSubmitQuestion(trimmed);
    setDraft("");
  };

  return (
    <section
      className="card conversation-bar"
      lang={locale}
      aria-labelledby={headingId}
      style={SECTION_STYLE}
    >
      <div style={HEADER_ROW_STYLE}>
        <h2
          id={headingId}
          style={{
            margin: 0,
            fontSize: "var(--text-lg, 1.25rem)",
            fontWeight: 800,
            lineHeight: 1.25
          }}
        >
          {copy.heading}
        </h2>
        <span className="pill conversation-mode-pill" data-mode={mode}>
          {copy.modeBadge[mode]}
        </span>
      </div>

      <div
        role="group"
        aria-label={copy.quickGroupLabel}
        className="conversation-quick-chips"
        style={CHIP_ROW_STYLE}
      >
        {copy.quickQuestions.map((question, idx) => (
          <button
            key={`${locale}-chip-${idx}`}
            type="button"
            className="chip conversation-quick-chip"
            data-quick-index={idx}
            disabled={isDisabled}
            aria-disabled={isDisabled}
            onClick={() => handleChipClick(question)}
            style={CHIP_BUTTON_STYLE}
          >
            {question}
          </button>
        ))}
      </div>

      <form className="conversation-form" onSubmit={handleSubmit} style={FORM_STYLE}>
        <label
          htmlFor={inputId}
          className="conversation-input-label"
          style={{
            fontWeight: 700,
            fontSize: "var(--text-sm, 1rem)",
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {copy.inputLabel}
        </label>

        <div style={INPUT_ROW_STYLE}>
          <input
            id={inputId}
            name="question"
            type="text"
            className="input conversation-input"
            placeholder={copy.inputPlaceholder}
            aria-describedby={hintId}
            autoComplete="off"
            value={draft}
            disabled={isDisabled}
            onChange={(event) => setDraft(event.target.value)}
            style={TEXT_INPUT_STYLE}
          />
          <button
            type="submit"
            className="btn btn-primary conversation-submit-btn"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            style={SUBMIT_BUTTON_STYLE}
          >
            {copy.askButton}
          </button>
        </div>

        <p
          id={hintId}
          className="conversation-mode-hint"
          style={{
            margin: 0,
            fontSize: "var(--text-xs, 0.875rem)",
            color: "var(--text-secondary, #d8e1ee)",
            lineHeight: 1.4
          }}
        >
          {copy.inputHintByMode[mode]}
        </p>
      </form>

      <div
        className="conversation-transcript-region"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        aria-label={copy.transcriptLabel}
        style={TRANSCRIPT_REGION_STYLE}
      >
        {visibleTranscripts.length === 0 ? (
          <p
            className="conversation-transcript-empty"
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              color: "var(--text-muted, #b5c2d6)",
              lineHeight: 1.45
            }}
          >
            {copy.emptyTranscript}
          </p>
        ) : (
          <ol className="conversation-transcript-list" style={TRANSCRIPT_LIST_STYLE}>
            {visibleTranscripts.map((entry) => {
              const isUser = entry.role === "user";
              const speakerLabel = isUser ? "You" : "HoldUp";
              return (
                <li
                  key={entry.id}
                  className={`conversation-transcript-item transcript-role-${entry.role}`}
                  data-role={entry.role}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "flex-start",
                    gap: "10px",
                    padding: "10px 12px",
                    borderRadius: "var(--radius-sm, 8px)",
                    backgroundColor: "var(--bg-surface, #121926)",
                    border: isUser
                      ? "1.5px solid var(--border-strong, #6980a3)"
                      : "1.5px solid var(--accent, #5cc0ff)"
                  }}
                >
                  <span
                    className={`badge transcript-speaker-badge transcript-badge-${entry.role}`}
                    style={{
                      backgroundColor: isUser
                        ? "var(--bg-elevated, #1a2333)"
                        : "var(--accent, #5cc0ff)",
                      color: isUser
                        ? "var(--text-primary, #f8fafc)"
                        : "var(--accent-fg, #04111f)",
                      borderColor: isUser
                        ? "var(--border-strong, #6980a3)"
                        : "var(--accent, #5cc0ff)",
                      fontWeight: 800,
                      flexShrink: 0
                    }}
                  >
                    {speakerLabel}
                  </span>

                  <span
                    className="transcript-text"
                    style={{
                      flex: "1 1 180px",
                      fontSize: "var(--text-base, 1.125rem)",
                      lineHeight: 1.45,
                      color: "var(--text-primary, #f8fafc)"
                    }}
                  >
                    {entry.text}
                  </span>

                  {!entry.final && (
                    <span
                      className="pill transcript-partial-indicator"
                      style={{
                        fontSize: "var(--text-xs, 0.875rem)",
                        padding: "2px 8px"
                      }}
                    >
                      {copy.streamingBadge}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

export default ConversationBar;
