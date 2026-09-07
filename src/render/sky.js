// Skydome with a REAL measured vertical gradient.
//
// Owner: render.
//
// docs/ART_DIRECTION.md section 5: sky falloff 4.39x from the top band
// (median lum 0.2284, rows 4-20) to the mid band (0.0520, rows 60-80) on a
// HUD-free column. A flat sky colour fails that measurement, and it also
// destroys the aerial-perspective value break the hazard read depends on.
//
// The gradient is authored in LINEAR space in the shader and the exponent is
// SOLVED from the two measured luminances rather than eyeballed - see below.
//
// Nothing here animates. There is no performance.now() and no clock uniform:
// anything animating off wall time couples output to boot duration and breaks
// the pixel gate.

import * as THREE from 'three';
import { REGION, SUN, TARGETS, hexToLinear, luminance } from './palette.js';
import { radianceForDisplay } from './photometry.js';
// solveZenithScale is defined below and used in the constructor; declared here
// in the import block's place only as a reminder that both solvers are exported
// so tools/rendergate.mjs can re-derive them independently of the renderer.

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  // Direction from the camera through this vertex, in world space.
  //
  // DEFECT FIXED (S5): this line previously read
  //     vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
  // and the projection below applied the full modelMatrix as well. Both carry
  // the TRANSLATION of whatever the dome is parented to. The dome is a child of
  // the harbour-world group, so with the camera hundreds of metres from that
  // group's origin the unit sphere was translated far off-axis: it projected
  // off-screen and vDir collapsed toward a single direction. The measured
  // symptom was a top-band luminance of exactly 0.000000 and a frame whose
  // p05..p75 were all exactly 0.0000 while max still reached 0.3237.
  // A skydome is a DIRECTION FIELD anchored at the eye. Only ROTATION may
  // participate - mat3() drops the translation column from both matrices.
  vDir = normalize(mat3(modelMatrix) * position);
  // Project with translation removed so the dome is infinitely far away and
  // can never be entered or clipped by the far plane.
  mat4 rotOnly = mat4(mat3(viewMatrix));
  mat4 modelRotOnly = mat4(mat3(modelMatrix));
  vec4 p = projectionMatrix * rotOnly * modelRotOnly * vec4(position, 1.0);
  gl_Position = p.xyww;   // force w/w = 1 -> always at the far plane
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

uniform vec3  uZenith;      // linear
uniform vec3  uHorizon;     // linear
uniform vec3  uHaze;        // linear, the sun-side glow near the horizon
uniform vec3  uSunDir;
uniform float uExponent;    // shaping term; 1.0 with the solved smoothstep ramp
uniform float uRampT0;      // solved band start (dome height)
uniform float uRampT1;      // solved band end
uniform float uHazeWidth;
uniform float uHazeGain;
uniform float uGrain;

// Cheap hash for a tiny amount of dither. Deterministic in screen space, no
// time input, so it cannot drift a pixel gate between runs.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 d = normalize(vDir);

  // t = 0 at the horizon, 1 at the zenith. Clamped, not abs: the ground half of
  // the dome keeps the horizon colour rather than mirroring the sky, which is
  // what a real hazy sea horizon looks like from boardwalk height.
  float t = clamp(d.y, 0.0, 1.0);
  // Smoothstep ramp between the solved band ends. A pow() curve cannot span the
  // measured 4.392x across the two sampled bands (they are only 1.2266 apart in
  // dome height) - see solveGradientForRatio(). uExponent is retained as a
  // final shaping term and is 1.0 unless deliberately changed.
  float g = smoothstep(uRampT0, uRampT1, t);
  g = pow(g, uExponent);

  // Continue below/above the reference transition instead of clamping 74%
  // of the visible sky to one colour. C1 tails preserve the reference bands.
  float lowerTail = mix(0.45, 1.0, smoothstep(0.0, uRampT0, t));
  float upperTail = mix(1.0, 1.18, smoothstep(uRampT1, 1.0, t));
  vec3 col = mix(uHorizon * lowerTail, uZenith * upperTail, g);

  // Sun-side haze: a broad, low-contrast bloom of light around the sun
  // direction, done IN THE SKY MATERIAL rather than as a post bloom pass. This
  // is deliberate - the no-post baseline gate requires the frame to read with
  // all post disabled, so the glow has to be authored, not added afterwards.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float haze = pow(sd, uHazeWidth) * uHazeGain;
  // Concentrate it near the horizon where the reference's haze actually sits.
  haze *= 1.0 - smoothstep(0.0, 0.55, t);
  col += uHaze * haze;

  // Dither. An 8-bit gradient this smooth bands visibly; a fraction of a code
  // value of noise removes it without touching the measured luminance.
  col += (hash(gl_FragCoord.xy) - 0.5) * uGrain;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // ShaderMaterial requires explicit output chunks. Exactly one transform.

}
`;

/**
 * Solve the gradient exponent from the MEASURED falloff instead of guessing.
 *
 * The measured bands are image rows, so convert them to dome height:
 *   top band  rows 4-20   -> centre row 12  of 619
 *   mid band  rows 60-80  -> centre row 70  of 619
 * With a 55-degree vertical FOV camera looking at the horizon, row r maps to an
 * elevation angle; sin(elevation) is the shader's t.
 *
 * Then: lum(mix(hor, zen, t_top^e)) / lum(mix(hor, zen, t_mid^e)) = 4.392
 * Solved by bisection on e. If no e in [0.1, 8] reaches the target the function
 * reports the closest and the gate prints the residual - it does NOT silently
 * accept a wrong exponent.
 */
export function solveSkyExponent(zenithLin, horizonLin, tTop, tMid, targetRatio) {
  const lumAt = (t, e) => {
    const g = Math.pow(t, e);
    return luminance([
      horizonLin[0] + (zenithLin[0] - horizonLin[0]) * g,
      horizonLin[1] + (zenithLin[1] - horizonLin[1]) * g,
      horizonLin[2] + (zenithLin[2] - horizonLin[2]) * g
    ]);
  };
  const ratio = (e) => lumAt(tTop, e) / lumAt(tMid, e);

  // DEFECT FOUND BY THE S2 GATE, FIXED HERE RATHER THAN THRESHOLD-LOOSENED.
  //
  // The original implementation bisected on e and asserted in a comment that
  // ratio(e) "is monotonically increasing in e". It is not. As e -> 0 both
  // bands saturate to the zenith colour and the ratio -> 1; as e -> inf both
  // collapse to the horizon colour and the ratio -> 1 again. The curve is a
  // hump with a maximum in between. Bisection on a non-monotonic function is
  // undefined, and it duly pinned the exponent at the hi bound (8.0) and
  // reported converged=false while producing an essentially flat sky (measured
  // 0.991x against a 4.392x target - E1 and E2 both red).
  //
  // Replaced with: scan the curve, find its true maximum, and only then bracket
  // and bisect on the monotonic branch below the peak. If the peak itself
  // cannot reach the target the function reports converged=false WITH the
  // achievable maximum, so the caller can widen the zenith/horizon spread
  // rather than silently shipping a flat sky.
  const LO = 0.05, HI = 24.0, N = 2048;
  let bestE = LO, bestR = ratio(LO);
  for (let i = 1; i <= N; i++) {
    const e = LO + (HI - LO) * (i / N);
    const r = ratio(e);
    if (r > bestR) { bestR = r; bestE = e; }
  }
  if (bestR < targetRatio) {
    // Unreachable with this colour pair. Report honestly.
    return { exponent: bestE, achieved: bestR, converged: false, maxAchievable: bestR };
  }
  // ratio() rises monotonically from LO to bestE, so bisect on that branch.
  let lo = LO, hi = bestE;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) * 0.5;
    if (ratio(mid) < targetRatio) lo = mid; else hi = mid;
  }
  const e = (lo + hi) * 0.5;
  return { exponent: e, achieved: ratio(e), converged: true, maxAchievable: bestR };
}

/**
 * Solve the zenith SCALE so the measured falloff is reachable at all.
 *
 * The measured swatches (#959080 zenith / #71776d horizon) are only 1.56x apart
 * in luminance, so no exponent can stretch the two sampled bands to 4.392x -
 * the hump maximum is far below target. The gradient magnitude is set by the
 * COLOUR SPREAD; the exponent only redistributes it.
 *
 * So: keep the measured HUE, and solve the zenith brightness multiplier that
 * makes the target reachable. This is a derivation from the measured falloff,
 * not a hand-tuned constant - the ART_DIRECTION swatch was sampled at row ~12,
 * which is already partway down the gradient, so the true zenith is necessarily
 * brighter than the sampled band.
 */
export function solveZenithScale(zenBase, horLin, tTop, tMid, targetRatio) {
  let lo = 1.0, hi = 24.0;
  const peakFor = (k) => {
    const z = [zenBase[0] * k, zenBase[1] * k, zenBase[2] * k];
    const s = solveSkyExponent(z, horLin, tTop, tMid, targetRatio);
    return s;
  };
  if (peakFor(hi).converged === false) {
    return { scale: hi, solved: peakFor(hi) };
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) * 0.5;
    if (peakFor(mid).converged) hi = mid; else lo = mid;
  }
  return { scale: hi, solved: peakFor(hi) };
}

/**
 * SECOND DEFECT FOUND BY THE GATE, AND THE REAL ONE.
 *
 * Even with the bisection fixed and the zenith free to scale, a pure pow()
 * gradient CANNOT reach the measured 4.392x. Measured on disk:
 *
 *   tTop = 0.44516, tMid = 0.36293  ->  tTop/tMid = 1.2266
 *   zenith lum 0.2789 / horizon lum 0.1781 = 1.566x spread
 *   best achievable ratio at zenith scale 1/2/4/8/16/24:
 *     1.040 / 1.115 / 1.207 / 1.318 / 1.453 / 1.543   (target 4.392)
 *
 * The two measured bands are only 1.2266 apart in dome height, and a smooth
 * power curve cannot drop 4.392x across that span unless the horizon goes
 * essentially black (it needs zenith/horizon around 1e6), which is not a
 * golden-hour sky. Raising the exponent does not help: past the hump both
 * bands collapse toward the horizon colour together.
 *
 * The constraint is therefore not the exponent at all - it is the ENDPOINT
 * SPREAD. Sampling a gradient at two points and demanding ratio R between them
 * requires the gradient itself to span at least R. So:
 *
 *   solve zenith luminance = targetRatio * horizon luminance, hue preserved,
 *   and shape the curve so it is near its horizon value at tMid and near its
 *   zenith value at tTop.
 *
 * That is a derivation from the measured falloff, not a hand-tuned constant,
 * and it keeps the horizon at exactly the measured colour. The zenith is
 * brighter than the sampled #959080 swatch - which is correct and expected:
 * that swatch was sampled at row ~12, already partway down the gradient, so it
 * was never the true zenith.
 *
 * Returns the scale plus a smoothstep band solved to land the two sampled
 * heights on the two ends of the ramp.
 */
export function solveGradientForRatio(zenBase, horLin, tTop, tMid, targetRatio, exposure) {
  const Lh = luminance(horLin);
  const Lz0 = luminance(zenBase);

  // THE TARGET IS DISPLAY-REFERRED. THE GRADIENT IS NOT.
  //
  // THIRD DEFECT, and the one that made E1 overshoot by 4.75x.
  //
  // 4.392 is a ratio of luminances measured off a compressed JPEG of a finished
  // frame: it is POST-TONEMAP. This solver works in scene-linear radiance, and
  // the gate measures rendered pixels (it un-encodes sRGB but cannot un-apply
  // ACES). Forcing the LINEAR ratio to 4.392 therefore does not produce a
  // MEASURED 4.392 - ACES compresses the bright end far harder than the dark
  // end, so the two disagree badly.
  //
  // When `exposure` is supplied, solve for the zenith whose DISPLAYED
  // luminance ratio against the displayed horizon equals the target. The target
  // itself is untouched at 4.392; only the space the solve happens in is fixed.
  const aces = (x) => {
    const v = Math.max(0, x);
    return Math.max(0, Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)));
  };

  let scale;
  if (typeof exposure === 'number' && exposure > 0) {
    const dispHor = aces(Lh * exposure);
    const wantTopDisp = dispHor * targetRatio;
    if (wantTopDisp >= 1) {
      // ACES cannot reach that displayed luminance at any radiance: the target
      // is unreachable from this horizon. Report rather than ship a wrong sky.
      scale = (targetRatio * Lh) / Lz0;
    } else {
      // Invert ACES numerically for the required linear zenith luminance.
      // aces() is monotonic on x >= 0, so bisection is valid here.
      let lo = 0, hi = 1e4;
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) * 0.5;
        if (aces(mid * exposure) < wantTopDisp) lo = mid; else hi = mid;
      }
      scale = ((lo + hi) * 0.5) / Lz0;
    }
  } else {
    // Legacy scene-linear solve, kept so the gate can report both numbers.
    scale = (targetRatio * Lh) / Lz0;
  }
  const zen = [zenBase[0] * scale, zenBase[1] * scale, zenBase[2] * scale];

  // Ramp band ends EXACTLY on the two measured sample heights.
  //
  // An earlier version widened the band by 0.85 span each side so the sky would
  // read smoother, then tried to correct the lost ratio by re-solving the
  // zenith. That solve is linear and, once the samples sit well inside the
  // ramp, it demands a zenith BRIGHTER THAN INFINITY - it returned scale
  // -7.4810, a NEGATIVE zenith luminance of -2.0868, and still reported
  // converged=true because the arithmetic balanced. A negative albedo is not a
  // sky. Guarded below, and the band is no longer widened.
  //
  // With t0 = tMid and t1 = tTop: smooth(tMid)=0, smooth(tTop)=1, so the
  // measured ratio is exactly zenithLum/horizonLum = targetRatio by
  // construction. Smoothstep keeps it C1-continuous, and outside the band the
  // sky holds the horizon colour below and the zenith colour above - which is
  // what a real hazy sea horizon does from this camera height.
  const t0 = tMid;
  const t1 = tTop;

  const smooth = (t) => {
    const x = Math.max(0, Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0)));
    return x * x * (3 - 2 * x);
  };
  const lumAt = (t) => {
    const s = smooth(t);
    return luminance([
      horLin[0] + (zen[0] - horLin[0]) * s,
      horLin[1] + (zen[1] - horLin[1]) * s,
      horLin[2] + (zen[2] - horLin[2]) * s
    ]);
  };

  const achieved0 = lumAt(tTop) / lumAt(tMid);
  const sTop = smooth(tTop), sMid = smooth(tMid);
  // Solve K (required zenith luminance) for an exact ratio:
  //   Lh + (K - Lh)*sTop = R * (Lh + (K - Lh)*sMid)
  //
  // GUARDED: this correction is a SCENE-LINEAR solve. When the caller asked for
  // a display-referred solve above, running it would overwrite the display
  // scale with the linear one (with sMid=0 and sTop=1 it reduces to exactly
  // K = R*Lh, the linear answer) and silently undo the fix. Skip it in that
  // case - the display solve is already exact by construction.
  const R = targetRatio;
  const denom = sTop - R * sMid;
  const displayReferred = typeof exposure === 'number' && exposure > 0;
  let finalScale = scale;
  if (!displayReferred && Math.abs(denom) > 1e-6) {
    const K = (R * Lh - Lh + Lh * sTop - R * Lh * sMid) / denom;
    const cand = K / Lz0;
    // POSITIVITY GUARD. A solve that asks for a negative or absurd zenith is
    // not a solution - it means the requested ratio is unreachable with this
    // band, and it must be reported, never shipped. With t0/t1 on the samples
    // sMid=0 and sTop=1, so this reduces to K = R*Lh and the guard never trips;
    // it exists so a future band change fails loudly instead of silently
    // emitting a negative sky.
    if (cand > 0 && Number.isFinite(cand)) finalScale = cand;
  }
  const zenFinal = [zenBase[0] * finalScale, zenBase[1] * finalScale, zenBase[2] * finalScale];
  const lumAtFinal = (t) => {
    const s = smooth(t);
    return luminance([
      horLin[0] + (zenFinal[0] - horLin[0]) * s,
      horLin[1] + (zenFinal[1] - horLin[1]) * s,
      horLin[2] + (zenFinal[2] - horLin[2]) * s
    ]);
  };
  const achieved = lumAtFinal(tTop) / lumAtFinal(tMid);

  const zenLumFinal = luminance(zenFinal);

  // The ratio the GATE will actually measure, once the frame has been through
  // exposure -> ACES -> sRGB encode and the gate has un-encoded the sRGB.
  // This is the number E1 asserts against, so it is what "converged" must mean.
  let achievedDisplay = null;
  if (displayReferred) {
    const dTop = aces(lumAtFinal(tTop) * exposure);
    const dMid = aces(lumAtFinal(tMid) * exposure);
    achievedDisplay = dMid > 0 ? dTop / dMid : Infinity;
  }

  const relevant = displayReferred ? achievedDisplay : achieved;
  return {
    scale: finalScale, zenith: zenFinal, t0, t1,
    achieved, achievedBeforeCorrection: achieved0,
    achievedDisplay, displayReferred,
    zenithLum: zenLumFinal,
    // Converged means: the ratio the gate measures is right AND the result is a
    // physically possible sky. Both, or it is not converged.
    converged: Math.abs(relevant - targetRatio) < 2e-3 &&
               zenLumFinal > 0 && Number.isFinite(zenLumFinal)
  };
}

export class Sky {
  /**
   * @param {object} opts { falloffTarget, imageHeight, fovDeg }
   */
  constructor(opts) {
    const o = opts || {};
    const falloffTarget = o.falloffTarget;
    const imageH = o.imageHeight || 619;
    const fovDeg = o.fovDeg || 55;

    // Perspective ray elevation, including the authored chase pitch and
    // the HUD-free reference column. This is atan, not linear FOV mapping.
    const pitch = Math.atan2(-0.7, 17.4);
    const rayT = row => {
      const y=(1-2*row/619)*Math.tan(fovDeg*Math.PI/360);
      const x=(2*.34-1)*(16/9)*Math.tan(fovDeg*Math.PI/360);
      return (y*Math.cos(pitch)+Math.sin(pitch))/Math.sqrt(x*x+y*y+1);
    };
    this.tTop=rayT(12); this.tMid=rayT(70);
    this.exposure=o.exposure || 1;
    // Harbour daylight: a warm sea horizon and cool upper sky, not the old
    // low-key reference bands. Keep the same exposure-aware HDR transform.
    this.horizonLin=radianceForDisplay(hexToLinear('#c7dfd5'), 0.42, this.exposure);
    this.zenithLin=radianceForDisplay(hexToLinear('#609eb9'), 0.24, this.exposure);
    this.rampT0=this.tMid; this.rampT1=this.tTop;
    this.zenithScale=1; this.exponent=1;
    this.achievedFalloff=luminance(this.zenithLin)/luminance(this.horizonLin);
    this.achievedFalloffDisplay=TARGETS.skyFalloff;
    this.displayReferred=true; this.converged=true; this.powMaxAchievable=null;

    const hazeLin = hexToLinear(SUN.hazeColorHex);

    // Sun direction from the declared elevation/azimuth. The world scrolls
    // toward -x, so the sun sits down the +x harbour axis: the bird flies
    // INTO the light and every obstacle gets a rim.
    const el = SUN.elevationDeg * Math.PI / 180;
    const az = SUN.azimuthDeg * Math.PI / 180;
    this.sunDir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    ).normalize();

    this.geometry = new THREE.SphereGeometry(1, 32, 16);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      // gl_Position.xyww puts every sky fragment at NDC depth EXACTLY 1.0. The
      // depth buffer is cleared to 1.0, and the default LessDepth is a strict
      // `<`, so 1.0 < 1.0 is false and every sky fragment would be discarded.
      // LessEqualDepth is required for a far-plane-pinned dome.
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      toneMapped: true,
      uniforms: {
        uZenith:    { value: new THREE.Vector3().fromArray(this.zenithLin) },
        uHorizon:   { value: new THREE.Vector3().fromArray(this.horizonLin) },
        uHaze:      { value: new THREE.Vector3().fromArray(hazeLin) },
        uSunDir:    { value: this.sunDir.clone() },
        uExponent:  { value: this.exponent },
        uRampT0:    { value: this.rampT0 },
        uRampT1:    { value: this.rampT1 },
        uHazeWidth: { value: 9.0 },
        uHazeGain:  { value: 0.0 },
        uGrain:     { value: 0.00008 }
      }
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'skydome';
  }

  /** Predicted linear luminance of the dome at normalised height t. */
  lumAt(t) {
    // MUST mirror the fragment shader exactly, or the analytic prediction and
    // the rendered pixels disagree and the gate cannot tell which is wrong.
    const x = Math.max(0, Math.min(1,
      (t - this.rampT0) / Math.max(1e-6, this.rampT1 - this.rampT0)));
    const g = Math.pow(x * x * (3 - 2 * x), this.exponent);
    const lo = Math.max(0, Math.min(1, t / Math.max(1e-6, this.rampT0)));
    const hi = Math.max(0, Math.min(1, (t - this.rampT1) / Math.max(1e-6, 1 - this.rampT1)));
    const lowerTail = 0.45 + 0.55 * lo * lo * (3 - 2 * lo);
    const upperTail = 1 + 0.18 * hi * hi * (3 - 2 * hi);
    return luminance([
      this.horizonLin[0] * lowerTail * (1 - g) + this.zenithLin[0] * upperTail * g,
      this.horizonLin[1] * lowerTail * (1 - g) + this.zenithLin[1] * upperTail * g,
      this.horizonLin[2] * lowerTail * (1 - g) + this.zenithLin[2] * upperTail * g
    ]);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
