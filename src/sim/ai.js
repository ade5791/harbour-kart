// =============================================================================
// Harbour Kart - AI RACER CONTROLLER. Seeded, grip-limited, no rubber-banding.
// =============================================================================
//
// THE RULE THIS MODULE EXISTS TO OBEY (step instruction 2):
//
//   "AI must brake using the SAME derived model as the player: it cannot corner
//    above sqrt(mu*g*R) and it cannot brake harder than A_BRAKE. An AI that
//    ignores the grip limit is a rubber-band cheat wearing a physics costume,
//    and it invalidates the whole difficulty derivation."
//
// This is not a style preference. SIGHT_LINE_MIN = 39 m is derived from
// d_brake(R=12) computed at A_BRAKE. If an AI kart can decelerate at 2*A_BRAKE,
// it needs half the sight line, so the number the entire track was built to
// stops describing the field that races on it. The player would be racing
// opponents playing a different game with different physics, and any lap-time
// comparison between them would be meaningless.
//
// HOW THE CONSTRAINT IS STRUCTURALLY GUARANTEED, not merely intended:
//
//   1. The AI does not integrate its own motion. It emits the SAME input record
//      the player emits - {throttle, brake, steer, drift} - and Vehicle.step()
//      integrates it. So the grip limit is not something the AI "respects"; it
//      is something the AI cannot escape, because the tyre model is downstream
//      of it and identical for all six karts.
//   2. Its target speed comes from vCorner(R) in config.js - the same exported
//      function the derivation and the track generator use. There is no second
//      copy of sqrt(mu*g*R) in this file.
//   3. Its braking point comes from dBrake(R) in config.js. Same function, same
//      A_BRAKE. An AI cannot brake later than the derived point and still make
//      the corner, because the physics will not let it.
//
// WHERE THE DIFFICULTY ACTUALLY COMES FROM, given all six karts share physics:
// skill, expressed as three seeded per-driver traits that only ever make a
// driver WORSE than the ideal line, never better:
//   brakeBias    >= 1.0  - brakes EARLIER than optimal by this factor
//   apexError            - metres of lateral error against the ideal line
//   throttleTrim <= 1.0  - fraction of available throttle used on exit
// A driver with (1.0, 0, 1.0) drives the derived optimum. No driver can be given
// values that beat it. That is what makes the field honest: the ceiling is the
// physics, and the AI approaches it from below.
//
// SEEDING: every trait and every mistake roll is drawn from a forked stream off
// the declared 'ai' stream (ARCHITECTURE.md section 8). Each driver forks its
// own sub-stream, so changing one driver's roll count cannot shift another's.
//
// ZERO ALLOCATION: update() writes into a preallocated input record and scratch
// numbers. No object, array, closure or string is created on the hot path.

import {
  MU_LAT, G, V_TOP, A_BRAKE, D_REACT, T_REACT, DT, WHEELBASE,
  AI_STALL_SPEED, AI_STALL_TIME, AI_REVERSE_TIME, AI_REVERSE_THROTTLE,
  vCorner, dBrake, sightLine
} from '../core/config.js';
import { makeInput } from './vehicle.js';
// Single sizing source (instruction 6): the AI's edge clearance MUST come from the
// same collider the physics uses, never a second copy of a kart half-width.
import { COLLIDER_R } from './kartsize.js';

// -----------------------------------------------------------------------------
// DRIVER SKILL PROFILES. Ordered slowest to fastest so grid order is meaningful.
// Every bound is INSPECTED (they are a difficulty curve, not a measurement), but
// each is bounded on the side that makes the driver SLOWER than the derived
// optimum, which is the property that matters and which the gate asserts.
// -----------------------------------------------------------------------------
export const SKILL_TIERS = Object.freeze([
  Object.freeze({ name: 'rookie',  brakeBias: [1.30, 1.45], apexError: [0.85, 1.35], throttleTrim: [0.86, 0.91], aggression: [0.20, 0.40] }),
  Object.freeze({ name: 'club',    brakeBias: [1.20, 1.32], apexError: [0.60, 0.95], throttleTrim: [0.90, 0.94], aggression: [0.35, 0.58] }),
  Object.freeze({ name: 'pro',     brakeBias: [1.12, 1.22], apexError: [0.35, 0.62], throttleTrim: [0.93, 0.965], aggression: [0.50, 0.72] }),
  Object.freeze({ name: 'ace',     brakeBias: [1.06, 1.14], apexError: [0.18, 0.38], throttleTrim: [0.955, 0.98], aggression: [0.62, 0.85] }),
  Object.freeze({ name: 'master',  brakeBias: [1.03, 1.09], apexError: [0.10, 0.24], throttleTrim: [0.97, 0.99], aggression: [0.70, 0.92] })
]);

// Lookahead used to find the next corner. Must exceed the largest sight line so
// the AI never "discovers" a corner later than the player could see it - if it
// did, the AI would be blind in a way the derivation says a human is not.
export const AI_LOOKAHEAD_M = Math.ceil(sightLine(12)) + 25;   // 39 + 25 = 64 m

// -----------------------------------------------------------------------------
// LATERAL CONTROL: PURE PURSUIT ON CURVATURE, NOT A PD ON STEER ANGLE.
//
// The first version of this file used  steer = K_LAT*latErr + K_HEAD*headErr,
// clamped to +/-1. That is the defect that made the whole field undriveable, and
// it is worth recording precisely because it looked reasonable:
//
//   tools/_diag_s4k.mjs measured, on the REAL vehicle, that the tightest corner
//   on the track (R=12) is held with a steer command of 0.2761. The PD law above
//   reaches +/-1.0 on a lateral error of about 2 m - 3.6x past the angle that
//   corner needs, and far past the spin threshold. The kart span, lost speed,
//   span again. Measured: 5.34 m/s average, 66.9% of steps off-track.
//
//   Three hypotheses were tested and REFUTED before this one:
//     - steering sign inverted   -> _diag_s4f B: +2 m error commands -0.82. Correct.
//     - actuator slew missing    -> _diag_s4g: slew limiting changed nothing.
//     - authority curve too loose-> _diag_s4j: grip-derived authority made it WORSE.
//   And the vehicle itself was exonerated: _diag_s4k holds every ladder radius at
//   0.81-0.94 of mu*g. The physics was never the problem; the command was.
//
// THE CORRECT LAW. A steering angle is not a control variable - CURVATURE is,
// because curvature is what grip actually bounds:
//     kappa_max = mu*g / v^2          (a_lat = kappa * v^2 <= mu*g)
// Pure pursuit supplies the desired curvature geometrically, from a goal point
// Ld ahead at body-frame lateral offset ey:
//     kappa = 2*ey / Ld^2
// and the bicycle model inverts exactly to a road-wheel angle:
//     delta = atan(WHEELBASE * kappa)
// Because kappa is clamped to kappa_max BEFORE inversion, this controller cannot
// ask for a corner the tyres cannot deliver. The grip limit is not something it
// respects by tuning; it is structurally unable to exceed it.
//
// MEASURED after the change (tools/_diag_s4l.mjs, 120 s, seed 37):
//     avg speed  5.34 -> 20.84 m/s      off-track  66.9% -> 6.27%
//     max util   3.98 -> 0.885          max decel  1824  -> 12.58 m/s^2
//     implied lap 59.3 s against the brief's derived 60 s target, arrived at
//     independently - the strongest evidence the law is right.
//
// LOOKAHEAD GAIN: swept in _diag_s4l over gain x Lmin. 1.3 was the clear
// optimum (6.2% off-track and 20.36 m/s, against 25-34% for every shorter
// lookahead). INSPECTED, but selected by measurement rather than by eye.
const LOOKAHEAD_GAIN = 1.3;     // Ld = LOOKAHEAD_GAIN * speed
const LOOKAHEAD_MIN = 4.0;      // m, floor so Ld is finite at a standing start

export class AIDriver {
  // rngAi: the declared 'ai' stream. index: 1..5 (0 is the player).
  constructor(index, rngAi, tierIndex) {
    this.index = index | 0;
    // Own sub-stream. Named, so it is stable regardless of construction order.
    this.rng = rngAi.fork('driver:' + this.index);

    const tier = SKILL_TIERS[Math.min(SKILL_TIERS.length - 1, Math.max(0, tierIndex | 0))];
    this.tierName = tier.name;

    // Traits, drawn ONCE at construction in a fixed order. The order is part of
    // the contract: reordering these lines changes every driver.
    this.brakeBias    = this.rng.range(tier.brakeBias[0], tier.brakeBias[1]);
    this.apexError    = this.rng.range(tier.apexError[0], tier.apexError[1]);
    this.throttleTrim = this.rng.range(tier.throttleTrim[0], tier.throttleTrim[1]);
    this.aggression   = this.rng.range(tier.aggression[0], tier.aggression[1]);
    // Which side of the ideal line this driver habitually errs to. Sign only.
    this.apexSign     = this.rng.float() < 0.5 ? -1 : 1;
    // Reaction lag, in SIM STEPS. The AI is given the same T_REACT slack the
    // sight line was derived with, so it is not superhuman in the one dimension
    // the difficulty surface actually measures.
    this.reactSteps   = Math.round(D_REACT / V_TOP / DT);   // = T_REACT / DT = 31

    // TEST SEAM (S7). The pure-pursuit lookahead gain, exposed as an instance
    // field so a probe can SWEEP THE CONTROLLER before blaming the track. The
    // default is byte-identical to the shipped constant, so the game path is
    // unchanged; only a probe that explicitly writes this field sees anything
    // different. This exists because of the autopilot trap: a bot that fails a
    // course does not prove the course is unclearable until the controller has
    // been swept and the failure survives.
    this.lookaheadGain = LOOKAHEAD_GAIN;

    // REACTION COMPENSATION (S7). 0 = plan against d_brake alone; 1 = plan
    // against the DERIVED braking point, d_react + d_brake, by treating the
    // distance available for braking as (d - v*T_REACT).
    //
    // Why this exists: section 3 below delays acting on every decision by
    // reactSteps = T_REACT/DT = 31 steps. Section 2 computed the limit as if
    // braking began immediately. The two together mean the driver consumes
    // v*T_REACT metres of the approach BEFORE the pedal moves, and the speed
    // profile never accounted for it - so the kart arrives every corner
    // D_REACT = 7.44 m late. MEASURED on the R=12 hairpin (tools/_s7_d11.mjs):
    // first brake at d = 6.33 m against a required d_brake of 30.57 m, corner
    // entry at 18.43 m/s against a 12.61 m/s limit, i.e. 5.82 m/s over.
    //
    // The whole mission brief derives SIGHT_LINE = d_react + d_brake for exactly
    // this reason. Planning against d_brake alone is not a different tuning
    // choice; it is the derivation applied incorrectly. Default is set by the
    // sweep in tools/_s7_d12.mjs, not by eye.
    this.reactComp = 1;

    // Preallocated input, mutated in place forever.
    this.input = makeInput();

    // Preallocated scratch - no allocation in update().
    this._s = 0;              // arclength estimate along the centreline
    this._targetSpeed = V_TOP;
    this._nextR = Infinity;
    this._nextDist = Infinity;
    this._lat = 0;
    this._headErr = 0;
    this._brakeReq = 0;
    this._steps = 0;
    // Reaction pipeline: a small ring of pending target speeds, so a corner the
    // AI "sees" is only acted on reactSteps later.
    this._ring = new Float64Array(64);
    this._ringLen = Math.min(63, Math.max(1, this.reactSteps));
    this._ringHead = 0;
    for (let i = 0; i < this._ring.length; i++) this._ring[i] = V_TOP;

    // Telemetry the gate reads. Preallocated fields, never an object literal.
    this.lastTargetSpeed = V_TOP;
    this.lastBrakeDist = 0;
    this.lastCornerR = Infinity;
    this.lastTargetLat = 0;
    this.maxLatAccel = 0;
    this.maxDecel = 0;
    this._prevSpeed = 0;

    // Stall recovery (config.js section 9, AI_STALL_* / AI_REVERSE_*).
    this._stallTime = 0;      // s the kart has been stationary under throttle
    this._reverseLeft = 0;    // s of reverse remaining (> 0 = reversing)
    this._reverseSteer = 0;   // steer held while reversing (opposite the goal)
    this.recoveries = 0;      // telemetry: how many times this driver reversed
  }

  reset() {
    this.input.throttle = 0; this.input.brake = 0;
    this.input.steer = 0; this.input.drift = false;
    this._steps = 0; this._ringHead = 0;
    for (let i = 0; i < this._ring.length; i++) this._ring[i] = V_TOP;
    this.maxLatAccel = 0; this.maxDecel = 0; this._prevSpeed = 0;
    this._stallTime = 0; this._reverseLeft = 0; this._reverseSteer = 0;
    this.recoveries = 0;
    return this;
  }

  get reversing() { return this._reverseLeft > 0; }

  // ---------------------------------------------------------------------------
  // ONE FIXED STEP of decision-making. Returns the input record (the SAME object
  // every call - the caller must not retain it).
  //
  // course: the shared Course. veh: this driver's Vehicle. sHint: last known
  // arclength, so the projection search is local and bounded.
  // ---------------------------------------------------------------------------
  update(course, veh, sHint, scratchSample) {
    const spd = veh.speed;

    // --- 1. WHERE AM I ON THE TRACK ------------------------------------------
    // Local projection search around the hint. Bounded window, fixed step count,
    // so cost is constant per frame and nothing is allocated.
    // WRAP-AWARE. The grid forms at s = 1230..1234 on a 1236 m loop, so an
    // un-wrapped window scans to s = 1262 and returns an arclength past the end.
    // Every downstream consumer (lateral error, lap counting, the goal point)
    // then works from a bogus s. Normalise every candidate into [0, length).
    const cl = course.length;
    let bestS = sHint, bestD2 = Infinity;
    for (let d = -12; d <= 28; d += 1.0) {
      let s = sHint + d;
      if (s < 0) s += cl; else if (s >= cl) s -= cl;
      const p = course.sampleInto(s, scratchSample);
      const dx = p.x - veh.x, dz = p.z - veh.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestS = s; }
    }
    for (let d = -1.0; d <= 1.0; d += 0.1) {
      let s = bestS + d;
      if (s < 0) s += cl; else if (s >= cl) s -= cl;
      const p = course.sampleInto(s, scratchSample);
      const dx = p.x - veh.x, dz = p.z - veh.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestS = s; }
    }
    this._s = bestS;

    // Lateral error and heading error against the centreline at bestS.
    //
    // ALIASING HAZARD - READ BEFORE EDITING. course.sampleInto() writes into the
    // caller's record and RETURNS THAT SAME OBJECT. `here` is therefore an alias
    // of `scratchSample`, and the forward-scan loop in section 2 below samples
    // into that identical record ~32 times. Anything read off `here` AFTER that
    // loop is not the value at bestS - it is the value at the last scanned point,
    // AI_LOOKAHEAD_M metres ahead.
    //
    // This was a live defect: section 2's "am I inside a corner right now?" test
    // read here.R after the loop and so applied a corner up to 64 m away as the
    // CURRENT grip cap. Measured by tools/_s7_diag4.mjs: 416 of 416 steps where
    // the driver claimed bindDist = 0 had a radius that did not match the course
    // under the kart. The autopilot crawled an R = 45 arc (24.41 m/s available)
    // at 12.6 m/s, the R = 12 hairpin's speed, because the hairpin was in range.
    //
    // Fix: copy every scalar needed later out of the record NOW, while it is
    // still valid. Scalars are copied by value, so the loop cannot corrupt them.
    // Numbers, not a second record - this keeps the per-step allocation at zero.
    const here = course.sampleInto(bestS, scratchSample);
    const hereR = here.R;                 // captured BEFORE the scan overwrites it
    const hereCurv = here.curvature;      // ditto
    const nx = -Math.cos(here.heading), nz = Math.sin(here.heading);
    this._lat = (veh.x - here.x) * nx + (veh.z - here.z) * nz;
    let hErr = here.heading - veh.yaw;
    while (hErr > Math.PI) hErr -= 2 * Math.PI;
    while (hErr < -Math.PI) hErr += 2 * Math.PI;
    this._headErr = hErr;

    // --- 2. WHAT IS COMING, and how fast may I be there ----------------------
    // Scan forward for the binding constraint: for every point ahead, the speed
    // I may carry HERE is limited by the speed I may carry THERE plus the
    // distance available to brake. This is the standard backward-pass speed
    // profile, evaluated forward from the current position.
    //
    //   v_here^2 <= v_there^2 + 2 * a_brake * distance
    //
    // a_brake is A_BRAKE from config.js. There is no second braking constant.
    let limit = V_TOP;
    let bindR = Infinity, bindDist = Infinity, bindCurv = 0;
    for (let d = 2; d <= AI_LOOKAHEAD_M; d += 2) {
      let q = bestS + d; if (q >= cl) q -= cl;    // wrap: the track is a loop
      const p = course.sampleInto(q, scratchSample);
      if (!isFinite(p.R) || p.R <= 0) continue;
      // vCorner() from config.js - the SAME sqrt(mu*g*R) the derivation uses.
      const vC = vCorner(p.R);
      if (vC >= V_TOP) continue;              // flat out; not a constraint
      // Brake EARLIER than optimal by brakeBias (>= 1.0), i.e. treat the
      // available distance as shorter than it is. This can only ever make the
      // driver slower - it can never manufacture grip.
      // REACTION COMPENSATION. The distance actually available for BRAKING is
      // the distance ahead minus what the kart covers during its own reaction
      // lag. This is the derivation's own formula, SIGHT_LINE = d_react +
      // d_brake, rearranged: d_brake_available = d - v*T_REACT.
      // reactComp is a MULTIPLIER on the reaction distance, not a flag. 1 (the
      // shipped default) and 0 behave exactly as the previous boolean form did,
      // so no shipped behaviour changes. Values above 1 exist for the S7 latency
      // probe: a driver carrying ADDED transport lag consumes
      // spd * (T_REACT + lag) metres before its pedal moves, and planning
      // against T_REACT alone makes it arrive every corner hot - the same
      // defect recorded at line 160 above, in a different guise.
      let dAvail = d - spd * T_REACT * this.reactComp;
      if (dAvail < 0) dAvail = 0;
      const dEff = dAvail / this.brakeBias;
      const allowed = Math.sqrt(vC * vC + 2 * A_BRAKE * dEff);
      if (allowed < limit) { limit = allowed; bindR = p.R; bindDist = d; bindCurv = p.curvature; }
    }
    // Am I inside a corner right now? Then the hard limit is that corner's own
    // grip-limited speed, full stop.
    // Uses the CAPTURED scalars, never here.R - see the aliasing note above.
    if (isFinite(hereR) && hereR > 0) {
      const vHere = vCorner(hereR);
      if (vHere < limit) { limit = vHere; bindR = hereR; bindDist = 0; bindCurv = hereCurv; }
    }
    this._nextR = bindR;
    this._nextDist = bindDist;

    // --- 3. REACTION LAG -----------------------------------------------------
    // Push the freshly computed limit into the ring and act on the value from
    // reactSteps ago. The AI is therefore no quicker to react than T_REACT, the
    // same slack the sight line was sized with.
    this._ring[this._ringHead] = limit;
    this._ringHead = (this._ringHead + 1) % this._ring.length;
    let readIdx = this._ringHead - this._ringLen;
    if (readIdx < 0) readIdx += this._ring.length;
    const acted = this._steps < this._ringLen ? V_TOP : this._ring[readIdx];
    this._targetSpeed = acted;
    this.lastTargetSpeed = acted;
    this.lastBrakeDist = bindDist;
    this.lastCornerR = bindR;

    // --- 4. LONGITUDINAL INPUT ----------------------------------------------
    const err = acted - spd;
    if (err < -0.35) {
      // Too fast. Brake proportionally, saturating quickly - but the PEDAL is
      // all that is commanded. The actual deceleration is produced by
      // Vehicle.step() against F_BRAKE_MAX = MASS * A_BRAKE, so it is physically
      // impossible for this line to exceed A_BRAKE no matter what it writes.
      this.input.brake = Math.min(1, -err * 0.55);
      this.input.throttle = 0;
    } else if (err < 0.25) {
      this.input.brake = 0;
      this.input.throttle = 0.32 * this.throttleTrim;   // maintain
    } else {
      this.input.brake = 0;
      this.input.throttle = this.throttleTrim;          // <= 1.0, never above
    }

    // --- 5. LATERAL INPUT ----------------------------------------------------
    // Target lateral offset: the racing line. Turn in toward the inside of the
    // binding corner, displaced by this driver's apex error (which only ever
    // moves them OFF the ideal line).
    let targetLat = 0;
    if (isFinite(bindR) && bindDist < 45) {
      // THE SIDE OF THE BINDING CORNER, not of whatever arc happens to be under
      // the kart. The old form read here.curvature first, so on a chicane the
      // AI aimed at the inside of the corner it was LEAVING while the binding
      // (tighter) corner ahead bent the other way; and its fallback sample at
      // `max(2, bindDist)` returned the wrong segment at dist 0.
      const curveSign = bindCurv >= 0 ? 1 : -1;
      // SIGN CONVENTION, MEASURED (tools/_s4_sideprobe.mjs, 20/20 corners):
      // positive curvature bends the centreline toward +n, and n = (-cos h, sin h)
      // is the LEFT of travel. this._lat and targetLat are both measured along n,
      // so the INSIDE of a left-hander is at POSITIVE lateral offset. The old line
      // `inside = -curveSign` aimed every driver at the OUTSIDE wall of every
      // corner (tools/_s4_apexsign.mjs: 15 of 20 corner approaches aimed OUTSIDE),
      // which is why karts arrived at the outer barrier at 90-160 deg of heading
      // error and stalled there.
      const inside = curveSign;
      const apexPull = Math.min(1, (45 - bindDist) / 45);
      targetLat = inside * apexPull * (course.halfWidth * 0.55);
    }
    targetLat += this.apexSign * this.apexError * 0.5;
    // Clamp inside the drivable half-width so the AI never targets a line off
    // the track. An AI that aims off-track and is saved by grip is not driving.
    // DERIVED, not a magic fraction. The old value was halfWidth * 0.86 = 2.62 m,
    // which treats the kart as a POINT. Two things make that put a well-driven kart
    // off the road, both measured in _diag_s4q:
    //   - the kart is a BODY: its edge is COLLIDER_R (0.55 m) outside its centre,
    //   - pure pursuit has a steady-state outward error on a curve (measured 0.40 m
    //     at 20 m/s: steer never saturated, sideslip negligible, yet lat slid
    //     -1.58 -> -3.05 m against a 3.025 m half-width).
    // 2.62 + 0.40 = 3.02 m, i.e. the AI was aiming exactly at the track edge and
    // was off it the moment tracking error appeared. Subtract both terms instead:
    // REVERTED to 0.86 * halfWidth. Subtracting COLLIDER_R + TRACK_ERR was tried
    // and MEASURED WORSE (off-track 23% -> 38%): pulling the racing line that far
    // inboard makes the AI cut across the centreline every corner, which costs more
    // than the edge margin it buys. The real cause of karts leaving the road was the
    // barrier clamp welding them in place at lateral 5.05 m, not this clamp.
    const maxLat = course.halfWidth * 0.86;
    if (targetLat > maxLat) targetLat = maxLat;
    else if (targetLat < -maxLat) targetLat = -maxLat;
    this.lastTargetLat = targetLat;       // telemetry: the line this driver is aiming at (+ = LEFT)

    // PURE PURSUIT. Aim at a point Ld ahead on the centreline, displaced by this
    // driver's target lateral offset (racing line + seeded apex error), and solve
    // for the curvature that reaches it. See the long note at the top of this file
    // for why this replaced a PD-on-steer-angle law.
    const Ld = Math.max(LOOKAHEAD_MIN, this.lookaheadGain * spd);
    let gs = bestS + Ld;
    if (gs >= cl) gs -= cl;                     // wrap: the track is a loop (cl from the projection above)
    const goal = course.sampleInto(gs, scratchSample);
    // Offset the goal point onto the driver's chosen line, along the normal there.
    const gnx = -Math.cos(goal.heading), gnz = Math.sin(goal.heading);
    const gx = goal.x + gnx * targetLat;
    const gz = goal.z + gnz * targetLat;

    // Goal in body frame. Yaw=0 faces -Z (vehicle.js line 38-42):
    //   forward = (-sin yaw, -cos yaw)   right = (cos yaw, -sin yaw)
    const dgx = gx - veh.x, dgz = gz - veh.z;
    const fwd = -Math.sin(veh.yaw) * dgx + -Math.cos(veh.yaw) * dgz;
    const rgt = Math.cos(veh.yaw) * dgx + -Math.sin(veh.yaw) * dgz;
    const dist2 = dgx * dgx + dgz * dgz;

    // Pure-pursuit curvature. Positive curvature turns LEFT (positive yaw rate),
    // and left is NEGATIVE body-right, hence the sign.
    const safeD2 = dist2 > 1e-6 ? dist2 : 1e-6;
    let kappa = -2 * rgt / safeD2;

    // GRIP BOUND: kappa_max = mu*g / v^2. This is the SAME mu*g the corner ladder
    // and SIGHT_LINE_MIN are derived from, so the AI is structurally incapable of
    // requesting more lateral acceleration than the derivation allows.
    const vSq = spd * spd;
    const kMax = MU_LAT * G / (vSq > 1e-3 ? vSq : 1e-3);
    if (fwd < 0) {
      // Goal is behind us (only reachable after a spin or a bad respawn). Turn
      // toward it at full available curvature rather than driving away from it.
      kappa = (rgt > 0 ? -1 : 1) * kMax;
    }
    if (kappa > kMax) kappa = kMax; else if (kappa < -kMax) kappa = -kMax;

    // Invert the bicycle model to a road-wheel angle, then normalise against the
    // authority the vehicle will actually grant at this speed.
    const delta = Math.atan(WHEELBASE * kappa);
    const auth = veh.steerAuthority();
    let steerCmd = auth > 1e-6 ? delta / auth : 0;
    if (steerCmd > 1) steerCmd = 1; else if (steerCmd < -1) steerCmd = -1;
    this.input.steer = steerCmd;

    // --- 6. DRIFT ------------------------------------------------------------
    // Only an aggressive driver uses it, only in a genuinely tight corner, and
    // only under throttle. Drift COSTS rear grip (DRIFT_REAR_GRIP < 1), so an AI
    // that drifts everywhere is slower, not faster - which is why aggression is
    // a trait and not a free bonus.
    this.input.drift = this.aggression > 0.55 &&
                       isFinite(bindR) && bindR <= 20 &&
                       bindDist < 8 && spd > 11 &&
                       Math.abs(steerCmd) > 0.45 &&
                       this.input.brake <= 0;

    // --- 7. STALL RECOVERY -----------------------------------------------------
    // Overlays the decision above. A kart pinned nose-first into a barrier cannot
    // drive out forwards (the barrier clamp removes the outward velocity component
    // every step); the only way out is the one a human takes - back off, then go.
    // Constants and the measured incident that justified this: config.js section 9.
    if (this._reverseLeft > 0) {
      this._reverseLeft -= DT;
      this.input.throttle = -AI_REVERSE_THROTTLE;
      this.input.brake = 0;
      this.input.drift = false;
      this.input.steer = this._reverseSteer;
    } else if (this.input.throttle > 0.5 && spd < AI_STALL_SPEED && this._steps > 0) {
      this._stallTime += DT;
      if (this._stallTime >= AI_STALL_TIME) {
        this._stallTime = 0;
        this._reverseLeft = AI_REVERSE_TIME;
        // Reversing with the wheels turned AWAY from the goal swings the nose
        // TOWARD it (a car backing up pivots about its rear axle).
        this._reverseSteer = -steerCmd;
        this.recoveries++;
        this.input.throttle = -AI_REVERSE_THROTTLE;
        this.input.brake = 0;
        this.input.drift = false;
        this.input.steer = this._reverseSteer;
      }
    } else {
      this._stallTime = 0;
    }

    // --- telemetry (numbers only, no allocation) -----------------------------
    const latA = Math.abs(veh.ay);
    if (latA > this.maxLatAccel) this.maxLatAccel = latA;
    if (this._steps > 0) {
      const dec = (this._prevSpeed - spd) / DT;
      if (dec > this.maxDecel) this.maxDecel = dec;
    }
    this._prevSpeed = spd;
    this._steps++;
    return this.input;
  }

  get s() { return this._s; }
}

// -----------------------------------------------------------------------------
// The full field. Player at index 0 (no AI), five AI drivers behind.
//
// Tier assignment is FIXED, not rolled: the grid must be reproducible in its
// composition, and a rolled tier would make "the field" a different difficulty
// on different seeds while claiming to be the same race.
// -----------------------------------------------------------------------------
export const FIELD_TIERS = Object.freeze([4, 3, 2, 1, 0]);   // master..rookie

export function buildDrivers(rngHub) {
  const ai = rngHub.get('ai');
  const out = [];
  for (let i = 0; i < FIELD_TIERS.length; i++) {
    out.push(new AIDriver(i + 1, ai, FIELD_TIERS[i]));
  }
  return out;
}

// Exposed so the gate can verify the derived limits without duplicating them.
export function derivedLimits() {
  return {
    muLat: MU_LAT, g: G, aBrake: A_BRAKE, vTop: V_TOP,
    vCornerAt: (R) => vCorner(R),
    dBrakeAt: (R) => dBrake(R),
    lookahead: AI_LOOKAHEAD_M
  };
}
