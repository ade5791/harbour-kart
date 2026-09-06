// Measured palette + lighting targets.
//
// Owner: render. Source: docs/ART_DIRECTION.md, which was measured off the
// user's reference frame by tools/refmeasure.py / refregions.py / refsky.py.
//
// EVERY albedo here is stored as the sRGB hex that was MEASURED, and converted
// to linear IN CODE. Pasting a linear triple by hand is how a palette silently
// drifts: the hex is the evidence, the linear value is a derivation.
//
// Rec.709 luminance is likewise computed, not typed, so a mistyped hex shows up
// as a luminance mismatch in the gate instead of passing quietly.

// sRGB 0..255 -> linear 0..1 (IEC 61966-2-1, the same transfer function three
// uses for SRGBColorSpace textures).
export function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex) {
  const h = hex.replace('#', '');
  return [
    srgbToLinear(parseInt(h.slice(0, 2), 16)),
    srgbToLinear(parseInt(h.slice(2, 4), 16)),
    srgbToLinear(parseInt(h.slice(4, 6), 16))
  ];
}

export function luminance(lin) {
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function swatch(hex, note) {
  const lin = hexToLinear(hex);
  return { hex, lin, lum: luminance(lin), note };
}

// ---- measured k-means palette (K=7, 24k samples, seeded) ------------------
// Kept for the albedo-band gate: every authored material must sit inside the
// physically plausible 0.02-0.9 band, and these are the reference anchors.
export const PALETTE = Object.freeze({
  darkWood:   swatch('#33281e', 'share 0.2307, ref lum 0.0232'),
  deepShadow: swatch('#1f1b16', 'share 0.2075, ref lum 0.0113'),
  midPlank:   swatch('#433b2d', 'share 0.1913, ref lum 0.0451'),
  hazeSea:    swatch('#4f5c50', 'share 0.1232, ref lum 0.0990'),
  sunStone:   swatch('#938166', 'share 0.0963, ref lum 0.2286'),
  occlusion:  swatch('#0c0b08', 'share 0.0936, ref lum 0.0034'),
  sunHilite:  swatch('#c2b8a5', 'share 0.0572, ref lum 0.4847')
});

// ---- measured region albedos (the actual material targets) ----------------
export const REGION = Object.freeze({
  skyUpper:      swatch('#959080', 'ref lum 0.2777'),
  skyHorizon:    swatch('#71776d', 'ref lum 0.1784'),
  lagoon:        swatch('#455e55', 'ref lum 0.0990'),
  sunlitFacade:  swatch('#6e6252', 'ref lum 0.1257 - KEY side of the key/fill ratio'),
  shadowedWall:  swatch('#36382e', 'ref lum 0.0378 - FILL side of the key/fill ratio'),
  palmCanopy:    swatch('#6b5e44', 'ref lum 0.1161'),
  boardwalkMid:  swatch('#39291f', 'ref lum 0.0258'),
  boardwalkFore: swatch('#28211d', 'ref lum 0.0164'),
  stoneKerb:     swatch('#42635b', 'ref lum 0.1088'),
  bollard:       swatch('#314a41', 'ref lum 0.0588'),
  rope:          swatch('#372c24', 'ref lum 0.0276')
});

// ---- measured lighting targets --------------------------------------------
//
// These are the numbers S2 is gated against. They are TARGETS FOR RENDERED
// PIXELS, not for authored constants: the point is that the lit result matches
// the reference, and an authored albedo is only an input to that.
export const TARGETS = Object.freeze({
  // Key/fill = sunlit facade luminance / shadowed wall luminance.
  keyFillRatio: REGION.sunlitFacade.lum / REGION.shadowedWall.lum,   // 3.327
  keyFillTolerance: 0.20,          // +/-20% band around 3.327 -> 2.66 .. 3.99

  // Sky vertical falloff, measured by refsky.py on a HUD-free column x 250-430:
  // top band (rows 4-20) median lum 0.2284 over mid band (rows 60-80) 0.0520.
  skyTopLum: 0.2284,
  skyMidLum: 0.0520,
  skyFalloff: 0.2284 / 0.0520,     // 4.392
  skyFalloffTolerance: 0.25,       // 3.29 .. 5.49; a real gradient, not flat

  // Whole-frame luminance distribution of the reference.
  lumP05: 0.0040,
  lumP25: 0.0143,
  lumP50: 0.0296,
  lumP75: 0.0841,
  lumP95: 0.3650,

  // Shadows are WARM: measured shadow mean RGB 22.9/19.9/16.1 (red leads blue
  // by 6.8 of 255). Highlight mean 178.3/165.5/142.8.
  shadowMeanRGB: [22.9, 19.9, 16.1],
  shadowRedOverBlue: 22.9 - 16.1,  // 6.8, in 0..255 sRGB points
  highlightMeanRGB: [178.3, 165.5, 142.8],

  // Silhouette readability. The REFERENCE measures 1.168 and that is explicitly
  // NOT the target - in the reference the track is the subject; here the
  // obstacle is what kills you.
  referenceObstacleContrast: 1.168,
  hazardContrastMin: 2.5,

  // Physically plausible albedo band.
  albedoMin: 0.02,
  albedoMax: 0.9
});

// ---- the sun ---------------------------------------------------------------
// Low golden sun. Elevation is low because the reference is a late-golden-hour
// frame; azimuth places it down the harbour axis so the camera looks INTO the
// sun-side haze, which is what produces the aerial-perspective value break the
// hazard read depends on.
export const SUN = Object.freeze({
  elevationDeg: 7.5,
  azimuthDeg: 8.0,                 // small offset from dead-ahead: full backlight
                                   // would flatten the key face to nothing
  // Warm key. Not saturated orange - the reference highlight mean 178/165/143
  // is only mildly warm; the warmth lives in the SHADOWS, not the key.
  keyColorHex: '#ffd9a8',
  fillColorHex: '#8c8f7a',         // sky/sea bounce, warm-neutral, never blue
  rimColorHex: '#ffeacc',          // sun-side haze wrap, the silhouette breaker
  hazeColorHex: '#8f9484'          // aerial perspective / fog colour
});
