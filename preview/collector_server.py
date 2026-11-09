"""Local filming server: static assets + explicitly disabled APIs. No upstream calls."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import json

ROOT = Path(__file__).resolve().parents[1] / 'public'

class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            data = json.dumps({'ok': False, 'error': 'Read-only filming preview; no request sent.', 'freeLeft': None,
                               'payUrl': None, 'paymentStatus': 'inactive'}).encode()
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        alias = {'/platform': '/platform.html', '/cleancheck': '/cleancheck.html', '/check': '/check.html', '/certificate': '/certificate.html'}
        if path in alias:
            self.path = alias[path]
        super().do_GET()

    def do_POST(self):
        self.send_error(405, 'Read-only preview; no request sent')

ThreadingHTTPServer(('0.0.0.0', 8890), Preview).serve_forever()
