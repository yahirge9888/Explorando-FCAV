#!/usr/bin/env python3
"""Servidor local del mapa de la facultad.

Sirve el sitio (igual que `python -m http.server`) y además guarda el mapa
editado en data/mapa.json, para que TODOS los dispositivos vean los mismos cambios.

Uso (desde la carpeta del proyecto):
    python server.py            # puerto 8000
    python server.py 8080       # otro puerto

Endpoints:
    GET    /api/map     -> mapa guardado (404 si aún no hay cambios guardados)
    PUT    /api/map     -> guarda el mapa (lista JSON de lugares)
    DELETE /api/map     -> borra los cambios y vuelve al mapa original (data.js)
    GET    /api/calib   -> calibración GPS guardada (404 si no hay)
    PUT    /api/calib   -> guarda la calibración ({"points": [{x, y, lat, lon}, ...]})
    DELETE /api/calib   -> borra la calibración (se usa la de data.js)
"""
import json
import os
import socket
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
MAP_FILE = os.path.join(DATA_DIR, "mapa.json")
CALIB_FILE = os.path.join(DATA_DIR, "calibracion.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
MAX_BYTES = 8 * 1024 * 1024  # 8 MB: el mapa y las fotos de los lugares
BLOCKED = ("server.py",)

lock = threading.Lock()


def valid_map(data):
    """El mapa debe ser una lista de lugares con id y categoría."""
    return (
        isinstance(data, list)
        and 0 < len(data) <= 500
        and all(isinstance(p, dict) and isinstance(p.get("id"), str) and isinstance(p.get("cat"), str) for p in data)
    )


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def valid_calib(data):
    """Calibración: entre 3 y 50 puntos de control con posición en el croquis y en el GPS."""
    pts = data.get("points") if isinstance(data, dict) else None
    return (
        isinstance(pts, list)
        and 3 <= len(pts) <= 50
        and all(
            isinstance(p, dict)
            and all(_num(p.get(k)) for k in ("x", "y", "lat", "lon"))
            and -90 <= p["lat"] <= 90
            and -180 <= p["lon"] <= 180
            for p in pts
        )
    )


def unwrap_map(data):
    if isinstance(data, dict) and isinstance(data.get("places"), list):
        return data["places"]
    return data


# ruta -> (archivo, validador, normalizador del cuerpo, mensaje si no hay datos)
ENDPOINTS = {
    "/api/map": (MAP_FILE, valid_map, unwrap_map, "sin datos guardados"),
    "/api/calib": (CALIB_FILE, valid_calib, lambda d: d, "sin calibración"),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Sin caché: los cambios (y los archivos del sitio) se ven al recargar
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _endpoint(self):
        return ENDPOINTS.get(self.path.split("?")[0].rstrip("/"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        ep = self._endpoint()
        if ep:
            path, _, _, missing = ep
            with lock:
                if not os.path.exists(path):
                    return self._json(404, {"error": missing})
                with open(path, "rb") as f:
                    data = f.read()
            return self._send(200, data)
        if os.path.basename(self.path.split("?")[0]) in BLOCKED:
            return self._json(404, {"error": "no encontrado"})
        return super().do_GET()

    def do_PUT(self):
        ep = self._endpoint()
        if not ep:
            return self._json(404, {"error": "no encontrado"})
        path, validate, normalize, _ = ep
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._json(400, {"error": "longitud inválida"})
        if length <= 0 or length > MAX_BYTES:
            return self._json(413, {"error": "tamaño inválido"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "JSON inválido"})
        data = normalize(data)
        if not validate(data):
            return self._json(400, {"error": "formato inválido"})
        with lock:
            os.makedirs(DATA_DIR, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)  # escritura atómica
        return self._json(200, {"ok": True})

    do_POST = do_PUT

    def do_DELETE(self):
        ep = self._endpoint()
        if not ep:
            return self._json(404, {"error": "no encontrado"})
        with lock:
            if os.path.exists(ep[0]):
                os.remove(ep[0])
        return self._json(200, {"ok": True})

    def log_message(self, fmt, *args):
        if "/api/" in (str(args[0]) if args else ""):
            super().log_message(fmt, *args)


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "IP-DE-TU-PC"


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Mapa de la facultad - servidor activo", flush=True)
    print(f"  En esta PC:      http://localhost:{PORT}", flush=True)
    print(f"  En tu teléfono:  http://{lan_ip()}:{PORT}   (misma red Wi-Fi)", flush=True)
    print(f"  Cambios guardados en: {MAP_FILE}", flush=True)
    print("  Ctrl+C para detener.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
