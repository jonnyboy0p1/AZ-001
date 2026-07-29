#!/usr/bin/env python3
"""
RC Sort / OBD Dashboard — Local Midway Proxy
Forwards requests to internal Amazon services using your Midway session cookie.

Upstreams (selected by URL prefix after /api):
  /api/reports/...     → FCLM portal            (legacy; RC Sort dashboard.html)
  /api/dockflow/...    → DockFlow MainSorter     (OBD destinations + weight)
  /api/yms/...         → YMS shipclerk yard       (trailer type per door)
  /api/fclm/...        → FCLM portal (explicit)

Collector endpoints (used by fuse-obd-collector.user.js + the dashboard):
  POST /collect        ← Tampermonkey pushes scraped rows {source, rows, ...}
  GET  /collect        → dashboard reads the latest capture per source
  GET  /collect?source=yms  → one source only

Usage:
  python proxy.py                  # default port 8765, warehouse RFD2
  python proxy.py --port 9000
  python proxy.py --warehouse DET6

Requirements: Python 3.6+, no external packages needed.
Note: DockFlow / YMS are single-page apps. A raw GET of the page URL returns the
app shell, not data rows. Point /api/dockflow and /api/yms at the JSON/XHR
endpoints those apps call, or use the dashboard's Paste CSV path.
"""

import http.server
import http.cookiejar
import urllib.request
import urllib.error
import json
import os
import re
import sys
import time
import argparse
import threading
from socketserver import ThreadingMixIn

FCLM_BASE      = "https://fclm-portal.amazon.com"
DOCKFLOW_BASE  = "https://prod-na.dockflow.robotics.a2z.com"
YMS_BASE       = "https://trans-logistics.amazon.com"
DEFAULT_PORT   = 8765
COOKIE_FILE    = os.path.expanduser("~/.midway/cookie")
COOKIE_MAX_AGE = 12 * 3600  # 12 hours in seconds

# Upstreams reachable through this proxy. The dashboard calls /api/<prefix>/<path>.
# Anything without a known prefix falls through to FCLM for backward compatibility
# (dashboard.html calls /api/reports/...).
UPSTREAMS = {
    "/dockflow": DOCKFLOW_BASE,
    "/yms":      YMS_BASE,
    "/fclm":     FCLM_BASE,
}

# Cookie domains worth forwarding. Midway federates across these internal hosts.
COOKIE_DOMAINS = ("amazon.com", "a2z.com", "aka.amazon.com")

# Module-level manual cookie override (set via POST /set-cookie)
_manual_cookie: str = ""


# ── Cookie helpers ────────────────────────────────────────────────────────────

def load_cookie_header() -> str:
    """Return a Cookie header string from ~/.midway/cookie or the manual override."""
    global _manual_cookie
    if _manual_cookie:
        return _manual_cookie

    if not os.path.exists(COOKIE_FILE):
        return ""

    jar = http.cookiejar.MozillaCookieJar(COOKIE_FILE)
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception:
        return ""

    pairs = [
        f"{c.name}={c.value}"
        for c in jar
        if any(dom in (c.domain or "") for dom in COOKIE_DOMAINS)
    ]
    return "; ".join(pairs)


def cookie_file_age_seconds() -> float | None:
    """Return age of the Midway cookie file in seconds, or None if missing."""
    if not os.path.exists(COOKIE_FILE):
        return None
    return time.time() - os.path.getmtime(COOKIE_FILE)


# ── CORS ──────────────────────────────────────────────────────────────────────

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


# ── Collector capture store ───────────────────────────────────────────────────
# The Tampermonkey userscript (fuse-obd-collector.user.js) runs inside the already
# authenticated YMS / SSP / DockFlow pages, scrapes the rendered data, and POSTs it
# here via GM_xmlhttpRequest (which bypasses the https→http-localhost mixed-content
# block). The dashboard then GETs /collect and merges by source. Nothing here needs
# the Midway cookie — the browser already did the auth.

_collect_lock = threading.Lock()
_collect_store: dict = {}          # source -> capture entry


def store_capture(payload: dict) -> dict:
    source = (str(payload.get("source", "") or "unknown").lower().strip()) or "unknown"
    rows = payload.get("rows") or []
    entry = {
        "source":     source,
        "capturedAt": payload.get("capturedAt") or int(time.time() * 1000),
        "url":        payload.get("url", ""),
        "node":       payload.get("node", ""),
        "rows":       rows,
        "raw":        payload.get("raw"),
        "count":      len(rows) if isinstance(rows, list) else 0,
    }
    with _collect_lock:
        _collect_store[source] = entry
    return entry


def collect_snapshot(source: str | None = None) -> dict:
    with _collect_lock:
        if source:
            return _collect_store.get(source, {})
        # shallow copy so we don't serialize under the lock indefinitely
        return dict(_collect_store)


# ── Request handler ───────────────────────────────────────────────────────────

class ProxyHandler(http.server.BaseHTTPRequestHandler):

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self._respond(200, {}, b"")

    def do_GET(self):
        if self.path == "/health":
            self._handle_health()
        elif self.path == "/collect" or self.path.startswith("/collect?"):
            self._handle_collect_get()
        elif self.path.startswith("/api/"):
            self._route_proxy(self.path[4:])   # strip /api → /<prefix>/<path> or /reports/...
        else:
            self._json({"error": "not found"}, 404)

    def _handle_collect_get(self):
        source = None
        if "?" in self.path:
            from urllib.parse import parse_qs, urlparse
            source = (parse_qs(urlparse(self.path).query).get("source", [None])[0])
        self._json(collect_snapshot(source.lower() if source else None))

    def _route_proxy(self, rest: str, method: str = "GET",
                     body: bytes | None = None, content_type: str | None = None):
        """Pick an upstream by leading prefix, else default to FCLM."""
        for prefix, base in UPSTREAMS.items():
            if rest == prefix or rest.startswith(prefix + "/"):
                self._handle_proxy(base, rest[len(prefix):] or "/", method, body, content_type)
                return
        # No known prefix → legacy FCLM behaviour (e.g. /reports/processPathRollup)
        self._handle_proxy(FCLM_BASE, rest, method, body, content_type)

    def do_POST(self):
        if self.path == "/collect":
            self._handle_collect_post()
        elif self.path == "/set-cookie":
            self._handle_set_cookie()
        elif self.path.startswith("/api/"):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""
            ctype = self.headers.get("Content-Type", "application/json")
            self._route_proxy(self.path[4:], method="POST", body=body, content_type=ctype)
        else:
            self._json({"error": "not found"}, 404)

    # ── Handlers ──────────────────────────────────────────────────────────────

    def _handle_health(self):
        age = cookie_file_age_seconds()
        if age is None:
            state = "no_cookie_file"
        elif age > COOKIE_MAX_AGE:
            state = "stale"
        elif not load_cookie_header():
            state = "empty"
        else:
            state = "ok"

        self._json({
            "status":      state,
            "cookieFile":  COOKIE_FILE,
            "cookieAge":   round(age) if age is not None else None,
            "manualCookie": bool(_manual_cookie),
        })

    def _handle_proxy(self, base: str, path: str, method: str = "GET",
                      body: bytes | None = None, content_type: str | None = None):
        url = base + path
        cookie = load_cookie_header()
        origin = base.rstrip("/")

        req = urllib.request.Request(url, data=body if method == "POST" else None,
                                     method=method)
        req.add_header("Cookie",          cookie)
        req.add_header("User-Agent",      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                                          "Chrome/120.0 Safari/537.36")
        req.add_header("Accept",          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        req.add_header("Accept-Language", "en-US,en;q=0.9")
        req.add_header("Referer",         origin + "/")
        req.add_header("Origin",          origin)
        if method == "POST" and content_type:
            req.add_header("Content-Type", content_type)

        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                content_type = resp.headers.get("Content-Type", "text/html")
                body = resp.read()
            extra = {"X-Upstream-Content-Type": content_type}
            self._respond(200, extra, body, content_type=content_type)

        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                self._json(
                    {
                        "error":   "auth_required",
                        "message": "Midway session expired or missing. "
                                   "Run  mwinit  in a terminal, then click Refresh. "
                                   "Or paste a fresh session cookie via the dashboard.",
                        "code":    exc.code,
                    },
                    200,
                    extra_headers={"X-Proxy-Auth-Error": "true"},
                )
            else:
                self._json({"error": f"HTTP {exc.code}", "code": exc.code}, 200,
                           extra_headers={"X-Proxy-Auth-Error": "true"})

        except TimeoutError:
            self._json({"error": "timeout", "message": "FCLM did not respond within 25 s."}, 200)

        except Exception as exc:
            self._json({"error": str(exc)}, 200)

    def _handle_set_cookie(self):
        global _manual_cookie
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
            _manual_cookie = body.get("cookie", "").strip()
            self._json({"status": "ok", "cookieSet": bool(_manual_cookie)})
        except Exception as exc:
            self._json({"error": str(exc)}, 400)

    def _handle_collect_post(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            entry = store_capture(payload)
            self._json({"ok": True, "source": entry["source"], "count": entry["count"]})
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, 400)

    # ── Low-level response helpers ────────────────────────────────────────────

    def _json(self, obj: dict, code: int = 200, extra_headers: dict | None = None):
        body = json.dumps(obj, indent=2).encode()
        self._respond(code, extra_headers or {}, body, content_type="application/json")

    def _respond(self, code: int, extra_headers: dict, body: bytes,
                 content_type: str = "application/octet-stream"):
        self.send_response(code)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        for k, v in extra_headers.items():
            self.send_header(k, v)
        self.send_header("Content-Type",   content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    # ── Suppress default request logging (use our own) ───────────────────────

    def log_message(self, fmt, *args):
        code = args[1] if len(args) > 1 else "?"
        path = args[0].split(" ")[1] if " " in args[0] else args[0]
        color = "\033[92m" if str(code).startswith("2") else "\033[93m"
        print(f"  {color}{code}\033[0m  {path}")


# ── Threaded server ───────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="RC Sort FCLM local proxy")
    parser.add_argument("--port",      type=int, default=DEFAULT_PORT)
    parser.add_argument("--warehouse", type=str, default="RFD2")
    args = parser.parse_args()

    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   RC Sort / OBD — Midway Proxy           ║")
    print("  ╚══════════════════════════════════════════╝")
    print(f"  Listening on  http://localhost:{args.port}")
    print(f"  Warehouse     {args.warehouse}")
    print(f"  Upstreams     FCLM · DockFlow · YMS")
    print(f"  Collector     POST/GET /collect  (Tampermonkey → dashboard)")
    print()

    age = cookie_file_age_seconds()
    if age is None:
        print(f"  \033[93m⚠  Midway cookie not found at {COOKIE_FILE}\033[0m")
        print("     Run  mwinit  in a new terminal, then open the dashboard.")
    elif age > COOKIE_MAX_AGE:
        h = int(age // 3600)
        print(f"  \033[93m⚠  Midway cookie is {h}h old (may be expired)\033[0m")
        print("     Run  mwinit  to refresh, then click Refresh in the dashboard.")
    else:
        mins = int(age // 60)
        print(f"  \033[92m✓  Midway cookie found ({mins}m old)\033[0m")

    print()
    print("  Press Ctrl+C to stop")
    print()

    try:
        server = ThreadedHTTPServer(("localhost", args.port), ProxyHandler)
        server.serve_forever()
    except OSError as exc:
        if "Address already in use" in str(exc):
            print(f"\n  \033[91m✗  Port {args.port} is already in use.\033[0m")
            print(f"     Kill the existing process:  lsof -ti:{args.port} | xargs kill")
            print(f"     Or use a different port:    python proxy.py --port 9000")
        else:
            raise
    except KeyboardInterrupt:
        print("\n  Proxy stopped.")


if __name__ == "__main__":
    main()
