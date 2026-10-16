#!/usr/bin/env python3
"""Development server: serves LA2 Studio from the repository root and a game folder under /data, with a JSON listing
the app's dev mode reads (?dev=http://localhost:8800/data). Used for automated browser tests.

    python3 tests/serve.py GAME_FOLDER [--port 8800]
    then open http://localhost:8800/?dev=http://localhost:8800/data
"""
import argparse, json, os, posixpath, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--port', type=int, default=8800)
    a = ap.parse_args()
    data = os.path.abspath(a.folder)
    name = os.path.basename(data.rstrip('/'))

    class H(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def translate_path(self, path):
            p = urllib.parse.unquote(urllib.parse.urlparse(path).path)
            if p.startswith('/data/'):
                return os.path.join(data, *[x for x in posixpath.normpath(p[6:]).split('/') if x not in ('', '..')])
            return os.path.join(ROOT, *[x for x in posixpath.normpath(p).split('/') if x not in ('', '..')])

        def do_GET(self):
            if self.path.split('?')[0] == '/data/__list.json':
                files = []
                for r, _, fs in os.walk(data):
                    for f in fs:
                        full = os.path.join(r, f)
                        files.append([name + '/' + os.path.relpath(full, data).replace(os.sep, '/'), os.path.getsize(full)])
                body = json.dumps({'name': name, 'files': files}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()

    print('LA2 Studio dev server: http://localhost:%d/?dev=http://localhost:%d/data' % (a.port, a.port), flush=True)
    ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()


if __name__ == '__main__':
    main()
