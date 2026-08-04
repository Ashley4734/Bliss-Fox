# Pinterest API — upgrading to Standard access

Trial access **cannot create Pins in production** (`POST /pins` → HTTP 403). The
publisher is fully built and verified; publishing to the live account requires
**Standard access** (free; demo video + manual review).

## First submission was denied — why

The reviewer said the demo was incomplete: it must show the **full OAuth flow**
*and* **real API usage with results** (not just UI/verify output). They also
required Pinterest-specific clauses in the privacy policy. This guide reflects
the corrected approach.

## The demo must show, in one continuous recording

1. **OAuth flow:** Pinterest login → "Give access" consent screen (scopes
   visible) → redirect back to the site with a `code` in the URL bar.
2. **Token exchange:** exchange the `code` for an access token.
3. **Integration with results:** a real API call and its result — here, create a
   board, create a Pin, and read the Pin back.

Production can't create Pins on Trial, so the integration is shown in the
**Sandbox** (`https://api-sandbox.pinterest.com`), which the reviewer explicitly
allows.

## Recording steps (browser only)

Pre-flight: confirm the `GH_PAT` secret exists (Secrets: Read and write). Start
the screen recorder and keep it running for all steps.

**1 — OAuth login + consent (Scene: OAuth flow).**
Open this and approve; the consent screen shows the scopes, then you're
redirected to `https://blissfoxstudio.com/?code=…` — copy the `code`:

```
https://www.pinterest.com/oauth/?client_id=1596011&redirect_uri=https://blissfoxstudio.com/&response_type=code&scope=boards:read,boards:write,pins:read,pins:write&state=blissfox
```

**2 — Token exchange (Scene: token exchange).**
Actions → "Pinterest token exchange (one-time)" → Run workflow:
- environment: `sandbox`
- code: the code from step 1
- redirect_uri: `https://blissfoxstudio.com/`

Open the run; it stores `PINTEREST_SANDBOX_REFRESH_TOKEN` (masked — narrate
"the token is exchanged and stored securely; nothing sensitive is logged").

**3 — Integration with results (Scene: API usage).**
Actions → "Pinterest sandbox demo" → Run workflow. Open the run log and show:
- `POST /boards` → board id
- `POST /pins` → pin id
- `GET /pins/{id}` → the created Pin returned by the API

Narrate: "a board and Pin created via the Pinterest API in the sandbox, then
read back — this is the app's real function." Keep it one continuous take.

**4 — Close.**
"Standard access will let this same flow publish owner-selected Pins to
production. First-party, single business account, no Pinterest data stored."

## Privacy policy requirements (reviewer)

The policy at https://blissfoxstudio.com/privacy must state:
- the app **uses the Pinterest API** and is **not endorsed by or affiliated
  with Pinterest**;
- what happens to **Pinterest-derived data when a user disconnects** (we store
  none; on disconnect the token is revoked and nothing is retained);
- that we **do not resell or redistribute** Pinterest content or Pinterest-
  derived data to third parties;
- a **contact email address** in the policy text.

## Rejection-proofing checklist

- Consent screen with scopes **visible** on camera.
- Token exchange **shown happening**.
- **Real API calls** (create board, create pin) **and their results** (read
  back) — not just verify/UI output.
- One continuous take.
- Narrate first-party, single-account, owner-selected, no data stored.

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
