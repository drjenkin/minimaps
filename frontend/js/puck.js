import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBumpFromAlbedo, computeTextureIntensity, applyKuwahara, applySketch, applyTritone, applyContours, applyWatercolor } from './filters.js';

// Physical sizing (units = cm, so 1 unit = 1 cm).
const PUCK_SIZE = 10;            // 10 cm square footprint
// MIN_THICKNESS is the printability floor: the puck is never thinner than this
// at any (x, z) point - guarantees no paper-thin spots under terrain valleys.
// The cross-section silhouette comes from the side walls following the terrain
// above this floor (lowest elevation point sits at y=MIN_THICKNESS).
const MIN_THICKNESS = 0.5;       // 5 mm

let renderer, scene, camera, controls, animationId;
let perspCamera = null, orthoCamera = null;
let cameraMode = 'perspective';
const ORTHO_REF_HALF_H = 10;     // fixed ortho frustum half-height; zoom scales it
let currentMesh = null;
let fillLight = null;

// Camera tween + present-mode state
let activeTween = null;
const presentation = {
  active: false,
  saved: null,
  shadowDisc: null,
  bg: null,
};

function ensureViewer(container) {
  if (renderer) return;

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171a);

  // IBL via a small procedural room - gives PBR materials a believable ambient
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  perspCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  perspCamera.position.set(14, 14, 14);
  orthoCamera = new THREE.OrthographicCamera(
    -ORTHO_REF_HALF_H, ORTHO_REF_HALF_H, ORTHO_REF_HALF_H, -ORTHO_REF_HALF_H, 0.1, 1000);
  orthoCamera.position.set(14, 14, 14);
  camera = perspCamera;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, MIN_THICKNESS * 0.6, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Pan is permanently disabled - for a single-object viewer it only causes
  // problems (any pan moves the orbit target off-axis and autoRotate then
  // sweeps the puck through a circle instead of spinning in place). User
  // still gets rotate + zoom; pan is the one they don't need.
  controls.enablePan = false;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

  // Env handles most of the ambient; direct lights add direction + warmth.
  // Slightly higher ambient because materials are fully matte (roughness 1.0)
  // and the env reflection contribution is dialled down.
  scene.add(new THREE.AmbientLight(0xffffff, 0.20));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.20);
  sun.position.set(10, 16, 8);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.38);
  rim.position.set(-8, 6, -10);
  scene.add(rim);

  // Optional cool fill from opposite the sun. Off by default - toggled from
  // the filters panel. Acts as a studio "key + fill" pair, brightening the
  // shadow side without flattening the lit side.
  fillLight = new THREE.DirectionalLight(0xc0d4ff, 0.5);
  fillLight.position.set(-10, 14, -8);
  fillLight.visible = false;
  scene.add(fillLight);

  window.addEventListener('resize', () => resize(container));
  // ResizeObserver picks up layout-driven size changes too - e.g. the
  // filters sidebar opening/closing shrinks/grows the three-container.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resize(container));
    ro.observe(container);
  }
  animate();
}

function resize(container) {
  if (!renderer) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  applyCameraAspect(w / h);
}

// Set the active camera's aspect ratio - perspective uses .aspect, while
// orthographic needs its left/right frustum bounds adjusted.
function applyCameraAspect(aspect) {
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
  } else {
    const halfH = (camera.top - camera.bottom) / 2;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
  }
  camera.updateProjectionMatrix();
}

// Toggle the optional cool fill light from opposite the sun. Off by default.
export function setFillLight(enabled) {
  if (fillLight) fillLight.visible = !!enabled;
}

// Toggle between perspective and orthographic projection. The two cameras
// share OrbitControls (just reassign .object) and we match framing on switch
// so the view doesn't jump.
export function setCameraMode(mode) {
  if (!controls || mode === cameraMode) return;
  const containerAspect =
    renderer.domElement.clientWidth / renderer.domElement.clientHeight || 1;

  if (mode === 'orthographic') {
    // Match the perspective framing: at the current distance the visible
    // half-height is dist·tan(fov/2); pick an ortho zoom that reproduces it.
    const dist = camera.position.distanceTo(controls.target);
    const visibleHalfH = dist * Math.tan(perspCamera.fov * Math.PI / 360);
    orthoCamera.top = ORTHO_REF_HALF_H;
    orthoCamera.bottom = -ORTHO_REF_HALF_H;
    orthoCamera.left = -ORTHO_REF_HALF_H * containerAspect;
    orthoCamera.right = ORTHO_REF_HALF_H * containerAspect;
    orthoCamera.zoom = ORTHO_REF_HALF_H / Math.max(0.001, visibleHalfH);
    orthoCamera.position.copy(camera.position);
    orthoCamera.quaternion.copy(camera.quaternion);
    orthoCamera.updateProjectionMatrix();
    camera = orthoCamera;
  } else {
    perspCamera.position.copy(camera.position);
    perspCamera.quaternion.copy(camera.quaternion);
    perspCamera.zoom = 1;
    perspCamera.aspect = containerAspect;
    perspCamera.updateProjectionMatrix();
    camera = perspCamera;
  }
  controls.object = camera;
  controls.update();
  cameraMode = mode;
}

export function getCameraMode() {
  return cameraMode;
}

let _lastFrameMs = 0;
let _exportOverlay = null;   // when set, animate() renders this overlay scene on top of the main scene
let _exportTrack = null;     // when set, animate() pushes a frame to this MediaStreamTrack each render
// Per-frame callbacks for overlays that need to run every frame (e.g. the
// Google 3D Tiles renderer's .update()). Registered via registerFrameCallback.
const _frameCallbacks = new Set();
export function registerFrameCallback(fn) { _frameCallbacks.add(fn); }
export function unregisterFrameCallback(fn) { _frameCallbacks.delete(fn); }

// Expose the live viewer internals so sibling modules can attach their own
// content to the same scene / camera / renderer / controls.
export function getViewer() {
  return { scene, camera, renderer, controls };
}

// Show/hide the puck mesh - used when an alternative view (Google 3D
// tileset) temporarily takes over the scene.
export function setPuckVisible(visible) {
  if (currentMesh) currentMesh.visible = visible;
}

// Show/hide ONLY the puck's terrain top surface (material group 0), keeping
// the cream sides + base (material group 1) visible. Used by the Google 3D
// view so we reuse the existing puck silhouette as the cup the tiles render
// into - no separate shell geometry needed.
export function setPuckTopVisible(visible) {
  if (!currentMesh) return;
  const mats = Array.isArray(currentMesh.material) ? currentMesh.material : [currentMesh.material];
  if (mats[0]) mats[0].visible = visible;
}

function animate(nowMs) {
  animationId = requestAnimationFrame(animate);
  const now = nowMs ?? performance.now();
  const dt = _lastFrameMs > 0 ? Math.min(0.1, (now - _lastFrameMs) / 1000) : 0;
  _lastFrameMs = now;
  controls?.update(dt);

  // Drive any registered per-frame overlays before rendering.
  for (const cb of _frameCallbacks) {
    try { cb(dt, now); } catch (e) { console.error('frame callback failed', e); }
  }

  if (currentMesh) {
    const t = now * 0.001;
    const mats = Array.isArray(currentMesh.material) ? currentMesh.material : [currentMesh.material];
    for (const m of mats) {
      if (m.userData?.uTime) m.userData.uTime.value = t;
    }
  }
  renderer.render(scene, camera);

  if (_exportOverlay) {
    renderer.autoClear = false;
    renderer.render(_exportOverlay.scene, _exportOverlay.camera);
    renderer.autoClear = true;
  }

  // Push exactly one frame to the recording stream per rendered frame. This
  // pairs with captureStream(0) (manual-frame mode) so the WebM has perfect
  // 1:1 timing with the render loop - no browser-side sampling jitter.
  if (_exportTrack) _exportTrack.requestFrame();
}

export async function createPuck(data, opts) {
  const { container } = opts;
  const zExag = opts.zExaggeration ?? 2.5;

  ensureViewer(container);
  resize(container);

  if (currentMesh) {
    scene.remove(currentMesh);
    disposeMesh(currentMesh);
    currentMesh = null;
  }

  const albedoCanvas = await ensureCanvas(data.albedo);
  const waterCanvas = data.waterMask ? await ensureCanvas(data.waterMask) : null;
  const built = buildPuckMesh(data.heightmap, albedoCanvas, zExag, data.bounds, waterCanvas);

  // Stash geo-scale params alongside everything else so building extrusions
  // (and any other future overlays) can sample the heightmap and convert
  // metres → puck cm without re-deriving these quantities.
  built.mesh.userData.geoParams = {
    bounds: data.bounds,
    heightmap: data.heightmap,
    size: PUCK_SIZE,
    baseThickness: MIN_THICKNESS,
    terrainHeightCm: built.stats.verticalCm - MIN_THICKNESS,
    minH: built.stats.minElevation,
    heightRange: Math.max(built.stats.maxElevation - built.stats.minElevation, 1),
    widthM: built.stats.widthM,
    zExag,
  };

  // Stash everything we need for post-capture filter toggling on the mesh.
  built.mesh.userData.albedoCanvas = albedoCanvas;
  built.mesh.userData.topMaterial = Array.isArray(built.mesh.material) ? built.mesh.material[0] : built.mesh.material;
  built.mesh.userData.bumpTex = null;
  built.mesh.userData.painterlyTex = null;
  built.mesh.userData.originalTex = built.mesh.userData.topMaterial.map;
  built.mesh.userData.styleCache = {};   // name → CanvasTexture
  built.mesh.userData.filters = { waterShader: true, surfaceBump: false, style: 'none' };
  built.mesh.userData.heightmap = data.heightmap;
  built.mesh.userData.bounds = data.bounds;
  built.mesh.userData.zExaggeration = zExag;
  built.mesh.userData.displacement = 0;
  built.mesh.userData.bumpCanvas = null;     // lazy
  built.mesh.userData.bumpPixelData = null;  // lazy
  currentMesh = built.mesh;
  scene.add(currentMesh);

  // Re-center the orbit pivot on the actual puck so rotation feels balanced.
  controls.target.copy(getPuckCenter());

  return {
    mesh: currentMesh,
    data,
    zExaggeration: zExag,
    stats: built.stats,
  };
}

async function ensureCanvas(albedo) {
  if (albedo instanceof HTMLCanvasElement) return albedo;
  if (typeof albedo === 'string') {
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        res(c);
      };
      img.onerror = rej;
      img.src = albedo;
    });
  }
  throw new Error('Unsupported albedo type');
}

let _dummyWaterTex = null;
function getDummyWaterTex() {
  if (_dummyWaterTex) return _dummyWaterTex;
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.fillRect(0, 0, 1, 1);
  _dummyWaterTex = new THREE.CanvasTexture(c);
  _dummyWaterTex.colorSpace = THREE.NoColorSpace;
  return _dummyWaterTex;
}

// Separable gaussian blur of an N x N Float32 field. Edge-clamped.
function gaussBlur2D(src, N, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let ksum = 0;
  for (let t = -r; t <= r; t++) { const w = Math.exp(-(t * t) / (2 * sigma * sigma)); k[t + r] = w; ksum += w; }
  for (let t = 0; t < k.length; t++) k[t] /= ksum;
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let t = -r; t <= r; t++) { const xx = Math.min(N - 1, Math.max(0, x + t)); s += src[y * N + xx] * k[t + r]; }
    tmp[y * N + x] = s;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let t = -r; t <= r; t++) { const yy = Math.min(N - 1, Math.max(0, y + t)); s += tmp[yy * N + x] * k[t + r]; }
    out[y * N + x] = s;
  }
  return out;
}

// Colour FIELD probe grid: a low-res, heavily-smoothed map of the real sea
// colour across the ocean. Unlike the old "two averaged colours" approach (which
// flattened the whole sea to one tone), this preserves spatial variation - river
// plumes, sandbanks, depth changes - while dissolving the blotchy raw patches.
// The shader samples it per-pixel; LinearFilter upsamples the small field
// smoothly so there are no hard edges.
//
// Technique: normalized convolution. Accumulate colour only where the mask says
// water+ocean (rejecting glint/voids), gaussian-blur the colour AND the coverage
// weight, then divide. Dividing by blurred weight means land never bleeds into
// the water colour, and the water colour extrapolates cleanly to the shoreline.
// Returns an N x N canvas, or null if no clean water was found.
function buildOceanColourField(albedoCanvas, maskCanvas, N = 96) {
  const small = (src) => {
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, N, N);
    return x.getImageData(0, 0, N, N).data;
  };
  const a = small(albedoCanvas);
  const m = small(maskCanvas);

  const cr = new Float32Array(N * N), cg = new Float32Array(N * N);
  const cb = new Float32Array(N * N), cw = new Float32Array(N * N);
  let anyWater = false;
  for (let i = 0; i < N * N; i++) {
    if (m[i * 4] < 150 || m[i * 4 + 2] < 120) continue;        // need water + ocean
    const ar = a[i * 4], ag = a[i * 4 + 1], ab = a[i * 4 + 2];
    const lum = 0.299 * ar + 0.587 * ag + 0.114 * ab;
    if (lum > 200 || lum < 12) continue;                        // drop glint / voids
    cr[i] = ar; cg[i] = ag; cb[i] = ab; cw[i] = 1; anyWater = true;
  }
  if (!anyWater) return null;

  const sigma = N / 14;   // ~7 px at N=96: dissolves patches, keeps broad gradients
  const br = gaussBlur2D(cr, N, sigma), bg = gaussBlur2D(cg, N, sigma);
  const bb = gaussBlur2D(cb, N, sigma), bw = gaussBlur2D(cw, N, sigma);

  const out = document.createElement('canvas');
  out.width = N; out.height = N;
  const octx = out.getContext('2d');
  const img = octx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const wgt = bw[i];
    if (wgt > 1e-4) {
      img.data[i * 4]     = Math.round(br[i] / wgt);
      img.data[i * 4 + 1] = Math.round(bg[i] / wgt);
      img.data[i * 4 + 2] = Math.round(bb[i] / wgt);
    }
    img.data[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function applyWaterShader(material, waterMaskCanvas, albedoCanvas) {
  let waterTex;
  if (waterMaskCanvas) {
    waterTex = new THREE.CanvasTexture(waterMaskCanvas);
    waterTex.colorSpace = THREE.NoColorSpace;
    waterTex.minFilter = THREE.LinearFilter;
    waterTex.magFilter = THREE.LinearFilter;
    waterTex.needsUpdate = true;
  } else {
    waterTex = getDummyWaterTex();
  }

  // Mask R = water, G = normalized distance from shore (0 shore → 1 deep).
  // Colours default to a stylized palette; real-colour sampling is opt-in at
  // runtime via setOceanColourProbes() (the 'Colour probes' toggle), so capture
  // stays cheap and the user can flip the effect to compare.
  material.userData.waterMask      = { value: waterTex };
  material.userData.waterShallow   = { value: new THREE.Color(0x2b5566) }; // darker teal at coast
  material.userData.waterDeep      = { value: new THREE.Color(0x112338) }; // deep navy
  material.userData.waterHighlight = { value: new THREE.Color(0xeef4f4) }; // near-white foam
  // Colour-probe field (opt-in): smoothed real-sea-colour map + on/off flag.
  material.userData.uWaterColourField  = { value: getDummyWaterTex() };
  material.userData.uWaterFieldEnabled = { value: 0 };
  material.userData.uTime          = { value: 0 };
  material.userData.uWaterEnabled  = { value: waterMaskCanvas ? 1 : 0 };
  // Shore fade range - start where the shader appears (close to coast =
  // small value), end where it reaches full strength. Default mirrors the
  // previous hard-coded smoothstep(0.30, 0.85).
  material.userData.uShoreFadeStart = { value: 0.30 };
  material.userData.uShoreFadeEnd   = { value: 0.85 };

  // Photo-style image adjustments - applied per-fragment after the texture
  // is sampled, before any water effects. Sliders just update the .value.
  material.userData.uBrightness    = { value: 0 };
  material.userData.uContrast      = { value: 1 };
  material.userData.uSaturation    = { value: 1 };
  material.userData.uSharpness     = { value: 0 };

  // Surface bump - sampler + strength. We compute derivatives ourselves so
  // we don't depend on three.js's bumpMap pipeline (which had been silently
  // failing with onBeforeCompile + late-bound bumpMap).
  material.userData.uBumpMap       = { value: getDummyWaterTex() };
  material.userData.uBumpStrength  = { value: 0 };

  // Texel size of the active map, used by both sharpness (unsharp mask) and
  // bump derivative sampling. Sized to whatever albedo we were given.
  const w = albedoCanvas ? albedoCanvas.width : 4096;
  const h = albedoCanvas ? albedoCanvas.height : 4096;
  material.userData.uTexelSize     = { value: new THREE.Vector2(1 / w, 1 / h) };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.waterMask      = material.userData.waterMask;
    shader.uniforms.waterShallow   = material.userData.waterShallow;
    shader.uniforms.waterDeep      = material.userData.waterDeep;
    shader.uniforms.waterHighlight = material.userData.waterHighlight;
    shader.uniforms.uWaterColourField  = material.userData.uWaterColourField;
    shader.uniforms.uWaterFieldEnabled = material.userData.uWaterFieldEnabled;
    shader.uniforms.uTime          = material.userData.uTime;
    shader.uniforms.uWaterEnabled  = material.userData.uWaterEnabled;
    shader.uniforms.uShoreFadeStart = material.userData.uShoreFadeStart;
    shader.uniforms.uShoreFadeEnd   = material.userData.uShoreFadeEnd;
    shader.uniforms.uBrightness    = material.userData.uBrightness;
    shader.uniforms.uContrast      = material.userData.uContrast;
    shader.uniforms.uSaturation    = material.userData.uSaturation;
    shader.uniforms.uSharpness     = material.userData.uSharpness;
    shader.uniforms.uBumpMap       = material.userData.uBumpMap;
    shader.uniforms.uBumpStrength  = material.userData.uBumpStrength;
    shader.uniforms.uTexelSize     = material.userData.uTexelSize;

    shader.fragmentShader =
      `uniform sampler2D waterMask;
       uniform vec3 waterShallow;
       uniform vec3 waterDeep;
       uniform vec3 waterHighlight;
       uniform sampler2D uWaterColourField;
       uniform float uWaterFieldEnabled;
       uniform float uTime;
       uniform float uWaterEnabled;
       uniform float uShoreFadeStart;
       uniform float uShoreFadeEnd;
       uniform float uBrightness;
       uniform float uContrast;
       uniform float uSaturation;
       uniform float uSharpness;
       uniform sampler2D uBumpMap;
       uniform float uBumpStrength;
       uniform vec2 uTexelSize;

       // 2D value noise - smooth, organic, no grid artifacts.
       float wh21(vec2 p) {
         p = fract(p * vec2(123.34, 456.21));
         p += dot(p, p + 78.91);
         return fract(p.x * p.y);
       }
       float wnoise(vec2 p) {
         vec2 i = floor(p);
         vec2 f = fract(p);
         vec2 u = f * f * (3.0 - 2.0 * f);
         return mix(mix(wh21(i),                  wh21(i + vec2(1.0, 0.0)), u.x),
                    mix(wh21(i + vec2(0.0, 1.0)), wh21(i + vec2(1.0, 1.0)), u.x),
                    u.y);
       }
       float wfbm(vec2 p) {
         return 0.55 * wnoise(p) + 0.30 * wnoise(p * 2.07) + 0.15 * wnoise(p * 4.13);
       }
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
      #include <map_fragment>

      // === Image adjustments (brightness / contrast / saturation / sharpness) ===
      // Sharpness: unsharp mask. 5-tap (current + 4 neighbours), high-pass diff.
      // The sample offset is one SCREEN pixel (fwidth of the UV), not one
      // source texel - the puck is displayed far smaller than the 4096px
      // texture, so a 1-texel offset lands inside a single visible pixel and
      // the high-pass cancels to zero. Screen-pixel spacing makes the effect
      // operate at the scale actually being rasterised, so it's visible at
      // any zoom. Clamped to ≥1 source texel so extreme close-ups still work.
      if (uSharpness > 0.001) {
        vec2 px = max(fwidth(vMapUv), uTexelSize);
        vec3 cN = texture2D(map, vMapUv + vec2(0.0, px.y)).rgb;
        vec3 cS = texture2D(map, vMapUv - vec2(0.0, px.y)).rgb;
        vec3 cE = texture2D(map, vMapUv + vec2(px.x, 0.0)).rgb;
        vec3 cW = texture2D(map, vMapUv - vec2(px.x, 0.0)).rgb;
        vec3 avg = (cN + cS + cE + cW) * 0.25;
        diffuseColor.rgb += (diffuseColor.rgb - avg) * uSharpness;
      }
      // Brightness: midtone-weighted lift. The weight peaks at mid-grey and
      // tapers to zero at pure black/white, so highlights don't blow out and
      // shadows don't crush - far more photo-like than a flat additive shift.
      if (abs(uBrightness) > 0.0001) {
        diffuseColor.rgb += uBrightness * (1.0 - abs(2.0 * diffuseColor.rgb - 1.0));
      }
      // Contrast: normalized sigmoid S-curve pivoted at mid-grey. Rolls
      // highlights/shadows off gently instead of clipping like a linear scale.
      // uContrast 1.0 = neutral, >1 punchier, <1 flatter.
      if (abs(uContrast - 1.0) > 0.002) {
        float k  = (uContrast - 1.0) * 6.0;
        vec3  s  = 1.0 / (1.0 + exp(-k * (diffuseColor.rgb - 0.5)));
        float s0 = 1.0 / (1.0 + exp( k * 0.5));
        float s1 = 1.0 / (1.0 + exp(-k * 0.5));
        diffuseColor.rgb = (s - s0) / (s1 - s0);
      }
      // Saturation: blend toward Rec.709 luma (correct sRGB weights - the old
      // 0.299/0.587/0.114 set is Rec.601 / SD-video).
      float _lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      diffuseColor.rgb = mix(vec3(_lum), diffuseColor.rgb, uSaturation);
      diffuseColor.rgb = clamp(diffuseColor.rgb, 0.0, 1.0);

      vec3 wsample = texture2D(waterMask, vMapUv).rgb;
      float waterAmt = wsample.r;
      float oceanFlag = wsample.b;  // 0 = lake / river, 1 = ocean
      if (waterAmt > 0.02 && oceanFlag > 0.02) {
        float depthNorm = wsample.g;

        // Fully transparent at the immediate shore, ramps over a long
        // feathered zone - 15% to 85% of the shore band - and reaches full
        // strength well offshore. The wide gradient hides any heightmap-mask
        // jaggedness and keeps near-shore detail (beaches, breakers,
        // shallow-water color) visible.
        float shoreFade = smoothstep(uShoreFadeStart, uShoreFadeEnd, depthNorm);

        // Base water color: shallow → deep. Narrow band so deep color is
        // reached within ~6% offshore.
        float depthCurve = smoothstep(0.0, 0.06, depthNorm);
        vec3 wcol = mix(waterShallow, waterDeep, depthCurve);
        // Colour probes: replace the two-tone gradient with the sampled,
        // smoothed real-sea-colour field (spatially varying, no patches).
        if (uWaterFieldEnabled > 0.5) {
          wcol = texture2D(uWaterColourField, vMapUv).rgb;
        }

        float n = wfbm(vMapUv * 5.0 + uTime * 0.015);
        wcol *= 0.97 + 0.04 * n;

        // Gated by oceanFlag - lakes / rivers contribute nothing. Their
        // satellite imagery shows through cleanly. Near-full mix offshore so the
        // blotchy raw sea pixels are replaced by the smooth probed colour;
        // shoreFade keeps near-shore detail (beaches, shallows) visible.
        diffuseColor.rgb = mix(diffuseColor.rgb, wcol, waterAmt * oceanFlag * 0.96 * shoreFade * uWaterEnabled);
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `
      #include <roughnessmap_fragment>
      vec3 ws2 = texture2D(waterMask, vMapUv).rgb;
      float waterAmt2  = ws2.r;
      float oceanFlag2 = ws2.b;
      float shoreFade2 = smoothstep(uShoreFadeStart, uShoreFadeEnd, ws2.g);
      roughnessFactor = mix(roughnessFactor, 0.92, waterAmt2 * oceanFlag2 * shoreFade2 * uWaterEnabled);
      `
    );

    // Animated wave normals - TWO noise layers at rotated angles & different
    // scales. Rotation between layers is what kills the value-noise grid
    // alignment that made the surface look like fabric weave. Standard trick
    // from game-engine water shaders (two normal maps panning at angles).
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `
      #include <normal_fragment_maps>

      // === Surface bump - perturb normal from a precomputed grayscale bump
      // map. Derivatives computed in-shader so we don't depend on three.js's
      // bumpMap pipeline (which had been failing silently with onBeforeCompile).
      if (uBumpStrength > 0.001) {
        vec2 stp = uTexelSize * 2.0;
        float bC = texture2D(uBumpMap, vMapUv).r - 0.5;
        float bE = texture2D(uBumpMap, vMapUv + vec2(stp.x, 0.0)).r - 0.5;
        float bN = texture2D(uBumpMap, vMapUv + vec2(0.0, stp.y)).r - 0.5;
        vec3 dB = vec3(bC - bE, bC - bN, 0.0) * uBumpStrength * 12.0;
        normal = normalize(normal + dB);
      }

      vec3 ws3 = texture2D(waterMask, vMapUv).rgb;
      float waterAmt3  = ws3.r;
      float oceanFlag3 = ws3.b;
      float shoreFade3 = smoothstep(uShoreFadeStart, uShoreFadeEnd, ws3.g);
      if (waterAmt3 > 0.02 && oceanFlag3 > 0.02) {
        // Layer A - rotated 25°. Lower scale = broader, softer swell (less grain).
        float a1 = 0.436; // 25°
        mat2 R1 = mat2(cos(a1), -sin(a1), sin(a1), cos(a1));
        vec2 uvA = R1 * vMapUv * 45.0 + vec2(uTime * 0.035, uTime * 0.022);
        // Layer B - rotated -55°.
        float a2 = -0.960; // -55°
        mat2 R2 = mat2(cos(a2), -sin(a2), sin(a2), cos(a2));
        vec2 uvB = R2 * vMapUv * 80.0 + vec2(-uTime * 0.020, uTime * 0.041);

        float eps = 0.55;
        float h0 = wnoise(uvA)                + 0.7 * wnoise(uvB);
        float hx = wnoise(uvA + vec2(eps, 0)) + 0.7 * wnoise(uvB + vec2(eps, 0));
        float hy = wnoise(uvA + vec2(0, eps)) + 0.7 * wnoise(uvB + vec2(0, eps));

        vec3 dN = vec3((h0 - hx) / eps, (h0 - hy) / eps, 0.0) * 0.028 * waterAmt3 * oceanFlag3 * shoreFade3 * uWaterEnabled;
        normal = normalize(normal + dN);
      }
      `
    );
  };

  material.needsUpdate = true;
}

function buildPuckMesh(heightmap, albedoCanvas, zExag, bounds, waterMaskCanvas) {
  const { ncols, nrows, values } = heightmap;

  let minH = Infinity, maxH = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  if (!isFinite(minH)) { minH = 0; maxH = 1; }
  const heightRange = Math.max(maxH - minH, 1);

  // True vertical scale on the puck (before exaggeration):
  //   terrain extent (m) / footprint extent (m) * puck footprint (cm)
  const midLat = (bounds.north + bounds.south) / 2;
  const widthM = (bounds.east - bounds.west) * 111320 * Math.cos(midLat * Math.PI / 180);
  const trueTerrainHeightCm = (heightRange / widthM) * PUCK_SIZE;
  const terrainHeightCm = trueTerrainHeightCm * zExag;

  const geom = buildTerrainBoxGeometry({
    values, ncols, nrows,
    size: PUCK_SIZE,
    baseThickness: MIN_THICKNESS,
    terrainHeight: terrainHeightCm,
    minH, heightRange,
  });

  const tex = new THREE.CanvasTexture(albedoCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;

  // Fully matte - terrain seen from altitude has no gloss. roughness 1.0
  // spreads the specular lobe out to nothing, and the reduced envMapIntensity
  // stops dark albedo from picking up a reflective sheen off the IBL.
  const topMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.45,
  });
  // Always install the custom shader - even without a water mask we want the
  // image-adjustment + bump uniforms wired up. Water effects are gated by
  // uWaterEnabled so they stay invisible when no real mask is present.
  applyWaterShader(topMat, waterMaskCanvas, albedoCanvas);

  const sideMat = new THREE.MeshStandardMaterial({
    color: 0xf3eee4,    // light off-white with the faintest cream warmth
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.45,
  });

  const mesh = new THREE.Mesh(geom, [topMat, sideMat]);
  mesh.userData.isPuck = true;

  return {
    mesh,
    stats: {
      widthM,
      minElevation: minH,
      maxElevation: maxH,
      verticalCm: terrainHeightCm + MIN_THICKNESS,
      trueVerticalCm: trueTerrainHeightCm + MIN_THICKNESS,
    },
  };
}

// Build a closed manifold: terrain top + flat base + 4 side walls (top edge
// follows terrain, bottom edge is flat). Material group 0 = top, group 1 = sides+base.
function buildTerrainBoxGeometry({
  values, ncols, nrows, size, baseThickness, terrainHeight, minH, heightRange,
  displacement = 0, bumpPixelData = null,
}) {
  const positions = [];
  const uvs = [];

  const half = size / 2;

  // Max displacement amplitude (cm) at slider = 1.0. The source map is a
  // positive 0..1 "texture intensity" - forests / urban areas score high
  // (so they rise), water / fields / snow score near zero (stay flat).
  const DISP_MAX_CM = 0.55;

  function sampleBump(uvX, uvY) {
    if (!bumpPixelData) return 0;
    const W = bumpPixelData.width, H = bumpPixelData.height;
    const bx = uvX * (W - 1);
    const by = uvY * (H - 1);
    const x0 = Math.floor(bx), y0 = Math.floor(by);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const tx = bx - x0, ty = by - y0;
    const d = bumpPixelData.data;
    const a = d[(y0 * W + x0) * 4];
    const b = d[(y0 * W + x1) * 4];
    const c = d[(y1 * W + x0) * 4];
    const e = d[(y1 * W + x1) * 4];
    const top = a * (1 - tx) + b * tx;
    const bot = c * (1 - tx) + e * tx;
    return (top * (1 - ty) + bot * ty) / 255; // 0..1
  }

  // sampleY = MIN_THICKNESS + (normalized terrain) * terrainHeight + micro-displacement.
  // The MIN_THICKNESS floor guarantees no point on the puck is thinner than that.
  function sampleY(c, r) {
    c = Math.max(0, Math.min(ncols - 1, c));
    r = Math.max(0, Math.min(nrows - 1, r));
    const v = values[r * ncols + c];
    const norm = v == null ? 0 : (v - minH) / heightRange;
    let y = baseThickness + norm * terrainHeight;

    if (displacement > 0 && bumpPixelData) {
      const uvX = c / (ncols - 1);
      const uvY = r / (nrows - 1);
      const b = sampleBump(uvX, uvY);    // 0..1 texture intensity
      // No centering - textured regions rise, smooth regions stay flat.
      y += b * DISP_MAX_CM * displacement;
    }
    return y;
  }

  // ===== TOP SURFACE =====
  // (r=0 → north, z=-half; r=nrows-1 → south, z=+half)
  const topOffset = 0;
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const x = (c / (ncols - 1)) * size - half;
      const z = (r / (nrows - 1)) * size - half;
      const y = sampleY(c, r);
      positions.push(x, y, z);
      uvs.push(c / (ncols - 1), 1 - r / (nrows - 1));
    }
  }
  const topIndices = [];
  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const a = topOffset + r * ncols + c;
      const b = a + 1;
      const d = a + ncols;
      const e = d + 1;
      // CCW from above (normal +Y)
      topIndices.push(a, d, b, b, d, e);
    }
  }

  // ===== BOTTOM (flat, 4 corners) =====
  const bottomOffset = positions.length / 3;
  positions.push(-half, 0, -half); uvs.push(0, 0);
  positions.push( half, 0, -half); uvs.push(1, 0);
  positions.push( half, 0,  half); uvs.push(1, 1);
  positions.push(-half, 0,  half); uvs.push(0, 1);
  // CCW from below (normal -Y)
  const bottomIndices = [
    bottomOffset + 0, bottomOffset + 1, bottomOffset + 2,
    bottomOffset + 0, bottomOffset + 2, bottomOffset + 3,
  ];

  // ===== SIDE WALLS =====
  // Each side strip duplicates the top edge so side normals are independent.
  const sideIndices = [];

  function addSideStrip(edgePts, outwardSign) {
    // outwardSign: +1 or -1 controlling winding so face normals point outward.
    const baseIdx = positions.length / 3;
    for (const p of edgePts) { positions.push(p.x, p.y, p.z); uvs.push(0, 0); }
    for (const p of edgePts) { positions.push(p.x, 0,   p.z); uvs.push(0, 0); }
    const n = edgePts.length;
    for (let i = 0; i < n - 1; i++) {
      const tA = baseIdx + i;
      const tB = baseIdx + i + 1;
      const bA = baseIdx + n + i;
      const bB = baseIdx + n + i + 1;
      if (outwardSign > 0) {
        sideIndices.push(tA, bA, tB, tB, bA, bB);
      } else {
        sideIndices.push(tA, tB, bA, tB, bB, bA);
      }
    }
  }

  // North edge (r=0, z=-half): outward normal = -Z → use sign -1
  const north = [];
  for (let c = 0; c < ncols; c++) {
    const x = (c / (ncols - 1)) * size - half;
    north.push({ x, y: sampleY(c, 0), z: -half });
  }
  addSideStrip(north, -1);

  // South edge (r=nrows-1, z=+half): outward normal = +Z
  const south = [];
  for (let c = 0; c < ncols; c++) {
    const x = (c / (ncols - 1)) * size - half;
    south.push({ x, y: sampleY(c, nrows - 1), z: half });
  }
  addSideStrip(south, +1);

  // West edge (c=0, x=-half): outward normal = -X
  const west = [];
  for (let r = 0; r < nrows; r++) {
    const z = (r / (nrows - 1)) * size - half;
    west.push({ x: -half, y: sampleY(0, r), z });
  }
  addSideStrip(west, +1);

  // East edge (c=ncols-1, x=+half): outward normal = +X
  const east = [];
  for (let r = 0; r < nrows; r++) {
    const z = (r / (nrows - 1)) * size - half;
    east.push({ x: half, y: sampleY(ncols - 1, r), z });
  }
  addSideStrip(east, -1);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

  const allIndices = topIndices.concat(bottomIndices, sideIndices);
  geom.setIndex(allIndices);

  geom.addGroup(0, topIndices.length, 0);
  geom.addGroup(topIndices.length, bottomIndices.length + sideIndices.length, 1);

  geom.computeVertexNormals();
  return geom;
}

function getPuckCenter() {
  if (!currentMesh) return new THREE.Vector3();
  const hm = currentMesh.userData.heightmap;
  // Without a heightmap (shouldn't normally happen) fall back to bbox center.
  if (!hm) {
    const box = new THREE.Box3().setFromObject(currentMesh);
    const c = new THREE.Vector3();
    box.getCenter(c);
    return c;
  }
  // Volume centroid in Y. For a flat-bottomed puck with column heights h_i
  // the centroid Y of column i is h_i/2, and the volume-weighted overall
  // centroid is Σ(h_i²) / (2·Σ(h_i)). This sits at the true mass-centre of
  // the puck (not the bbox midpoint, which floats above the puck when only
  // a few peaks pull the top up). Rotation feels balanced instead of glidey.
  const pos = currentMesh.geometry.attributes.position;
  const N = hm.ncols * hm.nrows;     // first N positions = top surface vertices
  let sumY = 0, sumYSq = 0;
  for (let i = 0; i < N; i++) {
    const y = pos.getY(i);
    sumY += y;
    sumYSq += y * y;
  }
  const cy = sumY > 0 ? (sumYSq / N) / (2 * sumY / N) : 0;
  // X & Z are 0 because the puck footprint is centred at the origin.
  return new THREE.Vector3(0, cy, 0);
}

function getPuckSize() {
  if (!currentMesh) return new THREE.Vector3(PUCK_SIZE, PUCK_SIZE, PUCK_SIZE);
  const box = new THREE.Box3().setFromObject(currentMesh);
  const s = new THREE.Vector3();
  box.getSize(s);
  return s;
}

function disposeMesh(mesh) {
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    m?.map?.dispose();
    m?.dispose();
  }
}

function tweenCamera(targetPos, targetLookAt, duration = 900) {
  if (activeTween) activeTween.cancelled = true;
  const tween = { cancelled: false };
  activeTween = tween;
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const t0 = performance.now();
  function step() {
    if (tween.cancelled) return;
    const a = Math.min((performance.now() - t0) / duration, 1);
    const e = 0.5 - 0.5 * Math.cos(a * Math.PI);
    camera.position.lerpVectors(startPos, targetPos, e);
    controls.target.lerpVectors(startTarget, targetLookAt, e);
    if (a < 1) requestAnimationFrame(step);
    else if (activeTween === tween) activeTween = null;
  }
  step();
}

function getPresentBackground() {
  if (presentation.bg) return presentation.bg;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 512;
  const ctx = c.getContext('2d');
  // Cool neutral "infinity backdrop" - lighter at top, darker at bottom, like
  // a photography studio's seamless paper curving from wall to floor. No warm
  // cast (yellow reads as "stock photo"), no pure white (reads as flat / boring).
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0.00, '#e8e9eb');
  g.addColorStop(0.50, '#d4d6d9');
  g.addColorStop(0.78, '#b8babe');
  g.addColorStop(1.00, '#9ca0a4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  presentation.bg = tex;
  return tex;
}

function getShadowDisc() {
  if (presentation.shadowDisc) return presentation.shadowDisc;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(256, 256, 60, 256, 256, 256);
  g.addColorStop(0, 'rgba(0,0,0,0.28)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PUCK_SIZE * 1.6, PUCK_SIZE * 1.6), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.002;
  presentation.shadowDisc = mesh;
  return mesh;
}

// `preserveCamera`: keep the user's current orbit/zoom instead of tweening to
// the idealised present-mode pose. Used by the video recorder so the export
// is WYSIWYG with the on-screen canvas (with the showroom-quality background,
// shadow disc, and exposure boost still applied).
export function enterPresentMode({ preserveCamera = false } = {}) {
  if (!scene || presentation.active) return;
  presentation.active = true;
  presentation.saved = {
    bg: scene.background,
    camPos: camera.position.clone(),
    target: controls.target.clone(),
    exposure: renderer.toneMappingExposure,
    autoRotate: controls.autoRotate,
  };

  scene.background = getPresentBackground();
  const disc = getShadowDisc();
  if (!scene.children.includes(disc)) scene.add(disc);
  renderer.toneMappingExposure = 1.18;

  // Present mode is the default viewing state now (no workshop fallback), so
  // the puck stays still by default - user grabs to orbit. The recorder still
  // turns autoRotate on internally during exports.
  controls.autoRotate = false;

  if (preserveCamera) return;       // skip the auto-framing tween

  const center = getPuckCenter();
  const size = getPuckSize();
  const radius = Math.max(size.x, size.z) * 0.5;
  const d = radius * 2.31;         // tuned for the 40° FOV - 10% closer than previous
  const camPos = new THREE.Vector3(center.x + d, center.y + d * 0.85, center.z + d);

  // In orthographic mode the camera distance only sets the angle, not the
  // apparent size - set the zoom to frame the puck (matches the perspective
  // framing at distance d).
  if (camera.isOrthographicCamera) {
    const visibleHalfH = d * Math.tan(perspCamera.fov * Math.PI / 360);
    camera.zoom = ORTHO_REF_HALF_H / Math.max(0.001, visibleHalfH);
    camera.updateProjectionMatrix();
  }

  tweenCamera(camPos, center, 900);
}

export function exitPresentMode() {
  if (!presentation.active) return;
  presentation.active = false;
  const s = presentation.saved;
  scene.background = s.bg;
  if (presentation.shadowDisc) scene.remove(presentation.shadowDisc);
  renderer.toneMappingExposure = s.exposure;
  controls.autoRotate = s.autoRotate;
  tweenCamera(s.camPos, s.target, 700);
}

export function isPresenting() {
  return presentation.active;
}

// === Post-capture filter toggles ===

export function setWaterShader(enabled) {
  if (!currentMesh) return;
  const mat = currentMesh.userData.topMaterial;
  if (mat?.userData?.uWaterEnabled) {
    mat.userData.uWaterEnabled.value = enabled ? 1 : 0;
  }
  currentMesh.userData.filters.waterShader = enabled;
}

// Colour probes (opt-in): when enabled, sample the real sea colour from the
// captured satellite image across the ocean areas and feed it to the shader's
// shallow/deep gradient. When disabled, restore the stylized defaults. Mutates
// the existing uniform Color objects, so it updates live with no recompile.
export function setOceanColourProbes(enabled) {
  if (!currentMesh) return;
  const mat = currentMesh.userData.topMaterial;
  if (!mat?.userData?.uWaterFieldEnabled) return;

  if (enabled) {
    const albedo = currentMesh.userData.albedoCanvas;       // stable captured image
    const mask   = mat.userData.waterMask?.value?.image;    // water-info canvas
    const field  = (albedo && mask) ? buildOceanColourField(albedo, mask) : null;
    if (field) {
      const tex = new THREE.CanvasTexture(field);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      const prev = mat.userData.uWaterColourField.value;
      mat.userData.uWaterColourField.value = tex;
      if (prev && prev.dispose && prev !== getDummyWaterTex()) prev.dispose();
      mat.userData.uWaterFieldEnabled.value = 1;
    } else {
      mat.userData.uWaterFieldEnabled.value = 0;   // nothing to sample
    }
  } else {
    mat.userData.uWaterFieldEnabled.value = 0;
  }
  currentMesh.userData.filters.waterProbes = enabled;
}

export function setSurfaceBumpStrength(strength) {
  if (!currentMesh) return;
  const mat = currentMesh.userData.topMaterial;
  if (!mat) return;
  const ud = currentMesh.userData;
  if (strength > 0 && !ud.bumpTex) {
    if (!ud.bumpCanvas) ud.bumpCanvas = computeBumpFromAlbedo(ud.albedoCanvas);
    const tex = new THREE.CanvasTexture(ud.bumpCanvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    ud.bumpTex = tex;
    if (mat.userData.uBumpMap) mat.userData.uBumpMap.value = tex;
  }
  if (mat.userData.uBumpStrength) mat.userData.uBumpStrength.value = strength;
  ud.filters.surfaceBump = strength;
}

export function setWaterShoreFade(start, feather) {
  if (!currentMesh) return;
  const mat = currentMesh.userData.topMaterial;
  if (!mat || !mat.userData.uShoreFadeStart) return;
  mat.userData.uShoreFadeStart.value = start;
  mat.userData.uShoreFadeEnd.value = Math.min(1.0, start + feather);
  if (!currentMesh.userData.filters.water) currentMesh.userData.filters.water = {};
  currentMesh.userData.filters.water.shoreStart = start;
  currentMesh.userData.filters.water.feather = feather;
}

export function setImageAdjust(name, value) {
  if (!currentMesh) return;
  const mat = currentMesh.userData.topMaterial;
  if (!mat) return;
  const u = mat.userData;
  if (name === 'brightness' && u.uBrightness) u.uBrightness.value = value;
  if (name === 'contrast'   && u.uContrast)   u.uContrast.value = value;
  if (name === 'saturation' && u.uSaturation) u.uSaturation.value = value;
  if (name === 'sharpness'  && u.uSharpness)  u.uSharpness.value = value;
  if (!currentMesh.userData.filters.image) currentMesh.userData.filters.image = {};
  currentMesh.userData.filters.image[name] = value;
}

// Generic stylized-texture filter. `name` is one of:
//   'none' | 'painterly' | 'sketch' | 'tritone' | 'posterize'
// Cached per puck so re-toggling is instant after the first compute.
export async function setStyle(name, onProgress) {
  if (!currentMesh) return;
  const mat = currentMesh.userData.topMaterial;
  if (!mat) return;
  const cache = currentMesh.userData.styleCache;
  const albedo = currentMesh.userData.albedoCanvas;

  let tex = currentMesh.userData.originalTex;
  if (name && name !== 'none') {
    if (!cache[name]) {
      let canvas = null;
      if (name === 'painterly') canvas = await applyKuwahara(albedo, { onProgress });
      else if (name === 'sketch')     canvas = applySketch(albedo);
      else if (name === 'tritone')    canvas = applyTritone(albedo);
      else if (name === 'watercolor') canvas = applyWatercolor(albedo);
      else if (name === 'contours')   canvas = applyContours(albedo, currentMesh.userData.heightmap);
      if (canvas) {
        const t = new THREE.CanvasTexture(canvas);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.needsUpdate = true;
        cache[name] = t;
      }
    }
    if (cache[name]) tex = cache[name];
  }

  mat.map = tex;
  mat.needsUpdate = true;
  currentMesh.userData.filters.style = name || 'none';
}

// Displacement uses a separate texture-intensity map (local stddev of
// luminance, heavily smoothed) - not the high-pass bump map which is too
// noisy for actual geometry. The bump canvas keeps catching light in the
// shader; the displacement canvas decides where to raise vertices.
function ensureDisplacementPixelData() {
  if (!currentMesh) return null;
  const ud = currentMesh.userData;
  if (ud.displacementPixelData) return ud.displacementPixelData;
  if (!ud.displacementCanvas) {
    ud.displacementCanvas = computeTextureIntensity(ud.albedoCanvas);
  }
  const ctx = ud.displacementCanvas.getContext('2d');
  ud.displacementPixelData = {
    width: ud.displacementCanvas.width,
    height: ud.displacementCanvas.height,
    data: ctx.getImageData(0, 0, ud.displacementCanvas.width, ud.displacementCanvas.height).data,
  };
  return ud.displacementPixelData;
}

// Single rebuild routine - reads current zExag + displacement off the mesh
// and constructs a new geometry. Both setZExaggeration and setDisplacement
// route through here.
function rebuildGeometry() {
  if (!currentMesh) return null;
  const ud = currentMesh.userData;
  const heightmap = ud.heightmap;
  const bounds = ud.bounds;
  if (!heightmap || !bounds) return null;

  const { ncols, nrows, values } = heightmap;
  const zExag = ud.zExaggeration ?? 1.0;
  const displacement = ud.displacement ?? 0;

  let minH = Infinity, maxH = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  if (!isFinite(minH)) { minH = 0; maxH = 1; }
  const heightRange = Math.max(maxH - minH, 1);

  const midLat = (bounds.north + bounds.south) / 2;
  const widthM = (bounds.east - bounds.west) * 111320 * Math.cos(midLat * Math.PI / 180);
  const trueTerrainHeightCm = (heightRange / widthM) * PUCK_SIZE;
  const terrainHeightCm = trueTerrainHeightCm * zExag;

  const dispPixelData = displacement > 0 ? ensureDisplacementPixelData() : null;

  const newGeom = buildTerrainBoxGeometry({
    values, ncols, nrows,
    size: PUCK_SIZE,
    baseThickness: MIN_THICKNESS,
    terrainHeight: terrainHeightCm,
    minH, heightRange,
    displacement,
    bumpPixelData: dispPixelData,
  });

  currentMesh.geometry.dispose();
  currentMesh.geometry = newGeom;

  // Keep geoParams in sync so any overlay (buildings, future markers, etc.)
  // that re-reads it picks up the current zExag-aware terrain height.
  if (currentMesh.userData.geoParams) {
    currentMesh.userData.geoParams.terrainHeightCm = terrainHeightCm;
    currentMesh.userData.geoParams.minH = minH;
    currentMesh.userData.geoParams.heightRange = heightRange;
    currentMesh.userData.geoParams.zExag = zExag;
  }

  if (controls) controls.target.copy(getPuckCenter());

  return {
    widthM,
    minElevation: minH,
    maxElevation: maxH,
    verticalCm: terrainHeightCm + MIN_THICKNESS,
    trueVerticalCm: trueTerrainHeightCm + MIN_THICKNESS,
  };
}

export function setZExaggeration(zExag) {
  if (!currentMesh) return null;
  currentMesh.userData.zExaggeration = zExag;
  return rebuildGeometry();
}

export function setDisplacement(amount) {
  if (!currentMesh) return null;
  currentMesh.userData.displacement = amount;
  return rebuildGeometry();
}

// === Share / export ===

// Set up the renderer + camera for an export at (width, height), plus a WebGL
// overlay scene that renders the caption from a precomputed canvas texture.
// Camera pull-back is aspect-aware so the puck fits at any aspect ratio.
// Returns a snapshot of the original state so it can be restored.
function setupExportState(width, height, overlay) {
  const state = {
    pixelRatio: renderer.getPixelRatio(),
    container: renderer.domElement.parentElement,
    camPos: camera.position.clone(),
    camZoom: camera.zoom,
    autoRotate: controls.autoRotate,
    autoRotateSpeed: controls.autoRotateSpeed,
    enableDamping: controls.enableDamping,
    overlay: null,
  };

  // GUARANTEE the rotation axis is the puck's own volume centroid. Even
  // though pan is disabled globally, this is a hard belt-and-suspenders
  // defence - every export starts on-axis no matter what.
  controls.target.copy(getPuckCenter());
  controls.update();

  // Disable damping for the export. With damping on, changing autoRotateSpeed
  // makes the rotation ramp up over ~12 frames - the recording would start
  // slow, never complete a clean 360°, and the loop wouldn't seam. Off, the
  // rotation is perfectly uniform from the first frame.
  controls.enableDamping = false;

  // Match the on-screen viewfinder, which is sized to 88% of the container
  // along its constraining axis. Perspective: pull the camera in by that
  // fraction. Orthographic: divide the zoom by it (zoom in).
  const cont = renderer.domElement.parentElement;
  const exportAspect = width / height;
  const containerAspect = cont ? (cont.clientWidth / cont.clientHeight) : exportAspect;
  const VIEWFINDER_FRACTION = 0.88;
  const factor = containerAspect >= exportAspect
    ? VIEWFINDER_FRACTION
    : VIEWFINDER_FRACTION * containerAspect / exportAspect;

  if (camera.isOrthographicCamera) {
    camera.zoom = camera.zoom / factor;
  } else {
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    const currentDist = camera.position.distanceTo(controls.target);
    camera.position.copy(controls.target).addScaledVector(dir, currentDist * factor);
  }

  renderer.setPixelRatio(1);
  renderer.setSize(width, height, true);
  applyCameraAspect(exportAspect);
  controls.update();

  if (overlay) {
    // Draw the caption once into a canvas at the full export dimensions; the
    // overlay callback receives `height` as the design scale so typography
    // sizes are consistent regardless of aspect ratio.
    const capCanvas = document.createElement('canvas');
    capCanvas.width = width;
    capCanvas.height = height;
    overlay(capCanvas.getContext('2d'), height);
    const capTex = new THREE.CanvasTexture(capCanvas);
    capTex.colorSpace = THREE.SRGBColorSpace;
    capTex.minFilter = THREE.LinearFilter;
    capTex.magFilter = THREE.LinearFilter;
    capTex.needsUpdate = true;

    // Full-screen quad with the caption texture, rendered in a second pass
    // (no depth test) so it overlays the main scene without interfering.
    const overlayScene = new THREE.Scene();
    const overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
    overlayCamera.position.z = 5;
    const mat = new THREE.MeshBasicMaterial({
      map: capTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    overlayScene.add(mesh);

    state.overlay = { scene: overlayScene, camera: overlayCamera, mesh, mat, tex: capTex };
    _exportOverlay = { scene: overlayScene, camera: overlayCamera };
  }

  return state;
}

function restoreExportState(state) {
  if (state.overlay) {
    _exportOverlay = null;
    state.overlay.mesh.geometry.dispose();
    state.overlay.mat.dispose();
    state.overlay.tex.dispose();
  }
  renderer.setPixelRatio(state.pixelRatio);
  if (state.container) {
    const w = state.container.clientWidth, h = state.container.clientHeight;
    renderer.setSize(w, h);
    applyCameraAspect(w / h);
  }
  camera.position.copy(state.camPos);
  camera.zoom = state.camZoom;
  camera.updateProjectionMatrix();
  controls.autoRotate = state.autoRotate;
  controls.autoRotateSpeed = state.autoRotateSpeed;
  controls.enableDamping = state.enableDamping;
  controls.update();
}

// PNG snapshot - renders main scene + (optional) overlay into the WebGL
// canvas, then reads it as a data URL.
export function captureSnapshotPNG({ width = 1440, height = 1080, overlay } = {}) {
  if (!renderer || !scene || !camera) return null;
  const state = setupExportState(width, height, overlay);

  renderer.render(scene, camera);
  if (state.overlay) {
    renderer.autoClear = false;
    renderer.render(state.overlay.scene, state.overlay.camera);
    renderer.autoClear = true;
  }
  const dataURL = renderer.domElement.toDataURL('image/png');

  restoreExportState(state);
  return dataURL;
}

// Records one full rotation as a WebM. Uses manual-frame capture so each
// rendered frame is pushed to the stream exactly once (no browser sampling
// jitter, no dropped frames). VP9 → VP8 fallback. 12 Mbps for clean motion.
// Mime types in preference order. MP4/H.264 is Twitter / X / Bluesky / most
// social platforms' native format and plays everywhere without re-encoding,
// so we try it first; WebM is the fallback for browsers that don't yet
// expose H.264 through MediaRecorder (mostly older Firefox).
//
// Important: the profile/level code must permit the output resolution. We
// render at 1440×1080, which requires AT LEAST Level 4.0. Earlier we picked
// Baseline 3.1 (avc1.42E01F) which caps at 720p - the encoder produced
// garbage frames silently. The codes below all cover 1080p properly.
const VIDEO_MIME_PREFERENCE = [
  'video/mp4;codecs=avc1.640028',   // H.264 High @ Level 4.0 - best quality
  'video/mp4;codecs=avc1.4D4028',   // H.264 Main @ Level 4.0
  'video/mp4;codecs=avc1.42E028',   // H.264 Baseline @ Level 4.0
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickBestVideoMime() {
  for (const t of VIDEO_MIME_PREFERENCE) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

export function getRecordingFileExtension(mimeType) {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export async function recordRotation({ durationSec = 8, width = 1440, height = 1080, overlay, onTick } = {}) {
  if (!renderer || !controls) throw new Error('Renderer not ready');
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Video recording not supported in this browser');
  }
  const mimeType = pickBestVideoMime();

  const state = setupExportState(width, height, overlay);

  // One full rotation in durationSec. controls.update is deltaTime-aware so
  // rotation stays smooth even under encoder load.
  controls.autoRotate = true;
  controls.autoRotateSpeed = 60 / durationSec;

  // captureStream(0) + manual requestFrame() gives perfectly-paced WebM, but
  // Chrome's MP4 H.264 encoder expects a steady-rate stream and only the
  // first frame comes through under manual-frame mode (you get a glitched
  // single-frame video with a colour bar). So: manual-frame for WebM,
  // steady 60 fps for MP4.
  const useManualFrame = !mimeType.startsWith('video/mp4');
  let stream, track;
  if (useManualFrame) {
    stream = renderer.domElement.captureStream(0);
    track = stream.getVideoTracks()[0];
    if (typeof track?.requestFrame !== 'function') {
      // Browser doesn't support requestFrame at all - fall back to steady.
      stream.getTracks().forEach(t => t.stop());
      stream = renderer.domElement.captureStream(60);
      track = null;
    }
  } else {
    stream = renderer.domElement.captureStream(60);
    track = null;
  }
  const manual = !!track;

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 12_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  // Warm up: render & wait a few frames so the first captured frame is fully
  // painted (texture uploads, env-map mipmaps, shader compiles all settled).
  for (let i = 0; i < 4; i++) {
    renderer.render(scene, camera);
    if (state.overlay) {
      renderer.autoClear = false;
      renderer.render(state.overlay.scene, state.overlay.camera);
      renderer.autoClear = true;
    }
    await new Promise(r => requestAnimationFrame(r));
  }

  // Hand the track to the animate loop - it'll push a frame each render.
  if (manual) _exportTrack = track;

  const startMs = performance.now();
  recorder.start();
  await new Promise(resolve => {
    recorder.onstop = resolve;
    const tick = () => {
      const t = (performance.now() - startMs) / 1000;
      if (onTick) onTick(Math.min(t, durationSec), durationSec);
      if (t >= durationSec) { recorder.stop(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  _exportTrack = null;
  restoreExportState(state);
  // Use the actual mime type the encoder produced so the caller can pick the
  // correct file extension (mp4 vs webm).
  return new Blob(chunks, { type: mimeType });
}

// Backwards-compat shim: a few earlier modules imported the function by its
// old "WebM"-specific name. Keep the alias so we don't have to touch them.
export const recordRotationWebM = recordRotation;

export function togglePresentRotation() {
  if (!controls) return false;
  controls.autoRotate = !controls.autoRotate;
  return controls.autoRotate;
}

// Returns the puck's current albedo source canvas (for texture export).
export function getPuckAlbedoCanvas() {
  return currentMesh?.userData?.albedoCanvas || null;
}

// Replace the puck's base albedo (used by both the resolution re-fetch and
// the manual texture import). Disposes the old texture, clears every derived
// cache (styles, bump, displacement) so they recompute from the new source,
// and updates the sharpness texel-size uniform. Caller is expected to
// re-apply the active filter-panel state afterward.
export function setPuckAlbedo(canvas) {
  if (!currentMesh) return;
  const ud = currentMesh.userData;
  const mat = ud.topMaterial;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;

  ud.originalTex?.dispose();
  ud.originalTex = tex;
  ud.albedoCanvas = canvas;

  // Invalidate everything derived from the albedo.
  for (const t of Object.values(ud.styleCache || {})) t.dispose?.();
  ud.styleCache = {};
  ud.bumpTex?.dispose?.();
  ud.bumpTex = null;
  ud.bumpCanvas = null;
  ud.bumpPixelData = null;
  ud.displacementCanvas = null;
  ud.displacementPixelData = null;

  mat.map = tex;
  if (mat.userData.uTexelSize) {
    mat.userData.uTexelSize.value.set(1 / canvas.width, 1 / canvas.height);
  }
  mat.needsUpdate = true;
}

export function getFilterState() {
  return currentMesh?.userData?.filters
    ? { ...currentMesh.userData.filters }
    : { waterShader: true, surfaceBump: false, style: 'none' };
}

// ===== Building overlays =====
// The buildings.js module needs the same heightmap / scale info that
// buildTerrainBoxGeometry used so its extrusions sit correctly on the
// terrain. We cached it on the mesh in createPuck; expose it here.
// Includes the live albedo canvas so buildings can pull a planar top-down
// projection of the satellite texture onto their roofs/walls.
export function getPuckGeoParams() {
  if (!currentMesh?.userData?.geoParams) return null;
  return {
    ...currentMesh.userData.geoParams,
    albedoCanvas: currentMesh.userData.albedoCanvas || null,
  };
}

export function setBuildingsGroup(group) {
  if (!currentMesh) return;
  const existing = currentMesh.userData.buildingsGroup;
  if (existing) {
    currentMesh.remove(existing);
    existing.traverse((c) => {
      if (c.isMesh) {
        c.geometry?.dispose();
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material?.dispose();
      }
    });
  }
  currentMesh.userData.buildingsGroup = group || null;
  if (group) currentMesh.add(group);
}

export function hasBuildings() {
  return !!(currentMesh?.userData?.buildingsGroup);
}

export function clearBuildings() { setBuildingsGroup(null); }
