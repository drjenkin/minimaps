import collections
import hashlib
import itertools
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from flask import Flask, jsonify, request, send_from_directory, Response


# In-process ring buffer of recent log lines, fed by _log(). Polled by the
# frontend's in-app dev console (/api/logs?since=N) so we don't have to flip
# between this terminal and the browser to follow a debug session.
_LOG_BUFFER = collections.deque(maxlen=500)
_LOG_SEQ = itertools.count(1)
_LOG_LOCK = threading.Lock()


def _classify(text: str) -> str:
    t = text.lower()
    if any(k in t for k in ("failed", "error", "exhausted", "timeout", "timed out", "non-grid")):
        return "error"
    if any(k in t for k in ("returned empty", "soft error", "verifying", "needs_key", "warn")):
        return "warn"
    return "info"


def _log(*parts):
    """Single-line timestamped log - appears in the Flask terminal so the
    Overpass handshake is visible alongside Flask's normal request logs,
    AND is mirrored into the in-app dev console buffer."""
    ts = time.strftime("%H:%M:%S")
    text = " ".join(str(p) for p in parts)
    print(f"[{ts}]", text, flush=True)
    with _LOG_LOCK:
        _LOG_BUFFER.append({
            "seq": next(_LOG_SEQ),
            "ts": ts,
            "epoch": time.time(),
            "level": _classify(text),
            "text": text,
        })


# === Overpass response cache ===========================================
# Public Overpass mirrors are flaky under load. Disk-caching responses by
# query hash means repeat fetches for the same bbox are instant and never
# touch the network - same trick Blender GIS uses. OSM building data
# changes slowly enough that cache-forever is fine; bust by deleting the
# cache dir or the specific file.
#
# Empty responses are deliberately NOT cached so a throttle-induced empty
# 200 doesn't poison the cache forever.
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache", "overpass")
os.makedirs(CACHE_DIR, exist_ok=True)
CACHE_ENABLED = os.environ.get("OVERPASS_CACHE", "1") != "0"


def _cache_path_for(query: str) -> str:
    key = hashlib.sha1(query.encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, key + ".json")


def _cache_get(query: str):
    if not CACHE_ENABLED:
        return None
    path = _cache_path_for(query)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        _log(f"cache read failed: {e}")
        return None


def _cache_put(query: str, body: str):
    if not CACHE_ENABLED:
        return
    # Skip empties - likely throttle-induced and we want to retry next time.
    try:
        parsed = json.loads(body)
        if not parsed.get("elements"):
            return
    except Exception:
        return
    path = _cache_path_for(query)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    except Exception as e:
        _log(f"cache write failed: {e}")

# OpenTopography API key resolution, in priority order:
#   1. ?key=... on the heightmap request - supplied by the browser from the
#      user's own saved key. This is the path used in production / shared
#      deployments where every visitor brings their own key.
#   2. OPENTOPO_KEY environment variable - convenient for local development
#      so you don't have to paste your key into the UI on every boot.
# If neither is present the /api/heightmap endpoint returns a 400 with a
# `needs_key` flag so the frontend can prompt the user.
OPENTOPO_KEY_ENV = os.environ.get("OPENTOPO_KEY")

FRONTEND_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)

app = Flask(__name__, static_folder=None)


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_file(path):
    return send_from_directory(FRONTEND_DIR, path)


_HEADER_KEYS = {
    "ncols", "nrows", "xllcorner", "yllcorner",
    "xllcenter", "yllcenter", "cellsize",
    "nodata_value", "dx", "dy",
}


def _parse_aaigrid(text: str):
    header = {}
    data_start = 0
    lines = text.splitlines()
    for i, line in enumerate(lines):
        parts = line.strip().split()
        if not parts:
            continue
        key = parts[0].lower()
        if key in _HEADER_KEYS and len(parts) >= 2:
            try:
                header[key] = float(parts[1])
                continue
            except ValueError:
                pass
        data_start = i
        break

    ncols = int(header["ncols"])
    nrows = int(header["nrows"])
    nodata = header.get("nodata_value", -9999.0)

    values = []
    for line in lines[data_start:]:
        for tok in line.split():
            v = float(tok)
            values.append(None if v == nodata else v)

    return {
        "ncols": ncols,
        "nrows": nrows,
        "cellsize": header.get("cellsize"),
        "xllcorner": header.get("xllcorner"),
        "yllcorner": header.get("yllcorner"),
        "values": values,
    }


@app.route("/api/heightmap")
def heightmap():
    try:
        south = float(request.args["south"])
        north = float(request.args["north"])
        west = float(request.args["west"])
        east = float(request.args["east"])
    except (KeyError, ValueError):
        return jsonify({"error": "Missing or invalid bbox params"}), 400

    demtype = request.args.get("demtype", "SRTMGL1")

    # Latitude coverage limits per DEM. SRTM-family instruments only flew
    # between ~60°N and ~56°S, so anything outside that band returns HTTP 204
    # (No Content) - a coverage gap, NOT a transient error. Catch it up front
    # so we can give a precise "switch to X" message instead of a vague fail.
    DEM_LAT_COVERAGE = {
        "SRTMGL1": (-56.0, 60.0),
        "SRTMGL3": (-56.0, 60.0),
        "NASADEM": (-56.0, 60.0),
        "AW3D30":  (-82.0, 82.0),   # JAXA ALOS - near-global, handles high lat
        # COP30 is fully global (poles included), so no entry = no gate.
    }
    cov = DEM_LAT_COVERAGE.get(demtype)
    if cov and (north > cov[1] or south < cov[0]):
        _log(f"heightmap[{demtype}]: bbox {south:.2f}..{north:.2f} outside coverage {cov}")
        return jsonify({
            "error": f"{demtype} has no data at this latitude",
            "detail": (f"{demtype} only covers {cov[0]:.0f}° to {cov[1]:.0f}° latitude "
                       f"(your region spans {south:.1f}° to {north:.1f}°). For polar / "
                       f"high-latitude areas use 'Copernicus 30m' (global) or "
                       f"'AWS Terrain (no key)'."),
            "coverage_gap": True,
        }), 400

    # Per-request key wins; env var is the local-dev convenience fallback.
    api_key = request.args.get("key") or OPENTOPO_KEY_ENV
    if not api_key:
        return jsonify({
            "error": "OpenTopography API key required",
            "detail": "Click '🔑 OpenTopo key' in the map controls and paste a free key from opentopography.org.",
            "needs_key": True,
        }), 400

    params = {
        "demtype": demtype,
        "south": south,
        "north": north,
        "west": west,
        "east": east,
        "outputFormat": "AAIGrid",
        "API_Key": api_key,
    }
    url = "https://portal.opentopography.org/API/globaldem?" + urllib.parse.urlencode(params)

    dem_label = f"heightmap[{demtype} {south:.4f},{west:.4f},{north:.4f},{east:.4f}]"
    masked_key = (api_key[:4] + "…" + api_key[-4:]) if len(api_key) >= 8 else "(short)"
    _log(f"{dem_label}: requesting OpenTopography (key {masked_key})")

    started = time.time()
    status = None
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            status = resp.getcode()
            text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        dur = time.time() - started
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        _log(f"{dem_label}: HTTP {e.code} in {dur:.1f}s - body[:200]={body[:200]!r}")
        # OpenTopography uses 401 (bad key) and 429 (quota) - surface those as
        # key issues so the frontend re-opens the key dialog.
        needs_key = e.code in (401, 403, 429)
        return jsonify({
            "error": f"OpenTopography HTTP {e.code}",
            "detail": body[:400] or "(empty error body)",
            "needs_key": needs_key,
        }), 502
    except urllib.error.URLError as e:
        dur = time.time() - started
        _log(f"{dem_label}: network error in {dur:.1f}s - {e.reason}")
        return jsonify({"error": "OpenTopography network error", "detail": str(e.reason)}), 502

    dur = time.time() - started
    _log(f"{dem_label}: HTTP {status} in {dur:.1f}s, {len(text)} bytes, head={text[:80]!r}")

    # OpenTopography occasionally responds with HTTP 200 but a plain-text error
    # body (e.g. for invalid keys or quota overruns) instead of a proper 4xx.
    # Detect that here so we can surface the actual message instead of dying
    # inside the AAIGrid parser with a cryptic KeyError.
    head_lower = text[:200].lower()
    if "ncols" not in head_lower:
        msg = text.strip()
        is_empty = not msg
        _log(f"{dem_label}: NON-GRID response ({'empty' if is_empty else msg[:160]!r})")
        body = {
            "error": "OpenTopography returned a non-grid response",
            "detail": msg[:600] or "(empty response)",
        }
        flag = msg.lower()
        if is_empty or status == 204:
            # Empty / 204 within nominal coverage usually means a localised
            # void in the DEM for this exact bbox. Could also be transient
            # load. Either way, recommend an alternative DEM rather than
            # silently substituting one.
            body["detail"] = ("OpenTopography returned no elevation data for this region. "
                              "This DEM may have a coverage void here - try 'Copernicus 30m' "
                              "or 'AWS Terrain (no key)' from the DEM dropdown.")
            body["coverage_gap"] = True
        elif any(kw in flag for kw in ("api_key", "api key", "invalid key", "unauthorized", "exceed", "quota", "limit")):
            body["needs_key"] = True
        return jsonify(body), 502

    try:
        return jsonify(_parse_aaigrid(text))
    except Exception as e:
        _log(f"{dem_label}: parse failed - {e}")
        return jsonify({"error": "Failed to parse heightmap", "detail": str(e), "head": text[:400]}), 502


TILE_PROVIDERS = {
    "esri":          lambda z, x, y: f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "esri-ocean":    lambda z, x, y: f"https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
    "esri-labels":   lambda z, x, y: f"https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    "aws-terrain":   lambda z, x, y: f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
}


@app.route("/api/tile/<provider>/<int:z>/<int:y>/<int:x>")
def tile(provider, z, y, x):
    if provider not in TILE_PROVIDERS:
        return jsonify({"error": f"Unknown provider: {provider}"}), 400

    url = TILE_PROVIDERS[provider](z, x, y)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (minimap-pucks experimental)",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
            ct = resp.headers.get("Content-Type", "image/jpeg")
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"Upstream HTTP {e.code}"}), 502
    except urllib.error.URLError as e:
        return jsonify({"error": "Network error", "detail": str(e.reason)}), 502

    response = app.response_class(data, mimetype=ct)
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


# Public Overpass mirrors. The main de instance is chronically overloaded and
# 504s on dense-area queries; the community mirrors are usually fresher. We
# try them in order and return the first that answers within the timeout.
OVERPASS_MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",       # Kumi Systems
    "https://overpass.osm.ch/api/interpreter",             # Swiss community mirror
    "https://overpass.openstreetmap.fr/api/interpreter",   # French community mirror
    "https://overpass-api.de/api/interpreter",             # main (often overloaded)
    "https://overpass.private.coffee/api/interpreter",     # private.coffee mirror
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def _overpass_query(query: str, timeout: int = 25, label: str = "overpass", verify_empty: bool = False):
    """Try each mirror in order. Returns (text, used_url) on success.
    Raises RuntimeError if every mirror fails.

    Every attempt is logged so the Flask terminal shows the full handshake:
    which mirror was hit, how long it took, what came back. This is the
    primary diagnostic when buildings silently fail to load.

    `verify_empty`: if True, a response with 0 elements is treated as
    suspicious and we try one more mirror before accepting it. Some public
    mirrors (notably overpass.osm.ch under load) silently return a fast
    empty response instead of a proper 429, which would otherwise look like
    a region genuinely having no data. Once a SECOND mirror also returns
    empty, we accept it as real."""
    _log(f"{label}: query length={len(query)}, mirrors={len(OVERPASS_MIRRORS)}, verify_empty={verify_empty}")
    last_err = None
    tried = []
    pending_empty = None  # (body, url, host) - held in case next mirror confirms

    for i, url in enumerate(OVERPASS_MIRRORS, start=1):
        host = url.split("//", 1)[-1].split("/", 1)[0]
        tried.append(host)
        req = urllib.request.Request(
            url, data=query.encode("utf-8"),
            headers={"User-Agent": "minimap-pucks/0.1"},
            method="POST",
        )
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                dur = time.time() - started

                # Overpass servers often return HTTP 200 with `{"remark": "runtime
                # error..."}` instead of `{"elements": [...]}` when they choke
                # mid-query (timeout, memory limit). Treat that as a soft fail
                # and rotate to the next mirror so we don't return zero buildings.
                soft_err = _detect_overpass_soft_error(body)
                if soft_err:
                    _log(f"{label}: {i}/{len(OVERPASS_MIRRORS)} {host} returned 200 in {dur:.1f}s but with soft error: {soft_err[:140]}")
                    last_err = RuntimeError(f"{host} soft error: {soft_err[:200]}")
                    continue

                # Verify-empty path: if the caller cares about distinguishing
                # "genuinely empty" from "mirror lied", hold the response and
                # see if the next mirror agrees.
                if verify_empty:
                    try:
                        elements = json.loads(body).get("elements", [])
                    except Exception:
                        elements = None
                    if elements is not None and len(elements) == 0:
                        if pending_empty is None:
                            _log(f"{label}: {i}/{len(OVERPASS_MIRRORS)} {host} returned EMPTY in {dur:.1f}s - verifying with next mirror")
                            pending_empty = (body, url, host)
                            continue
                        else:
                            # Two mirrors in a row say empty - accept it.
                            _log(f"{label}: {i}/{len(OVERPASS_MIRRORS)} {host} also empty in {dur:.1f}s - confirmed genuinely empty")
                            return body, url

                _log(f"{label}: {i}/{len(OVERPASS_MIRRORS)} {host} OK in {dur:.1f}s, {len(body)} bytes")
                return body, url
        except urllib.error.HTTPError as e:
            dur = time.time() - started
            _log(f"{label}: {i}/{len(OVERPASS_MIRRORS)} {host} HTTP {e.code} in {dur:.1f}s")
            if e.code in (429, 500, 502, 503, 504):
                last_err = e
                continue
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            dur = time.time() - started
            _log(f"{label}: {i}/{len(OVERPASS_MIRRORS)} {host} {type(e).__name__} in {dur:.1f}s: {e}")
            last_err = e
            continue

    # All mirrors exhausted. If we held an empty response from earlier, return
    # it now (better than nothing - caller will report "0 buildings").
    if pending_empty is not None:
        body, url, host = pending_empty
        _log(f"{label}: exhausted - falling back to held empty response from {host}")
        return body, url

    msg = f"All {len(OVERPASS_MIRRORS)} Overpass mirrors failed (tried: {', '.join(tried)})"
    if last_err:
        msg += f" - last error: {type(last_err).__name__}: {last_err}"
    _log(f"{label}: EXHAUSTED - {msg}")
    raise RuntimeError(msg)


def _detect_overpass_soft_error(body: str):
    """Overpass returns its internal errors as HTTP 200 with one of:
      - JSON `{"remark": "..."}`  (no elements, or elements + remark)
      - HTML "Error: runtime error: query timed out..."
    Returns the human-readable error string if detected, else None."""
    head = body[:500]
    if "runtime error" in head.lower() or "query timed out" in head.lower():
        return head.strip().replace("\n", " ")[:300]
    if head.lstrip().startswith("{"):
        try:
            parsed = json.loads(body)
            remark = parsed.get("remark")
            if remark and ("error" in remark.lower() or "timed out" in remark.lower()):
                return remark
        except Exception:
            pass
    return None


@app.route("/api/water")
def water():
    try:
        south = float(request.args["south"])
        north = float(request.args["north"])
        west = float(request.args["west"])
        east = float(request.args["east"])
    except (KeyError, ValueError):
        return jsonify({"error": "Missing or invalid bbox params"}), 400

    query = (
        "[out:json][timeout:25];"
        "("
        f'way["natural"="water"]({south},{west},{north},{east});'
        f'relation["natural"="water"]({south},{west},{north},{east});'
        ");"
        "out geom;"
    )
    bbox_label = f"water[{south:.4f},{west:.4f},{north:.4f},{east:.4f}]"

    cached = _cache_get(query)
    if cached is not None:
        _log(f"{bbox_label}: CACHE HIT (no network)")
        return app.response_class(cached, mimetype="application/json")

    try:
        data, _ = _overpass_query(query, timeout=25, label=bbox_label)
        _cache_put(query, data)
        return app.response_class(data, mimetype="application/json")
    except Exception as e:
        # Water is non-fatal - let the puck render without it.
        _log(f"{bbox_label}: FAILED - {e}")
        return jsonify({"error": "Overpass unavailable", "detail": str(e)}), 502
    except urllib.error.URLError as e:
        return jsonify({"error": "Overpass network error", "detail": str(e.reason)}), 502


@app.route("/api/buildings")
def buildings():
    """Overpass query for OSM building footprints in the requested bbox.
    Returns the raw Overpass JSON ({elements: [...]}). Each way carries a
    `geometry` array of {lat, lon} plus a `tags` object that may include
    `height`, `building:levels`, `building`, `name`, etc."""
    try:
        south = float(request.args["south"])
        north = float(request.args["north"])
        west = float(request.args["west"])
        east = float(request.args["east"])
    except (KeyError, ValueError):
        return jsonify({"error": "Missing or invalid bbox params"}), 400

    # `out geom` returns the geometry inline so we don't need a second
    # roundtrip to resolve node ids. Relations are included so multipolygon
    # buildings (with courtyards / holes) come through as their member ways.
    query = (
        "[out:json][timeout:25];"
        "("
        f'way["building"]({south},{west},{north},{east});'
        f'relation["building"]({south},{west},{north},{east});'
        ");"
        "out geom;"
    )
    bbox_label = f"buildings[{south:.4f},{west:.4f},{north:.4f},{east:.4f}]"

    # Cache hit path - return immediately, no network. Pass through a header
    # so the frontend devtools can see it was served locally.
    cached = _cache_get(query)
    if cached is not None:
        try:
            elements = json.loads(cached).get("elements", [])
            _log(f"{bbox_label}: CACHE HIT, {len(elements)} elements (no network)")
        except Exception:
            _log(f"{bbox_label}: CACHE HIT")
        response = app.response_class(cached, mimetype="application/json")
        response.headers["X-Overpass-Cache"] = "hit"
        return response

    try:
        data, used = _overpass_query(query, timeout=25, label=bbox_label, verify_empty=True)
        _cache_put(query, data)
        # Count elements for the log so we can see if a "successful" fetch
        # came back empty - common cause of silent UI failures.
        try:
            parsed = json.loads(data)
            elements = parsed.get("elements", [])
            host = used.split('//', 1)[-1].split('/', 1)[0]
            _log(f"{bbox_label}: served by {host}, {len(elements)} elements")
            # Empty result: dump the full body + a verification URL so we can
            # tell "genuinely no buildings in this bbox" from "throttled / stale
            # mirror lied to us". Paste the URL into a browser to verify.
            if len(elements) == 0:
                verify_url = (
                    "https://overpass-turbo.eu/?Q="
                    + urllib.parse.quote(query, safe='')
                    + "&R="
                )
                _log(f"{bbox_label}: EMPTY RESPONSE BODY: {data[:400]}")
                _log(f"{bbox_label}: verify on overpass-turbo: {verify_url}")
        except Exception:
            _log(f"{bbox_label}: served {len(data)} bytes but could not parse element count")
        response = app.response_class(data, mimetype="application/json")
        response.headers["X-Overpass-Mirror"] = used
        return response
    except Exception as e:
        _log(f"{bbox_label}: FAILED - {e}")
        return jsonify({
            "error": "All Overpass mirrors unavailable",
            "detail": str(e),
            "hint": "Public Overpass instances rate-limit and time out under load. Try a smaller capture region, or wait 1–2 minutes and click Reload again."
        }), 502


@app.route("/api/logs")
def logs():
    """Cursor-based polling endpoint for the in-app dev console. Client passes
    `?since=<seq>` (the highest seq it's already seen); we return everything
    newer plus the new high-water-mark. First poll uses since=0 to get the
    full buffer."""
    try:
        since = int(request.args.get("since", "0"))
    except ValueError:
        since = 0
    with _LOG_LOCK:
        new = [e for e in _LOG_BUFFER if e["seq"] > since]
        latest = _LOG_BUFFER[-1]["seq"] if _LOG_BUFFER else since
    return jsonify({"lines": new, "next": latest})


@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    params = {
        "format": "json",
        "q": q,
        "limit": 6,
        "addressdetails": 1,
    }
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": "minimap-pucks/0.1",
        "Accept-Language": "en",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8")
        return app.response_class(data, mimetype="application/json")
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"Nominatim HTTP {e.code}"}), 502
    except urllib.error.URLError as e:
        return jsonify({"error": "Nominatim network error", "detail": str(e.reason)}), 502


@app.route("/api/geocode")
def geocode():
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify({"error": "Missing lat/lon"}), 400

    params = {
        "format": "json",
        "lat": lat,
        "lon": lon,
        "zoom": 10,
        "addressdetails": 1,
    }
    url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": "minimap-pucks/0.1",
        "Accept-Language": "en",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8")
        return app.response_class(data, mimetype="application/json")
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"Nominatim HTTP {e.code}"}), 502
    except urllib.error.URLError as e:
        return jsonify({"error": "Nominatim network error", "detail": str(e.reason)}), 502


@app.route("/api/transcode", methods=["POST"])
def transcode():
    """Transcode an uploaded WebM rotation clip to MP4 (H.264) via ffmpeg.

    The browser records WebM when it can't natively encode MP4; X/Twitter and
    many tools reject WebM, so we convert server-side. Raw clip bytes arrive as
    the request body. Returns the MP4 bytes, or an error the client can fall
    back on (saving the original WebM)."""
    import subprocess
    import tempfile
    import shutil

    data = request.get_data()
    if not data:
        return jsonify({"error": "empty body"}), 400
    if len(data) > 250 * 1024 * 1024:            # 250 MB hard cap
        return jsonify({"error": "clip too large"}), 413

    tmp = tempfile.mkdtemp(prefix="mm_transcode_")
    src = os.path.join(tmp, "in.webm")
    dst = os.path.join(tmp, "out.mp4")
    try:
        with open(src, "wb") as f:
            f.write(data)
        # yuv420p + even dimensions = maximum player/social compatibility;
        # +faststart moves the index to the front for instant web playback.
        cmd = [
            "ffmpeg", "-y", "-i", src,
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-crf", "20", "-preset", "veryfast",
            "-movflags", "+faststart", "-an", dst,
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=180)
        if proc.returncode != 0 or not os.path.exists(dst):
            tail = proc.stderr.decode("utf-8", "ignore")[-500:]
            _log(f"transcode: ffmpeg failed rc={proc.returncode} — {tail}")
            return jsonify({"error": "ffmpeg failed"}), 500
        with open(dst, "rb") as f:
            mp4 = f.read()
        _log(f"transcode: {len(data)//1024} KB webm -> {len(mp4)//1024} KB mp4")
        return Response(mp4, mimetype="video/mp4")
    except FileNotFoundError:
        return jsonify({"error": "ffmpeg not installed"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "transcode timeout"}), 504
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    # Public build runs on its own port so it can coexist with the pro/dev
    # version (which uses 5000). Open http://127.0.0.1:5001/
    app.run(host="127.0.0.1", port=5001, debug=True)
