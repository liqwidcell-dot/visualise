#!/usr/bin/env python3
"""visualise — local helper server. Stdlib only.

Serves the page, streams system audio (PipeWire/PulseAudio monitor source)
to the browser over chunked HTTP, and proxies MPRIS metadata + playback
control from playerctl. Binds 127.0.0.1 only.

Usage: python3 serve.py [--no-open] [--port N]
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
RATE = 48000          # default capture rate; the page asks for its own below
CHANNELS = 2
CHUNK = 8192          # bytes per read from parec (~21ms of stereo s16le)
ART_MAX = 8 * 1024 * 1024

# playerctl metadata format: one tab-separated line per player.
PCTL_FMT = "\t".join([
    "{{playerName}}", "{{status}}", "{{mpris:trackid}}", "{{xesam:title}}",
    "{{xesam:artist}}", "{{xesam:album}}", "{{mpris:artUrl}}",
    "{{position}}", "{{mpris:length}}",
])


def _resolve_monitor():
    """Monitor source of the current default sink (all system audio)."""
    try:
        sink = subprocess.run(
            ["pactl", "get-default-sink"], capture_output=True, text=True, timeout=3
        ).stdout.strip()
        if sink:
            return sink + ".monitor"
        row = subprocess.run(
            ["pactl", "list", "short", "sources"], capture_output=True, text=True, timeout=3
        ).stdout
        for line in row.splitlines():
            if "monitor" in line:
                return line.split("\t")[1]
    except Exception:
        pass
    return None


_monitor = {"name": None, "at": 0.0}


def default_monitor():
    """Cached briefly, so a sink change (headphones plugged in after start)
    is picked up by the next capture connection instead of going silent."""
    if _monitor["name"] and time.monotonic() - _monitor["at"] < 5:
        return _monitor["name"]
    name = _resolve_monitor()
    _monitor.update(name=name, at=time.monotonic())
    return name


MONITOR = default_monitor()


def parec_proc(rate=RATE, channels=CHANNELS):
    monitor = default_monitor()
    if not monitor or not shutil.which("parec"):
        return None
    try:
        return subprocess.Popen(
            ["parec", "--device", monitor, "--format=s16le",
             f"--rate={rate}", f"--channels={channels}", "--latency=50ms"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None


def _query_players():
    """All MPRIS players with metadata, normalised (seconds, unquoted ids)."""
    try:
        out = subprocess.run(
            ["playerctl", "-a", "metadata", "--format", PCTL_FMT],
            capture_output=True, text=True, timeout=3,
        ).stdout
    except Exception:
        return []
    players = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 9 or not parts[0].strip():
            continue
        def secs(raw):                     # playerctl format reports µs
            try:
                return float(raw or 0) / 1e6
            except ValueError:
                return 0.0
        players.append({
            "player": parts[0].strip(), "status": parts[1].strip(),
            # Some players (firefox) quote the D-Bus object path.
            "trackid": parts[2].strip().strip("'\""),
            "title": parts[3].strip(), "artist": parts[4].strip(),
            "album": parts[5].strip(), "artUrl": parts[6].strip(),
            "position": secs(parts[7]), "length": secs(parts[8]),
        })
    return players


_last_player = {"name": None}


def mpris_state(force=None):
    """Best player's now-playing info.

    Selection is sticky: while a player is Playing it wins; when nothing is
    playing we keep the last-selected player if it is still around, so two
    paused players do not fight over the page.
    """
    if not shutil.which("playerctl"):
        return {"ok": False, "reason": "playerctl not installed"}
    players = _query_players()
    if not players:
        return {"ok": False, "reason": "no players"}
    if force:
        sel = next((p for p in players if p["player"] == force), None)
        if sel is None:
            return {"ok": False, "reason": "no such player: " + force}
    else:
        cur = _last_player["name"]
        playing = [p for p in players if p["status"] == "Playing"]
        if playing:
            sel = next((p for p in playing if p["player"] == cur), playing[0])
        else:
            sel = next((p for p in players if p["player"] == cur), players[0])
        _last_player["name"] = sel["player"]
    return {"ok": True, **sel}


def control(action, value, player=None):
    """Run a playerctl command against the chosen (or given) player."""
    if not shutil.which("playerctl"):
        return {"ok": False, "reason": "playerctl not installed"}
    base = ["playerctl"]
    if player:
        base += ["-p", player]
    else:
        st = mpris_state()
        if not st.get("ok"):
            return {"ok": False, "reason": "no player"}
        base += ["-p", st["player"]]
    if action == "seek":
        try:
            cmd = base + ["position", str(float(value))]
        except (TypeError, ValueError):
            return {"ok": False, "reason": "bad seek value"}
    elif action in ("play-pause", "next", "previous"):
        cmd = base + [action]
    else:
        return {"ok": False, "reason": "unknown action"}
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        return {"ok": r.returncode == 0, "reason": r.stderr.strip() or None}
    except Exception as e:
        return {"ok": False, "reason": str(e)}


def fetch_art(url):
    """Proxy cover art so the page can read its pixels (same-origin)."""
    try:
        if url.startswith("file://"):
            path = urllib.parse.unquote(url[7:])
            with open(path, "rb") as f:
                data = f.read(ART_MAX)
            ext = os.path.splitext(path)[1].lower()
            ctype = {".png": "image/png", ".gif": "image/gif",
                     ".webp": "image/webp"}.get(ext, "image/jpeg")
            return data, ctype
        if not url.startswith(("http://", "https://")):
            return None, None
        req = urllib.request.Request(url, headers={"User-Agent": "visualise/2.0 (local)"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = r.read(ART_MAX)
            ctype = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
        return data, ctype if ctype.startswith("image/") else "image/jpeg"
    except Exception:
        return None, None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, rel, ctype):
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            self._json({"ok": False, "reason": "not found"}, 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._file("index.html", "text/html; charset=utf-8")
        elif parsed.path == "/api/state":
            q = urllib.parse.parse_qs(parsed.query)
            self._json(mpris_state((q.get("player") or [None])[0]))
        elif parsed.path == "/api/art":
            q = urllib.parse.parse_qs(parsed.query)
            data, ctype = fetch_art((q.get("url") or [""])[0])
            if data is None:
                self._json({"ok": False, "reason": "unfetchable"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "private, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
        elif parsed.path == "/stream":
            self.do_stream(parsed)
        else:
            self._json({"ok": False, "reason": "not found"}, 404)

    def do_stream(self, parsed):
        """Raw s16le stereo PCM from the monitor source, until client leaves.

        The page passes its AudioContext's real sample rate so parec and the
        Web Audio graph always agree (no resampling, no drift).
        """
        q = urllib.parse.parse_qs(parsed.query)
        try:
            rate = int((q.get("rate") or [RATE])[0])
            channels = int((q.get("channels") or [CHANNELS])[0])
        except (ValueError, TypeError):
            rate, channels = RATE, CHANNELS
        if not (8000 <= rate <= 192000):
            rate = RATE
        if channels not in (1, 2):
            channels = CHANNELS
        proc = parec_proc(rate, channels)
        if proc is None:
            self._json({"ok": False, "reason": "parec/monitor unavailable"}, 503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Rate", str(rate))
        self.send_header("X-Channels", str(channels))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                chunk = proc.stdout.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except Exception:
                proc.kill()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/control":
            self._json({"ok": False, "reason": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            self._json({"ok": False, "reason": "bad body"}, 400)
            return
        self._json(control(body.get("action"), body.get("value"), body.get("player")))


def main():
    no_open = "--no-open" in sys.argv
    port = 8765
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except (ValueError, IndexError):
            pass
    server = None
    for candidate in range(port, port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        sys.exit("no free port in range")
    url = f"http://127.0.0.1:{port}/"
    print(f"visualise → {url}" + ("" if MONITOR else "   (no monitor source: audio capture disabled)"),
          flush=True)
    if not no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
