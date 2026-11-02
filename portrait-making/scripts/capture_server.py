"""Receives canvas captures POSTed from the browser and writes them to disk.

  python capture_server.py --out work/frames --port 8124

The page POSTs a data URL (image/png or image/jpeg) to http://127.0.0.1:<port>/<filename>.
Run it in the background and stop it when the capture is done. Only pages served from
this machine may send it anything, and only images are written. If you change --port,
add ?capturePort=<port> to the page's URL.
"""
import argparse
import base64
import http.server
import os
import re

LOCAL_PAGE = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$")
IMAGES = (".png", ".jpg", ".jpeg")


def make_handler(out):
    class Handler(http.server.BaseHTTPRequestHandler):
        def _refused(self):
            # a browser sends a plain POST whatever the CORS headers say, so the
            # server itself has to turn away pages from anywhere else
            origin = self.headers.get("Origin")
            if origin is None or LOCAL_PAGE.match(origin):
                return False
            self.send_error(403)
            return True

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "*")

        def do_OPTIONS(self):
            if self._refused():
                return
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_POST(self):
            if self._refused():
                return
            name = os.path.basename(self.path.strip("/")) or "capture.png"
            if not name.lower().endswith(IMAGES):
                self.send_error(400)
                return
            data = self.rfile.read(int(self.headers["Content-Length"])).decode()
            with open(os.path.join(out, name), "wb") as f:
                f.write(base64.b64decode(data.split(",", 1)[1]))
            self.send_response(200)
            self._cors()
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=8124)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    print(f"saving captures to {os.path.abspath(a.out)} on 127.0.0.1:{a.port}", flush=True)
    http.server.HTTPServer(("127.0.0.1", a.port), make_handler(a.out)).serve_forever()


if __name__ == "__main__":
    main()
