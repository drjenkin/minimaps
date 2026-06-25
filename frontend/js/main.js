import { setupMap, capture, getRegionWidthMeters, refetchAlbedo, usefulZoomRange, getOpentopoKey, setOpentopoKey, NeedsOpentopoKeyError } from './map.js';

const MIN_REGION_M = 800;
const MAX_REGION_M = 40000;

// Seconds for one full rotation in the exported WebM. Higher = slower, more
// graceful spin. This is the single knob - change it and the recording length
// + rotation speed both follow. (~24 s reads as a calm showcase rotation.)
const WEBM_ROTATION_SECONDS = 32;
import { createPuck, enterPresentMode, exitPresentMode, setWaterShader, setOceanColourProbes, setWaterShoreFade, setSurfaceBumpStrength, setImageAdjust, setStyle, setZExaggeration, setCameraMode, getCameraMode, setPuckAlbedo, getFilterState, captureSnapshotPNG, recordRotation, getRecordingFileExtension, getPuckGeoParams, setBuildingsGroup, hasBuildings, clearBuildings, setFillLight } from './puck.js';
import { buildWaterMask } from './water.js';
import { loadLibrary, saveToLibrary, deleteFromLibrary } from './library.js';
import { exportSTL, exportOBJ, exportGLB } from './stl.js';
import { fetchBuildings, buildBuildingGroup } from './buildings.js';

const state = {
  map: null,
  currentPuck: null,
  currentName: null,
};

// Debug hook so we can poke at module-internal state from the browser console.
// Use as `mm.state.currentPuck` etc. Harmless in production; cheap to keep.
if (typeof window !== 'undefined') window.mm = { state };

const $ = (id) => document.getElementById(id);

function setBusy(msg) {
  const el = $('busy');
  if (msg) {
    $('busy-text').textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// Lightweight transient notification - bottom-centre, auto-dismisses. Used
// for non-blocking heads-ups (e.g. DEM fallback) that shouldn't hijack the
// busy spinner. Creates its element lazily so no HTML/CSS dependency.
let _toastTimer = null;
function flashToast(msg, ms = 3500) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = [
      'position:absolute', 'bottom:84px', 'left:50%', 'transform:translateX(-50%)',
      'background:rgba(20,22,25,0.95)', 'color:#e6e6e6', 'padding:10px 16px',
      'border-radius:8px', 'font-size:12.5px', 'z-index:1600', 'max-width:80%',
      'box-shadow:0 8px 24px rgba(0,0,0,0.4)', 'backdrop-filter:blur(10px)',
      'border:1px solid #2e3238', 'pointer-events:none',
    ].join(';');
    document.getElementById('app').appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Showroom = the only viewing state for a puck now. Apply the present-mode
// styling (gradient background, no grid, shadow disc, exposure boost), drop
// the on-screen caption and the export viewfinder, and leave the user's
// orbit/zoom untouched. Auto-rotate is off - the puck sits still until they
// grab it.
function enterShowroom() {
  enterPresentMode({ preserveCamera: true });
  document.body.classList.add('presenting');
  renderPresentCaption();
  $('export-viewfinder').hidden = false;
  updateViewfinderSize();
}

function leaveShowroom() {
  exitPresentMode();
  document.body.classList.remove('presenting');
  $('present-caption').hidden = true;
  $('export-viewfinder').hidden = true;
}

function switchView(name) {
  // Leaving the puck view → tear down the showroom styling so the next puck
  // (or library load) starts clean.
  if (name !== 'puck') leaveShowroom();

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(name + '-view').classList.add('active');

  // Body class so CSS can react to which view is showing - e.g. the gallery
  // hides the library sidebar (it IS the library, at full size).
  document.body.classList.remove('view-gallery', 'view-map', 'view-puck');
  document.body.classList.add('view-' + name);

  if (name === 'map') {
    $('filters-panel').hidden = true;     // filters are puck-view-only
    setTimeout(() => state.map?.invalidateSize(), 50);
  }
  if (name === 'puck') window.dispatchEvent(new Event('resize'));
  if (name === 'gallery') renderGallery();
}

// Promote the filters panel out of #puck-view to become a real flex sibling
// of #stage in #app. With flexbox it then shrinks the stage when open instead
// of overlaying the canvas. The DOM move is purely cosmetic - IDs and event
// listeners survive.
document.getElementById('app').appendChild($('filters-panel'));

state.map = setupMap('map');

// Filters panel - toggle on button click, explicit close via × button. No
// auto-close on outside click so the panel can stay open while inspecting
// the puck.
$('filters-btn').addEventListener('click', () => {
  const p = $('filters-panel');
  p.hidden = !p.hidden;
});
$('filters-close').addEventListener('click', () => {
  $('filters-panel').hidden = true;
});

// Filter toggles apply directly to the current puck (post-capture).
$('filter-water-shader').addEventListener('change', (e) => {
  if (!state.currentPuck) return;
  setWaterShader(e.target.checked);
});
$('filter-water-probes').addEventListener('change', (e) => {
  if (!state.currentPuck) return;
  setOceanColourProbes(e.target.checked);
});

function applyWaterShoreSettings() {
  const start = parseFloat($('water-shore-start').value);
  const feather = parseFloat($('water-feather').value);
  if (state.currentPuck) setWaterShoreFade(start, feather);
}
$('water-shore-start').addEventListener('input', (e) => {
  $('water-shore-start-val').textContent = parseFloat(e.target.value).toFixed(2);
  applyWaterShoreSettings();
});
$('water-feather').addEventListener('input', (e) => {
  $('water-feather-val').textContent = parseFloat(e.target.value).toFixed(2);
  applyWaterShoreSettings();
});

// OpenTopography key dialog - opened either from the explicit button in the
// map controls, or automatically when /api/heightmap rejects a request for
// lack of a key.
function openOpentopoKeyDialog(message) {
  const dlg = $('opentopo-key-dialog');
  $('opentopo-key-input').value = getOpentopoKey();
  if (message) {
    $('opentopo-key-input').placeholder = message;
  }
  dlg.hidden = false;
  $('opentopo-key-input').focus();
}
function closeOpentopoKeyDialog() { $('opentopo-key-dialog').hidden = true; }

// Map-screen button - lets users add/change their OpenTopo key any time, in
// case they skipped the first-run banner. Opens the same dialog.
$('opentopo-key-btn').addEventListener('click', () => {
  openOpentopoKeyDialog('Paste your free OpenTopography API key here');
});

// Capture rotation: lets users frame off-North. The slider visually rotates the
// capture square; the value is read by the capture handler and threaded through
// to map.js, which resamples the rotated region out of a north-up fetch.
let _captureRotation = 0;
const _rotSlider = $('rotation-slider');
if (_rotSlider) {
  _rotSlider.addEventListener('input', (e) => {
    _captureRotation = parseInt(e.target.value, 10) || 0;
    $('rotation-val').textContent = _captureRotation + '°';
    const sq = $('capture-square');
    if (sq) sq.style.transform = `rotate(${_captureRotation}deg)`;
  });
}

$('opentopo-key-cancel').addEventListener('click', closeOpentopoKeyDialog);
$('opentopo-key-save').addEventListener('click', () => {
  const v = $('opentopo-key-input').value.trim();
  setOpentopoKey(v);
  closeOpentopoKeyDialog();
  refreshFirstRunBanner();   // hide the banner once a key is saved
});
$('opentopo-key-clear').addEventListener('click', () => {
  setOpentopoKey('');
  $('opentopo-key-input').value = '';
});
$('opentopo-key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('opentopo-key-save').click();
  if (e.key === 'Escape') closeOpentopoKeyDialog();
});

// First-run banner. Shown on the gallery view until the user either saves
// an OpenTopo key (Copernicus is then unblocked) or explicitly dismisses
// it. Dismissal sticks in localStorage so they never see it again.
const FIRST_RUN_DISMISSED_KEY = 'minimap_first_run_dismissed';
function shouldShowFirstRunBanner() {
  if (getOpentopoKey()) return false;
  try { if (localStorage.getItem(FIRST_RUN_DISMISSED_KEY) === '1') return false; } catch {}
  return true;
}
function refreshFirstRunBanner() {
  const el = $('first-run-banner');
  if (!el) return;
  el.hidden = !shouldShowFirstRunBanner();
}
$('frb-paste').addEventListener('click', () => {
  openOpentopoKeyDialog('Paste your free OpenTopography API key here');
});
$('frb-dismiss').addEventListener('click', () => {
  try { localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1'); } catch {}
  refreshFirstRunBanner();
});

// Fill light - scene-level preference (NOT a per-puck filter). Persists in
// localStorage so it survives page reloads and applies to every puck loaded
// this session without needing to be on each one's saved state.
const FILL_LIGHT_KEY = 'minimap_fill_light';
function applyFillLightFromPref() {
  const on = localStorage.getItem(FILL_LIGHT_KEY) === 'on';
  $('filter-fill-light').checked = on;
  setFillLight(on);
}
$('filter-fill-light').addEventListener('change', (e) => {
  const on = e.target.checked;
  localStorage.setItem(FILL_LIGHT_KEY, on ? 'on' : 'off');
  setFillLight(on);
});

// Camera mode toggle button (main puck controls).
$('camera-toggle-btn').addEventListener('click', () => {
  const next = getCameraMode() === 'perspective' ? 'orthographic' : 'perspective';
  setCameraMode(next);
  $('camera-toggle-btn').textContent = next === 'perspective' ? 'Perspective' : 'Orthographic';
});

// ===== Experimental panel =====
// Drop-up menu (same pattern as #share-menu) housing features that are still
// rough around the edges - currently OSM building overlays with optional
// satellite-texture projection. Click-outside closes it.

$('experimental-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('experimental-menu');
  m.hidden = !m.hidden;
});

document.addEventListener('click', (e) => {
  if ($('experimental-menu').hidden) return;
  if (!e.target.closest('#experimental-menu') && !e.target.closest('#experimental-btn')) {
    $('experimental-menu').hidden = true;
  }
});

// Rebuild the buildings group from cached Overpass JSON using the current
// panel state. Fetches OSM if we haven't seen it for this puck yet.
async function rebuildBuildings({ forceRefetch = false } = {}) {
  if (!state.currentPuck) return;
  const geoParams = getPuckGeoParams();
  if (!geoParams) return;

  const reloadBtn    = $('exp-buildings-reload');
  const enableBox    = $('exp-buildings-enable');
  const projectBox   = $('exp-buildings-project');
  const offWhiteBox  = $('exp-buildings-walls-offwhite');

  reloadBtn.disabled = true;
  try {
    let overpass = state.currentPuck.data.buildingsOSM;
    if (forceRefetch || !overpass) {
      setBusy('Fetching OSM buildings…');
      overpass = await fetchBuildings(state.currentPuck.data.bounds);
      state.currentPuck.data.buildingsOSM = overpass;
    }
    setBusy('Extruding buildings…');
    await new Promise(r => setTimeout(r, 0));   // let the spinner paint
    const group = buildBuildingGroup(overpass, geoParams, {
      projectTexture: projectBox.checked,
      wallsOffWhite:  offWhiteBox.checked,
    });
    setBuildingsGroup(group);
    state.currentPuck.data.buildingsActive = true;
    enableBox.checked = true;
    const n = group.userData.buildingCount || 0;
    const elementCount = (overpass.elements || []).length;
    console.log(`[buildings] extruded ${n} (from ${elementCount} OSM elements)`);
    reloadBtn.textContent = n ? `↻ Reload buildings (${n})` : '↻ Reload (no buildings found)';
    // Silent-empty case: surface it so the user knows there genuinely are
    // no buildings in this region rather than wondering if it failed.
    if (n === 0) {
      alert(`No buildings found in this region. OSM returned ${elementCount} elements, 0 valid building outlines.`);
    }
  } catch (e) {
    console.error(e);
    alert('Buildings failed: ' + e.message);
    enableBox.checked = hasBuildings();
  } finally {
    setBusy(null);
    reloadBtn.disabled = false;
  }
}

$('exp-buildings-enable').addEventListener('change', async (e) => {
  if (!state.currentPuck) { e.target.checked = false; return; }
  if (e.target.checked) {
    await rebuildBuildings();
  } else {
    clearBuildings();
    state.currentPuck.data.buildingsActive = false;
    $('exp-buildings-reload').textContent = '↻ Reload buildings';
  }
});

// Texture-projection toggle: only meaningful when buildings are visible. We
// rebuild rather than swap the material so the cached overpass is the only
// source of truth and there's no two-material book-keeping.
$('exp-buildings-project').addEventListener('change', async () => {
  if (hasBuildings()) await rebuildBuildings();
});

// Off-white walls toggle: same rebuild path as the project toggle.
$('exp-buildings-walls-offwhite').addEventListener('change', async () => {
  if (hasBuildings()) await rebuildBuildings();
});

$('exp-buildings-reload').addEventListener('click', async () => {
  // Reload re-uses the cached Overpass response - purpose is to re-seat the
  // extrusions on the current terrain (after a Z-exag change), not to re-pull
  // data. Hold Shift while clicking to force-refetch.
  await rebuildBuildings({ forceRefetch: false });
});

// Photo sliders - instant GPU uniform updates, no re-processing.
function wireSlider(id, valId, fmt, apply) {
  const el = $(id), valEl = $(valId);
  el.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    valEl.textContent = fmt(v);
    if (!state.currentPuck) return;
    apply(v);
  });
}
wireSlider('img-brightness', 'img-brightness-val', v => v.toFixed(2),
           v => setImageAdjust('brightness', v));
wireSlider('img-contrast',   'img-contrast-val',   v => v.toFixed(2),
           v => setImageAdjust('contrast',   v));
wireSlider('img-saturation', 'img-saturation-val', v => v.toFixed(2),
           v => setImageAdjust('saturation', v));
wireSlider('img-sharpness',  'img-sharpness-val',  v => v.toFixed(2),
           v => setImageAdjust('sharpness',  v));
wireSlider('img-bump',       'img-bump-val',       v => v.toFixed(2),
           v => setSurfaceBumpStrength(v));
$('filter-style').addEventListener('change', async (e) => {
  if (!state.currentPuck) return;
  const sel = e.target;
  const value = sel.value;
  sel.disabled = true;
  if (value === 'painterly') setBusy('Computing painterly filter…');
  else if (value !== 'none') setBusy('Applying style…');
  try {
    await setStyle(value);
  } catch (err) {
    console.error(err);
  } finally {
    setBusy(null);
    sel.disabled = false;
  }
});

async function applyFilterPanelToPuck() {
  if (!state.currentPuck) return;
  setWaterShader($('filter-water-shader').checked);
  setOceanColourProbes($('filter-water-probes').checked);
  applyWaterShoreSettings();
  setImageAdjust('brightness', parseFloat($('img-brightness').value));
  setImageAdjust('contrast',   parseFloat($('img-contrast').value));
  setImageAdjust('saturation', parseFloat($('img-saturation').value));
  setImageAdjust('sharpness',  parseFloat($('img-sharpness').value));
  setSurfaceBumpStrength(parseFloat($('img-bump').value));
  const style = $('filter-style').value;
  if (style !== 'none') {
    setBusy(style === 'painterly' ? 'Computing painterly filter…' : 'Applying style…');
    try { await setStyle(style); }
    finally { setBusy(null); }
  } else {
    await setStyle('none');
  }
}

// Region status (live width + capture-button gating)
function formatDistance(m) {
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
}

function updateRegionStatus() {
  const w = getRegionWidthMeters(state.map, $('capture-square'));
  $('region-width').textContent = formatDistance(w);
  const square = $('capture-square');
  const captureBtn = $('capture-btn');
  if (w < MIN_REGION_M) {
    square.dataset.state = 'too-small';
    captureBtn.disabled = true;
    captureBtn.title = `Region too small - minimum ${MIN_REGION_M} m. Zoom out.`;
  } else if (w > MAX_REGION_M) {
    square.dataset.state = 'too-large';
    captureBtn.disabled = true;
    captureBtn.title = `Region too large - maximum ${MAX_REGION_M / 1000} km. Zoom in.`;
  } else {
    square.dataset.state = 'ok';
    captureBtn.disabled = false;
    captureBtn.title = '';
  }
}

state.map.on('move zoom resize', updateRegionStatus);
setTimeout(updateRegionStatus, 100);

// Post-capture Resolution control. The puck stores the zoom it was captured
// at; this dropdown offers that zoom and every sharper level up to the
// provider's max. Changing it re-stitches ONLY the albedo (no heightmap
// re-query) and swaps the texture on the live puck.
function populateResolutionDropdown() {
  const sel = $('resolution-select');
  const puck = state.currentPuck;
  sel.innerHTML = '';
  if (!puck) return;

  const captured = puck.data.captureZoom;
  const { lo, hi, sat } = usefulZoomRange(puck.data.bounds, puck.data.provider, captured);
  // The "ideal" finest level where tiles fill the output 1:1. Levels at or
  // below this are guaranteed to have content; we mark it so the user knows
  // where sharpness stops improving.
  const idealMax = Math.min(hi, Math.max(1, Math.ceil(sat)));

  for (let z = lo; z <= hi; z++) {
    const opt = document.createElement('option');
    opt.value = String(z);
    const delta = z - captured;
    let label;
    if (delta === 0)      label = `Current (z${z})`;
    else if (delta > 0)   label = `Sharper +${delta} (z${z})`;
    else                  label = `Coarser ${delta} (z${z})`;
    if (z === idealMax && z !== captured) label += ' · max detail';
    if (z > idealMax)     label += ' · ⚠ may be blank';
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = String(captured);
}

$('resolution-select').addEventListener('change', async (e) => {
  const puck = state.currentPuck;
  if (!puck) return;
  const newZoom = parseInt(e.target.value, 10);
  if (newZoom === puck.data.captureZoom) return;
  const sel = e.target;
  const prevZoom = puck.data.captureZoom;
  const prevAlbedo = puck.data.albedo;
  sel.disabled = true;
  setBusy('Re-fetching imagery…');
  try {
    // Old saved pucks predate captureGeo - synthesise it from bounds (rotation 0).
    const geo = puck.data.captureGeo || {
      centerLat: (puck.data.bounds.north + puck.data.bounds.south) / 2,
      centerLon: (puck.data.bounds.east + puck.data.bounds.west) / 2,
      edgeM: puck.data.regionWidthM,
      rotationDeg: 0,
    };
    const albedo = await refetchAlbedo(geo, puck.data.provider, newZoom, (m) => setBusy(m));

    // Safety net: if the requested zoom exceeds what the provider actually
    // stocks for this location, many tiles come back blank and the stitch is
    // mostly black. Detect that and roll back rather than wrecking the puck.
    const blackFrac = estimateBlackFraction(albedo);
    if (blackFrac > 0.5) {
      flashToast(`z${newZoom} has little/no imagery here (${Math.round(blackFrac * 100)}% blank) - kept z${prevZoom}.`);
      sel.value = String(prevZoom);
      return;
    }

    puck.data.albedo = albedo;
    puck.data.captureZoom = newZoom;
    setPuckAlbedo(albedo);
    await applyFilterPanelToPuck();   // re-apply style / bump from the new albedo
  } catch (err) {
    console.error(err);
    alert('Resolution change failed: ' + err.message);
    puck.data.albedo = prevAlbedo;
    sel.value = String(prevZoom);
  } finally {
    setBusy(null);
    sel.disabled = false;
  }
});

// Sample a coarse grid of the albedo canvas and report the fraction of pixels
// that are near-black - a proxy for "missing tiles". Cheap (samples ~400 px).
function estimateBlackFraction(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const N = 20;
    const w = canvas.width, h = canvas.height;
    const sx = Math.max(1, Math.floor(w / N));
    const sy = Math.max(1, Math.floor(h / N));
    let black = 0, total = 0;
    for (let y = 0; y < h; y += sy) {
      for (let x = 0; x < w; x += sx) {
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[0] < 12 && d[1] < 12 && d[2] < 12) black++;
        total++;
      }
    }
    return total ? black / total : 0;
  } catch {
    return 0;   // cross-origin or other read failure - don't block the change
  }
}

// Search
let searchTimer = null;
const searchInput = $('search-input');
const searchResults = $('search-results');

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { hideSearchResults(); return; }
  searchTimer = setTimeout(() => doSearch(q), 350);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSearchResults();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#map-search')) hideSearchResults();
});

async function doSearch(q) {
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) return hideSearchResults();
    const items = await res.json();
    showSearchResults(items);
  } catch {
    hideSearchResults();
  }
}

function showSearchResults(items) {
  searchResults.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    searchResults.innerHTML = '<div class="no-results">No matches</div>';
    searchResults.hidden = false;
    return;
  }
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'search-result';
    el.textContent = item.display_name;
    el.addEventListener('click', () => {
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      const zoom = pickZoomFromBoundingbox(item.boundingbox);
      state.map.flyTo([lat, lon], zoom, { duration: 1.0 });
      hideSearchResults();
      searchInput.value = item.display_name.split(',')[0];
    });
    searchResults.appendChild(el);
  }
  searchResults.hidden = false;
}

function hideSearchResults() {
  searchResults.hidden = true;
  searchResults.innerHTML = '';
}

function pickZoomFromBoundingbox(bb) {
  // bb: [south, north, west, east] as strings
  if (!bb || bb.length !== 4) return 14;
  const widthDeg = Math.abs(parseFloat(bb[3]) - parseFloat(bb[2]));
  const widthM = widthDeg * 111320; // rough, ignoring cos(lat)
  // Pick a zoom that lands inside the valid capture range
  const targetM = Math.min(MAX_REGION_M * 0.8, Math.max(MIN_REGION_M * 4, widthM));
  // square is ~480 px; meters/pixel at zoom Z ≈ 156543 / 2^Z (equatorial)
  // → Z = log2(156543 * 480 / targetM)
  const z = Math.log2(156543 * 480 / targetM);
  return Math.max(3, Math.min(18, Math.round(z)));
}

// Post-capture geometry sliders - each rebuilds the puck mesh in place.
$('puck-zexag').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('puck-zexag-val').textContent = v.toFixed(2) + '×';
  if (!state.currentPuck) return;
  const stats = setZExaggeration(v);
  if (stats) {
    state.currentPuck.stats = stats;
    state.currentPuck.zExaggeration = v;
    updatePuckInfo(state.currentPuck);
  }
});

$('new-puck-btn').addEventListener('click', () => switchView('map'));
// The "+ Create new" tile is rendered inside the grid by renderGallery (see
// below), so the click handler attaches to the dynamic card, not a static
// header button.

// Sidebar title doubles as a "back to gallery" affordance for non-gallery views.
$('library').querySelector('h1').style.cursor = 'pointer';
$('library').querySelector('h1').addEventListener('click', () => switchView('gallery'));
$('back-btn').addEventListener('click', () => switchView('map'));

$('capture-btn').addEventListener('click', async () => {
  // Copernicus DEM is served via OpenTopography and needs a free per-user
  // API key. Only prompt when Copernicus is the selected source - AWS
  // Terrain Tiles needs no key. Saves the user from a pointless dialog if
  // they've already chosen the keyless option.
  const demtype = $('dem-select').value;
  if (demtype === 'COP30' && !getOpentopoKey()) {
    openOpentopoKeyDialog('Paste your free OpenTopography API key here, or switch the Elevation dropdown to AWS Terrain.');
    return;
  }
  const btn = $('capture-btn');
  btn.disabled = true;
  try {
    const demtype = $('dem-select').value;
    // Reset post-capture sliders to defaults for every new puck.
    $('puck-zexag').value = 1.0;     $('puck-zexag-val').textContent = '1.00×';
    $('img-brightness').value = 0;   $('img-brightness-val').textContent = '0.00';
    $('img-contrast').value = 1;     $('img-contrast-val').textContent = '1.00';
    $('img-saturation').value = 1;   $('img-saturation-val').textContent = '1.00';
    $('img-sharpness').value = 0;    $('img-sharpness-val').textContent = '0.00';
    $('img-bump').value = 0;         $('img-bump-val').textContent = '0.00';
    $('water-shore-start').value = 0.30; $('water-shore-start-val').textContent = '0.30';
    $('water-feather').value = 0.55;     $('water-feather-val').textContent = '0.55';
    $('exp-buildings-enable').checked = false;
    $('exp-buildings-project').checked = true;
    $('exp-buildings-walls-offwhite').checked = true;
    $('exp-buildings-reload').textContent = '↻ Reload buildings';
    $('export-filename').value = '';   // re-prefills from the new puck on menu open
    const zExag = 1.0;
    setBusy('Stitching satellite tiles…');
    // Resolution is now a post-capture control - capture always uses the
    // default +3× zoom; the user refines it afterward without re-querying DEM.
    const result = await capture(state.map, $('capture-square'), demtype, (m) => setBusy(m), undefined, _captureRotation);
    result.center = {
      lat: (result.bounds.north + result.bounds.south) / 2,
      lon: (result.bounds.east + result.bounds.west) / 2,
    };

    // Ocean only - DEM-derived (heightmap zero-elevation), no Overpass call,
    // so no network hang. Pass overpass=null to skip the inland-water query.
    // The mask is built from the (rotated, if rotated) heightmap, so it stays
    // aligned with the albedo. Free; runs in a couple of ms.
    const waterMask = buildWaterMask(null, result.heightmap, result.bounds, result.demtype);
    if (waterMask) result.waterMask = waterMask;

    setBusy('Building 3D puck…');
    const puck = await createPuck(result, {
      zExaggeration: zExag,
      container: $('three-container'),
    });
    state.currentPuck = puck;
    state.currentName = null;
    updatePuckInfo(puck);
    populateResolutionDropdown();
    switchView('puck');
    await applyFilterPanelToPuck();
    enterShowroom();
    applyFillLightFromPref();

    // Reverse-geocode in the background; refresh HUD when it lands.
    reverseGeocode(result.center.lat, result.center.lon).then(geo => {
      if (geo && state.currentPuck === puck) {
        result.geo = geo;
        updatePuckInfo(puck);
      }
    });
  } catch (e) {
    console.error(e);
    if (e instanceof NeedsOpentopoKeyError) {
      openOpentopoKeyDialog(e.message);
    } else {
      alert('Capture failed: ' + e.message);
    }
  } finally {
    setBusy(null);
    btn.disabled = false;
  }
});

// Export viewfinder - visible in showroom view, shows the 4:3 region that
// Share → Image / Record will capture so the user can frame the puck.
const EXPORT_ASPECT = 4 / 3;
function updateViewfinderSize() {
  const frame = document.querySelector('#export-viewfinder .export-frame');
  if (!frame) return;
  const container = $('three-container');
  if (!container) return;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  let w, h;
  if (cw / ch > EXPORT_ASPECT) {
    h = ch * 0.88;
    w = h * EXPORT_ASPECT;
  } else {
    w = cw * 0.88;
    h = w / EXPORT_ASPECT;
  }
  frame.style.width = w + 'px';
  frame.style.height = h + 'px';
}
window.addEventListener('resize', updateViewfinderSize);

function renderPresentCaption() {
  const puck = state.currentPuck;
  if (!puck) return;
  const d = puck.data;
  const name = state.currentName || 'Untitled puck';
  const loc = placeLabel(d.geo);
  const center = d.center;
  const coords = center ? formatLatLon(center.lat, center.lon) : '';
  const widthM = d.regionWidthM;
  const rows = [];
  if (loc) rows.push(['Location', loc]);
  if (coords) rows.push(['Coordinates', coords]);
  if (widthM) rows.push(['Region', widthM < 1000 ? `${Math.round(widthM)} m` : `${(widthM/1000).toFixed(widthM<10000?2:1)} km`]);
  if (d.demtype) rows.push(['Source', d.demtype]);

  const el = $('present-caption');
  el.innerHTML = `
    <div class="pc-name">${escapeHtml(name)}</div>
    <div class="pc-rule"></div>
    <div class="pc-meta">
      ${rows.map(([k, v]) => `<div class="pc-label">${k}</div><div class="pc-value">${escapeHtml(String(v))}</div>`).join('')}
    </div>
  `;
  el.hidden = false;
}

$('save-btn').addEventListener('click', async () => {
  if (!state.currentPuck) return;
  // Capture the live filter state + geometry sliders so reloading restores them.
  state.currentPuck.data.filters = getFilterState();
  state.currentPuck.zExaggeration = parseFloat($('puck-zexag').value);
  const entry = await saveToLibrary(state.currentPuck, undefined, suggestedDisplayName());
  if (entry) {
    state.currentName = entry.name;
    renderLibrary();
    renderGallery();
  }
});

// Human-readable name suggestion for the Save prompt - distinct from
// slugName() (which produces a filename-safe slug for exports). Same input
// signal: prefer the user's saved name, then the reverse-geocoded locality,
// then coordinates. Returns null if there's nothing useful to suggest so
// library.js can fall back to its 'Puck <date>' default.
function suggestedDisplayName() {
  if (state.currentName) return state.currentName;
  const a = state.currentPuck?.data?.geo?.address;
  if (a) {
    const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
    const region = a.state || a.region;
    if (locality && region) return `${locality}, ${region}`;
    if (locality) return locality;
  }
  const c = state.currentPuck?.data?.center;
  if (c?.lat != null && c?.lon != null) {
    return `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`;
  }
  return null;
}


// Suggested filename base for exports. Priority:
//   1. User's saved puck name (if loaded from library)
//   2. Reverse-geocoded locality (city/town/village/hamlet/county)
//   3. Lat-lon coordinates (always available, even before geocode lands)
//   4. Generic fallback
function slugName() {
  const slugify = (s) => s.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  if (state.currentName) return slugify(state.currentName);

  const data = state.currentPuck?.data;
  const a = data?.geo?.address;
  if (a) {
    const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
    const region = a.state || a.region;
    if (locality && region) return slugify(`${locality}_${region}`);
    if (locality) return slugify(locality);
  }

  const c = data?.center;
  if (c?.lat != null && c?.lon != null) {
    const fmt = (v) => v.toFixed(3).replace('.', 'p').replace('-', 'n');
    return `minimap_${fmt(c.lat)}_${fmt(c.lon)}`;
  }
  return 'minimap-puck';
}

// Base filename for exports. Reads the user-editable field in the Export menu,
// sanitises it to filesystem-safe characters, and falls back to the puck's
// slug name if the field is empty.
function exportBaseName() {
  const raw = ($('export-filename')?.value || '').trim();
  const cleaned = raw.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
  return cleaned || slugName();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadDataURL(dataURL, filename) {
  const a = document.createElement('a');
  a.href = dataURL;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Builds a draw-callback that paints the present-mode caption onto an
// arbitrary canvas2d context at any size. Mirrors the HTML layout in
// #present-caption / .pc-* - name (light sans), 32 px rule, then label/value
// rows in small-caps + monospace.
function buildCaptionOverlay() {
  const puck = state.currentPuck;
  if (!puck) return null;
  const d = puck.data;
  const name = state.currentName || 'Untitled puck';
  const loc = placeLabel(d.geo);
  const center = d.center;
  const coords = center ? formatLatLon(center.lat, center.lon) : '';
  const widthM = d.regionWidthM;
  const rows = [];
  if (loc) rows.push(['Location', loc]);
  if (coords) rows.push(['Coordinates', coords]);
  if (widthM) rows.push(['Region', widthM < 1000 ? `${Math.round(widthM)} m` : `${(widthM/1000).toFixed(widthM<10000?2:1)} km`]);
  if (d.demtype) rows.push(['Source', d.demtype]);

  return (ctx, size) => drawCaptionOnCanvas(ctx, size, name, rows);
}

function drawCaptionOnCanvas(ctx, size, name, rows) {
  // Layout is sized to a 1080 design canvas, scaled linearly.
  const s = size / 1080;
  const px = (n) => n * s;

  const padding = px(56);
  const x0 = padding;

  const nameSize       = px(28);
  const nameLineH      = px(28 * 1.15);
  const ruleTopGap     = px(18);
  const ruleHeight     = Math.max(1, Math.round(px(1.2)));
  const ruleBottomGap  = px(16);
  const labelSize      = px(9.5);
  const valueSize      = px(11);
  const rowHeight      = px(20);
  const valueColOffset = px(104);  // 84px label col + 18px gap, plus a hair

  const totalH = nameLineH + ruleTopGap + ruleHeight + ruleBottomGap + rows.length * rowHeight;
  let y = size - padding - totalH;

  ctx.save();
  ctx.textBaseline = 'top';

  // Name
  ctx.fillStyle = '#18191b';
  ctx.font = `300 ${nameSize}px "Inter", "Söhne", "Segoe UI", system-ui, -apple-system, sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px(-0.14)}px`;
  ctx.fillText(name, x0, y);
  y += nameLineH;

  // Rule
  y += ruleTopGap;
  ctx.fillStyle = '#6a6c70';
  ctx.fillRect(x0, y, px(32), ruleHeight);
  y += ruleHeight + ruleBottomGap;

  // Meta rows - label small-caps, value monospace, baseline-aligned per row
  ctx.textBaseline = 'middle';
  for (const [label, value] of rows) {
    const yMid = y + rowHeight / 2;

    ctx.fillStyle = '#7a7c80';
    ctx.font = `500 ${labelSize}px "Inter", "Söhne", "Segoe UI", system-ui, sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${px(2.09)}px`;
    ctx.fillText(label.toUpperCase(), x0, yMid);

    ctx.fillStyle = '#2a2c30';
    ctx.font = `${valueSize}px ui-monospace, "Consolas", "JetBrains Mono", monospace`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = 'normal';
    ctx.fillText(value, x0 + valueColOffset, yMid);

    y += rowHeight;
  }
  ctx.restore();
}

function buildShareCaption() {
  const puck = state.currentPuck;
  if (!puck) return '';
  const d = puck.data;
  const lines = [];
  const loc = placeLabel(d.geo);
  if (loc) lines.push(loc);
  if (d.center) lines.push(formatLatLon(d.center.lat, d.center.lon));
  return lines.join('\n');
}

$('share-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('share-menu');
  m.hidden = !m.hidden;
  if (!m.hidden) {
    $('share-caption').textContent = buildShareCaption();
    const copyBtn = $('share-copy-btn');
    copyBtn.textContent = 'Copy to clipboard';
    copyBtn.disabled = false;
    // Pre-fill the filename field with the puck's current name each time the
    // menu opens - but don't clobber an edit the user already made this session.
    const fn = $('export-filename');
    if (fn && !fn.value.trim()) fn.value = slugName();
  }
});

$('share-copy-btn').addEventListener('click', async () => {
  const text = $('share-caption').textContent;
  if (!text) return;
  const btn = $('share-copy-btn');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 1600);
  } catch (e) {
    // Fallback for older / non-secure contexts.
    const range = document.createRange();
    range.selectNode($('share-caption'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 1600);
  }
});
document.addEventListener('click', (e) => {
  if ($('share-menu').hidden) return;
  if (!e.target.closest('#share-menu') && !e.target.closest('#share-btn')) {
    $('share-menu').hidden = true;
  }
});

$('share-menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-share]');
  if (!btn) return;
  $('share-menu').hidden = true;
  if (!state.currentPuck) return;

  const action = btn.dataset.share;
  if (action === 'image') {
    const dataURL = captureSnapshotPNG({ width: 1920, height: 1440 });
    if (!dataURL) { alert('Snapshot failed'); return; }
    downloadDataURL(dataURL, exportBaseName() + '.png');
  } else if (action === 'video') {
    // The puck view is already in showroom styling - just record from the
    // user's current orbit/zoom. autoRotate is flipped on inside the recorder.
    try {
      setBusy(`Recording 0 / ${WEBM_ROTATION_SECONDS} s…`);
      const blob = await recordRotation({
        durationSec: WEBM_ROTATION_SECONDS,
        width: 1440,
        height: 1080,
        onTick: (t, total) => setBusy(`Recording ${t.toFixed(1)} / ${total} s…`),
      });
      // The encoder picks MP4 if the browser supports H.264 MediaRecorder,
      // otherwise falls back to WebM. Use the blob's actual mime type so the
      // saved file has the matching extension.
      const ext = getRecordingFileExtension(blob.type);
      if (ext === 'webm') {
        flashToast('Your browser does not support MP4 recording - saved as WebM. Twitter / X may reject it.', 6000);
      }
      setBusy(`Encoding ${ext.toUpperCase()}…`);
      downloadBlob(blob, exportBaseName() + '.' + ext);
    } catch (err) {
      console.error(err);
      alert('Recording failed: ' + err.message);
    } finally {
      setBusy(null);
    }
  } else if (action === 'stl' || action === 'obj' || action === 'glb') {
    const exportTarget = state.currentPuck;
    if (!exportTarget?.mesh) { alert('Nothing to export.'); return; }
    if (action === 'stl') {
      exportSTL(exportTarget, exportBaseName());
    } else if (action === 'obj') {
      exportOBJ(exportTarget, exportBaseName());
    } else if (action === 'glb') {
      setBusy('Encoding GLB…');
      try { await exportGLB(exportTarget, exportBaseName()); }
      catch (err) { console.error(err); alert('GLB export failed: ' + err.message); }
      finally { setBusy(null); }
    }
  }
});

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function placeLabel(geo) {
  if (!geo || !geo.address) return null;
  const a = geo.address;
  const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
  const region = a.state || a.region;
  const country = a.country;
  return [locality, region, country].filter(Boolean).join(', ');
}

function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${ns}, ${Math.abs(lon).toFixed(5)}°${ew}`;
}

function googleMapsUrl(lat, lon, zoom) {
  const z = Math.max(3, Math.min(20, Math.round(zoom || 16)));
  return `https://www.google.com/maps/@${lat},${lon},${z}z/data=!3m1!1e3`;
}

function updatePuckInfo(puck) {
  const s = puck.stats;
  const d = puck.data;
  const center = d.center;
  const label = placeLabel(d.geo);
  const coords = center ? formatLatLon(center.lat, center.lon) : null;
  const gmaps = center ? googleMapsUrl(center.lat, center.lon, d.captureZoom) : null;

  const locationBlock = (label || coords)
    ? `<div class="info-loc">
         ${label ? `<div><strong>${escapeHtml(label)}</strong></div>` : ''}
         ${coords ? `<div class="coords">${coords}</div>` : ''}
         ${gmaps ? `<div><a href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps ↗</a></div>` : ''}
       </div>`
    : '';

  $('puck-info').innerHTML = `
    ${locationBlock}
    <div><strong>Region:</strong> ${s.widthM.toFixed(0)} m wide</div>
    <div><strong>Elevation:</strong> ${s.minElevation.toFixed(0)} – ${s.maxElevation.toFixed(0)} m${d.heightmap?.inferred ? ' <span style="color:#ffb347">(inferred)</span>' : ''}</div>
    <div><strong>Puck height:</strong> ${s.verticalCm.toFixed(2)} cm (true: ${s.trueVerticalCm.toFixed(2)} cm)</div>
    <div><strong>Z-exaggeration:</strong> ${puck.zExaggeration.toFixed(1)}×</div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Shared "load a saved puck into the viewer" path. Used by both the sidebar
// library list and the gallery grid so the two stay in lock-step.
async function loadPuckFromItem(item) {
  setBusy('Loading puck…');
  try {
    const savedZExag = item.zExaggeration || 1.0;
    const puck = await createPuck(item.data, {
      zExaggeration: savedZExag,
      container: $('three-container'),
    });
    state.currentPuck = puck;
    state.currentName = item.name;
    $('export-filename').value = '';   // re-prefills from this puck on menu open
    updatePuckInfo(puck);
    populateResolutionDropdown();
    switchView('puck');

    // Restore filter state from saved data, sync the panel UI.
    const f = item.data.filters || {};
    const img = f.image || {};
    $('filter-water-shader').checked = f.waterShader !== false;
    $('filter-water-probes').checked = f.waterProbes === true;
    $('filter-style').value          = f.style || 'none';
    $('puck-zexag').value            = savedZExag;
    $('puck-zexag-val').textContent  = savedZExag.toFixed(2) + '×';
    const setSlider = (id, valId, raw, fmt) => {
      const v = (raw ?? 0);
      $(id).value = v;
      $(valId).textContent = fmt(v);
    };
    setSlider('img-brightness', 'img-brightness-val', img.brightness ?? 0,   v => v.toFixed(2));
    setSlider('img-contrast',   'img-contrast-val',   img.contrast   ?? 1,   v => v.toFixed(2));
    setSlider('img-saturation', 'img-saturation-val', img.saturation ?? 1,   v => v.toFixed(2));
    setSlider('img-sharpness',  'img-sharpness-val',  img.sharpness  ?? 0,   v => v.toFixed(2));
    setSlider('img-bump',       'img-bump-val',       typeof f.surfaceBump === 'number' ? f.surfaceBump : 0, v => v.toFixed(2));
    const water = f.water || {};
    setSlider('water-shore-start', 'water-shore-start-val', water.shoreStart ?? 0.30, v => v.toFixed(2));
    setSlider('water-feather',     'water-feather-val',     water.feather    ?? 0.55, v => v.toFixed(2));
    await applyFilterPanelToPuck();
    enterShowroom();
    applyFillLightFromPref();
  } catch (e) {
    console.error(e);
    alert('Could not load puck: ' + e.message);
  } finally {
    setBusy(null);
  }
}

async function confirmAndDelete(item) {
  if (!confirm(`Delete "${item.name}"?`)) return;
  await deleteFromLibrary(item.id);
  renderLibrary();
  renderGallery();
}

async function renderLibrary() {
  const list = $('library-list');
  list.innerHTML = '<div class="lib-empty">Loading…</div>';
  const lib = await loadLibrary();
  list.innerHTML = '';
  if (lib.length === 0) {
    list.innerHTML = '<div class="lib-empty">No pucks yet. Create one →</div>';
    return;
  }
  for (const item of lib) {
    const el = document.createElement('div');
    el.className = 'lib-item';
    const dt = new Date(item.createdAt);
    const loc = placeLabel(item.data.geo);
    el.innerHTML = `
      <button class="del-btn" title="Delete puck" aria-label="Delete">×</button>
      <img src="${item.thumbnail}" alt="">
      <div class="name">${escapeHtml(item.name)}</div>
      ${loc ? `<div class="meta">${escapeHtml(loc)}</div>` : ''}
      <div class="meta">${dt.toLocaleDateString()} · ${item.data.demtype}</div>
    `;
    el.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAndDelete(item);
    });
    el.addEventListener('click', () => loadPuckFromItem(item));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      confirmAndDelete(item);
    });
    list.appendChild(el);
  }
}

// Gallery grid - large cards over the dark library sidebar. The first tile
// is always a "+ Create new puck" card styled distinctly so the primary
// action lives in the grid's top-left where the eye lands first. Reuses
// loadLibrary so it stays in lock-step with the sidebar.
async function renderGallery() {
  const grid = $('gallery-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Always-on create-new tile, prepended.
  const createCard = document.createElement('div');
  createCard.className = 'gallery-create-card';
  createCard.innerHTML = `
    <div class="cc-icon">+</div>
    <div class="cc-label">Create new puck</div>
    <div class="cc-sub">Pick a region on the map</div>
  `;
  createCard.addEventListener('click', () => switchView('map'));
  grid.appendChild(createCard);

  const lib = await loadLibrary();

  // Top-right meta count: small subtle counter. Shown only when there are
  // pucks; left blank for an empty library so the home screen stays clean.
  const meta = $('gallery-meta');
  if (meta) {
    meta.textContent = lib.length
      ? `${lib.length} puck${lib.length === 1 ? '' : 's'}`
      : '';
  }

  if (lib.length === 0) return;
  for (const item of lib) {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    const dt = new Date(item.createdAt);
    const loc = placeLabel(item.data.geo);
    card.innerHTML = `
      <button class="del-btn" title="Delete puck" aria-label="Delete">×</button>
      <img src="${item.thumbnail}" alt="">
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="meta">${escapeHtml(loc || '-')}</div>
      <div class="meta">${dt.toLocaleDateString()} · ${item.data.demtype}</div>
    `;
    card.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAndDelete(item);
    });
    card.addEventListener('click', () => loadPuckFromItem(item));
    grid.appendChild(card);
  }
}

renderLibrary();

// Sync the fill-light checkbox to the saved preference at boot (so the user
// sees its previous state even before they capture a puck).
$('filter-fill-light').checked = localStorage.getItem(FILL_LIGHT_KEY) === 'on';

// About modal - credits + attributions. Lives on the gallery view as a
// discreet bottom-right button. Public users land on the gallery first so
// they always have one click to see what data sources we depend on.
$('about-btn').addEventListener('click', () => { $('about-modal').hidden = false; });
$('about-close').addEventListener('click', () => { $('about-modal').hidden = true; });
$('about-modal').addEventListener('click', (e) => {
  // Click-outside-the-card dismiss.
  if (e.target.id === 'about-modal') $('about-modal').hidden = true;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('about-modal').hidden) $('about-modal').hidden = true;
});

// Land on the gallery as the startup screen. switchView also tags the body
// with `view-gallery` so the sidebar hides itself (gallery IS the library at
// full size) and triggers the first renderGallery().
switchView('gallery');
refreshFirstRunBanner();   // show the OpenTopo notice if no key + not dismissed
