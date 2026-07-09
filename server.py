#!/usr/bin/env python3
"""RB20 local dashboard + bridge server (port 5220)."""

from __future__ import annotations

import json
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

PORT = 5220
ROOT = Path(__file__).resolve().parent

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.user.js': 'application/javascript; charset=utf-8',
}

bridge_data: dict | None = None
bridge_received_at = 0


class RB20Handler(BaseHTTPRequestHandler):
    server_version = 'RB20Server/1.0'

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _cors(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send(self, code: int, body: bytes = b'', content_type: str | None = None, cors: bool = False) -> None:
        self.send_response(code)
        if cors:
            self._cors()
        if content_type:
            self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        if urlparse(self.path).path == '/bridge':
            self._send(204, cors=True)
            return
        self._send(405)

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path == '/bridge':
            global bridge_data, bridge_received_at
            if not bridge_data:
                self._send(204, cors=True)
                return
            body = json.dumps({'payload': bridge_data, 'receivedAt': bridge_received_at}).encode('utf-8')
            self._send(200, body, 'application/json', cors=True)
            return

        rel = 'index.html' if path == '/' else path.lstrip('/')
        file_path = (ROOT / rel).resolve()
        if not str(file_path).startswith(str(ROOT)):
            self._send(403, b'Forbidden')
            return
        if not file_path.is_file():
            self._send(404, b'Not found')
            return

        data = file_path.read_bytes()
        ext = file_path.suffix.lower()
        content_type = MIME.get(ext) or mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
        self._send(200, data, content_type)

    def do_POST(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path != '/bridge':
            self._send(405, b'Method Not Allowed', cors=True)
            return

        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            self._send(400, b'Bad JSON', cors=True)
            return

        global bridge_data, bridge_received_at
        bridge_data = payload
        bridge_received_at = int(time.time() * 1000)
        self._send(200, b'{"ok":true}', 'application/json', cors=True)


def main() -> None:
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), RB20Handler)
    print(f'RB20 dashboard:  http://127.0.0.1:{PORT}/')
    print(f'RB20 bridge API: http://127.0.0.1:{PORT}/bridge')
    print('Press Ctrl+C to stop.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
        httpd.server_close()


if __name__ == '__main__':
    main()
