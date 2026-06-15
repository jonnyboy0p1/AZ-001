# FlowFone 📲 — watch the DockFlow Sorter from your phone

Mirror the DockFlow **Sorter** workcell table into a Google Sheet so you can
check it on your phone (Google Sheets app) while you're away from the laptop.

Built for this view:

```
https://prod-na.dockflow.robotics.a2z.com/RFD2/wc/MainSorter/Sorter
  …columns: Status · Arc · ArcRelatedWorkcells · Utilization · Recircs
```

---

## Why it's built this way (read this first)

DockFlow (`*.dockflow.robotics.a2z.com`) sits behind **Amazon Midway SSO + the
corporate network**. Google Apps Script runs on *Google's* servers, which
**cannot reach DockFlow and cannot log in**. So "have Google Sheets fetch the
DockFlow link" simply can't work — it hits a login wall.

FlowFone uses a **push** model instead:

```
 ┌─ Laptop, browser tab logged into DockFlow ─────────────┐
 │  flowfone.user.js  (Tampermonkey)                      │
 │   • reads the Sorter table the page already rendered   │
 │   • POSTs it every N seconds  ─────────────────────────┼──┐
 └────────────────────────────────────────────────────────┘  │
                                                              ▼
                       Google Apps Script web app  (google-apps-script.gs)
                                                              │ writes rows
                                                              ▼
                                 Google Sheet  ◄──── 📱 your phone opens this
```

The userscript runs **inside your already-authenticated tab**, so there's no
auth to handle. Your phone just reads the Sheet. Leave the laptop on with the
DockFlow tab open and you'll see updates from your phone while you walk around.

> ⚠️ **Data handling:** this copies work data from an internal Amazon tool into a
> personal Google Sheet. Make sure that's allowed under your team's / employer's
> data-handling policy before relying on it. That's your call, not the script's.

---

## What you need

- A Google account (the Sheet + Apps Script).
- A laptop browser with **Tampermonkey** (Chrome/Edge/Firefox) and an active,
  logged-in DockFlow session.
- The phone Google Sheets app (or any browser) to view the Sheet.

---

## Setup

### 1) Create the Sheet + deploy the web app
1. Create a new Google Sheet (name it e.g. `Sorter Live`).
2. **Extensions → Apps Script**. Delete the starter code.
3. Paste **`google-apps-script.gs`** in full.
4. Change `CONFIG.TOKEN` to a secret of your choice, e.g. `'rfd2-sorter-7Q2x'`.
   Save (💾).
5. **Deploy → New deployment**. Click the gear → **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
6. **Deploy**, approve the permission prompt, and **copy the Web app URL**
   (it ends in `/exec`).
   - Tip: paste that URL in a browser — you should see
     `{"ok":true,"app":"FlowFone",...}`. That confirms it's live.

### 2) Install the userscript
1. Install **Tampermonkey** in your laptop browser.
2. Tampermonkey → **Create a new script** → paste **`flowfone.user.js`** →
   save (Ctrl/Cmd-S).

### 3) Wire them together
1. Open your DockFlow Sorter URL (the full one with the `workAreasTableConfig`
   query string keeps your columns). A dark **FlowFone** panel appears
   bottom-right.
2. Fill in:
   - **Web App URL** → the `/exec` URL from step 1.6
   - **Shared token** → the exact same value as `CONFIG.TOKEN`
   - **Every (sec)** → e.g. `60`
   - **Reload (min)** → `0` to start (see freshness note below)
3. Click **Push now**. Status should read `✓ pushed (N rows) @ hh:mm:ss`.
4. Check the Sheet — a **`Live`** tab now holds the table, with the last-updated
   time in row 1.
5. Click **Start** to push on the interval. (It remembers this and auto-starts
   next time you open the page.)

### 4) On your phone
- Install the **Google Sheets** app, open the same Sheet (same Google account or
  share it to yourself). It refreshes as the laptop pushes — pull down to force
  a refresh.
- Leave the laptop on with the DockFlow tab open to keep updates flowing.

---

## Notes & tuning

- **Freshness in a background tab.** Browsers throttle background tabs, and the
  DockFlow page may slow its own data polling when not focused. If the numbers
  look stale, set **Reload (min)** to e.g. `5` — FlowFone will reload the page
  on that interval to force fresh data, then resume pushing. (Keep the tab
  logged in; a reload won't re-auth you if your Midway session has expired.)
- **Session expiry.** If your DockFlow/Midway session drops, the page shows a
  login screen, the table disappears, and you'll see
  `No Sorter table found`. Re-log into DockFlow and it resumes.
- **Which table?** FlowFone auto-picks the table whose header mentions
  Recircs / Utilization / Arc / Status, so it follows your visible columns. Show
  or hide columns in DockFlow and the Sheet follows on the next push.
- **`History` tab.** Each push also appends `Timestamp · Rows · Source` to a
  `History` tab so you can confirm it's still alive and eyeball the trend.
  Trimmed to the last 5000 rows; turn off with `CONFIG.KEEP_HISTORY = false`.
- **Security.** The web app is public-by-URL, so the **token** is what stops
  random POSTs from writing to your Sheet. Keep it non-obvious. Re-deploy a new
  version if you ever change the script.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No FlowFone panel | Confirm Tampermonkey is on and the script's `@match` covers your DockFlow host; hard-refresh the page. |
| `✗ failed — bad token` | The panel token ≠ `CONFIG.TOKEN`. Make them identical. |
| `✗ network error` | The Web App URL is wrong, or not deployed as **Anyone**. Re-check the `/exec` URL. |
| `No Sorter table found` | Page still loading, no rows match your filter, or you're on a login screen. Wait / re-log in / press **Push now**. |
| Sheet not updating on phone | Pull-to-refresh; confirm laptop says `✓ pushed`; confirm same Google account/sharing. |
| First deploy asks for authorization | Expected — approve it (it only touches *this* spreadsheet). |

---

## How this relates to the rest of the repo

The repo root has the earlier, **laptop-only** version of this idea —
`proxy.py` + `dashboard.html` — which scrapes **fclm-portal.amazon.com** through
a local Python proxy using your Midway cookie and shows a dashboard on the same
machine. FlowFone is the **mobile** companion: instead of a local dashboard, it
pushes a live snapshot to Google Sheets so the data follows you to your phone.
