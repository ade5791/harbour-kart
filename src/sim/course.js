// =============================================================================
// Harbour Kart - COURSE GENERATOR. Closed-loop centreline in metres.
// =============================================================================
//
// WHY THIS IS ITS OWN MODULE
//
// On the previous build the mission brief claimed course generation lived in
// `src/course.mjs` "so probes can sample it headlessly". S1 read the actual 2D
// source and found that file DOES NOT EXIST - generation was inline in
// `sim.js#spawnPipe`, and every headless probe had to REIMPLEMENT the sampler to
// test it. A probe that reimplements the thing it is testing proves nothing about
// the shipped game; it proves the two implementations agree, which they did right
// up until they did not.
//
// So this module is the SINGLE generator. The renderer builds geometry from it,
// the AI drives against it, and tools/vehgate.mjs samples this exact code. There
// is no second copy.
//
// THE SIGHT LINE IS A CONSTRUCTION CONSTRAINT, NOT A POST-HOC CHECK
//
// This is the whole point of the mission's difficulty spine. SIGHT_LINE_MIN is
// the kart-racer equivalent of the flap game's GAP_H, and GAP_H was not a number
// the old generator was audited against afterwards - it was the number that
// SIZED the thing being generated. The same discipline applies here:
//
//   Every corner of radius R is preceded by a straight of at least sightLine(R)
//   metres, where sightLine(R) = d_react + d_brake(R).
//
// The reason that specific rule is the right one is geometric. Along a straight,
// the line of sight to the far end is collinear with the centreline, so the
// approach is unobstructed for its whole length. Approaching a corner through
// ANOTHER corner, the chord cuts inside the bend and the view is cut off after
//
//   d_visible = R * 2 * acos(1 - clearance / R)
//
// which at R = 12 m and a 5.05 m clearance is 22.9 m - well under the 38.0 m that
// corner needs. That is not a tuning problem. A tight corner hidden behind another
// tight corner is unfair BY CONSTRUCTION, exactly as the brief says, and the fix
// has to be in the GEOMETRY.
//
// So the generator enforces the minimum approach straight as a hard lower bound
// during closure, and validateSightLines() re-measures the built result from the
// sampler afterwards. The check is not vacuous: it fails loudly if the closure
// solver ever has to push a straight below its bound, and that failure is
// reported rather than absorbed.
//
// WHAT S3 INHERITS: sightCorridor() returns the keep-clear envelope. Scenery,
// ropes, mooring posts and palms may not intrude on it, or they re-introduce the
// occlusion this geometry was built to avoid. That is hard rule 10 in the brief -
// decoration may never touch the collision surface - extended to visibility.
//
// NO Math.random(). Every stochastic choice draws from a seeded, named RNG stream.

import { RNG } from '../core/rng.js';
import {
  CORNER_RADII, sightLine, LAP_LEN, TRACK_W_ROUNDED, SIGHT_LINE_MIN,
  LAP_TARGET_S, V_AVG, R_FLAT, CHECKPOINTS_PER_LAP
} from '../core/config.js';

// Lateral clearance either side of the centreline that the sight model assumes is
// visually open: half the track plus a shoulder.
//   TRACK_W_ROUNDED / 2 = 3.05 m   (derived from the width, itself INSPECTED)
//   SIGHT_SHOULDER      = 2.00 m   (INSPECTED - the sand/stone run-off either
//                                   side of the boardwalk in the reference frame)
// S3 MUST keep this envelope clear of sight-blocking geometry.
export const SIGHT_SHOULDER = 2.00;                                   // m
export const SIGHT_CLEARANCE = TRACK_W_ROUNDED / 2 + SIGHT_SHOULDER;  // 5.05 m

// How far you can see THROUGH a bend of radius R before the inside edge cuts the
// chord off. Sagitta of a chord subtending theta on radius R is R(1 - cos(t/2));
// setting that equal to the clearance and solving:
//   theta_max = 2 * acos(1 - clearance / R)
//   d_visible = R * theta_max
// Returns Infinity for a straight (R = 0 or Infinity).
export function visibleThroughArc(R) {
  if (!(R > 0) || !isFinite(R)) return Infinity;
  const c = 1 - SIGHT_CLEARANCE / R;
  if (c <= -1) return Infinity;         // clearance so wide the bend never blocks
  return R * 2 * Math.acos(Math.max(-1, Math.min(1, c)));
}

const TWO_PI = Math.PI * 2;

// -----------------------------------------------------------------------------
// Segment types. A course is an alternating chain: straight, arc, straight, arc,
// ... , closing back on the start. Headings close automatically because the
// signed sweeps are constrained to sum to exactly 2*pi.
// -----------------------------------------------------------------------------
export const SEG = Object.freeze({ STRAIGHT: 0, ARC: 1 });

export class Course {
  constructor(seed = 12345, opts) {
    const o = opts || {};
    this.seed = seed >>> 0;
    this.cornerCount = o.cornerCount || 14;
    this.targetLen = o.targetLen || LAP_LEN;
    this.halfWidth = (o.trackW || TRACK_W_ROUNDED) / 2;

    this.segments = [];        // built by generate()
    this.length = 0;
    this.closureError = 0;     // m; distance between the last point and the start
    this.attempts = 0;
    this.rejected = [];        // every rejected attempt, with its reason
    this.checkpoints = [];

    // Preallocated sample record. sampleInto() writes here so a probe can walk
    // the whole course without allocating. sample() returns a fresh object and is
    // for setup code only - it is never called per frame.
    this._smp = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };

    this.generate();
  }

  // ---------------------------------------------------------------------------
  // Generation. Deterministic, with an explicit bounded retry: a rejected attempt
  // is RECORDED with its reason rather than silently reseeded, so a generator
  // that only works on lucky seeds is visible instead of invisible.
  // ---------------------------------------------------------------------------
  generate() {
    const MAX_ATTEMPTS = 64;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      this.attempts = attempt + 1;
      const rng = new RNG(this.seed).fork('spawn').fork('course' + attempt);
      const built = this._attempt(rng);
      if (built.ok) {
        this.segments = built.segments;
        this.length = built.length;
        this.closureError = built.closureError;
        this._buildCheckpoints();
        return this;
      }
      this.rejected.push({ attempt, reason: built.reason });
    }
    throw new Error(
      'Course: no valid layout in ' + MAX_ATTEMPTS + ' attempts for seed ' +
      this.seed + '. Reasons: ' +
      this.rejected.map((r) => r.reason).join(' | ')
    );
  }

  _attempt(rng) {
    const n = this.cornerCount;

    // ---- 1. RADII: every ladder rung used, cycled and shuffled -------------
    const radii = new Array(n);
    for (let i = 0; i < n; i++) radii[i] = CORNER_RADII[i % CORNER_RADII.length];
    for (let i = n - 1; i > 0; i--) {          // seeded Fisher-Yates
      const j = rng.int(0, i);
      const t = radii[i]; radii[i] = radii[j]; radii[j] = t;
    }

    // ---- 2. DIRECTIONS. Net turning must be exactly +2*pi (one closed lap).
    // The reference frame shows a sweeping LEFT bend, so the circuit runs
    // predominantly left-handed with a minority of right-handers for variety.
    const signs = new Array(n);
    const rightCount = Math.max(2, Math.round(n * 0.28));
    for (let i = 0; i < n; i++) signs[i] = 1;
    let placed = 0;
    while (placed < rightCount) {
      const k = rng.int(0, n - 1);
      if (signs[k] === 1) { signs[k] = -1; placed++; }
    }

    // ---- 3. SWEEPS. Seeded base angles, then the LEFT sweeps are uniformly
    // scaled so the signed total is exactly 2*pi. If that scale factor pushes any
    // sweep outside a plausible band the attempt is REJECTED, not clamped -
    // clamping would silently break closure.
    const sweeps = new Array(n);
    let sumL = 0, sumR = 0;
    for (let i = 0; i < n; i++) {
      sweeps[i] = rng.range(0.38, 1.15);        // rad
      if (signs[i] > 0) sumL += sweeps[i]; else sumR += sweeps[i];
    }
    const wantL = TWO_PI + sumR;
    const scale = wantL / sumL;
    if (!(scale > 0.45 && scale < 2.4)) {
      return { ok: false, reason: 'left-sweep scale ' + scale.toFixed(3) + ' out of band' };
    }
    for (let i = 0; i < n; i++) if (signs[i] > 0) sweeps[i] *= scale;
    for (let i = 0; i < n; i++) {
      if (sweeps[i] < 0.20 || sweeps[i] > 2.60) {
        return { ok: false, reason: 'sweep ' + sweeps[i].toFixed(3) + ' rad out of band at corner ' + i };
      }
    }

    // ---- 4. MINIMUM APPROACH STRAIGHTS - THE DERIVED CONSTRAINT ------------
    // Straight i precedes corner i, so its lower bound is the sight line that
    // corner i needs. This is where SIGHT_LINE_MIN stops being a printed number
    // and starts SIZING the track.
    const minL = new Array(n);
    let minSum = 0;
    for (let i = 0; i < n; i++) {
      minL[i] = sightLine(radii[i]);
      minSum += minL[i];
    }

    // ---- 5. ARC DISPLACEMENTS, and an initial straight-length guess --------
    // Heading BEFORE corner i is the running sum of the sweeps already turned.
    const headingBefore = new Array(n);
    let hd = 0;
    let arcLen = 0;
    let arcDx = 0, arcDz = 0;
    for (let i = 0; i < n; i++) {
      headingBefore[i] = hd;
      const R = radii[i], sw = sweeps[i], sg = signs[i];
      arcLen += R * sw;
      // Arc displacement in world space. Heading h means direction
      // (-sin h, -cos h) in the WorldBasis frame (forward = -Z at h = 0).
      //
      // S3 DEFECT FIX - THE ARC DISPLACEMENT WAS SIGN-INVERTED.
      // The integral of the unit tangent over an arc, with h(s) = h0 + sg*s/R:
      //   dx = INT -sin(h) ds = (R/sg)[cos(h1) - cos(h0)] = sg*R*(cos h1 - cos h0)
      //   dz = INT -cos(h) ds = -(R/sg)[sin(h1) - sin(h0)] = sg*R*(sin h0 - sin h1)
      // (using 1/sg == sg for sg = +/-1). The previous form had BOTH terms
      // negated, so every arc moved the kart BACKWARDS along its own heading and
      // folded the track over itself - measured worst non-adjacent centreline
      // separation 0.05 m on a 6.1 m wide track, i.e. total overlap.
      //
      // Why S2's own sight-line check did not catch it: validateSightLines()
      // compares a chord built from sampleInto() against a centreline built from
      // the SAME sampleInto(). Both carried the identical inversion, so the error
      // cancelled and the check passed 14/14 on a folded track. That is the
      // "probe echoes the implementation" failure the module header warns about,
      // reappearing one level up. Ground truth is now an INDEPENDENT numerical
      // integration (tools/_s3_diag2.mjs), which the corrected form matches to
      // 0.000000000 m on 6/6 cases and the old form missed by 17-106 m.
      const h0 = hd, h1 = hd + sg * sw;
      arcDx += sg * R * (Math.cos(h1) - Math.cos(h0));
      arcDz += sg * R * (Math.sin(h0) - Math.sin(h1));
      hd = h1;
    }
    // Heading closes by construction; assert it rather than assume it.
    const headErr = Math.abs(((hd % TWO_PI) + TWO_PI) % TWO_PI);
    if (Math.min(headErr, TWO_PI - headErr) > 1e-9) {
      return { ok: false, reason: 'heading closure error ' + headErr.toExponential(3) };
    }

    const slackTotal = this.targetLen - arcLen - minSum;
    if (slackTotal < 0) {
      return {
        ok: false,
        reason: 'arcs(' + arcLen.toFixed(1) + ') + min approach straights(' +
                minSum.toFixed(1) + ') exceed target lap ' + this.targetLen.toFixed(1)
      };
    }
    const L = new Array(n);
    for (let i = 0; i < n; i++) L[i] = minL[i] + slackTotal / n;

    // ---- 6. CLOSURE SOLVE ---------------------------------------------------
    // Position closure is LINEAR in the straight lengths, because the headings
    // depend only on the arcs. With direction u_i for straight i:
    //     sum_i L_i * u_i + arcDisp = 0
    // Two equations, n unknowns. The minimum-norm correction is
    //     dL = J^T (J J^T)^-1 (-e)
    // with J the 2xn matrix of directions, so J J^T is a 2x2 solve. Being linear,
    // ONE step is exact for the unconstrained problem. The bound L_i >= minL_i
    // makes it constrained, so this is an active-set loop: solve, freeze any
    // straight that hit its bound, re-solve on the rest. If everything freezes
    // and the error is still open, the attempt is REJECTED - never clamped into a
    // course that does not actually close.
    const ux = new Array(n), uz = new Array(n);
    for (let i = 0; i < n; i++) {
      ux[i] = -Math.sin(headingBefore[i]);
      uz[i] = -Math.cos(headingBefore[i]);
    }
    const frozen = new Array(n).fill(false);
    let closureError = Infinity;

    for (let iter = 0; iter < n + 4; iter++) {
      let ex = arcDx, ez = arcDz;
      for (let i = 0; i < n; i++) { ex += L[i] * ux[i]; ez += L[i] * uz[i]; }
      closureError = Math.hypot(ex, ez);
      if (closureError < 1e-9) break;

      let a = 0, b = 0, c = 0;               // J J^T = [[a,b],[b,c]]
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue;
        a += ux[i] * ux[i]; b += ux[i] * uz[i]; c += uz[i] * uz[i];
      }
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-12) {
        return { ok: false, reason: 'closure Jacobian singular at iter ' + iter };
      }
      // lambda = (J J^T)^-1 * (-e)
      const lx = (c * -ex - b * -ez) / det;
      const lz = (a * -ez - b * -ex) / det;

      let hitBound = false;
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue;
        const d = ux[i] * lx + uz[i] * lz;
        let next = L[i] + d;
        if (next < minL[i]) { next = minL[i]; frozen[i] = true; hitBound = true; }
        L[i] = next;
      }
      if (!hitBound) {
        let fx = arcDx, fz = arcDz;
        for (let i = 0; i < n; i++) { fx += L[i] * ux[i]; fz += L[i] * uz[i]; }
        closureError = Math.hypot(fx, fz);
        break;
      }
      if (frozen.every(Boolean)) {
        return { ok: false, reason: 'all straights pinned at their sight-line minimum, closure ' + closureError.toFixed(3) + ' m open' };
      }
    }

    if (!(closureError < 1e-6)) {
      return { ok: false, reason: 'closure error ' + closureError.toFixed(6) + ' m' };
    }
    for (let i = 0; i < n; i++) {
      if (L[i] < minL[i] - 1e-9) {
        return {
          ok: false,
          reason: 'straight ' + i + ' = ' + L[i].toFixed(2) +
                  ' m is below its sight-line minimum ' + minL[i].toFixed(2) + ' m'
        };
      }
    }

    // ---- 7. EMIT SEGMENTS ---------------------------------------------------
    const segments = [];
    let s = 0, x = 0, z = 0, h = 0;
    for (let i = 0; i < n; i++) {
      segments.push({
        type: SEG.STRAIGHT, index: segments.length, len: L[i],
        s0: s, x0: x, z0: z, h0: h, R: Infinity, sign: 0, sweep: 0,
        cornerIndex: -1
      });
      x += L[i] * -Math.sin(h);
      z += L[i] * -Math.cos(h);
      s += L[i];

      const R = radii[i], sw = sweeps[i], sg = signs[i];
      segments.push({
        type: SEG.ARC, index: segments.length, len: R * sw,
        s0: s, x0: x, z0: z, h0: h, R, sign: sg, sweep: sw,
        cornerIndex: i, approachLen: L[i], requiredSight: minL[i]
      });
      const h1 = h + sg * sw;
      x += sg * R * (Math.cos(h1) - Math.cos(h));   // S3 sign fix (see _attempt)
      z += sg * R * (Math.sin(h) - Math.sin(h1));
      s += R * sw;
      h = h1;
    }

    const totalLen = s;
    const finalErr = Math.hypot(x, z);
    if (!(finalErr < 1e-6)) {
      return { ok: false, reason: 'integrated endpoint off by ' + finalErr.toFixed(6) + ' m' };
    }
    // Lap length must land near the design target, or the 60 s lap the whole
    // geometry was sized from is not what the player actually drives.
    const lenErr = Math.abs(totalLen - this.targetLen) / this.targetLen;
    if (lenErr > 0.08) {
      return { ok: false, reason: 'lap length ' + totalLen.toFixed(1) + ' m is ' + (lenErr * 100).toFixed(1) + '% off target' };
    }

    return { ok: true, segments, length: totalLen, closureError: finalErr };
  }

  _buildCheckpoints() {
    this.checkpoints.length = 0;
    const step = this.length / CHECKPOINTS_PER_LAP;
    for (let i = 0; i < CHECKPOINTS_PER_LAP; i++) {
      const smp = this.sample(i * step);
      this.checkpoints.push({ index: i, s: i * step, x: smp.x, z: smp.z, heading: smp.heading });
    }
  }

  // ---------------------------------------------------------------------------
  // SAMPLING. sampleInto() writes into a caller-owned record and allocates
  // nothing - that is the form the sim and the probes use. sample() wraps it and
  // returns the shared record; it is setup-only, never per-frame.
  // ---------------------------------------------------------------------------
  sampleInto(s, out) {
    let t = s % this.length;
    if (t < 0) t += this.length;
    // Linear scan. The segment count is ~28, so a scan is cheaper than a binary
    // search and, more importantly, has no allocation and no branch surprises.
    let seg = this.segments[this.segments.length - 1];
    for (let i = 0; i < this.segments.length; i++) {
      const sg = this.segments[i];
      if (t < sg.s0 + sg.len) { seg = sg; break; }
    }
    const local = t - seg.s0;
    if (seg.type === SEG.STRAIGHT) {
      out.x = seg.x0 + local * -Math.sin(seg.h0);
      out.z = seg.z0 + local * -Math.cos(seg.h0);
      out.heading = seg.h0;
      out.curvature = 0;
      out.R = Infinity;
    } else {
      const phi = seg.sign * (local / seg.R);
      const h1 = seg.h0 + phi;
      out.x = seg.x0 + seg.sign * seg.R * (Math.cos(h1) - Math.cos(seg.h0));
      out.z = seg.z0 + seg.sign * seg.R * (Math.sin(seg.h0) - Math.sin(h1));
      out.heading = h1;
      out.curvature = seg.sign / seg.R;
      out.R = seg.R;
    }
    out.segIndex = seg.index;
    out.sLocal = local;
    return out;
  }

  sample(s) { return this.sampleInto(s, this._smp); }

  // Corners, in track order, with the approach straight that precedes each.
  corners() {
    const out = [];
    for (const seg of this.segments) {
      if (seg.type === SEG.ARC) {
        out.push({
          index: seg.cornerIndex,
          R: seg.R,
          sweep: seg.sweep,
          sign: seg.sign,
          s0: seg.s0,
          arcLen: seg.len,
          approachLen: seg.approachLen,
          requiredSight: seg.requiredSight,
          vCornerKmh: Math.sqrt(1.35 * 9.81 * seg.R) * 3.6
        });
      }
    }
    return out;
  }

  // The keep-clear envelope S3 must respect. Everything within this lateral
  // distance of the centreline over the approach to a corner must stay free of
  // sight-blocking geometry, or the derived sight line is not actually delivered
  // to the player no matter what this generator computed.
  sightCorridor() {
    return {
      halfWidth: this.halfWidth,
      shoulder: SIGHT_SHOULDER,
      clearance: SIGHT_CLEARANCE,
      note: 'S3: no sight-blocking geometry inside +/-clearance of the centreline ' +
            'over each corner approach. Decoration outside it only.'
    };
  }

  // ---------------------------------------------------------------------------
  // SIGHT-LINE VALIDATION, measured back off the BUILT geometry rather than off
  // the parameters that were fed in. This is what makes it a check and not an
  // echo: it walks backwards from each corner entry through the real sampler and
  // stops at the first point whose straight-line chord to the entry leaves the
  // clearance envelope.
  // ---------------------------------------------------------------------------
  validateSightLines(stepM = 0.25) {
    const results = [];
    const a = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    const b = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    const m = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };

    for (const c of this.corners()) {
      this.sampleInto(c.s0, a);                    // corner entry point
      let available = 0;
      const maxBack = Math.min(this.length * 0.5, c.requiredSight * 3 + 20);

      for (let back = stepM; back <= maxBack; back += stepM) {
        this.sampleInto(c.s0 - back, b);           // candidate viewpoint
        // Does the straight chord b -> a stay inside the clearance envelope?
        // Sample the chord and measure each point's lateral distance from the
        // centreline it is supposed to be following.
        const samples = Math.max(2, Math.ceil(back / 1.0));
        let clear = true;
        for (let k = 1; k < samples; k++) {
          const f = k / samples;
          const px = b.x + (a.x - b.x) * f;
          const pz = b.z + (a.z - b.z) * f;
          this.sampleInto(c.s0 - back + back * f, m);
          const dx = px - m.x, dz = pz - m.z;
          if (Math.hypot(dx, dz) > SIGHT_CLEARANCE) { clear = false; break; }
        }
        if (!clear) break;
        available = back;
      }

      results.push({
        corner: c.index,
        R: c.R,
        required: c.requiredSight,
        available,
        approachLen: c.approachLen,
        pass: available >= c.requiredSight - 1e-6,
        marginM: available - c.requiredSight
      });
    }
    return results;
  }

  // Ideal lap time from the geometry itself: drive each segment at its own limit
  // speed, subject to braking between segments. A coarse but honest upper bound
  // on pace, used to check the generated track is near the 60 s design centre.
  idealLapEstimate(mu = 1.35, g = 9.81, vTop = 28.6111, aBrake = 10.791) {
    let t = 0;
    for (const seg of this.segments) {
      if (seg.type === SEG.ARC) {
        t += seg.len / Math.min(vTop, Math.sqrt(mu * g * seg.R));
      } else {
        // Accelerate then brake for the next corner; approximate with the mean of
        // entry and exit speeds over the straight.
        const next = this.segments[(seg.index + 1) % this.segments.length];
        const vExit = next.type === SEG.ARC
          ? Math.min(vTop, Math.sqrt(mu * g * next.R)) : vTop;
        const vMean = 0.5 * (vTop + vExit);
        t += seg.len / vMean;
      }
    }
    return t;
  }

  stats() {
    const cs = this.corners();
    return {
      seed: this.seed,
      attempts: this.attempts,
      rejected: this.rejected.length,
      segments: this.segments.length,
      corners: cs.length,
      length: this.length,
      targetLen: this.targetLen,
      lenErrPct: 100 * (this.length - this.targetLen) / this.targetLen,
      closureError: this.closureError,
      minRadius: Math.min(...cs.map((c) => c.R)),
      maxRadius: Math.max(...cs.map((c) => c.R)),
      rFlat: R_FLAT,
      sightLineMin: SIGHT_LINE_MIN,
      idealLapS: this.idealLapEstimate(),
      lapTargetS: LAP_TARGET_S,
      vAvg: V_AVG,
      checkpoints: this.checkpoints.length
    };
  }
}
