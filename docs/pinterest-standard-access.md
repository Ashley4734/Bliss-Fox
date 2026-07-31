# Pinterest API — upgrading to Standard access

Trial access **cannot create Pins in production** (`POST /pins` returns HTTP 403:
"Apps with Trial access may not create Pins in production"). The Pin publisher is
fully built and verified on Trial (OAuth, token refresh, board matching, queue),
but publishing to the live account requires **Standard access**.

Standard access is free. It requires a demo video and a manual review
(~1 week if clean, 3–4 weeks if changes are requested).

## What reviewers want in the demo video

A single continuous screen recording showing, in order:

1. the **OAuth authorization screen** (the consent screen with the requested
   scopes visible),
2. the **token exchange** (code → token), and
3. a **successful authenticated API call**.

Common rejection cause: not showing the OAuth flow end-to-end in one recording.
Narrate that this is a **first-party, single-account** tool that posts
**owner-selected** Pins and **stores no Pinterest API data**.

## Demo script (~2–3 min, browser only)

Before recording: log into the Bliss Fox Studio Pinterest account, open a screen
recorder, and have the GitHub **Actions** tab ready. Re-add the one-time
token-exchange helper workflow first (so the token-exchange scene works).

**Scene 1 — Intro (10–15s):**
> "This is Bliss Fox Studio Pin Sync, a first-party tool that publishes Pins for
> our own coloring-book shop to our own Pinterest boards. The shop owner selects
> each Pin — nothing posts without an explicit choice — and it stores no data
> from the Pinterest API."

**Scene 2 — OAuth authorization (~30s):**
Paste into the browser and go, then show the consent screen and click *Give access*:

```
https://www.pinterest.com/oauth/?client_id=1596011&redirect_uri=https://blissfoxstudio.com/&response_type=code&scope=boards:read,boards:write,pins:read,pins:write&state=blissfox
```

Show the redirect to `https://blissfoxstudio.com/?code=…` ("the app receives an
authorization code"). Copy the code.

**Scene 3 — Token exchange (~30s):**
Actions → "Pinterest token exchange (one-time)" → Run workflow → paste the code →
run. Open the run and narrate: "the code is exchanged for a token, stored as an
encrypted secret and never logged — no sensitive data is stored."

**Scene 4 — Authenticated API call (~30s):**
Actions → "Pinterest publish" → Run workflow → mode `verify`. Show the log:
"✓ All theme boards exist" and the board list — "an authenticated call to the
Pinterest API listing our own boards."

**Scene 5 — Close (10s):**
> "Standard access will let this same flow publish the owner-selected Pins to
> production. Single business account, first-party use only."

## Rejection-proofing checklist

- Consent screen with scopes **visible** on camera.
- Token exchange **shown happening** (not pre-done off-screen).
- A **successful authenticated API call** in the same recording.
- Narrate first-party, single-account, owner-selected, no data stored.
- One continuous take.

## After approval

1. Re-enable the daily schedule in `.github/workflows/pinterest-publish.yml`
   (uncomment the `schedule:` / `cron:` lines).
2. Run **Pinterest publish** in mode `publish` (or wait for the schedule).
3. Pins post to production. No other changes needed.

## App facts (for the application form)

- App id: `1596011`
- Redirect URI: `https://blissfoxstudio.com/`
- Scopes: `boards:read`, `boards:write`, `pins:read`, `pins:write`
- Privacy policy: `https://blissfoxstudio.com/privacy`
- Use: content marketing / Pin scheduler for our own merchant shop (first-party,
  single account)
