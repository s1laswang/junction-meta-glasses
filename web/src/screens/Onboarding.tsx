import { useEffect, useRef, useState } from "react";
import { Icon, Logo } from "../components/Icons.tsx";
import { classifyError, explain, mediaSupported, platformHint, queryPermission, type PermState } from "../lib/media.ts";
import { announce, unlockFeedback } from "../lib/feedback.ts";

function useFocusHeading(dep: unknown) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [dep]);
  return ref;
}

const CARDS = [
  {
    icon: <Icon.camera size={56} />,
    title: "What HoldUp captures",
    points: [
      "Camera pictures, only while a check is running. You start it, a CAMERA ON sign and a sound tell you it's on, and it turns off by itself after 45 seconds without a label.",
      "Your voice, only while you're in a check.",
      "No pictures are taken in the background, ever.",
    ],
  },
  {
    icon: <Icon.cloud size={56} />,
    title: "Where it goes",
    points: [
      "Pictures and voice travel over an encrypted connection to Google's Gemini AI, which reads the label and talks to you.",
      "HoldUp handles them in memory and does not store your pictures, audio or what you said.",
      "People in view are ignored. HoldUp never describes faces.",
    ],
  },
  {
    icon: <Icon.phone size={56} />,
    title: "What stays on this phone",
    points: [
      "Your medicine list, allergies and dose log are saved only on this phone.",
      "You can delete everything with one button in Privacy.",
      "HoldUp is not a medical device. It never guesses a dose, and when it isn't sure it tells you to ask a pharmacist.",
    ],
  },
];

export function Consent({ onAgree, onNotNow }: { onAgree: () => void; onNotNow: () => void }) {
  const [i, setI] = useState(-1); // -1 = welcome
  const h = useFocusHeading(i);
  if (i === -1)
    return (
      <main className="onb">
        <Logo size={64} />
        <div className="body">
          <h1 ref={h} tabIndex={-1}>
            HoldUp
          </h1>
          <p className="hero-tag">Hold it up. Know it's the right one.</p>
          <p className="lede">Hold a medicine box or food package in front of the camera. HoldUp guides you until the label is readable, then tells you if it's the right one for you.</p>
          <p className="lede">First, three short things about your privacy.</p>
        </div>
        <div className="actions">
          <button className="btn primary wide" onClick={() => (unlockFeedback(), setI(0))}>
            Continue
          </button>
        </div>
      </main>
    );
  const c = CARDS[i];
  const last = i === CARDS.length - 1;
  return (
    <main className="onb">
      <div className="progress" role="progressbar" aria-label="Privacy explanation" aria-valuemin={1} aria-valuemax={CARDS.length} aria-valuenow={i + 1} aria-valuetext={`Card ${i + 1} of ${CARDS.length}`}>
        {CARDS.map((_, k) => (
          <span key={k} className={k <= i ? "on" : ""} />
        ))}
      </div>
      <div className="body">
        <div className="art">{c.icon}</div>
        <h1 ref={h} tabIndex={-1}>
          <span className="sr-only">
            {i + 1} of {CARDS.length}:{" "}
          </span>
          {c.title}
        </h1>
        <ul>
          {c.points.map((p, k) => (
            <li key={k}>
              <Icon.check size={24} />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="actions">
        {last ? (
          <>
            <button className="btn primary wide" onClick={onAgree}>
              I agree
            </button>
            <button className="btn wide" onClick={onNotNow}>
              Not now
            </button>
          </>
        ) : (
          <button className="btn primary wide" onClick={() => setI(i + 1)}>
            Next
          </button>
        )}
        {i > 0 ? (
          <button className="btn ghost wide" onClick={() => setI(i - 1)}>
            Back
          </button>
        ) : null}
      </div>
    </main>
  );
}

export type PermResult = { camera: PermState; mic: PermState };

/** In-context request for camera + mic, with a plain explanation. */
export function PermissionStep({ onDone }: { onDone: (r: PermResult) => void }) {
  const h = useFocusHeading(0);
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState<PermState>("unknown");
  const [mic, setMic] = useState<PermState>("unknown");

  useEffect(() => {
    void (async () => {
      const [c, m] = await Promise.all([queryPermission("camera"), queryPermission("microphone")]);
      setCam(c);
      setMic(m);
      if (c === "granted" && m === "granted") onDone({ camera: c, mic: m });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask() {
    setBusy(true);
    unlockFeedback();
    let c: PermState = "unknown";
    let m: PermState = "unknown";
    if (!window.isSecureContext) {
      c = m = "insecure";
    } else if (!mediaSupported()) {
      c = m = "unavailable";
    } else {
      // ask separately so one "no" doesn't hide the other answer
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        s.getTracks().forEach((t) => t.stop());
        c = "granted";
      } catch (e) {
        c = classifyError(e);
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        m = "granted";
      } catch (e) {
        m = classifyError(e);
      }
    }
    setBusy(false);
    setCam(c);
    setMic(m);
    announce(c === "granted" && m === "granted" ? "Camera and microphone allowed." : "Some access was not allowed.", "assertive");
    onDone({ camera: c, mic: m });
  }

  return (
    <main className="onb">
      <div className="body">
        <div className="art">
          <Icon.camera size={56} />
        </div>
        <h1 ref={h} tabIndex={-1}>
          Camera and microphone
        </h1>
        <p className="lede">To read a label, HoldUp needs to see it and hear your question. Your phone will ask you to allow both.</p>
        <ul>
          <li>
            <Icon.camera size={24} />
            <span>The camera is only on during a check, and you'll always hear and see when it is.</span>
          </li>
          <li>
            <Icon.mic size={24} />
            <span>The microphone lets you ask "is this my evening pill?" without touching the screen.</span>
          </li>
        </ul>
        {cam === "blocked" || mic === "blocked" ? <p className="muted">Your browser has already blocked access for this site. The next screen shows how to turn it back on.</p> : null}
      </div>
      <div className="actions">
        <button className="btn primary wide" onClick={ask} disabled={busy} aria-busy={busy}>
          {busy ? "Waiting for your answer…" : "Allow camera and microphone"}
        </button>
        <button className="btn wide" onClick={() => onDone({ camera: cam === "granted" ? cam : "denied", mic: mic === "granted" ? mic : "denied" })}>
          Not now
        </button>
      </div>
    </main>
  );
}

/** Shown when camera or mic is denied, blocked, missing or needs https. */
export function PermissionRecovery({ result, onRetry, onContinue }: { result: PermResult; onRetry: () => void; onContinue: () => void }) {
  const h = useFocusHeading(result);
  const plat = platformHint();
  const camOk = result.camera === "granted";
  const micOk = result.mic === "granted";
  const needsSettings = [result.camera, result.mic].some((s) => s === "denied" || s === "blocked");
  const insecure = [result.camera, result.mic].includes("insecure");
  return (
    <main className="onb">
      <div className="body">
        <div className="art" style={{ borderColor: "var(--warning)", color: "var(--warning)" }}>
          <Icon.lock size={56} />
        </div>
        <h1 ref={h} tabIndex={-1}>
          {!camOk && !micOk ? "HoldUp can't use the camera or microphone yet" : !camOk ? "HoldUp can't use the camera yet" : "HoldUp can't use the microphone yet"}
        </h1>
        <ul>
          {!camOk ? (
            <li>
              <Icon.camera size={24} />
              <span>{explain("camera", result.camera) || "The camera is off."}</span>
            </li>
          ) : null}
          {!micOk ? (
            <li>
              <Icon.mic size={24} />
              <span>{explain("mic", result.mic) || "The microphone is off."}</span>
            </li>
          ) : null}
        </ul>
        {needsSettings && !insecure ? (
          <section className="card stack" aria-labelledby="howto">
            <h2 id="howto">How to turn it on</h2>
            {plat === "ios" ? (
              <ol className="stack" style={{ margin: 0, paddingLeft: "1.3em" }}>
                <li>Tap "aA" (or the page menu) in Safari's address bar.</li>
                <li>Choose "Website Settings".</li>
                <li>Set Camera and Microphone to "Allow".</li>
                <li>
                  Or open the Settings app, then Apps, Safari, and set Camera and Microphone to "Allow". Then come back and tap "Try again".
                </li>
              </ol>
            ) : plat === "android" ? (
              <ol className="stack" style={{ margin: 0, paddingLeft: "1.3em" }}>
                <li>Tap the settings icon to the left of the web address in Chrome.</li>
                <li>Tap "Permissions".</li>
                <li>Turn on Camera and Microphone.</li>
                <li>Come back and tap "Try again".</li>
              </ol>
            ) : (
              <ol className="stack" style={{ margin: 0, paddingLeft: "1.3em" }}>
                <li>Click the icon to the left of the web address.</li>
                <li>Set Camera and Microphone to "Allow".</li>
                <li>Reload the page if asked, then press "Try again".</li>
              </ol>
            )}
          </section>
        ) : null}
        <section className="card stack" aria-labelledby="without">
          <h2 id="without">You can still use HoldUp</h2>
          <p>{!camOk ? "Take a photo of the label with your phone's camera app button, or type what the box says. HoldUp checks it against your list and reads the answer out." : "Type your question instead of speaking. Answers are still read out loud."}</p>
        </section>
      </div>
      <div className="actions">
        <button className="btn primary wide" onClick={onRetry}>
          Try again
        </button>
        <button className="btn wide" onClick={onContinue}>
          Continue without {!camOk && !micOk ? "them" : !camOk ? "the camera" : "the microphone"}
        </button>
      </div>
    </main>
  );
}
