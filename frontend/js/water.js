// Build a water-info texture combining OSM natural=water polygons (Overpass)
// with heightmap-zero ocean detection. The returned canvas encodes:
//   R = water mask (255 = water, 0 = land)
//   G = normalized distance from shore (0 at shore → 255 deep interior)
//   B = water type           (0 = lake / river,  255 = ocean)
// The shader uses R for masking, G for the shore→deep gradient, B to decide
// how heavily to blend the shader effect over the underlying albedo.

const MASK_SIZE = 1024;
const SHORE_BAND_METERS = 6000;     // real-world width of the shore→deep band
const OCEAN_DEMS = new Set(['SRTMGL1', 'SRTMGL3', 'NASADEM', 'aws-terrain', 'COP30']);

export async function fetchWater(bounds) {
  const qs = new URLSearchParams({
    south: bounds.south, north: bounds.north,
    west: bounds.west,  east: bounds.east,
  });
  try {
    const res = await fetch('/api/water?' + qs.toString());
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function buildWaterMask(overpass, heightmap, bounds, demtype) {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_SIZE;
  canvas.height = MASK_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);

  let painted = false;

  // Step 1: Inland water (OSM polygons) - vector-drawn directly to the mask
  // since these come from real coastline vectors (no resolution problem). R=255.
  if (overpass?.elements) {
    ctx.fillStyle = 'rgb(255, 0, 0)';
    for (const el of overpass.elements) {
      if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
      // Overpass sometimes returns null vertices at bbox edges (ways clipped
      // to the query box). Drop them - the rest of the outline is fine to
      // draw as long as we have ≥3 valid points.
      const pts = el.geometry.filter(p => p && p.lon != null && p.lat != null);
      if (pts.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const x = (p.lon - bounds.west) / (bounds.east - bounds.west) * MASK_SIZE;
        const y = (bounds.north - p.lat) / (bounds.north - bounds.south) * MASK_SIZE;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      painted = true;
    }
  }

  // Step 2: Ocean from heightmap zero-elevation. Build at heightmap resolution
  // (~256×256), then BILINEAR-UPSCALE onto the 1024 mask. This is the key
  // anti-aliasing step - the canvas does smooth interpolation between cells so
  // the coastline becomes a soft ~half-cell gradient instead of a step.
  // Drawn LAST so heightmap-detected ocean correctly wins over OSM water in
  // coastal bays (those should be flagged as ocean, B=255).
  if (heightmap?.values && OCEAN_DEMS.has(demtype)) {
    const { ncols, nrows, values } = heightmap;
    const small = document.createElement('canvas');
    small.width = ncols;
    small.height = nrows;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(ncols, nrows);
    let any = false;
    for (let i = 0; i < ncols * nrows; i++) {
      const v = values[i];
      if (v !== null && v <= 0.5) {
        img.data[i * 4 + 0] = 255; // R = water
        img.data[i * 4 + 2] = 255; // B = ocean flag
        img.data[i * 4 + 3] = 255;
        any = true;
      }
    }
    if (any) {
      sctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(small, 0, 0, MASK_SIZE, MASK_SIZE);
      painted = true;
    }
  }

  if (!painted) return null;

  // Scale the shore-distance band so it spans ~SHORE_BAND_METERS in real space.
  const midLat = (bounds.north + bounds.south) / 2;
  const regionWidthM = (bounds.east - bounds.west) * 111320 * Math.cos(midLat * Math.PI / 180);
  const shoreDistPx = Math.max(8, Math.min(400, Math.round((SHORE_BAND_METERS / regionWidthM) * MASK_SIZE)));

  // Distance-to-shore → G channel.
  const img = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
  const dist = chamferDistance(img.data, MASK_SIZE);
  for (let i = 0, p = 0; i < dist.length; i++, p += 4) {
    const d = dist[i];
    img.data[p + 1] = d >= shoreDistPx
      ? 255
      : Math.max(0, Math.floor((d / shoreDistPx) * 255));
  }
  ctx.putImageData(img, 0, 0);

  return canvas;
}

// Alpha-only mask used to composite ESRI Ocean Base over the land albedo -
// alpha is set wherever heightmap-zero ocean was detected. Returns null if
// either no ocean was found or the DEM doesn't reliably mark sea level.
export function buildOceanAlphaMask(heightmap, demtype, size) {
  if (!OCEAN_DEMS.has(demtype)) return null;
  if (!heightmap?.values) return null;

  const { ncols, nrows, values } = heightmap;

  const small = document.createElement('canvas');
  small.width = ncols;
  small.height = nrows;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(ncols, nrows);
  let any = false;
  for (let i = 0; i < ncols * nrows; i++) {
    const v = values[i];
    if (v !== null && v <= 0.5) {
      img.data[i * 4 + 3] = 255;
      any = true;
    }
  }
  if (!any) return null;
  sctx.putImageData(img, 0, 0);

  // Bilinear upscale to target size - gives soft, anti-aliased coast lines.
  const big = document.createElement('canvas');
  big.width = size;
  big.height = size;
  const bctx = big.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, size, size);

  return big;
}

// 2-pass 8-connected chamfer distance transform. Returns a Float32 array of
// distances in pixels, where land == 0 and each water cell holds the distance
// to its nearest land cell. Good approximation of Euclidean distance, ~O(N).
function chamferDistance(rgba, size) {
  const SQRT2 = Math.SQRT2;
  const n = size * size;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = rgba[i * 4] > 128 ? Infinity : 0;
  }
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const idx = row + x;
      let v = d[idx];
      if (v === 0) continue;
      if (x > 0)                  v = Math.min(v, d[idx - 1] + 1);
      if (y > 0)                  v = Math.min(v, d[idx - size] + 1);
      if (x > 0 && y > 0)         v = Math.min(v, d[idx - size - 1] + SQRT2);
      if (x < size - 1 && y > 0)  v = Math.min(v, d[idx - size + 1] + SQRT2);
      d[idx] = v;
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    const row = y * size;
    for (let x = size - 1; x >= 0; x--) {
      const idx = row + x;
      let v = d[idx];
      if (v === 0) continue;
      if (x < size - 1)                   v = Math.min(v, d[idx + 1] + 1);
      if (y < size - 1)                   v = Math.min(v, d[idx + size] + 1);
      if (x < size - 1 && y < size - 1)   v = Math.min(v, d[idx + size + 1] + SQRT2);
      if (x > 0 && y < size - 1)          v = Math.min(v, d[idx + size - 1] + SQRT2);
      d[idx] = v;
    }
  }
  return d;
}
