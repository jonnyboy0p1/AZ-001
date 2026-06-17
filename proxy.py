#!/usr/bin/env python3
"""
RC Sort Dashboard — FCLM / Dockflow Local Proxy
Forwards requests to internal Amazon tools using your Midway session cookie.

Routes:
  GET /health                 → cookie status
  GET /api/<fclm-path>        → https://fclm-portal.amazon.com/<fclm-path>
  GET /fetch?url=<https url>   → any https://*.amazon.com URL (e.g. Dockflow)
  POST /set-cookie            → paste a session cookie manually

Usage:
  python proxy.py                  # default port 8765, warehouse RFD2
  python proxy.py --port 9000
  python proxy.py --warehouse DET6

Requirements: Python 3.6+, no external packages needed.
"""

import http.server
import http.cookiejar
import urllib.request
import urllib.error
import urllib.parse
import json
import os
import sys
import time
import argparse
from socketserver import ThreadingMixIn

FCLM_BASE      = "https://fclm-portal.amazon.com"
DEFAULT_PORT   = 8765
COOKIE_FILE    = os.path.expanduser("~/.midway/cookie")
COOKIE_MAX_AGE = 12 * 3600  # 12 hours in seconds

# Hosts the generic /fetch route is allowed to reach. Dockflow, FCLM and other
# internal Midway-gated tools all live under *.amazon.com. Broaden if needed.
ALLOWED_HOST_SUFFIX = ".amazon.com"

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
        if "amazon.com" in (c.domain or "")
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


# ── Request handler ───────────────────────────────────────────────────────────

class ProxyHandler(http.server.BaseHTTPRequestHandler):

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self._respond(200, {}, b"")

    def do_GET(self):
        if self.path == "/health":
            self._handle_health()
        elif self.path.startswith("/api/"):
            self._handle_proxy(self.path[4:])   # strip /api → /reports/...
        elif self.path.startswith("/fetch"):
            self._handle_fetch()                # generic *.amazon.com passthrough (Dockflow etc.)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/set-cookie":
            self._handle_set_cookie()
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

    def _handle_proxy(self, path: str):
        """FCLM convenience route: /api/<fclm-path> → fclm-portal.amazon.com."""
        self._forward(FCLM_BASE + path)

    def _handle_fetch(self):
        """Generic route: /fetch?url=<https url> → any *.amazon.com host (e.g. Dockflow).

        The dashboard discovers the exact Dockflow endpoint from browser DevTools
        and passes it here so it inherits the same Midway session cookie."""
        qs     = urllib.parse.urlparse(self.path).query
        raw    = (urllib.parse.parse_qs(qs).get("url") or [""])[0]
        target = urllib.parse.unquote(raw)

        if not target:
            self._json({"error": "missing 'url' query parameter"}, 400)
            return

        parts = urllib.parse.urlparse(target)
        host  = parts.hostname or ""
        if parts.scheme != "https" or not host.endswith(ALLOWED_HOST_SUFFIX):
            self._json({
                "error":   "url_not_allowed",
                "message": f"Only https://*{ALLOWED_HOST_SUFFIX} URLs are permitted.",
                "host":    host,
            }, 403)
            return

        self._forward(target)

    def _forward(self, url: str):
        cookie = load_cookie_header()

        req = urllib.request.Request(url)
        req.add_header("Cookie",          cookie)
        req.add_header("User-Agent",      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                                          "Chrome/120.0 Safari/537.36")
        req.add_header("Accept",          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        req.add_header("Accept-Language", "en-US,en;q=0.9")
        req.add_header("Referer",         "https://fclm-portal.amazon.com/")

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
    print("  ║   RC Sort Dashboard — FCLM Proxy         ║")
    print("  ╚══════════════════════════════════════════╝")
    print(f"  Listening on  http://localhost:{args.port}")
    print(f"  Warehouse     {args.warehouse}")
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
