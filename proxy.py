#!/usr/bin/env python3
"""
OB Period Report Card — Midway Local Proxy
Forwards requests to internal Amazon endpoints using your Midway session,
so the dashboard (index.html) can pull FCLM / MonitorPortal / Fluid Roster
data directly — no Tampermonkey required for those sources.

Endpoints
  GET  /health                 → Midway cookie state
  GET  /fetch?url=<ENCODED>     → fetch any allow-listed Amazon URL (Midway auth)
  GET  /api/<path>             → legacy FCLM-only proxy (kept for dashboard.html)
  POST /set-cookie             → paste a session cookie manually

Usage
  python proxy.py                  # default port 8765
  python proxy.py --port 9000

Requirements: Python 3.6+, no external packages needed.
First run  mwinit  in a terminal so ~/.midway/cookie exists.
"""

import http.server
import http.cookiejar
import urllib.request
import urllib.error
import urllib.parse
import json
import os
import time
import argparse
from socketserver import ThreadingMixIn

FCLM_BASE      = "https://fclm-portal.amazon.com"
DEFAULT_PORT   = 8765
COOKIE_FILE    = os.path.expanduser("~/.midway/cookie")
COOKIE_MAX_AGE = 12 * 3600  # 12 hours in seconds

# Hosts the dashboard is allowed to pull from through /fetch. Anything else is
# rejected so the proxy can't be turned into an open relay.
ALLOWED_HOSTS = {
    "fclm-portal.amazon.com",
    "monitorportal.amazon.com",
    "zone-ra.amazon.dev",
    "neo.meta.amazon.dev",
}

# Cookie domains we forward (Midway SSO spans both of these).
COOKIE_DOMAIN_HINTS = ("amazon.com", "amazon.dev")

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
        if any(hint in (c.domain or "") for hint in COOKIE_DOMAIN_HINTS)
    ]
    return "; ".join(pairs)


def cookie_file_age_seconds():
    """Return age of the Midway cookie file in seconds, or None if missing."""
    if not os.path.exists(COOKIE_FILE):
        return None
    return time.time() - os.path.getmtime(COOKIE_FILE)


# ── CORS ──────────────────────────────────────────────────────────────────────

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Proxy-Auth-Error, X-Upstream-Content-Type, X-Upstream-Url",
}


# ── Request handler ───────────────────────────────────────────────────────────

class ProxyHandler(http.server.BaseHTTPRequestHandler):

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self._respond(200, {}, b"")

    def do_GET(self):
        if self.path == "/health":
            self._handle_health()
        elif self.path.startswith("/fetch?"):
            self._handle_fetch()
        elif self.path.startswith("/api/"):
            # Legacy FCLM-only path (kept so the older dashboard.html keeps working)
            self._fetch_and_respond(FCLM_BASE + self.path[4:], FCLM_BASE + "/")
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
            "status":       state,
            "cookieFile":   COOKIE_FILE,
            "cookieAge":    round(age) if age is not None else None,
            "manualCookie": bool(_manual_cookie),
            "allowedHosts": sorted(ALLOWED_HOSTS),
        })

    def _handle_fetch(self):
        query = urllib.parse.urlsplit(self.path).query
        params = urllib.parse.parse_qs(query)
        target = (params.get("url") or [""])[0]

        if not target:
            self._json({"error": "missing url parameter"}, 400)
            return

        parsed = urllib.parse.urlsplit(target)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in ALLOWED_HOSTS:
            self._json({
                "error": "host_not_allowed",
                "host": parsed.hostname,
                "allowedHosts": sorted(ALLOWED_HOSTS),
            }, 400)
            return

        referer = f"{parsed.scheme}://{parsed.hostname}/"
        self._fetch_and_respond(target, referer)

    def _fetch_and_respond(self, url: str, referer: str):
        cookie = load_cookie_header()

        req = urllib.request.Request(url)
        req.add_header("Cookie",          cookie)
        req.add_header("User-Agent",      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                                          "Chrome/120.0 Safari/537.36")
        req.add_header("Accept",          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        req.add_header("Accept-Language", "en-US,en;q=0.9")
        req.add_header("Referer",         referer)

        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                content_type = resp.headers.get("Content-Type", "text/html")
                body = resp.read()
            extra = {"X-Upstream-Content-Type": content_type, "X-Upstream-Url": url}
            self._respond(200, extra, body, content_type=content_type)

        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                self._json(
                    {
                        "error":   "auth_required",
                        "message": "Midway session expired or missing. Run  mwinit  in a "
                                   "terminal, then pull again. Or paste a fresh session cookie.",
                        "code":    exc.code,
                    },
                    200,
                    extra_headers={"X-Proxy-Auth-Error": "true"},
                )
            else:
                self._json({"error": f"HTTP {exc.code}", "code": exc.code}, 200,
                           extra_headers={"X-Proxy-Auth-Error": "true"})

        except TimeoutError:
            self._json({"error": "timeout", "message": "Upstream did not respond within 25 s."}, 200)

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

    def _json(self, obj: dict, code: int = 200, extra_headers=None):
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
        print(f"  {color}{code}\033[0m  {path[:120]}")


# ── Threaded server ───────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="OB Period Report Card Midway proxy")
    parser.add_argument("--port",      type=int, default=DEFAULT_PORT)
    parser.add_argument("--warehouse", type=str, default="RFD2")
    args = parser.parse_args()

    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   OB Period Report Card — Midway Proxy    ║")
    print("  ╚══════════════════════════════════════════╝")
    print(f"  Listening on  http://localhost:{args.port}")
    print(f"  Allow-list    {', '.join(sorted(ALLOWED_HOSTS))}")
    print()

    age = cookie_file_age_seconds()
    if age is None:
        print(f"  \033[93m⚠  Midway cookie not found at {COOKIE_FILE}\033[0m")
        print("     Run  mwinit  in a new terminal, then open the dashboard.")
    elif age > COOKIE_MAX_AGE:
        h = int(age // 3600)
        print(f"  \033[93m⚠  Midway cookie is {h}h old (may be expired)\033[0m")
        print("     Run  mwinit  to refresh, then pull again in the dashboard.")
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
