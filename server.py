#!/usr/bin/env python3
"""RB21 local dashboard + bridge server (port 5220).

Serves static files, stores bridge payloads at /bridge, and proxies authenticated
requests to Amazon internal sites using the local Midway session cookie.
"""

from __future__ import annotations

import http.cookiejar
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, unquote, urlparse

PORT = 5220
ROOT = Path(__file__).resolve().parent
COOKIE_FILE = os.path.expanduser("~/.midway/cookie")
COOKIE_MAX_AGE = 12 * 3600

ALLOWED_PROXY_HOSTS = (
    "fclm-portal.amazon.com",
    "monitorportal.amazon.com",
    "neo.meta.amazon.dev",
    "zone-ra.amazon.dev",
)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}

bridge_data: dict | None = None
bridge_received_at = 0
_manual_cookie = ""


def load_cookie_header() -> str:
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

    return "; ".join(
        f"{c.name}={c.value}"
        for c in jar
        if "amazon.com" in (c.domain or "") or "amazon.dev" in (c.domain or "")
    )


def cookie_file_age_seconds() -> float | None:
    if not os.path.exists(COOKIE_FILE):
        return None
    return time.time() - os.path.getmtime(COOKIE_FILE)


def proxy_allowed(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return any(host == allowed or host.endswith("." + allowed) for allowed in ALLOWED_PROXY_HOSTS)


def fetch_upstream(url: str, timeout: int = 25) -> tuple[int, str, bytes]:
    cookie = load_cookie_header()
    req = urllib.request.Request(url)
    req.add_header("Cookie", cookie)
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    )
    req.add_header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
    req.add_header("Accept-Language", "en-US,en;q=0.9")
    req.add_header("Referer", f"{urlparse(url).scheme}://{urlparse(url).netloc}/")

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        content_type = resp.headers.get("Content-Type", "application/octet-stream")
        return resp.status, content_type, resp.read()


class RB21Handler(BaseHTTPRequestHandler):
    server_version = "RB21Server/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(
        self,
        code: int,
        body: bytes = b"",
        content_type: str | None = None,
        cors: bool = False,
        extra_headers: dict | None = None,
    ) -> None:
        self.send_response(code)
        if cors:
            self._cors()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, obj: dict, code: int = 200, cors: bool = False, extra_headers: dict | None = None) -> None:
        body = json.dumps(obj, indent=2).encode()
        self._send(code, body, "application/json", cors=cors, extra_headers=extra_headers)

    def do_OPTIONS(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path in ("/bridge", "/set-cookie", "/health", "/api/proxy"):
            self._send(204, cors=True)
            return
        self._send(405)

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)
        query = parse_qs(urlparse(self.path).query)

        if path == "/health":
            age = cookie_file_age_seconds()
            if age is None:
                state = "no_cookie_file"
            elif age > COOKIE_MAX_AGE:
                state = "stale"
            elif not load_cookie_header():
                state = "empty"
            else:
                state = "ok"
            self._json(
                {
                    "status": state,
                    "cookieFile": COOKIE_FILE,
                    "cookieAge": round(age) if age is not None else None,
                    "manualCookie": bool(_manual_cookie),
                },
                cors=True,
            )
            return

        if path == "/bridge":
            global bridge_data, bridge_received_at
            if not bridge_data:
                self._send(204, cors=True)
                return
            body = json.dumps({"payload": bridge_data, "receivedAt": bridge_received_at}).encode("utf-8")
            self._send(200, body, "application/json", cors=True)
            return

        if path == "/api/proxy":
            target = query.get("url", [""])[0]
            if not target or not proxy_allowed(target):
                self._json({"error": "invalid or disallowed url"}, 400, cors=True)
                return
            try:
                status, content_type, body = fetch_upstream(target)
                self._send(
                    200,
                    body,
                    content_type,
                    cors=True,
                    extra_headers={
                        "X-Upstream-Status": str(status),
                        "X-Upstream-Content-Type": content_type,
                    },
                )
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403):
                    self._json(
                        {
                            "error": "auth_required",
                            "message": "Midway session expired or missing. Run mwinit, then retry.",
                            "code": exc.code,
                        },
                        200,
                        cors=True,
                        extra_headers={"X-Proxy-Auth-Error": "true"},
                    )
                else:
                    self._json({"error": f"HTTP {exc.code}", "code": exc.code}, 200, cors=True)
            except TimeoutError:
                self._json({"error": "timeout", "message": "Upstream did not respond within 25 s."}, 200, cors=True)
            except Exception as exc:
                self._json({"error": str(exc)}, 200, cors=True)
            return

        if path.startswith("/api/"):
            upstream_path = self.path[4:]
            upstream_url = f"https://fclm-portal.amazon.com{upstream_path}"
            try:
                status, content_type, body = fetch_upstream(upstream_url)
                self._send(
                    200,
                    body,
                    content_type,
                    cors=True,
                    extra_headers={
                        "X-Upstream-Status": str(status),
                        "X-Upstream-Content-Type": content_type,
                    },
                )
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403):
                    self._json(
                        {
                            "error": "auth_required",
                            "message": "Midway session expired or missing. Run mwinit, then retry.",
                            "code": exc.code,
                        },
                        200,
                        cors=True,
                        extra_headers={"X-Proxy-Auth-Error": "true"},
                    )
                else:
                    self._json({"error": f"HTTP {exc.code}", "code": exc.code}, 200, cors=True)
            except Exception as exc:
                self._json({"error": str(exc)}, 200, cors=True)
            return

        rel = "index.html" if path == "/" else path.lstrip("/")
        file_path = (ROOT / rel).resolve()
        if not str(file_path).startswith(str(ROOT)) or not file_path.is_file():
            self._send(404, b"Not found")
            return

        data = file_path.read_bytes()
        ext = file_path.suffix.lower()
        content_type = MIME.get(ext) or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self._send(200, data, content_type)

    def do_POST(self) -> None:
        global _manual_cookie, bridge_data, bridge_received_at
        path = unquote(urlparse(self.path).path)

        if path == "/set-cookie":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                _manual_cookie = body.get("cookie", "").strip()
                self._json({"status": "ok", "cookieSet": bool(_manual_cookie)}, cors=True)
            except Exception as exc:
                self._json({"error": str(exc)}, 400, cors=True)
            return

        if path != "/bridge":
            self._send(405, b"Method Not Allowed", cors=True)
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(400, b"Bad JSON", cors=True)
            return

        bridge_data = payload
        bridge_received_at = int(time.time() * 1000)
        self._send(200, b'{"ok":true}', "application/json", cors=True)


class ThreadedHTTPServer(ThreadingMixIn, ThreadingHTTPServer):
    daemon_threads = True


def main() -> None:
    httpd = ThreadedHTTPServer(("127.0.0.1", PORT), RB21Handler)
    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   OB Period Report Card — Local Server     ║")
    print("  ╚══════════════════════════════════════════╝")
    print(f"  Dashboard   http://127.0.0.1:{PORT}/")
    print(f"  Bridge API  http://127.0.0.1:{PORT}/bridge")
    print(f"  Proxy API   http://127.0.0.1:{PORT}/api/proxy?url=...")
    print()

    age = cookie_file_age_seconds()
    if age is None:
        print(f"  ⚠  Midway cookie not found at {COOKIE_FILE}")
        print("     Run mwinit in a terminal, then refresh the dashboard.")
    elif age > COOKIE_MAX_AGE:
        print(f"  ⚠  Midway cookie is {int(age // 3600)}h old (may be expired)")
    else:
        print(f"  ✓  Midway cookie found ({int(age // 60)}m old)")

    print()
    print("  Press Ctrl+C to stop")
    print()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
