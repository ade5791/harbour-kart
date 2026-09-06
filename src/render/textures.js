// Procedural texture generation - seeded, allocation-free at runtime.
//
// Owner: render. ARCHITECTURE.md section 4.
//
// WHY DataTexture AND NOT A CANVAS:
//   A 2D canvas is a DOM dependency and its rasterisation is not guaranteed
//   bit-identical across machines, which would break the pixel gate. Typed
//   arrays filled by our own seeded noise are bit-identical everywhere and run
//   unchanged under node for offline probes.
//
// WHY EVERY MATERIAL GETS ONE:
//   The visual bar forbids flat untextured surfaces. Every surface carries
//   albedo variation, a normal map, roughness variation, and a high-frequency
//   detail octave that is still readable at half a metre.
//
// NO Math.random(). All variation comes from the 'material' RNG stream.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Seeded value noise. A permutation table is built once from an RNG stream, so
// the same seed produces the same texture byte-for-byte on every machine.
// ---------------------------------------------------------------------------

const PERM_SIZE = 256;
const PERM_MASK = 255;

export function buildPermutation(rng) {
  const p = new Uint8Array(PERM_SIZE * 2);
  for (let i = 0; i < PERM_SIZE; i++) p[i] = i;
  // Fisher-Yates driven by the seeded stream (never Math.random).
  for (let i = PERM_SIZE - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < PERM_SIZE; i++) p[PERM_SIZE + i] = p[i];
  return p;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

// Tileable value noise on an integer lattice of period `period`.
// Tileability matters: a texture that does not wrap shows a seam, and a seam is
// a "perfectly repeated" artefact the visual bar forbids.
function vnoise(perm, x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;

  const h = (a, b) => perm[(perm[a & PERM_MASK] + b) & PERM_MASK] / 255;
  const v00 = h(x0, y0), v10 = h(x1, y0), v01 = h(x0, y1), v11 = h(x1, y1);

  const u = fade(xf), v = fade(yf);
  const a = v00 + u * (v10 - v00);
  const b = v01 + u * (v11 - v01);
  return a + v * (b - a);
}

// Fractal Brownian motion. `octaves` is the detail-layer count: the last octave
// is what stays readable at half a metre.
export function fbm(perm, x, y, basePeriod, octaves, gain) {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(perm, x * freq, y * freq, basePeriod * freq);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Height field -> the three maps every material needs.
//
// One height field feeds all three so the maps AGREE: a crevice in the normal
// map is also darker in albedo and dirtier in roughness, which is what makes a
// surface read as one material rather than three unrelated layers.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   size        texel resolution (square)
 *   period      lattice period in texels/period units (tileable)
 *   octaves     detail octaves
 *   gain        amplitude falloff per octave
 *   warp        domain-warp strength - kills the grid look of raw value noise
 *   stripe      0 = none; >0 adds directional plank/masonry banding
 *   stripeAxis  'x' | 'y'
 *   stripeCount bands across the tile
 *   rng         seeded stream (required)
 */
export function heightField(opts) {
  const size = opts.size;
  const perm = buildPermutation(opts.rng);
  const warpPerm = buildPermutation(opts.rng);
  const h = new Float32Array(size * size);

  const period = opts.period;
  const octaves = opts.octaves;
  const gain = opts.gain;
  const warp = opts.warp || 0;
  const stripe = opts.stripe || 0;
  const stripeCount = opts.stripeCount || 8;
  const stripeAxis = opts.stripeAxis || 'y';

  // Per-band jitter so no two planks / courses of masonry are identical. This
  // is the "nothing perfectly repeated" rule made mechanical.
  const bandOffset = new Float32Array(stripeCount);
  const bandValue = new Float32Array(stripeCount);
  for (let i = 0; i < stripeCount; i++) {
    bandOffset[i] = opts.rng.range(-0.5, 0.5);
    bandValue[i] = opts.rng.range(-1, 1);
  }

  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * period;
      const v = (y / size) * period;

      let wu = u, wv = v;
      if (warp > 0) {
        wu = u + warp * (fbm(warpPerm, u, v, period, 2, 0.5) - 0.5);
        wv = v + warp * (fbm(warpPerm, u + 5.2, v + 1.3, period, 2, 0.5) - 0.5);
      }

      let val = fbm(perm, wu, wv, period, octaves, gain);

      if (stripe > 0) {
        const t = (stripeAxis === 'x' ? x : y) / size;
        const bandF = t * stripeCount;
        const band = Math.floor(bandF) % stripeCount;
        const frac = bandF - Math.floor(bandF);
        // Groove between bands: a dark, narrow, slightly wandering seam.
        const centre = 0.5 + bandOffset[band] * 0.06;
        const d = Math.abs(frac - centre) * 2;
        const groove = Math.max(0, 1 - d / 0.92);
        val += stripe * (bandValue[band] * 0.35 - groove * groove * 1.0);
      }

      h[y * size + x] = val;
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    }
  }

  // Normalise to 0..1 so downstream contrast constants mean the same thing for
  // every material regardless of its noise settings.
  const inv = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) * inv;
  return h;
}

/**
 * Albedo variation map, MEAN-NORMALISED TO 1.0.
 *
 * This is the load-bearing detail. The material's base colour carries the
 * MEASURED linear albedo from docs/ART_DIRECTION.md; this texture only
 * multiplies it. If the texture's mean were not 1.0 it would silently shift
 * every measured albedo and the palette match would be a lie. The function
 * measures its own mean and divides it out.
 *
 * Returns { texture, mean } - mean is the PRE-normalisation mean, reported by
 * the gate so the correction is visible rather than assumed.
 */
export function albedoVariationTexture(height, size, contrast, tintR, tintG, tintB) {
  const n = size * size;
  const f = new Float32Array(n * 3);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const hv = height[i];
    const v = 1 + (hv - 0.5) * 2 * contrast;
    sum += v;
    // Crevices go warmer and darker (grime), peaks go slightly cooler and
    // lighter (sun bleaching). Reference shadows are WARM, not blue.
    const warm = (0.5 - hv) * 2;
    f[i * 3 + 0] = v * (1 + warm * tintR);
    f[i * 3 + 1] = v * (1 + warm * tintG);
    f[i * 3 + 2] = v * (1 + warm * tintB);
  }
  const mean = sum / n;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = f[i * 3 + c] / mean;
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 127.5)));
    }
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  // Multiply-style variation map: stored linear (it is a multiplier, not a
  // colour), so NoColorSpace, and scaled by 2 in the material via .color.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return { texture: tex, mean };
}

/** Tangent-space normal map from the height field. */
export function normalTexture(height, size, strength) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size, xr = (x + 1) % size;
      const yd = (y - 1 + size) % size, yu = (y + 1) % size;
      const dx = (height[y * size + xr] - height[y * size + xl]) * strength;
      const dy = (height[yu * size + x] - height[yd * size + x]) * strength;
      // n = normalize(-dx, -dy, 1)
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Packed ORM: R = ambient occlusion, G = roughness, B = metalness.
 * MeshStandardMaterial reads aoMap.r, roughnessMap.g, metalnessMap.b, so one
 * texture and one sampler serve all three. Fewer samplers is fewer program
 * permutations, which is the point of doing it this way.
 *
 * AO is derived from the height field's cavity term. That AO is what supplies
 * the crevice darkening WITH ALL POST DISABLED - it is why the no-post gate
 * can pass without an SSAO pass.
 */
export function ormTexture(height, size, roughLo, roughHi, aoStrength, metal) {
  const data = new Uint8Array(size * size * 4);
  const m = Math.round(metal * 255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const hv = height[i];

      // Cavity AO: compare the texel to a 5-tap neighbourhood mean. Below the
      // local mean means recessed, which means occluded.
      const xl = (x - 1 + size) % size, xr = (x + 1) % size;
      const yd = (y - 1 + size) % size, yu = (y + 1) % size;
      const local = (height[y * size + xl] + height[y * size + xr] +
                     height[yd * size + x] + height[yu * size + x]) * 0.25;
      const cav = Math.max(0, local - hv);
      const ao = Math.max(0, Math.min(1, 1 - cav * aoStrength * 8));

      // Recessed, grimy texels are rougher; exposed, worn peaks are smoother.
      const rough = roughLo + (roughHi - roughLo) * (1 - hv);

      const o = i * 4;
      data[o + 0] = Math.round(ao * 255);
      data[o + 1] = Math.round(Math.max(0, Math.min(1, rough)) * 255);
      data[o + 2] = m;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Everything this module allocates is tracked so dispose() can be exact. */
export class TextureSet {
  constructor() { this.all = []; }
  track(t) { this.all.push(t); return t; }
  dispose() {
    for (let i = 0; i < this.all.length; i++) this.all[i].dispose();
    this.all.length = 0;
  }
}
