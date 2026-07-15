#!/usr/bin/env python3
"""
ARC Capacity Dashboard — Crossdock Manager / Harmony local proxy.

Forwards data requests to internal Amazon endpoints (Crossdock Manager,
Harmony, FCLM, …) using your Midway session cookie, so the ARC Capacity
dashboard can read live data from your browser-less localhost tool.

Because the exact Crossdock Manager data API is not known ahead of time,
this proxy is a *general authenticated forwarder*: the dashboard hands it the
full data-request URL you copied from the browser Network tab, and the proxy
replays it with your Midway cookie attached. Forwarding is restricted to
Amazon-internal hosts (*.a2z.com / *.amazon.com) so your cookie is never sent
anywhere else.

Usage:
  python arc_proxy.py                 # default port 8770
  python arc_proxy.py --port 9100

Requirements: Python 3.6+, no external packages needed.
"""

import http.server
import http.cookiejar
import urllib.request
import urllib.error
import json
import os
import time
import argparse
from urllib.parse import urlparse, parse_qs
from socketserver import ThreadingMixIn

DEFAULT_PORT   = 8770
COOKIE_FILE    = os.path.expanduser("~/.midway/cookie")
COOKIE_MAX_AGE = 12 * 3600  # 12 hours in seconds

# Only replay the Midway cookie to Amazon-internal hosts.
ALLOWED_SUFFIXES = (".a2z.com", ".amazon.com")

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
        if any(s.lstrip(".") in (c.domain or "") for s in ALLOWED_SUFFIXES)
    ]
    return "; ".join(pairs)


def cookie_file_age_seconds():
    """Return age of the Midway cookie file in seconds, or None if missing."""
    if not os.path.exists(COOKIE_FILE):
        return None
    return time.time() - os.path.getmtime(COOKIE_FILE)


def host_allowed(url: str) -> bool:
    """True only for https:// URLs on Amazon-internal hosts."""
    try:
        p = urlparse(url)
    except Exception:
        return False
    if p.scheme != "https" or not p.hostname:
        return False
    host = p.hostname.lower()
    return any(host == s.lstrip(".") or host.endswith(s) for s in ALLOWED_SUFFIXES)


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
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._handle_health()
        elif parsed.path == "/fetch":
            qs = parse_qs(parsed.query)
            target = (qs.get("url") or [""])[0]
            self._handle_fetch(target)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if urlparse(self.path).path == "/set-cookie":
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
        })

    def _handle_fetch(self, url: str):
        if not url:
            self._json({"error": "missing_url", "message": "Pass ?url=<absolute https URL>."}, 200,
                       extra_headers={"X-Proxy-Auth-Error": "true"})
            return
        if not host_allowed(url):
            self._json(
                {
                    "error":   "host_not_allowed",
                    "message": "The proxy only forwards to https Amazon-internal hosts "
                               "(*.a2z.com / *.amazon.com).",
                },
                200,
                extra_headers={"X-Proxy-Auth-Error": "true"},
            )
            return

        cookie = load_cookie_header()
        req = urllib.request.Request(url)
        req.add_header("Cookie",          cookie)
        req.add_header("User-Agent",      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                                          "Chrome/120.0 Safari/537.36")
        req.add_header("Accept",          "application/json,text/html;q=0.9,*/*;q=0.8")
        req.add_header("Accept-Language", "en-US,en;q=0.9")

        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                content_type = resp.headers.get("Content-Type", "application/json")
                body = resp.read()
            self._respond(200, {"X-Upstream-Content-Type": content_type},
                          body, content_type=content_type)

        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                self._json(
                    {
                        "error":   "auth_required",
                        "message": "Midway session expired or missing. Run  mwinit  in a "
                                   "terminal, then click Refresh — or paste a fresh cookie.",
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

    def _json(self, obj: dict, code: int = 200, extra_headers: dict = None):
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
    parser = argparse.ArgumentParser(description="ARC Capacity — Crossdock Manager local proxy")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   ARC Capacity Dashboard — Harmony Proxy ║")
    print("  ╚══════════════════════════════════════════╝")
    print(f"  Listening on  http://localhost:{args.port}")
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
            print(f"     Kill it:  lsof -ti:{args.port} | xargs kill")
            print(f"     Or:       python arc_proxy.py --port 9100")
        else:
            raise
    except KeyboardInterrupt:
        print("\n  Proxy stopped.")


if __name__ == "__main__":
    main()
