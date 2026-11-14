import { useEffect, useState } from "react";
import { onAnnounce } from "../lib/feedback.ts";

/** Two visually hidden live regions fed by announce(). The text is toggled so repeats are re-read. */
export function Announcer() {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  useEffect(
    () =>
      onAnnounce((msg, p) => {
        const set = p === "assertive" ? setAssertive : setPolite;
        set("");
        setTimeout(() => set(msg), 60);
      }),
    [],
  );
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </>
  );
}
