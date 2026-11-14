import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Profile as P } from "../../shared/types.ts";
import { Announcer } from "./components/Announcer.tsx";
import { Icon, Logo } from "./components/Icons.tsx";
import { Checker } from "./lib/checker.ts";
import { announce } from "./lib/feedback.ts";
import { IS_MOCK } from "./lib/mock.ts";
import { deleteAllData, loadConsent, loadProfile, saveConsent, type Consent as C } from "./lib/storage.ts";
import { Live } from "./screens/Live.tsx";
import { Consent, PermissionRecovery, PermissionStep, type PermResult } from "./screens/Onboarding.tsx";
import { Privacy } from "./screens/Privacy.tsx";
import { Profile } from "./screens/Profile.tsx";

type Screen = "consent" | "permissions" | "recovery" | "check" | "profile" | "privacy";
const TITLES: Record<string, string> = { check: "Check", profile: "Profile", privacy: "Privacy" };

// one controller for the app's lifetime (survives StrictMode double effects and tab switches)
let singleton: Checker | null = null;
const getChecker = () => (singleton ??= new Checker());

export function App() {
  const [consent, setConsent] = useState<C | null>(loadConsent());
  const [screen, setScreen] = useState<Screen>(consent ? "check" : "consent");
  const [perm, setPerm] = useState<PermResult | null>(null);
  const [profile, setProfile] = useState<P>(loadProfile());
  const checker = getChecker();
  const s = useSyncExternalStore(checker.subscribe, checker.get);
  const h1 = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    checker.onProfileChange = setProfile;
  }, [checker]);

  // focus management: move focus to the screen heading on every tab change
  useEffect(() => {
    if (["check", "profile", "privacy"].includes(screen)) {
      h1.current?.focus();
      document.title = `${TITLES[screen]} · HoldUp`;
    } else document.title = "HoldUp";
  }, [screen]);

  if (screen === "consent")
    return (
      <>
        <Announcer />
        <Consent
          onAgree={() => {
            saveConsent();
            setConsent(loadConsent());
            setScreen("permissions");
          }}
          onNotNow={() => {
            announce("No problem. The camera stays off until you agree.");
            setScreen("profile");
          }}
        />
      </>
    );
  if (screen === "permissions")
    return (
      <>
        <Announcer />
        <PermissionStep
          onDone={(r) => {
            setPerm(r);
            setScreen(r.camera === "granted" && r.mic === "granted" ? "check" : "recovery");
          }}
        />
      </>
    );
  if (screen === "recovery" && perm)
    return (
      <>
        <Announcer />
        <PermissionRecovery result={perm} onRetry={() => setScreen("permissions")} onContinue={() => setScreen("check")} />
      </>
    );

  const tab = (id: Screen, label: string, icon: React.ReactNode) => (
    <button aria-current={screen === id ? "page" : undefined} onClick={() => setScreen(id)}>
      {icon}
      {label}
    </button>
  );

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Announcer />
      <header className="topbar">
        <span className="wordmark">
          <Logo size={30} />
          HoldUp
        </span>
        <span className="spacer" />
        {IS_MOCK ? <span className="chip mock">Demo</span> : null}
        <span className={`chip ${s.mode}`} aria-label={`Mode: ${s.mode}${s.running ? ", check running" : ""}`}>
          <span className="dot" aria-hidden="true" />
          {s.mode === "live" ? (s.running ? (s.conn === "open" ? "Live" : "Connecting") : "Ready") : s.mode === "snapshot" ? "Snapshot" : "Offline"}
        </span>
      </header>
      <main id="main">
        <h1 ref={h1} tabIndex={-1} className={screen === "check" ? "sr-only" : undefined}>
          {screen === "check" ? "Check a label" : TITLES[screen]}
        </h1>
        {screen === "check" ? (
          <Live
            checker={checker}
            consented={!!consent}
            onReviewConsent={() => setScreen("consent")}
            onFixPermissions={() => {
              setPerm({ camera: s.cameraPerm === "granted" ? "granted" : s.cameraPerm, mic: s.micPerm === "granted" ? "granted" : s.micPerm });
              void checker.stop("Check stopped to fix permissions.");
              setScreen("recovery");
            }}
          />
        ) : screen === "profile" ? (
          <Profile profile={profile} onChange={setProfile} />
        ) : (
          <Privacy
            consent={consent}
            onReviewConsent={() => setScreen("consent")}
            onWithdraw={() => {
              void checker.stop();
              try {
                localStorage.removeItem("holdup.consent");
              } catch {
                /* ignore */
              }
              setConsent(null);
            }}
            onDeleteAll={async () => {
              await checker.stop("Check stopped.");
              await deleteAllData();
              setConsent(null);
              setProfile(loadProfile());
              announce("All your HoldUp data has been deleted from this phone.", "assertive");
              setScreen("consent");
            }}
          />
        )}
      </main>
      <nav className="tabs" aria-label="Main">
        {tab("check", "Check", <Icon.camera size={26} />)}
        {tab("profile", "Profile", <Icon.list size={26} />)}
        {tab("privacy", "Privacy", <Icon.shield size={26} />)}
      </nav>
    </div>
  );
}
