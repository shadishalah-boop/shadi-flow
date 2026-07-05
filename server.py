#!/usr/bin/env python3
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class ShadiFlowHandler(SimpleHTTPRequestHandler):
    server_version = "ShadiFlow/0.8"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), ShadiFlowHandler)
    print(f"ShadiFlow static preview running on http://{host}:{port}/")
    server.serve_forever()
