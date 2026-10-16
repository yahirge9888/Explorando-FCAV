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
    GET    /api/foto/<id> -> imagen de un lugar; el mapa solo dice si existe
"""
import base64
import json
import os
import re
import socket
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
MAP_FILE = os.path.join(DATA_DIR, "mapa.json")
CALIB_FILE = os.path.join(DATA_DIR, "calibracion.json")
FOTO_DIR = os.path.join(DATA_DIR, "fotos")
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


# Las fotos no viajan dentro del mapa. Cada una es un archivo y se pide al ver el lugar.
ID_OK = re.compile(r"[A-Za-z0-9_-]{1,80}")
FOTO_EXT = {"jpeg": ".jpg", "jpg": ".jpg", "png": ".png", "webp": ".webp", "gif": ".gif"}
FOTO_TYPE = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}


def safe_id(value):
    if isinstance(value, str) and ID_OK.fullmatch(value):
        return value
    return None


def foto_files(sid):
    if not sid or not os.path.isdir(FOTO_DIR):
        return []
    return [os.path.join(FOTO_DIR, sid + ext) for ext in FOTO_TYPE if os.path.isfile(os.path.join(FOTO_DIR, sid + ext))]


def remove_foto(sid):
    for path in foto_files(sid):
        try:
            os.remove(path)
        except OSError:
            pass


def parse_data_url(value):
    if not isinstance(value, str) or not value.startswith("data:image/"):
        return None
    head, _, body = value.partition(",")
    if ";base64" not in head:
        return None
    kind = head[11:].split(";", 1)[0].lower()
    if kind not in FOTO_EXT:
        return None
    try:
        raw = base64.b64decode("".join(body.split()), validate=False)
    except (ValueError, TypeError):
        return None
    if not raw or len(raw) > 2 * 1024 * 1024:
        return None
    return kind, raw


def read_map():
    if not os.path.isfile(MAP_FILE):
        return None
    try:
        with open(MAP_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, list) else None


def write_map(places):
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(places, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, MAP_FILE)


def detach_photos(places):
    """Guarda las imágenes embebidas como archivos y deja en el mapa solo photo: true."""
    os.makedirs(FOTO_DIR, exist_ok=True)
    changed = False
    live = set()
    for p in places:
        if not isinstance(p, dict):
            continue
        if "photoRev" in p:
            p.pop("photoRev", None)
            changed = True
        sid = safe_id(p.get("id"))
        if sid:
            live.add(sid)
        photo = p.get("photo")
        if isinstance(photo, str) and photo.startswith("data:"):
            changed = True
            parsed = parse_data_url(photo) if sid else None
            if parsed:
                kind, raw = parsed
                remove_foto(sid)
                dest = os.path.join(FOTO_DIR, sid + FOTO_EXT[kind])
                fd, tmp = tempfile.mkstemp(dir=FOTO_DIR, suffix=".tmp")
                with os.fdopen(fd, "wb") as f:
                    f.write(raw)
                os.replace(tmp, dest)
                p["photo"] = True
            else:
                p.pop("photo", None)
                if sid:
                    remove_foto(sid)
        elif photo is True:
            if not sid or not foto_files(sid):
                p.pop("photo", None)
                changed = True
        else:
            if sid and foto_files(sid):
                remove_foto(sid)
                changed = True
            if "photo" in p:
                p.pop("photo", None)
                changed = True
    if os.path.isdir(FOTO_DIR):
        for name in os.listdir(FOTO_DIR):
            stem, ext = os.path.splitext(name)
            if ext.lower() not in FOTO_TYPE or stem not in live:
                try:
                    os.remove(os.path.join(FOTO_DIR, name))
                except OSError:
                    pass
                changed = True
    return changed


def public_map(places):
    """El mapa que viaja a los clientes: indica que hay foto, sin enviarla."""
    out = []
    for p in places:
        if not isinstance(p, dict):
            continue
        item = dict(p)
        item.pop("photoRev", None)
        sid = safe_id(item.get("id"))
        files = foto_files(sid) if sid else []
        if files:
            item["photo"] = True
            item["photoRev"] = int(os.path.getmtime(files[0]))
        else:
            item.pop("photo", None)
        out.append(item)
    return out


def clear_fotos():
    if not os.path.isdir(FOTO_DIR):
        return
    for name in os.listdir(FOTO_DIR):
        try:
            os.remove(os.path.join(FOTO_DIR, name))
        except OSError:
            pass


# ruta -> (archivo, validador, normalizador del cuerpo, mensaje si no hay datos)
ENDPOINTS = {
    "/api/map": (MAP_FILE, valid_map, unwrap_map, "sin datos guardados"),
    "/api/calib": (CALIB_FILE, valid_calib, lambda d: d, "sin calibración"),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Sin caché: los cambios (y los archivos del sitio) se ven al recargar.
        # La foto de un lugar sí se puede guardar: su dirección cambia al reemplazarla.
        if not getattr(self, "_cache_ok", False):
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

    def _foto_id(self):
        path = unquote(self.path.split("?")[0])
        prefix = "/api/foto/"
        if not path.startswith(prefix):
            return None
        return safe_id(path[len(prefix):].strip("/"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        fid = self._foto_id()
        if fid:
            with lock:
                files = foto_files(fid)
                blob = None
                ctype = "application/octet-stream"
                if files:
                    ext = os.path.splitext(files[0])[1].lower()
                    ctype = FOTO_TYPE.get(ext, ctype)
                    with open(files[0], "rb") as f:
                        blob = f.read()
            if blob is None:
                return self._json(404, {"error": "sin foto"})
            self._cache_ok = True
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(blob)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(blob)
            return
        ep = self._endpoint()
        if ep:
            path, _, _, missing = ep
            with lock:
                if path == MAP_FILE:
                    places = read_map()
                    if places is None:
                        return self._json(404, {"error": missing})
                    if detach_photos(places):
                        write_map(places)
                    return self._json(200, public_map(places))
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
            if path == MAP_FILE:
                detach_photos(data)
                write_map(data)
            else:
                os.makedirs(DATA_DIR, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                os.replace(tmp, path)
        return self._json(200, {"ok": True})

    do_POST = do_PUT

    def do_DELETE(self):
        ep = self._endpoint()
        if not ep:
            return self._json(404, {"error": "no encontrado"})
        with lock:
            if os.path.exists(ep[0]):
                os.remove(ep[0])
            if ep[0] == MAP_FILE:
                clear_fotos()
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
    with lock:
        stored = read_map()
        if stored and detach_photos(stored):
            write_map(stored)
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
