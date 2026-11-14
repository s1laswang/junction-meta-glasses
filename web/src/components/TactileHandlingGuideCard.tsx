import React, { type CSSProperties } from "react";
import { cueLabel, normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { CoachCue } from "../types.ts";

void React;

export type TactileTechniqueId =
  | "chest_anchor"
  | "bottle_quarter_turn"
  | "blister_glare_tilt"
  | "carton_barcode_find";

export type TactileHoldTechnique = {
  id: TactileTechniqueId;
  title: string;
  summary: string;
  spokenTip: string;
  relatedCue: CoachCue;
};

export type TactileHandlingGuideCardProps = {
  lang: string;
  activeCue?: CoachCue | null;
  onSpeakTip?: (spokenTip: string) => void;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  povPill: string;
  idleStatusPill: string;
  matchedStatusPill: (title: string) => string;
  unmatchedCuePill: (cueText: string) => string;
  listAriaLabel: string;
  pairedCuePrefix: string;
  activeMatchBadge: string;
  spokenPreviewLabel: string;
  hearTipLabel: string;
  hearTipAria: (title: string) => string;
};

const TECHNIQUES_BY_LOCALE: Record<UiLocale, readonly TactileHoldTechnique[]> = {
  en: [
    {
      id: "chest_anchor",
      title: "Sternum Chest Anchor",
      summary:
        "Tuck both elbows lightly against your ribs and hold the package by its bottom corners at sternum height, 25 to 30 cm ahead, keeping thumbs off printed text.",
      spokenTip:
        "Rest your elbows against your ribs and hold the bottom corners at chest height, about one hand-span from your chest, so the glasses camera frames the label steadily without your thumb covering the dose.",
      relatedCue: "hold_still"
    },
    {
      id: "bottle_quarter_turn",
      title: "Bottle Quarter-Turn Roll",
      summary:
        "Pinch a round pill bottle by its cap and bottom rim, rotating it left in 90-degree quarter-turns with a brief pause so multi-frame capture reads curved strength text.",
      spokenTip:
        "Hold the bottle cap with one hand and the bottom rim with the other. Turn it left a quarter-turn and pause for one beat so the glasses capture the full curved label.",
      relatedCue: "rotate_left"
    },
    {
      id: "blister_glare_tilt",
      title: "Blister Foil Glare Tilt",
      summary:
        "Pinch the flat corner margin of a silver blister strip and angle the foil 15 degrees downward to bounce overhead ceiling glare away from printed tablet strengths.",
      spokenTip:
        "Hold the outer corner of the blister strip and tilt the top edge slightly forward, about 15 degrees, to clear ceiling light reflections off the metallic foil.",
      relatedCue: "more_light"
    },
    {
      id: "carton_barcode_find",
      title: "Carton Seam & Barcode Flip",
      summary:
        "Feel for raised Braille dots, the tuck-flap notch, or the matte pharmacy sticker, then flip the carton 180 degrees to expose the opposite prescription or EAN barcode panel.",
      spokenTip:
        "Slide a fingertip across the box to find raised Braille dots or the pharmacy sticker edge. If HoldUp asks for the other side, flip the carton halfway around to show the front label or barcode.",
      relatedCue: "other_side"
    }
  ],
  fi: [
    {
      id: "chest_anchor",
      title: "Rintakehän tukipiste",
      summary:
        "Nojaa kyynärpäät kevyesti kylkiin ja pidä pakkauksen alakulmista kiinni rintalastan korkeudella noin 25-30 cm etäisyydellä niin, etteivät peukalot peitä tekstiä.",
      spokenTip:
        "Tue kyynärpäät kylkiin ja pidä pakkauksen alareunoista kiinni rinnan korkeudella noin vaaksan päässä rinnasta, jolloin lasien kamera näkee etiketin vakaasti ilman että peukalo peittää vahvuutta.",
      relatedCue: "hold_still"
    },
    {
      id: "bottle_quarter_turn",
      title: "Lääkepurkin neljänneskierros",
      summary:
        "Ota pyöreästä lääkepurkista ote korkista ja pohjareunasta, käännä 90 astetta vasemmalle ja pysähdy hetkeksi, jotta moniruutuluku yhdistää kaarevan etiketin.",
      spokenTip:
        "Pidä toisella kädellä purkin korkista ja toisella pohjareunasta. Käännä purkkia neljänneskierros vasemmalle ja pysähdy hetkeksi, jotta lasit lukevat kaarevan vahvuustekstin.",
      relatedCue: "rotate_left"
    },
    {
      id: "blister_glare_tilt",
      title: "Läpipainoliuskan heijastuskallistus",
      summary:
        "Tartu metallisen läpipainoliuskan kulmareunaan ja kallista pintaa 15 astetta alaviistoon, jotta kattovalon kiilto ei peitä painettua vahvuutta.",
      spokenTip:
        "Pidä kiinni liuskan ulkokulmasta ja kallista yläreunaa hieman eteenpäin noin 15 astetta, jotta kattovalon heijastus poistuu kiiltävältä foliopinnalta.",
      relatedCue: "more_light"
    },
    {
      id: "carton_barcode_find",
      title: "Kotelon sauma- ja viivakoodikääntö",
      summary:
        "Tunnustele pistekirjoitusnystyrät, avausläpän lovi tai apteekin mattatarra ja käännä kotelo 180 astetta ympäri tuodaksesi reseptietiketin tai viivakoodin esiin.",
      spokenTip:
        "Tunnustele sormenpäällä kotelon pistekirjoitusta tai apteekkitarran reunaa. Jos HoldUp pyytää toista puolta, käännä pakkaus puoli kierrosta ympäri etiketin tai viivakoodin näyttämiseksi.",
      relatedCue: "other_side"
    }
  ],
  sv: [
    {
      id: "chest_anchor",
      title: "Bröstbensankare",
      summary:
        "Stöd armbågarna lätt mot revbenen och håll i förpackningens nederhörn i brösthöjd cirka 25-30 cm framför dig med tummarna borta från texten.",
      spokenTip:
        "Vila armbågarna mot sidan av kroppen och håll i de nedre hörnen i brösthöjd ungefär ett handspann ut, så att glasögonkameran får skarp bild utan att tummen skymmer styrkan.",
      relatedCue: "hold_still"
    },
    {
      id: "bottle_quarter_turn",
      title: "Kvartsvridning för burk",
      summary:
        "Håll en rund pillerburk i locket och bottenkanten, vrid 90 grader åt vänster i steg med kort paus så att flerbildsavläsningen fångar den böjda styrketexten.",
      spokenTip:
        "Greppa locket med ena handen och bottenkanten med den andra. Vrid burken ett kvarts varv åt vänster och stanna upp kort så att glasögonen läser hela den rundade etiketten.",
      relatedCue: "rotate_left"
    },
    {
      id: "blister_glare_tilt",
      title: "Vinkla bort blisterblänk",
      summary:
        "Håll i ytterhörnet på en silverfärgad blisterkarta och vinkla folien 15 grader svagt nedåt för att leda bort taklampans blänk från tryckt styrketext.",
      spokenTip:
        "Håll i blisterkartans ytterkant och vinkla överkanten lätt framåt, ungefär 15 grader, så att skarpa ljusreflexer försvinner från metallfolien.",
      relatedCue: "more_light"
    },
    {
      id: "carton_barcode_find",
      title: "Känn skarv och vänd mot streckkod",
      summary:
        "Känn efter upphöjd punktskrift, öppningsflikens skåra eller den matta apoteksetiketten och vänd kartongen 180 grader för att visa receptsidan eller EAN-streckkoden.",
      spokenTip:
        "Dra fingertoppen över asken för att hitta punktskrift eller kanten på apoteksetiketten. Om HoldUp ber om andra sidan, vänd kartongen ett halvt varv så att framsidan eller streckkoden syns.",
      relatedCue: "other_side"
    }
  ]
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "Proprioceptive First-Person Framing",
    heading: "Tactile & Proprioceptive Hold Guide",
    subtitle:
      "Four hands-free body-anchored holds that align curved bottles, shiny blister foil, and pharmacy cartons with the Meta AI Glasses nose-bridge camera.",
    povPill: "First-Person Glasses POV",
    idleStatusPill: "4 Tactile Holds Ready",
    matchedStatusPill: (title) => `Active Hold: ${title}`,
    unmatchedCuePill: (cueText) => `Live Cue: ${cueText}`,
    listAriaLabel: "Four tactile and proprioceptive package handling techniques",
    pairedCuePrefix: "Cue",
    activeMatchBadge: "ACTIVE CUE",
    spokenPreviewLabel: "Spoken audio tip",
    hearTipLabel: "Hear Tip",
    hearTipAria: (title) => `Hear Tip: ${title}`
  },
  fi: {
    eyebrow: "Kehotuntoon perustuva lasirajaus",
    heading: "Tunto- ja asento-opas pakkausten pitelyyn",
    subtitle:
      "Neljä kädet vapaana -otetta, jotka linjaavat pyöreät purkit, kiiltävät läpipainoliuskat ja apteekkikotelot suoraan Meta AI -lasien kameran eteen.",
    povPill: "Lasien 1. persoonan näkymä",
    idleStatusPill: "4 tunto-otetta valmiina",
    matchedStatusPill: (title) => `Aktiivinen ote: ${title}`,
    unmatchedCuePill: (cueText) => `Ohjaus: ${cueText}`,
    listAriaLabel: "Neljä tunto- ja asentoperusteista pakkauksen pitelytekniikkaa",
    pairedCuePrefix: "Vihje",
    activeMatchBadge: "AKTIIVINEN OHJE",
    spokenPreviewLabel: "Puhuttava äänivinkki",
    hearTipLabel: "Kuuntele ohje",
    hearTipAria: (title) => `Kuuntele ohje: ${title}`
  },
  sv: {
    eyebrow: "Proprioceptiv inramning i förstapersonsvy",
    heading: "Taktil och proprioceptiv greppguide",
    subtitle:
      "Fyra kroppsförankrade grepp som riktar runda burkar, blanka blisterkartor och apotekskartonger rakt mot Meta AI-glasögonens kamera.",
    povPill: "Förstapersonsvy i glasögon",
    idleStatusPill: "4 taktila grepp redo",
    matchedStatusPill: (title) => `Aktivt grepp: ${title}`,
    unmatchedCuePill: (cueText) => `Aktiv signal: ${cueText}`,
    listAriaLabel: "Fyra taktila och proprioceptiva grepp för läkemedelsförpackningar",
    pairedCuePrefix: "Signal",
    activeMatchBadge: "AKTIV SIGNAL",
    spokenPreviewLabel: "Talat ljudtips",
    hearTipLabel: "Lyssna på tips",
    hearTipAria: (title) => `Lyssna på tips: ${title}`
  }
};

export function getTactileHoldTechniques(lang: string): TactileHoldTechnique[] {
  const locale = normalizeLang(lang);
  return TECHNIQUES_BY_LOCALE[locale].map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    spokenTip: item.spokenTip,
    relatedCue: item.relatedCue
  }));
}

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
  boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
};

const GRID_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const HEAR_TIP_BUTTON_STYLE: CSSProperties = {
  width: "100%",
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 16px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800
};

function TactileHoldIcon({ id }: { id: TactileTechniqueId }) {
  const iconStyle: CSSProperties = { width: "24px", height: "24px", flexShrink: 0 };

  if (id === "chest_anchor") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className="tactile-hold-icon"
        data-hold-icon="chest_anchor"
        style={iconStyle}
      >
        <path d="M4 7c2.2-1.8 5-2.7 8-2.7s5.8.9 8 2.7" />
        <path d="M5 11l2.5 6h3" />
        <path d="M19 11l-2.5 6h-3" />
        <rect x="8.5" y="9.5" width="7" height="7" rx="1.5" />
        <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (id === "bottle_quarter_turn") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className="tactile-hold-icon"
        data-hold-icon="bottle_quarter_turn"
        style={iconStyle}
      >
        <rect x="9" y="3" width="6" height="3" rx="1" />
        <rect x="7.5" y="6" width="9" height="14" rx="2.5" />
        <line x1="7.5" y1="11" x2="16.5" y2="11" />
        <path d="M20 13a8 8 0 0 1-14.5 4.5" />
        <polyline points="4.5 14.5 5.5 17.8 8.8 17" />
      </svg>
    );
  }

  if (id === "blister_glare_tilt") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className="tactile-hold-icon"
        data-hold-icon="blister_glare_tilt"
        style={iconStyle}
      >
        <polygon points="4 9 16 6 20 17 8 20" />
        <circle cx="10.5" cy="11.5" r="1.3" />
        <circle cx="14.5" cy="10.5" r="1.3" />
        <circle cx="12" cy="15.5" r="1.3" />
        <circle cx="16" cy="14.5" r="1.3" />
        <path d="M5 3l3.5 3.5L12 3" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="tactile-hold-icon"
      data-hold-icon="carton_barcode_find"
      style={iconStyle}
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4a3 3 0 0 0 6 0" />
      <line x1="8" y1="10" x2="8" y2="16" />
      <line x1="11" y1="10" x2="11" y2="16" />
      <line x1="13.5" y1="10" x2="13.5" y2="16" />
      <line x1="16" y1="10" x2="16" y2="16" />
    </svg>
  );
}

export function TactileHandlingGuideCard(props: TactileHandlingGuideCardProps) {
  const { lang, activeCue = null, onSpeakTip } = props;

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const techniques = getTactileHoldTechniques(locale);
  const hasSpeakTip = typeof onSpeakTip === "function";

  const headingId = "tactile-handling-guide-heading";
  const matchedTechnique =
    activeCue !== null ? (techniques.find((item) => item.relatedCue === activeCue) ?? null) : null;

  const statusText =
    matchedTechnique !== null
      ? copy.matchedStatusPill(matchedTechnique.title)
      : activeCue !== null
        ? copy.unmatchedCuePill(cueLabel(locale, activeCue))
        : copy.idleStatusPill;

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card tactile-handling-guide-card"
      data-active-cue={activeCue ?? "none"}
      data-highlighted-technique={matchedTechnique ? matchedTechnique.id : "none"}
      style={CARD_STYLE}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            flex: "1 1 320px"
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--accent, #5cc0ff)"
            }}
          >
            {copy.eyebrow}
          </p>

          <h2
            id={headingId}
            style={{
              margin: 0,
              fontSize: "var(--text-lg, 1.25rem)",
              lineHeight: 1.28,
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.heading}
          </h2>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              lineHeight: 1.45,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.subtitle}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            role="status"
            aria-live="polite"
            className="badge tactile-guide-status-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              ...(matchedTechnique !== null
                ? {
                    backgroundColor: "var(--verdict-match-bg, #06261d)",
                    color: "var(--verdict-match-fg, #7ef7c8)",
                    border: "2px solid var(--verdict-match-border, #2dd4a0)"
                  }
                : {
                    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
                    color: "var(--verdict-info-fg, #a6d4ff)",
                    border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)"
                  })
            }}
          >
            {statusText}
          </span>

          <span
            className="pill tactile-guide-pov-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              color: "var(--text-primary, #f8fafc)",
              border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700
            }}
          >
            {copy.povPill}
          </span>
        </div>
      </header>

      <ul
        aria-label={copy.listAriaLabel}
        className="tactile-technique-grid"
        style={GRID_STYLE}
      >
        {techniques.map((item, idx) => {
          const isHighlighted = activeCue !== null && item.relatedCue === activeCue;
          const stepNumber = String(idx + 1).padStart(2, "0");
          const pairedCueText = cueLabel(locale, item.relatedCue);

          return (
            <li
              key={item.id}
              data-technique-id={item.id}
              data-related-cue={item.relatedCue}
              data-highlighted={isHighlighted ? "true" : "false"}
              aria-current={isHighlighted ? "step" : undefined}
              className={`tactile-technique-item tactile-technique-${item.id}${isHighlighted ? " is-highlighted" : ""}`}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "12px",
                padding: "var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                border: isHighlighted
                  ? "2px solid var(--verdict-match-border, #2dd4a0)"
                  : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px"
                  }}
                >
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "10px"
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "44px",
                        height: "44px",
                        borderRadius: "var(--radius-md, 12px)",
                        ...(isHighlighted
                          ? {
                              backgroundColor: "var(--verdict-match-bg, #06261d)",
                              color: "var(--verdict-match-fg, #7ef7c8)",
                              border: "2px solid var(--verdict-match-border, #2dd4a0)"
                            }
                          : {
                              backgroundColor: "var(--bg-surface, #121926)",
                              color: "var(--accent, #5cc0ff)",
                              border: "1.5px solid var(--border-strong, #6980a3)"
                            })
                      }}
                    >
                      <TactileHoldIcon id={item.id} />
                    </span>

                    <span
                      aria-hidden="true"
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 800,
                        color: "var(--text-muted, #b5c2d6)"
                      }}
                    >
                      {stepNumber}
                    </span>
                  </div>

                  {isHighlighted ? (
                    <span
                      className="badge tactile-technique-active-badge"
                      style={{
                        padding: "4px 10px",
                        borderRadius: "var(--radius-sm, 8px)",
                        backgroundColor: "var(--verdict-match-bg, #06261d)",
                        color: "var(--verdict-match-fg, #7ef7c8)",
                        border: "1.5px solid var(--verdict-match-border, #2dd4a0)",
                        fontSize: "0.78rem",
                        fontWeight: 800,
                        letterSpacing: "0.04em"
                      }}
                    >
                      {copy.activeMatchBadge}
                    </span>
                  ) : null}
                </div>

                <h3
                  id={`tactile-tech-title-${item.id}`}
                  style={{
                    margin: 0,
                    fontSize: "var(--text-base, 1.125rem)",
                    fontWeight: 800,
                    lineHeight: 1.3,
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {item.title}
                </h3>

                <p
                  className="tactile-technique-summary"
                  style={{
                    margin: 0,
                    fontSize: "var(--text-sm, 1rem)",
                    lineHeight: 1.45,
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {item.summary}
                </p>

                <div
                  className="tactile-technique-cue-tag"
                  style={{
                    alignSelf: "flex-start",
                    padding: "4px 10px",
                    borderRadius: "var(--radius-sm, 8px)",
                    backgroundColor: "var(--bg-surface, #121926)",
                    color: "var(--text-primary, #f8fafc)",
                    border: "1.5px solid var(--border-strong, #6980a3)",
                    fontSize: "var(--text-xs, 0.875rem)",
                    fontWeight: 700
                  }}
                >
                  {`${copy.pairedCuePrefix}: ${pairedCueText}`}
                </div>

                <p
                  aria-label={`${copy.spokenPreviewLabel}: ${item.title}`}
                  className="tactile-technique-spoken-tip"
                  style={{
                    margin: 0,
                    padding: "10px 12px",
                    borderRadius: "var(--radius-sm, 8px)",
                    backgroundColor: "var(--bg-surface, #121926)",
                    border: "1px solid var(--border-subtle, #2c3a52)",
                    fontSize: "var(--text-xs, 0.875rem)",
                    lineHeight: 1.45,
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {`"${item.spokenTip}"`}
                </p>
              </div>

              {hasSpeakTip ? (
                <button
                  type="button"
                  className={`btn ${isHighlighted ? "btn-primary" : "btn-secondary"} tactile-hear-tip-btn`}
                  data-technique-id={item.id}
                  data-action="speak-tip"
                  aria-label={copy.hearTipAria(item.title)}
                  onClick={() => onSpeakTip(item.spokenTip)}
                  style={HEAR_TIP_BUTTON_STYLE}
                >
                  <span>{copy.hearTipLabel}</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default TactileHandlingGuideCard;
