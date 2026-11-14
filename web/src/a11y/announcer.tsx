import { useCallback, useState } from "react";

export type AnnouncementState = {
  slot: 0 | 1;
  a: string;
  b: string;
};

export const INITIAL_ANNOUNCEMENT_STATE: AnnouncementState = {
  slot: 1,
  a: "",
  b: ""
};

export function nextAnnouncementState(
  prev: { slot: 0 | 1; a: string; b: string },
  message: string
): { slot: 0 | 1; a: string; b: string } {
  const nextSlot: 0 | 1 = prev.slot === 0 ? 1 : 0;
  return nextSlot === 0
    ? { slot: 0, a: message, b: "" }
    : { slot: 1, a: "", b: message };
}

export type ScreenReaderAnnouncerProps = {
  politeMessage?: string | null;
  politeSeq?: number;
  assertiveMessage?: string | null;
  assertiveSeq?: number;
};

type ChannelTracker = {
  token: string;
  state: AnnouncementState;
};

function channelToken(message: string, seq: number | undefined): string {
  return seq !== undefined ? `${seq}:${message}` : message;
}

function initialChannelState(message: string, seq: number | undefined): AnnouncementState {
  if (!message || seq === 0) {
    return INITIAL_ANNOUNCEMENT_STATE;
  }
  if (seq !== undefined) {
    const seedSlot: 0 | 1 = Math.abs(Math.trunc(seq)) % 2 === 1 ? 1 : 0;
    return nextAnnouncementState({ slot: seedSlot, a: "", b: "" }, message);
  }
  return nextAnnouncementState(INITIAL_ANNOUNCEMENT_STATE, message);
}

function useChannelAnnouncement(
  rawMessage: string | null | undefined,
  seq: number | undefined
): AnnouncementState {
  const message = rawMessage ?? "";
  const token = channelToken(message, seq);
  const [tracker, setTracker] = useState<ChannelTracker>(() => ({
    token,
    state: initialChannelState(message, seq)
  }));

  if (tracker.token !== token) {
    const nextState =
      !message || seq === 0
        ? nextAnnouncementState(tracker.state, "")
        : nextAnnouncementState(tracker.state, message);
    setTracker({ token, state: nextState });
    return nextState;
  }

  return tracker.state;
}

export function ScreenReaderAnnouncer({
  politeMessage = "",
  politeSeq,
  assertiveMessage = "",
  assertiveSeq
}: ScreenReaderAnnouncerProps) {
  const polite = useChannelAnnouncement(politeMessage, politeSeq);
  const assertive = useChannelAnnouncement(assertiveMessage, assertiveSeq);

  return (
    <>
      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-announcer-slot="polite-a"
      >
        {polite.a}
      </div>
      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-announcer-slot="polite-b"
      >
        {polite.b}
      </div>
      <div
        className="sr-only"
        aria-live="assertive"
        aria-atomic="true"
        data-announcer-slot="assertive-a"
      >
        {assertive.a}
      </div>
      <div
        className="sr-only"
        aria-live="assertive"
        aria-atomic="true"
        data-announcer-slot="assertive-b"
      >
        {assertive.b}
      </div>
    </>
  );
}

export function useLiveAnnouncer() {
  const [polite, setPolite] = useState<{ message: string; seq: number }>({
    message: "",
    seq: 0
  });
  const [assertive, setAssertive] = useState<{ message: string; seq: number }>({
    message: "",
    seq: 0
  });

  const announcePolite = useCallback((message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setPolite((prev) => ({ message: trimmed, seq: prev.seq + 1 }));
  }, []);

  const announceAssertive = useCallback((message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setAssertive((prev) => ({ message: trimmed, seq: prev.seq + 1 }));
  }, []);

  const announce = useCallback(
    (message: string, priority: "polite" | "assertive" = "polite") => {
      if (priority === "assertive") {
        announceAssertive(message);
      } else {
        announcePolite(message);
      }
    },
    [announceAssertive, announcePolite]
  );

  return {
    politeMessage: polite.message,
    politeSeq: polite.seq,
    assertiveMessage: assertive.message,
    assertiveSeq: assertive.seq,
    announce,
    announcePolite,
    announceAssertive
  };
}
