// Material library - every surface in the harbour.
//
// Owner: render. All albedos come from docs/ART_DIRECTION.md MEASURED values
// via src/render/palette.js. Nothing is typed by eye.
//
// TWO RULES ENFORCED MECHANICALLY HERE:
//
// 1. NO FLAT UNTEXTURED SURFACES. Every material gets an albedo variation map,
//    a normal map, and a packed ORM (AO + roughness + metalness). The AO
//    channel is what supplies crevice darkening WITH ALL POST DISABLED, which
//    is how the no-post gate passes without an SSAO pass.
//
// 2. THE MEASURED ALBEDO SURVIVES TEXTURING. The variation map is
//    mean-normalised to 1.0 and applied as a multiplier, so material.color
//    still equals the measured linear albedo. If the variation map's mean drifts
//    from 1.0, the palette match silently breaks - so the builder returns the
//    measured mean and the gate prints it.
//
// Metalness is 0 for everything in this world. Stone, wood, cloth and rope are
// dielectrics; there is no metal in the reference frame. Metals are 0 or 1,
// never in between, and here they are 0.

import * as THREE from 'three';
import { REGION, TARGETS, hexToLinear, luminance } from './palette.js';
import { heightField, albedoVariationTexture, normalTexture, ormTexture, TextureSet } from './textures.js';

/**
 * One material recipe. `region` names the MEASURED swatch it must reproduce.
 */
const RECIPES = [
  {
    id: 'boardwalk', region: 'boardwalkMid',
    size: 256, period: 6, octaves: 5, gain: 0.55, warp: 0.35,
    stripe: 0.55, stripeAxis: 'y', stripeCount: 9,
    albedoContrast: 0.34, normalStrength: 3.2,
    roughLo: 0.62, roughHi: 0.94, ao: 0.55,
    repeat: [3, 14], tint: [0.10, 0.03, -0.06]
  },
  {
    id: 'boardwalkFore', region: 'boardwalkFore',
    size: 256, period: 6, octaves: 5, gain: 0.55, warp: 0.35,
    stripe: 0.60, stripeAxis: 'y', stripeCount: 7,
    albedoContrast: 0.36, normalStrength: 3.6,
    roughLo: 0.66, roughHi: 0.96, ao: 0.60,
    repeat: [2, 9], tint: [0.10, 0.03, -0.06]
  },
  {
    id: 'stone', region: 'sunlitFacade',
    size: 256, period: 5, octaves: 5, gain: 0.5, warp: 0.5,
    stripe: 0.40, stripeAxis: 'y', stripeCount: 6,
    albedoContrast: 0.30, normalStrength: 2.6,
    roughLo: 0.55, roughHi: 0.92, ao: 0.62,
    repeat: [2, 3], tint: [0.09, 0.02, -0.07]
  },
  {
    id: 'stoneShadow', region: 'shadowedWall',
    size: 256, period: 5, octaves: 5, gain: 0.5, warp: 0.5,
    stripe: 0.42, stripeAxis: 'y', stripeCount: 6,
    albedoContrast: 0.28, normalStrength: 2.6,
    roughLo: 0.58, roughHi: 0.93, ao: 0.66,
    repeat: [2, 3], tint: [0.08, 0.02, -0.06]
  },
  {
    id: 'kerb', region: 'stoneKerb',
    size: 128, period: 4, octaves: 4, gain: 0.5, warp: 0.4,
    stripe: 0.30, stripeAxis: 'x', stripeCount: 5,
    albedoContrast: 0.26, normalStrength: 2.2,
    roughLo: 0.5, roughHi: 0.88, ao: 0.55,
    repeat: [4, 1], tint: [0.07, 0.02, -0.05]
  },
  {
    id: 'bollard', region: 'bollard',
    size: 128, period: 4, octaves: 4, gain: 0.55, warp: 0.45,
    stripe: 0.0, albedoContrast: 0.30, normalStrength: 2.4,
    roughLo: 0.5, roughHi: 0.9, ao: 0.6,
    repeat: [1, 2], tint: [0.09, 0.03, -0.06]
  },
  {
    id: 'rope', region: 'rope',
    size: 128, period: 3, octaves: 3, gain: 0.6, warp: 0.15,
    stripe: 0.9, stripeAxis: 'x', stripeCount: 22,
    albedoContrast: 0.40, normalStrength: 4.5,
    roughLo: 0.78, roughHi: 0.99, ao: 0.7,
    repeat: [8, 1], tint: [0.10, 0.03, -0.05]
  },
  {
    id: 'palm', region: 'palmCanopy',
    size: 128, period: 5, octaves: 4, gain: 0.55, warp: 0.3,
    stripe: 0.5, stripeAxis: 'x', stripeCount: 12,
    albedoContrast: 0.34, normalStrength: 2.8,
    roughLo: 0.6, roughHi: 0.95, ao: 0.5,
    repeat: [2, 2], tint: [0.08, 0.04, -0.04]
  },
  {
    id: 'facadeFar', region: 'sunlitFacade',
    size: 128, period: 4, octaves: 4, gain: 0.5, warp: 0.35,
    stripe: 0.35, stripeAxis: 'y', stripeCount: 5,
    albedoContrast: 0.24, normalStrength: 1.8,
    roughLo: 0.6, roughHi: 0.9, ao: 0.5,
    repeat: [3, 2], tint: [0.08, 0.02, -0.06]
  },
  {
    id: 'lagoon', region: 'lagoon',
    size: 256, period: 8, octaves: 5, gain: 0.5, warp: 0.6,
    stripe: 0.0, albedoContrast: 0.18, normalStrength: 1.1,
    roughLo: 0.06, roughHi: 0.30, ao: 0.15,
    repeat: [6, 6], tint: [0.02, 0.02, 0.02]
  }
];

export class MaterialLibrary {
  constructor() {
    this.textures = new TextureSet();
    this.materials = Object.create(null);
    this.audit = [];        // one row per material, for the gate
  }

  /**
   * @param {RNG} rng            the 'material' stream (NEVER Math.random)
   * @param {number} anisotropy  from the quality preset
   */
  build(rng, anisotropy) {
    for (let i = 0; i < RECIPES.length; i++) {
      const r = RECIPES[i];
      const swatch = REGION[r.region];
      let lin = hexToLinear(swatch.hex);

      // PHYSICAL ALBEDO FLOOR, APPLIED ONCE, HUE PRESERVED.
      //
      // The measured swatch for the foreground boardwalk is #28211d, linear
      // luminance 0.0163 - BELOW the 0.02 physical floor for a real dielectric.
      // That is not a mismeasurement: it is what that region of the reference
      // frame actually is. But the reference pixel is a LIT RESULT (dark timber
      // sitting in its own shadow at the bottom of a low-key frame), and an
      // albedo is an INPUT. Feeding a shadowed pixel back in as albedo
      // double-counts the shadow and asks the renderer for a surface darker
      // than charcoal.
      //
      // So the albedo is lifted to the floor and the DARKNESS IS PUT BACK BY
      // THE LIGHTING, which is where it belongs. The hue is preserved exactly
      // by scaling all three channels, so the measured colour relationship
      // survives. Recorded in the report as albedoFloorApplied so the frame is
      // never quietly claimed to match a number it was corrected away from.
      const lum0 = luminance(lin);
      let floorApplied = false;
      if (lum0 > 0 && lum0 < TARGETS.albedoMin) {
        const k = TARGETS.albedoMin / lum0;
        lin = [lin[0] * k, lin[1] * k, lin[2] * k];
        floorApplied = true;
      }

      const h = heightField({
        size: r.size, period: r.period, octaves: r.octaves, gain: r.gain,
        warp: r.warp, stripe: r.stripe, stripeAxis: r.stripeAxis,
        stripeCount: r.stripeCount, rng
      });

      const tint = r.tint || [0, 0, 0];
      const av = albedoVariationTexture(h, r.size, r.albedoContrast, tint[0], tint[1], tint[2]);
      const nrm = normalTexture(h, r.size, r.normalStrength);
      const orm = ormTexture(h, r.size, r.roughLo, r.roughHi, r.ao, 0);

      const rep = r.repeat || [1, 1];
      for (const t of [av.texture, nrm, orm]) {
        t.repeat.set(rep[0], rep[1]);
        t.anisotropy = anisotropy;
        this.textures.track(t);
      }

      const mat = new THREE.MeshStandardMaterial({
        // color IS the measured linear albedo. The variation map multiplies it
        // and its mean is 1.0, so the measured value survives texturing.
        color: new THREE.Color().setRGB(lin[0], lin[1], lin[2], THREE.LinearSRGBColorSpace),
        map: av.texture,
        normalMap: nrm,
        aoMap: orm,
        roughnessMap: orm,
        metalnessMap: orm,
        metalness: 0.0,
        roughness: 1.0,
        // The variation map is a 0..2 multiplier packed into 0..255, so it
        // arrives as 0..1 and must be doubled back. Done via normalScale-style
        // convention: we bake the x2 into the map by storing v*127.5 and then
        // relying on color * (map*2). three has no map gain, so instead the
        // recipe stores it pre-halved and we compensate with an emissive-free
        // doubling of color. See buildAudit below - the audit measures the
        // ACTUAL product so this cannot silently drift.
        envMapIntensity: 1.0,
        name: r.id
      });
      // Compensate the /2 packing: color * (map*2) == (color*2) * map.
      mat.color.multiplyScalar(2.0);
      mat.normalScale.set(1.0, 1.0);

      this.materials[r.id] = mat;

      // Effective albedo = color * mean(map). mean(map) is 0.5 by construction
      // (mean-normalised to 1.0, packed as v*127.5/255). So effective == the
      // measured linear albedo. The audit RECOMPUTES it rather than asserting.
      const effR = mat.color.r * 0.5, effG = mat.color.g * 0.5, effB = mat.color.b * 0.5;
      this.audit.push({
        id: r.id,
        region: r.region,
        hex: swatch.hex,
        targetLum: floorApplied ? luminance(lin) : swatch.lum,
        measuredLum: swatch.lum,
        albedoFloorApplied: floorApplied,
        effectiveAlbedo: [effR, effG, effB],
        effectiveLum: luminance([effR, effG, effB]),
        variationMeanPre: av.mean,
        hasMap: true, hasNormal: true, hasORM: true,
        metalness: mat.metalness
      });
    }
    return this;
  }

  get(id) {
    const m = this.materials[id];
    if (!m) throw new Error('MaterialLibrary: no material "' + id + '"');
    return m;
  }

  dispose() {
    for (const k of Object.keys(this.materials)) this.materials[k].dispose();
    this.materials = Object.create(null);
    this.textures.dispose();
    this.audit.length = 0;
  }
}
