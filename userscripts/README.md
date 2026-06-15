# OB Period Report Card — Tampermonkey bridges

These userscripts feed the OB Period Report Card dashboard
(`…/Desktop/RBv01/ROBv01/index.html`) with live data scraped from NEO, FCLM,
monitorportal, and the fluid roster. They share one bridge key
(`OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE`) and the same `PRC_V2_HYBRID_*`
postMessage protocol the dashboard listens for.

## Install only ONE

All three scripts use the same bridge key, panel, and timers, so running more
than one at a time causes duplicate panels and double pulls. Pick one:

- **`obperiodreportcardmerged.user.js`** — recommended. Newest build; pulls FL
  Utilization and Battle of the Belt live through hidden off-screen frames plus
  the per-tab live collectors, and includes the monitor pull diagnostic.
- `ob02bridge.user.js` — hybrid bridge; FL Util + Belt expected to be supplied
  by open monitor tabs rather than hidden frames.
- `obperiodreportcardbridge.user.js` — older hybrid bridge variant.

Install: open Tampermonkey → Create/Import → paste a script → save. The dashboard
is a `file://` page, so enable **Allow access to file URLs** for the Tampermonkey
extension (`chrome://extensions` → Tampermonkey → Details).

## What was fixed (2026-06-15)

1. **Dashboard was never matched.** The scripts pointed at old folders
   (`OB02`, `OBR03`, `OB-REPORT CARD`). The current dashboard at
   `file:///C:/Users/jonavroa/Desktop/RBv01/ROBv01/index.html` was added to
   `@match`, to the `isDashboard` check, and to `CONFIG.dashboardUrl`, so the
   bridge actually injects and auto-pulls on the dashboard.
2. **Dash normalization.** `normalizeText` had mojibake (`/[â€“â€”]/g`) and no
   longer matched real en/em dashes. Restored to `/[–—]/g` so FCLM/NEO
   rows like "Fluid Load – Tote" and "Transfer Out – Direct" match.
3. **Reset crash (`obperiodreportcardbridge.user.js`).** `resetBridgeData()`
   called an undefined `pushDesktopBridge(...)`; corrected to `pushToDesktop(...)`.
4. **Cosmetic.** Fixed the mojibake bullet in the panel header and normalized the
   non-breaking-space regex in `cleanText`.

The old folder paths were left in place for backward compatibility; the new path
is additive.
