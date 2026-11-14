# Real-user test kit (Chintufp + Ivar, Sat evening to Sun morning)

Goal: by Sun 05:00, at least **one real person with low vision, or a screen-reader user**, has tried HoldUp for about 10 minutes, and we have **one consented quote**. Failing that, get a review from a Meta mentor or an accessibility professional. Write everything in `docs/USER_FEEDBACK.md`.

## Who to contact (in parallel, tonight)
1. **Näkövammaisten liitto (Finnish Federation of the Visually Impaired)**, Helsinki, Iiris centre (Marjaniementie 74). Use the main switchboard, the email on nkl.fi, and their social media. Ask for a volunteer, peer-support person or accessibility expert willing to try a prototype for 10 minutes on Sunday morning at the venue or by video call.
2. **The venue:** ask the Junction organisers and the info desk whether any participant or mentor is blind or low-vision, or uses a screen reader daily. Post in the event Slack/Discord.
3. **Meta booth:** ask Amanda Le and the Web Apps mentors for a 5-minute review of the glasses demo. Their feedback counts as expert validation.
4. **Your own network:** a grandparent or older relative who manages several medicines is a valid user too (the second audience). A 10-minute video call is fine.

### Message template (EN; translate to FI as needed)
> Hi! We're a student team at Junction 2026 (Helsinki) building **HoldUp**, a free prototype on Meta AI glasses that helps blind and low-vision people check a medicine box or food package hands-free. You hold it up, it guides you by voice until the label is readable, and then it tells you whether it's *your* evening pill or contains your allergen. It only states a dose it can read clearly; otherwise it says it isn't sure. Could you, or someone you know who's blind or has low vision, try it for 10 minutes on Sunday morning (on site or by video), or give us 5 minutes of honest feedback? No data about you is stored. Thank you!

## The 10-minute session
1. **Consent (read aloud, record a verbal yes):**
   > This is a student prototype, not a medical device. Please don't use it for real medication decisions today. During the test, the camera sees the packages you hold up. Frames go to Google's Gemini service to read the label and are not stored by us. We won't record your face or voice unless you agree. May we write down your feedback, and may we quote you by first name, initials or anonymously (your choice) in our presentation?
2. **Setup (2 min):** they wear the glasses (or hold the phone). Load the demo profile, or try "set up by voice" if the `addmed` feature is ready.
3. **Tasks (6 min), observe only and don't help:**
   - "Which of these three boxes is your evening pill?" (scene mode)
   - "Check this box." (label away from them first)
   - "Does this snack contain nuts?"
   - One task that fails on purpose: cover the strength with a thumb. Does the "I'm not sure" feel trustworthy or annoying?
4. **Questions (2 min):**
   - What did you like most?
   - What was confusing?
   - Would you use this daily, and for what?
   - Did you trust the answers? Why or why not?
   - Is the voice too fast, too slow, or too chatty?
5. Write it in `docs/USER_FEEDBACK.md`: date, who (first name/initials, or "anonymous", as they chose), condition (e.g. "low vision since 2015, uses TalkBack"), what worked, what failed, a quote, and the consent given (quote yes/no, how named).

## Ethics guardrails
- No real medication decisions during the test. Use our props or their own boxes for reading only.
- No faces in photos or video unless explicitly agreed. Prefer filming hands and packages.
- Never pressure anyone. A "no" is fine.
- Don't overstate it in the deck: one session is "early feedback from N users", not "validated".
