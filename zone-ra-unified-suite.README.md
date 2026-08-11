# Zone-RA Unified Suite — FCMenu connectivity fix (v2.3)

## Symptom
Labor Tracker shows a red dot and the toast **"Cannot reach FCMenu"**. Badges never track.

## Root cause
The FCMenu labor-tracking kiosk (`/do/laborTrackingKiosk`) sits behind **Midway SSO**, exactly
like FCLM and MonitorPortal do elsewhere in this project (`proxy.py`, `index.html`). When your
Midway session is missing or expired, FCMenu answers the request with a **302 redirect to a
Midway sign-in page** on `midway-auth.amazon.com`.

`GM_xmlhttpRequest` will only *follow* a redirect if the destination host is listed in `@connect`.
In v2.2 only `fcmenu-iad-regionalized.corp.amazon.com` was listed, so Tampermonkey **aborted the
redirect** and fired `onerror`. The old code's `onerror` handler threw away all detail and just
said "Cannot reach FCMenu" — so a routine "please sign in" looked like a dead endpoint.

## What changed in v2.3
1. **`@connect` grants added** for `midway-auth.amazon.com`, `corp.amazon.com`, and `amazon.com`,
   so the SSO redirect is followed instead of silently aborted.
2. **Auth-wall detection** (`ltLooksLikeAuthWall`) — reuses this repo's proven
   `/midway|sign.?in|sentry/i` check to tell an SSO bounce apart from a real failure.
3. **Real diagnostics** — `onerror`/`ontimeout`/non-2xx are logged to the console with the final
   URL and HTTP status, and the toast now says *why* (auth vs. network vs. HTTP error).
4. **`withCredentials: true` + a 20s timeout** on every FCMenu request, so the browser's Midway
   cookie is always sent and hung requests fail loudly instead of hanging.
5. **"🔌 Test FCMenu" button** in the Labor Track → *My Codes* panel — runs a live connectivity
   check and reports the exact state. If sign-in is needed it opens FCMenu in a new tab for you.
6. **"⚙️ FCMenu URL" button** — the base URL is now stored in `GM_setValue('lt_fcmenu_base', …)`.
   If IAD is not your region, change it here (no code edit) and reload.
7. Removed a latent `xtAutoScanNewCards()` call that referenced an undefined function and threw a
   `ReferenceError` in the console on every card render.

## How to get connected
1. Reinstall/refresh the script in Tampermonkey (v2.3). When prompted, **allow** the new
   `@connect` domains.
2. Make sure you are on the **corp network / VPN** — `*.corp.amazon.com` is internal-only, even
   though `zone-ra.amazon.dev` may load off-network.
3. Open the FCMenu kiosk once in a normal browser tab and complete **Midway** sign-in
   (run `mwinit` if needed). This sets the session cookie the script reuses.
4. Back in Zone-RA, open **Labor Track → My Codes → 🔌 Test FCMenu**. Green dot = you're good.
5. Wrong region? Use **⚙️** to set `https://fcmenu-<your-region>-regionalized.corp.amazon.com`
   and reload.

## Still red?
Open DevTools → Console and look for `[LaborTracker]` lines. They print the final URL and status:
- redirected to `midway-auth…` → sign in (step 3)
- network error with no status → VPN/host (steps 2 & 5)
- HTTP 4xx/5xx → the endpoint reached you; check the code/region.
