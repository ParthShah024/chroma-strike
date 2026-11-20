import * as THREE from 'three';

/**
 * ============================================================================
 * Procedural PBR Texture & Bump Generator ("Chroma Ascent" material library)
 * ============================================================================
 *
 * Every surface texture in the arena is painted at runtime into an offscreen
 * `<canvas>` (no image downloads), then wrapped in a cached, reusable
 * `THREE.CanvasTexture` pair:
 *
 *   - `map`     : sRGB albedo (base color) — multiplied by `material.color`,
 *                 so ONE texture can be re-tinted per region.
 *   - `bumpMap` : linear grayscale height field (white = raised, black = recessed).
 *                 `MeshStandardMaterial.bumpMap` perturbs shading normals from
 *                 its screen-space derivatives, so mortar joints, rib grooves,
 *                 rivets and slab seams catch real sun light & shadow without
 *                 adding a single triangle.
 *
 * How the painting works (seamless tiling):
 *   1. A deterministic RNG (`mulberry32`) seeds every texture so the arena
 *      looks identical on every machine / rebuild.
 *   2. Periodic value-noise lattices (`wrap`-around corner lookups) are summed
 *      into fractal Brownian motion (fBm) for grain, grime and veining. Because
 *      every lattice wraps exactly at the canvas edge, all textures tile
 *      seamlessly with `RepeatWrapping`.
 *   3. A per-pixel pass writes albedo + height together, then optional vector
 *      passes (stencils, glyphs) are drawn with the 2D canvas API.
 *
 * All generators are SSR / headless-safe: when `document` is unavailable
 * (Node verification scripts, workers) they return `null` maps without throwing,
 * and materials simply fall back to their flat `color`.
 */

/** World-space meters covered by ONE repeat of the large surface textures (walls / floors). */
export const TEXTURE_WORLD_SIZE_M = 4.0;

/** Albedo + bump pair for a lit `MeshStandardMaterial`. */
export interface PbrTextureSet {
  map: THREE.CanvasTexture | null;
  bumpMap: THREE.CanvasTexture | null;
}

/** Color + alpha pair for the translucent hex-grid buy-phase barrier. */
export interface BarrierTextureSet {
  map: THREE.CanvasTexture | null;
  alphaMap: THREE.CanvasTexture | null;
}

/** Identifiers of every cached arena surface texture. */
export type ArenaTextureId =
  | 'plaza_concrete'
  | 'sandstone_ashlar'
  | 'terracotta_trim'
  | 'cobalt_steel'
  | 'hazard_trim'
  | 'radianite_crate'
  | 'olive_cargo'
  | 'steel_grate';

const ANISOTROPY = 8;
const NULL_SET: PbrTextureSet = { map: null, bumpMap: null };

const textureCache = new Map<ArenaTextureId, PbrTextureSet>();
let barrierCache: BarrierTextureSet | null = null;

// ---------------------------------------------------------------------------
// Low-level helpers: RNG, periodic noise, canvas plumbing
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Periodic value-noise field (`cellsX x cellsY` lattice wrapped across a
 * `w x h` canvas) returning values in `[0, 1]`.
 */
function noiseField(w: number, h: number, cellsX: number, cellsY: number, rand: () => number): Float32Array {
  const lattice = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * cellsY;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    const r0 = (y0 % cellsY) * cellsX;
    const r1 = ((y0 + 1) % cellsY) * cellsX;
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * cellsX;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const c0 = x0 % cellsX;
      const c1 = (x0 + 1) % cellsX;
      const a = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * tx;
      const b = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Seamless fBm: sum of periodic octaves (`baseCells`, x2, x4 ...) normalized to `[0, 1]`. */
function fbm(w: number, h: number, baseCellsX: number, baseCellsY: number, octaves: number, rand: () => number): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = 1 << o;
    const field = noiseField(w, h, baseCellsX * f, baseCellsY * f, rand);
    for (let i = 0; i < out.length; i++) out[i] += field[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

interface CanvasPair {
  albedo: HTMLCanvasElement;
  albedoCtx: CanvasRenderingContext2D;
  bump: HTMLCanvasElement;
  bumpCtx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function createCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return { canvas, ctx };
  } catch {
    return null;
  }
}

function createCanvasPair(w: number, h: number): CanvasPair | null {
  const a = createCanvas(w, h);
  const b = createCanvas(w, h);
  if (!a || !b) return null;
  return { albedo: a.canvas, albedoCtx: a.ctx, bump: b.canvas, bumpCtx: b.ctx, w, h };
}

/**
 * Runs a per-pixel shader writing albedo RGB (`0..1`) and height (`0..1`) into
 * both canvases of the pair.
 */
function paintPixels(
  pair: CanvasPair,
  shade: (x: number, y: number, i: number, outRgb: [number, number, number]) => number
): void {
  const { w, h } = pair;
  const albedo = pair.albedoCtx.createImageData(w, h);
  const bump = pair.bumpCtx.createImageData(w, h);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const height = shade(x, y, i, rgb);
      const p = i * 4;
      albedo.data[p] = Math.round(clamp01(rgb[0]) * 255);
      albedo.data[p + 1] = Math.round(clamp01(rgb[1]) * 255);
      albedo.data[p + 2] = Math.round(clamp01(rgb[2]) * 255);
      albedo.data[p + 3] = 255;
      const hv = Math.round(clamp01(height) * 255);
      bump.data[p] = hv;
      bump.data[p + 1] = hv;
      bump.data[p + 2] = hv;
      bump.data[p + 3] = 255;
    }
  }
  pair.albedoCtx.putImageData(albedo, 0, 0);
  pair.bumpCtx.putImageData(bump, 0, 0);
}

function finishTexture(canvas: HTMLCanvasElement, isColor: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = ANISOTROPY;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function finishPair(pair: CanvasPair, name: string): PbrTextureSet {
  const map = finishTexture(pair.albedo, true);
  const bumpMap = finishTexture(pair.bump, false);
  map.name = `${name}-albedo`;
  bumpMap.name = `${name}-bump`;
  return { map, bumpMap };
}

/** Draws text on both canvases: colored paint on albedo, slightly recessed on bump. */
function stencilText(
  pair: CanvasPair,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  bumpGray: string,
  alpha = 0.92
): void {
  for (const [ctx, fill] of [
    [pair.albedoCtx, color],
    [pair.bumpCtx, bumpGray],
  ] as const) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 1. Plaza Concrete Tiles (2m slabs, 4m repeat)
// ---------------------------------------------------------------------------

function generatePlazaConcrete(): PbrTextureSet {
  const S = 512;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0xc0ffee);
  const grain = fbm(S, S, 8, 8, 5, rand);
  const blotch = fbm(S, S, 3, 3, 3, rand);
  const slab = 256; // 2m per slab
  const slabTone = [0, 1, 2, 3].map(() => (rand() - 0.5) * 0.07);
  const joint = 3;

  paintPixels(pair, (x, y, i, rgb) => {
    const sx = x % slab;
    const sy = y % slab;
    const slabIdx = (Math.floor(y / slab) % 2) * 2 + (Math.floor(x / slab) % 2);
    const edge = Math.min(sx, sy, slab - 1 - sx, slab - 1 - sy);
    const speck = grain[i] > 0.74 ? -0.06 : grain[(i * 7) % grain.length] < 0.2 ? 0.035 : 0;
    let v = 0.6 + slabTone[slabIdx] + (grain[i] - 0.5) * 0.14 + (blotch[i] - 0.5) * 0.1 + speck;
    let height = 0.62 + (grain[i] - 0.5) * 0.22;

    if (edge < joint) {
      v *= 0.55;
      height = 0.12;
    } else if (edge < joint + 4) {
      const t = (edge - joint) / 4;
      height = 0.3 + 0.32 * t + (grain[i] - 0.5) * 0.1;
      v *= 0.85 + 0.15 * t;
    }
    // Faint saw-cut control joint across the middle of every slab.
    if (Math.abs(sx - slab / 2) < 1 && edge > joint + 6) {
      v *= 0.82;
      height *= 0.6;
    }
    rgb[0] = v * 0.99;
    rgb[1] = v * 0.99;
    rgb[2] = v * 1.03;
    return height;
  });
  return finishPair(pair, 'plaza-concrete');
}

// ---------------------------------------------------------------------------
// 2. Site A Warm Sandstone / Travertine Ashlar Masonry (4m repeat)
// ---------------------------------------------------------------------------

function generateSandstoneAshlar(): PbrTextureSet {
  const S = 512;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0x5a4d57);
  const grain = fbm(S, S, 16, 16, 4, rand);
  const vein = fbm(S, S, 2, 8, 4, rand);
  const pitsField = noiseField(S, S, 96, 96, rand);
  const courseH = 64; // 0.5m courses
  const mortar = 5;
  const courses = S / courseH;

  // Per course: block break positions (wrapping exactly at S) + per-block tint.
  const breaks: number[][] = [];
  const tints: Array<Array<[number, number]>> = [];
  for (let c = 0; c < courses; c++) {
    const offset = Math.floor(rand() * S);
    const widths: number[] = [];
    let total = 0;
    while (S - total > 208) {
      const bw = 112 + Math.floor(rand() * 96);
      widths.push(bw);
      total += bw;
    }
    widths.push(S - total);
    const starts: number[] = [];
    let acc = offset;
    for (const bw of widths) {
      starts.push(acc % S);
      acc += bw;
    }
    breaks.push(starts);
    tints.push(widths.map(() => [0.9 + rand() * 0.18, (rand() - 0.5) * 0.08]));
  }

  paintPixels(pair, (x, y, i, rgb) => {
    const course = Math.floor(y / courseH);
    const cy = y % courseH;
    const starts = breaks[course];
    // Find block containing x and distance to its vertical joints (wrap-aware).
    let blockIdx = 0;
    let distJoint = S;
    for (let b = 0; b < starts.length; b++) {
      const d = Math.min(Math.abs(x - starts[b]), S - Math.abs(x - starts[b]));
      if (d < distJoint) distJoint = d;
      const rel = (x - starts[b] + S) % S;
      const nextRel = (starts[(b + 1) % starts.length] - starts[b] + S) % S || S;
      if (rel < nextRel) blockIdx = b;
    }
    const distCourse = Math.min(cy, courseH - 1 - cy);
    const edge = Math.min(distJoint, distCourse);
    const [tone, hueShift] = tints[course][blockIdx];

    if (edge < mortar * 0.5 + 0.5) {
      const m = 0.8 + (grain[i] - 0.5) * 0.12;
      rgb[0] = m * 1.02;
      rgb[1] = m * 0.95;
      rgb[2] = m * 0.82;
      return 0.14 + grain[i] * 0.08;
    }

    // Travertine: horizontal banding + pits.
    const band = Math.sin((y + vein[i] * 90) * 0.21) * 0.5 + 0.5;
    let v = tone * (0.92 + (grain[i] - 0.5) * 0.16 + band * 0.05);
    let height = 0.66 + (grain[i] - 0.5) * 0.2;
    const pit = pitsField[i] > 0.93;
    if (pit) {
      v *= 0.72;
      height = 0.32;
    }
    // Chiselled bevel toward joints.
    const bevel = edge - mortar * 0.5;
    if (bevel < 5) {
      height *= 0.55 + 0.45 * (bevel / 5);
      v *= 0.9 + 0.1 * (bevel / 5);
    }
    rgb[0] = v * (0.86 + hueShift);
    rgb[1] = v * 0.71;
    rgb[2] = v * (0.52 - hueShift * 0.5);
    return height;
  });
  return finishPair(pair, 'sandstone-ashlar');
}

// ---------------------------------------------------------------------------
// 3. Terracotta Trim (Site A banding, tile-mode)
// ---------------------------------------------------------------------------

function generateTerracottaTrim(): PbrTextureSet {
  const S = 256;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0x7e44a);
  const grain = fbm(S, S, 8, 8, 4, rand);
  const tileW = 64;

  paintPixels(pair, (x, y, i, rgb) => {
    const tx = x % tileW;
    const dEdgeX = Math.min(tx, tileW - 1 - tx);
    const dEdgeY = Math.min(y, S - 1 - y);
    const tileIdx = Math.floor(x / tileW);
    const tone = 0.92 + ((tileIdx * 37) % 5) * 0.03;
    let v = tone * (0.9 + (grain[i] - 0.5) * 0.22);
    let height = 0.62 + (grain[i] - 0.5) * 0.2;
    // Fluted groove along the middle of the trim course.
    const groove = Math.abs(y - S / 2);
    if (groove < 10) {
      const t = groove / 10;
      height = 0.3 + 0.3 * t;
      v *= 0.82 + 0.18 * t;
    }
    if (dEdgeX < 2 || dEdgeY < 6) {
      v *= 0.62;
      height = 0.15;
    }
    rgb[0] = v * 0.76;
    rgb[1] = v * 0.38;
    rgb[2] = v * 0.23;
    return height;
  });
  return finishPair(pair, 'terracotta-trim');
}

// ---------------------------------------------------------------------------
// 4. Site B Industrial Ribbed Cobalt-Steel Panels (4m repeat)
// ---------------------------------------------------------------------------

function generateCobaltSteel(): PbrTextureSet {
  const S = 512;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0xc0b417);
  const grime = fbm(S, S, 4, 4, 5, rand);
  const brushed = fbm(S, S, 2, 64, 3, rand);
  const panelW = 128; // 1m panels
  const ribPeriod = 32;
  const seam = 3;

  paintPixels(pair, (x, y, i, rgb) => {
    const px = x % panelW;
    const distSeamX = Math.min(px, panelW - 1 - px);
    const py = y % 256;
    const distSeamY = Math.min(py, 255 - py);
    const panelIdx = Math.floor(x / panelW) + Math.floor(y / 256) * 4;
    const panelTone = 0.94 + ((panelIdx * 53) % 7) * 0.018;

    // Trapezoidal corrugation rib profile.
    const phase = ((px % ribPeriod) / ribPeriod) * Math.PI * 2;
    const rib = clamp01(0.5 + Math.cos(phase) * 0.9);
    let height = 0.25 + rib * 0.6;
    let v = panelTone * (0.84 + rib * 0.16 + (brushed[i] - 0.5) * 0.08) * (0.85 + grime[i] * 0.2);

    if (distSeamX < seam || distSeamY < seam) {
      v *= 0.5;
      height = 0.05;
    } else {
      // Rivets every 32px along both seams.
      const rivetNearX = distSeamX < 10 && Math.abs((y % 32) - 16) < 3 && Math.abs(distSeamX - 7) < 3;
      const rivetNearY = distSeamY < 10 && Math.abs((x % 32) - 16) < 3 && Math.abs(distSeamY - 7) < 3;
      if (rivetNearX || rivetNearY) {
        v = 0.9;
        height = 1.0;
      }
    }
    rgb[0] = v * 0.27;
    rgb[1] = v * 0.4;
    rgb[2] = v * 0.58;
    return height;
  });
  return finishPair(pair, 'cobalt-steel');
}

// ---------------------------------------------------------------------------
// 5. Hazard-Striped Trim (Site B banding, tile-mode)
// ---------------------------------------------------------------------------

function generateHazardTrim(): PbrTextureSet {
  const S = 256;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0x4a2a4d);
  const wear = fbm(S, S, 8, 8, 4, rand);
  const period = 64;

  paintPixels(pair, (x, y, i, rgb) => {
    const stripe = ((x + y) % period) < period / 2;
    const worn = wear[i] > 0.68;
    let height = 0.6;
    if (worn) {
      const v = 0.45 + wear[i] * 0.2;
      rgb[0] = v;
      rgb[1] = v * 1.02;
      rgb[2] = v * 1.06;
      height = 0.45;
    } else if (stripe) {
      rgb[0] = 0.96;
      rgb[1] = 0.74;
      rgb[2] = 0.1;
    } else {
      rgb[0] = 0.08;
      rgb[1] = 0.085;
      rgb[2] = 0.095;
    }
    const dEdge = Math.min(y, S - 1 - y);
    if (dEdge < 12) {
      const v = 0.26;
      rgb[0] = v;
      rgb[1] = v * 1.05;
      rgb[2] = v * 1.12;
      height = dEdge < 4 ? 0.2 : 0.85;
    }
    return height;
  });
  return finishPair(pair, 'hazard-trim');
}

// ---------------------------------------------------------------------------
// 6. Radianite Crate (`B`) stenciled metal (one 2m crate face per repeat)
// ---------------------------------------------------------------------------

function generateRadianiteCrate(): PbrTextureSet {
  const S = 512;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0x7ad1a);
  const grime = fbm(S, S, 4, 4, 5, rand);
  const frame = 38;

  paintPixels(pair, (x, y, i, rgb) => {
    const dEdge = Math.min(x, y, S - 1 - x, S - 1 - y);
    let v: number;
    let height: number;
    let tint: [number, number, number];
    if (dEdge < frame) {
      // Raised steel frame with a bevelled inner lip.
      v = 0.8 + (grime[i] - 0.5) * 0.18;
      height = dEdge < 3 ? 0.55 : 0.92;
      if (frame - dEdge < 5) height = 0.6;
      tint = [0.3, 0.34, 0.4];
    } else {
      // Inner panel with vertical stiffening ribs and an X-brace.
      const rib = Math.abs(((x - frame) % 72) - 36) < 4;
      const d1 = Math.abs(x - y) / Math.SQRT2;
      const d2 = Math.abs(x + y - S) / Math.SQRT2;
      const brace = Math.min(d1, d2) < 12;
      v = 0.86 + (grime[i] - 0.5) * 0.22;
      height = 0.42;
      tint = [0.43, 0.48, 0.55];
      if (rib) {
        height = 0.56;
        v *= 1.06;
      }
      if (brace) {
        height = 0.8;
        tint = [0.34, 0.38, 0.44];
      }
    }
    // Corner bolts.
    const cx = x < S / 2 ? 19 : S - 20;
    const cy = y < S / 2 ? 19 : S - 20;
    if ((x - cx) ** 2 + (y - cy) ** 2 < 49) {
      v = 1.1;
      height = 1;
    }
    rgb[0] = v * tint[0];
    rgb[1] = v * tint[1];
    rgb[2] = v * tint[2];
    return height;
  });

  // Radianite hex glyph + stencil lettering (paint: barely recessed on bump).
  const ctx = pair.albedoCtx;
  ctx.save();
  ctx.translate(S / 2, S / 2 - 34);
  ctx.strokeStyle = '#ff4d6d';
  ctx.fillStyle = 'rgba(255, 77, 109, 0.22)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    const px = Math.cos(a) * 62;
    const py = Math.sin(a) * 62;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ff4d6d';
  ctx.beginPath();
  ctx.moveTo(0, -34);
  ctx.lineTo(22, 6);
  ctx.lineTo(0, 30);
  ctx.lineTo(-22, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  stencilText(pair, 'RADIANITE', S / 2, S / 2 + 68, 'bold 54px "Arial Black", Arial, sans-serif', '#f1f5f9', '#5a5a5a', 0.88);
  stencilText(pair, 'CR-07  //  HANDLE WITH CARE', S / 2, S / 2 + 114, 'bold 22px Arial, sans-serif', '#ffb4c1', '#606060', 0.8);
  return finishPair(pair, 'radianite-crate');
}

// ---------------------------------------------------------------------------
// 7. Olive Braced Cargo (`D`) stenciled timber + steel straps (one tier per repeat)
// ---------------------------------------------------------------------------

function generateOliveCargo(): PbrTextureSet {
  const S = 512;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0x011e);
  const woodGrain = fbm(S, S, 2, 24, 4, rand);
  const grime = fbm(S, S, 4, 4, 4, rand);
  const plankH = 128;
  const strap = 30;

  paintPixels(pair, (x, y, i, rgb) => {
    const py = y % plankH;
    const dPlank = Math.min(py, plankH - 1 - py);
    const plankIdx = Math.floor(y / plankH);
    const tone = 0.92 + ((plankIdx * 29) % 4) * 0.035;
    const dStrap = Math.min(x, S - 1 - x);
    if (dStrap < strap) {
      // Dark steel corner straps with bolts.
      let v = 0.75 + (grime[i] - 0.5) * 0.2;
      let height = 0.9;
      if (Math.abs(py - plankH / 2) < 7 && Math.abs(dStrap - strap / 2) < 7) {
        v = 1.1;
        height = 1;
      }
      rgb[0] = v * 0.25;
      rgb[1] = v * 0.27;
      rgb[2] = v * 0.24;
      return height;
    }
    const grainLines = Math.sin(woodGrain[i] * 60) * 0.5 + 0.5;
    let v = tone * (0.84 + grainLines * 0.12 + (grime[i] - 0.5) * 0.14);
    let height = 0.55 + grainLines * 0.15;
    if (dPlank < 4) {
      v *= 0.45;
      height = 0.08;
    }
    rgb[0] = v * 0.4;
    rgb[1] = v * 0.46;
    rgb[2] = v * 0.29;
    return height;
  });
  stencilText(pair, 'CARGO 07', S / 2, S / 2 - 6, 'bold 78px "Arial Black", Arial, sans-serif', '#e9dfa8', '#4e4e4e', 0.78);
  stencilText(pair, '\u25B2 \u25B2  THIS SIDE UP', S / 2, S / 2 + 64, 'bold 26px Arial, sans-serif', '#e9dfa8', '#545454', 0.7);
  return finishPair(pair, 'olive-cargo');
}

// ---------------------------------------------------------------------------
// 8. Steel Diamond Tread Plate (decks / stairs, 2m repeat)
// ---------------------------------------------------------------------------

function generateSteelGrate(): PbrTextureSet {
  const S = 256;
  const pair = createCanvasPair(S, S);
  if (!pair) return NULL_SET;
  const rand = mulberry32(0x96a7e);
  const grime = fbm(S, S, 4, 4, 4, rand);
  const cell = 32;

  paintPixels(pair, (x, y, i, rgb) => {
    const cx = (x % cell) - cell / 2;
    const cy = (y % cell) - cell / 2;
    const flip = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
    // Elongated diamond lugs alternating 90 degrees per cell.
    const u = flip ? cx * 0.7071 + cy * 0.7071 : cx * 0.7071 - cy * 0.7071;
    const w = flip ? -cx * 0.7071 + cy * 0.7071 : cx * 0.7071 + cy * 0.7071;
    const lug = Math.abs(u) / 11 + Math.abs(w) / 3.2 < 1;
    let v = 0.7 + (grime[i] - 0.5) * 0.25;
    let height = 0.3;
    if (lug) {
      v *= 1.18;
      height = 0.95;
    }
    rgb[0] = v * 0.42;
    rgb[1] = v * 0.45;
    rgb[2] = v * 0.5;
    return height;
  });
  return finishPair(pair, 'steel-grate');
}

// ---------------------------------------------------------------------------
// 9. Hex-Grid Translucent Buy-Phase Barrier
// ---------------------------------------------------------------------------

function generateHexBarrier(): BarrierTextureSet {
  const W = 256;
  const H = 256;
  const colorCanvas = createCanvas(W, H);
  const alphaCanvas = createCanvas(W, H);
  if (!colorCanvas || !alphaCanvas) return { map: null, alphaMap: null };

  // Pointy-top hexes: 4 columns across W, 4 rows (2 vertical periods) across H.
  // The y-axis is scaled so the lattice period divides H exactly (seamless tiling).
  const s = W / (4 * Math.sqrt(3));
  const hexW = Math.sqrt(3) * s;
  const yScale = H / (6 * s);

  const drawLattice = (ctx: CanvasRenderingContext2D, interior: string, edge: string, glow: string) => {
    ctx.fillStyle = interior;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.scale(1, yScale);
    ctx.lineJoin = 'round';
    for (let row = -1; row <= 5; row++) {
      for (let col = -1; col <= 5; col++) {
        const cx = col * hexW + (row % 2 !== 0 ? hexW / 2 : 0);
        const cy = row * 1.5 * s;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k - Math.PI / 2;
          const px = cx + Math.cos(a) * s * 0.94;
          const py = cy + Math.sin(a) * s * 0.94;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.shadowColor = glow;
        ctx.shadowBlur = 10;
        ctx.strokeStyle = edge;
        ctx.lineWidth = 3.2;
        ctx.stroke();
      }
    }
    ctx.restore();
    // Horizontal energy scanlines.
    ctx.fillStyle = edge;
    for (let y = 0; y < H; y += 16) {
      ctx.globalAlpha = 0.12;
      ctx.fillRect(0, y, W, 2);
    }
    ctx.globalAlpha = 1;
  };

  drawLattice(colorCanvas.ctx, '#28364a', '#ffffff', '#ffffff');
  drawLattice(alphaCanvas.ctx, '#ffffff', '#ffffff', '#ffffff');

  const map = finishTexture(colorCanvas.canvas, true);
  const alphaMap = finishTexture(alphaCanvas.canvas, false);
  map.anisotropy = ANISOTROPY;
  alphaMap.anisotropy = ANISOTROPY;
  map.name = 'buy-barrier-hex-color';
  alphaMap.name = 'buy-barrier-hex-alpha';
  return { map, alphaMap };
}

// ---------------------------------------------------------------------------
// Public Cached API
// ---------------------------------------------------------------------------

const GENERATORS: Record<ArenaTextureId, () => PbrTextureSet> = {
  plaza_concrete: generatePlazaConcrete,
  sandstone_ashlar: generateSandstoneAshlar,
  terracotta_trim: generateTerracottaTrim,
  cobalt_steel: generateCobaltSteel,
  hazard_trim: generateHazardTrim,
  radianite_crate: generateRadianiteCrate,
  olive_cargo: generateOliveCargo,
  steel_grate: generateSteelGrate,
};

/**
 * Returns the cached `{ map, bumpMap }` pair for `id`, generating it on first
 * use. Returns `{ map: null, bumpMap: null }` when no DOM canvas is available.
 */
export function getArenaTexture(id: ArenaTextureId): PbrTextureSet {
  const cached = textureCache.get(id);
  if (cached) return cached;
  if (typeof document === 'undefined') return NULL_SET;
  let set: PbrTextureSet;
  try {
    set = GENERATORS[id]();
  } catch {
    set = NULL_SET;
  }
  textureCache.set(id, set);
  return set;
}

/** Returns the cached hex-grid buy-barrier `{ map, alphaMap }` pair (null maps headless). */
export function getBuyBarrierTexture(): BarrierTextureSet {
  if (barrierCache) return barrierCache;
  if (typeof document === 'undefined') return { map: null, alphaMap: null };
  try {
    barrierCache = generateHexBarrier();
  } catch {
    barrierCache = { map: null, alphaMap: null };
  }
  return barrierCache;
}

/**
 * Frees every cached texture's GPU memory and clears the cache (textures are
 * regenerated lazily on next use). `map.ts` calls `dispose()` on textures it
 * finds on arena materials during teardown; Three.js transparently re-uploads
 * a disposed `CanvasTexture` the next time a material samples it, so cached
 * sets stay valid across `rebuildArenaScene` calls.
 */
export function disposeArenaTextures(): void {
  for (const set of textureCache.values()) {
    set.map?.dispose();
    set.bumpMap?.dispose();
  }
  textureCache.clear();
  if (barrierCache) {
    barrierCache.map?.dispose();
    barrierCache.alphaMap?.dispose();
    barrierCache = null;
  }
}
