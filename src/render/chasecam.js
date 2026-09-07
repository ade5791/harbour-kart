// =============================================================================
// Harbour Kart - CHASE CAMERA. Reference geometry, spring-damped, sight-safe.
// =============================================================================
//
// REFERENCE GEOMETRY (step instruction 3): "roughly kart-roof height, about 1 to
// 1.5 kart lengths back, with the rear and top of the player kart and the
// driver's back visible."
//
// Both of those are expressed AS MULTIPLES OF THE KART, not as free metres, so
// they are anchored to the sizing contract:
//     distance = 1.25 * KART_L   (midpoint of the stated 1.0-1.5 range)
//     height   = kart roof height + a small rise
// "Kart roof height" is not a guess either - it is the top of the driver's
// helmet, which kartsize.js already derives. So if the kart changes size, the
// camera moves with it and the framing is preserved by construction.
//
// WHY THIS MODULE IS SHARED WITH THE GATE, AND WHY THAT MATTERS
//
// Step instruction 3 ends with the load-bearing sentence: "if the camera hides a
// corner that the track validation says is visible, the validation was run from
// the wrong eye point. Re-run it from the ACTUAL camera."
//
// S3 validated sight lines from EYE_H = 1.35 m, standing on the centreline. The
// real camera is neither of those things - it is HIGHER (so it sees further over
// short occluders) and BEHIND the kart (so it is further from the corner, which
// costs distance). Those two effects pull in opposite directions and neither can
// be assumed to win. It has to be measured.
//
// So the camera's steady-state eye offset is exported as a pure function, and
// tools/kartgate.mjs imports THIS function - not a copy of the numbers - to
// re-cast every sight line. If the camera geometry is ever changed, the gate
// re-measures automatically. A second copy of the offsets in the gate would let
// the two silently diverge, which is the exact failure mode the sizing contract
// exists to prevent for the kart.
//
// ZERO ALLOCATION: update() writes into preallocated vectors.

import * as THREE from 'three';
import { L as KART_L, SEAT_Y, TORSO_H, HELMET_R } from '../sim/kartsize.js';
import { V_TOP } from '../core/config.js';

// -----------------------------------------------------------------------------
// GEOMETRY, all derived from the kart.
// -----------------------------------------------------------------------------

// The top of the driver's helmet - the tallest point of the kart, i.e. its
// "roof". DERIVED from kartsize.js, not typed.
export const KART_ROOF_H = SEAT_Y + TORSO_H * 0.86 + HELMET_R;

// Base follow distance: 1.25 kart lengths, the midpoint of the reference's
// "1 to 1.5 kart lengths back".
export const CAM_DIST_KARTS = 1.25;
export const CAM_DIST_BASE = CAM_DIST_KARTS * KART_L;        // 2.3125 m

// Base eye height. The reference camera sits "roughly at kart-roof height"; a
// camera exactly AT roof height cannot see the top of the kart, and the frame
// clearly shows the rear AND TOP of the player kart plus the driver's back. So
// it must be slightly above the roof. 1.14x is INSPECTED - it is the smallest
// rise that puts the kart's top surface inside the frame at the base distance,
// and the gate verifies the resulting framing rather than trusting the factor.
export const CAM_HEIGHT_FACTOR = 1.14;
export const CAM_HEIGHT_BASE = KART_ROOF_H * CAM_HEIGHT_FACTOR;

// Look-at target: slightly ahead of and above the kart, so the kart sits in the
// lower-centre of the frame exactly as the reference shows it, rather than dead
// centre.
export const LOOK_AHEAD_BASE = 0.85 * KART_L;
export const LOOK_HEIGHT = KART_ROOF_H * 0.62;

// Speed response. Pull back and widen with speed for the sense of speed
// (step instruction 3). Both are bounded so the framing never leaves the
// reference envelope: max distance stays within the 1.0-1.5 kart-length band's
// upper end plus a small overshoot allowance.
export const CAM_DIST_SPEED_GAIN = 0.42 * KART_L;   // extra metres at V_TOP
export const FOV_BASE = 62;                          // deg
export const FOV_SPEED_GAIN = 12;                    // deg added at V_TOP

// Spring-damper. Critically damped so the camera never oscillates behind the
// kart - an oscillating chase camera at 28 m/s reads as the track wobbling.
export const CAM_SPRING = 9.5;      // 1/s
export const CAM_DAMP = 2 * Math.sqrt(CAM_SPRING);   // critical damping

// BOOM-YAW spring. The boom is sprung in POLAR coordinates about the kart
// (angle + length), not in world space - see the MEASURED DEFECT note in
// update(). A critically damped angle spring lags a steady yaw rate w by
// 2*w/sqrt(k). Sized so the R=12 hairpin at its corner speed (w = v/R =
// 12.6/12 = 1.05 rad/s) swings the view ~15 deg, visible but never the
// side-on view a 9.5 spring gives (70 deg at the 1.88 rad/s measured in a
// spin). INSPECTED.
export const CAM_YAW_SPRING = 65;   // 1/s^2
export const CAM_YAW_DAMP = 2 * Math.sqrt(CAM_YAW_SPRING);

// Collision safety: the camera must never clip through kerbs, barriers or
// buildings (step instruction 3). It is pulled in along the boom until clear.
export const CAM_MIN_DIST = 0.55 * KART_L;
export const CAM_PROBE_R = 0.35;      // m, camera near-clearance sphere

// -----------------------------------------------------------------------------
// THE SHARED GEOMETRY FUNCTION. The gate imports this.
//
// Returns the STEADY-STATE eye position for a kart at (x, z, yaw) travelling at
// `speed`, written into `out`. Steady state - not the spring's current position -
// because the sight-line question is "where is the eye when the driver is
// approaching this corner at racing speed", which is the settled pose.
// -----------------------------------------------------------------------------
export function chaseEye(x, z, yaw, speed, out) {
  const dist = CAM_DIST_BASE + CAM_DIST_SPEED_GAIN * Math.min(1, speed / V_TOP);
  // forward = (-sin yaw, 0, -cos yaw). The camera sits BEHIND, i.e. -forward.
  out.x = x + Math.sin(yaw) * dist;
  out.z = z + Math.cos(yaw) * dist;
  out.y = CAM_HEIGHT_BASE;
  out.dist = dist;
  return out;
}

// The point the camera looks at, for the same pose.
export function chaseTarget(x, z, yaw, out) {
  out.x = x - Math.sin(yaw) * LOOK_AHEAD_BASE;
  out.z = z - Math.cos(yaw) * LOOK_AHEAD_BASE;
  out.y = LOOK_HEIGHT;
  return out;
}

export function chaseFov(speed) {
  return FOV_BASE + FOV_SPEED_GAIN * Math.min(1, speed / V_TOP);
}

// -----------------------------------------------------------------------------
// THE RUNTIME CAMERA.
// -----------------------------------------------------------------------------
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    // Preallocated. update() creates nothing.
    this._desired = new THREE.Vector3();
    this._targetPt = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._prevDesired = new THREE.Vector3();
    this._hasPrevDesired = false;
    // Polar boom state: sprung angle (world yaw of the boom) and its rate.
    this._boomYaw = 0;
    this._boomYawVel = 0;
    this._boomLen = CAM_DIST_BASE;
    this._boomLenVel = 0;
    // Shipped ON. Off = spring the eye in world space (the measured defect).
    this.polarBoom = true;
    // Shipped ON. The probe (tools/_s4_camlag.mjs) flips it off to reproduce
    // the measured lag as a negative control.
    this.feedForward = true;
    this._eye = { x: 0, y: 0, z: 0, dist: 0 };
    this._look = { x: 0, y: 0, z: 0 };
    this._initialised = false;

    // Impact impulse (step requirement 5).
    this.impulseX = 0; this.impulseY = 0;
    this._impMag = 0; this._impT = 0; this._t = 0;

    this.lastDist = CAM_DIST_BASE;
    this.lastFov = FOV_BASE;
    this.clippedBy = null;
  }

  reset(x, z, yaw, speed) {
    chaseEye(x, z, yaw, speed || 0, this._eye);
    this._pos.set(this._eye.x, this._eye.y, this._eye.z);
    this._vel.set(0, 0, 0);
    this._boomYaw = yaw;
    this._boomYawVel = 0;
    this._boomLen = this._eye.dist;
    this._boomLenVel = 0;
    this._hasPrevDesired = false;
    this._initialised = true;
    this.impulseX = 0; this.impulseY = 0; this._impT = 0;
    return this;
  }

  // occluders: the SAME list the sight test uses (track.occluders). Passing the
  // same array is deliberate - a camera that avoids a different set of solids
  // than the sight test measures against would make the two disagree.
  update(dt, x, y, z, yaw, speed, occluders) {
    this._t += dt;
    if (!this._initialised) this.reset(x, z, yaw, speed);

    chaseEye(x, z, yaw, speed, this._eye);
    chaseTarget(x, z, yaw, this._look);

    // --- BOOM YAW: SPRING THE ANGLE, NOT THE WORLD POSITION -------------------
    // MEASURED DEFECT (K19b after the AI stall-recovery landed): with the eye
    // sprung in world space, a kart yawing at 1.88 rad/s at 11 km/h (the pilot
    // swinging its nose off a barrier) put the eye 1.84 m off the designed
    // distance - the boom tip has to travel dist*w = 4.7 m/s sideways to keep
    // up and the world spring cannot. The kart's forward displacement is fed
    // forward (below), but a rotation about the kart is not a displacement of
    // the kart, so it was never fed forward. Spring the BOOM ANGLE about the
    // kart instead: the eye then sits at exactly the designed radius and only
    // the view angle lags, by 2*w/sqrt(k), which is the swing a chase camera
    // is supposed to show. Off = the old world-space path (negative control).
    // feedForward=false is the probe's negative control for the ORIGINAL
    // world-space lag; it must reproduce that defect, so it disables the
    // polar boom too.
    const polar = this.polarBoom && this.feedForward;
    let boomYaw = yaw;
    if (polar) {
      let e = yaw - this._boomYaw;
      while (e > Math.PI) e -= 2 * Math.PI;
      while (e < -Math.PI) e += 2 * Math.PI;
      const acc = CAM_YAW_SPRING * e - CAM_YAW_DAMP * this._boomYawVel;
      this._boomYawVel += acc * dt;
      this._boomYaw += this._boomYawVel * dt;
      while (this._boomYaw > Math.PI) this._boomYaw -= 2 * Math.PI;
      while (this._boomYaw < -Math.PI) this._boomYaw += 2 * Math.PI;
      boomYaw = this._boomYaw;
    }

    // --- COLLISION SAFETY -----------------------------------------------------
    // Walk the boom from the kart out to the desired eye and stop short of any
    // solid the camera sphere would enter. This is what keeps the camera out of
    // kerbs, barriers and buildings. Walked along the SPRUNG boom, because that
    // is where the camera actually is.
    let dist = this._eye.dist;
    this.clippedBy = null;
    if (occluders && occluders.length) {
      const bx = Math.sin(boomYaw), bz = Math.cos(boomYaw);   // boom direction (backwards)
      for (let i = 0; i < occluders.length; i++) {
        const o = occluders[i];
        if (o.top <= 0.2) continue;
        // Only solids at or above the camera height can actually clip it.
        if (o.top < CAM_HEIGHT_BASE * 0.5) continue;
        // Closest approach of the boom segment to this occluder's circle.
        const fx = x - o.x, fz = z - o.z;
        const b = fx * bx + fz * bz;
        const c = fx * fx + fz * fz - (o.r + CAM_PROBE_R) * (o.r + CAM_PROBE_R);
        const disc = b * b - c;
        if (disc <= 0) continue;
        const sq = Math.sqrt(disc);
        const t0 = -b - sq, t1 = -b + sq;
        // First entry along the positive boom direction.
        const tEnter = t0 > 0 ? t0 : (t1 > 0 ? 0 : -1);
        if (tEnter >= 0 && tEnter < dist) {
          dist = Math.max(CAM_MIN_DIST, tEnter);
          this.clippedBy = o.src || 'solid';
        }
      }
    }
    this._desired.set(x + Math.sin(boomYaw) * dist, this._eye.y, z + Math.cos(boomYaw) * dist);
    this.lastDist = dist;

    // --- FEED-FORWARD, THEN SPRING THE RESIDUAL ------------------------------
    // MEASURED DEFECT (S4 capture): a critically damped spring on WORLD position
    // lags a constant-velocity target by c*V/k = 2*sqrt(9.5)*V/9.5 - 7.46 m at
    // 41 km/h (capture read 8.25 m against a designed 2.62 m) and 18.6 m at
    // V_TOP. A rival kart sat between the camera and the player. The gate's
    // K19 checked chaseEye()'s steady-state formula and passed; the runtime
    // never reached that pose. Fix: translate the camera by the KART's own
    // displacement this frame (feed-forward), so a kart at constant velocity
    // has ZERO steady-state lag, and let the spring absorb only the BOOM
    // residual - yaw swing and the speed-dependent pull-back - which is what
    // the damping is for. (Feeding forward the whole desired-eye delta was
    // tried first: it drove the error to 1e-14 m, i.e. a rigid mount with an
    // inert spring, which is not a spring-damped follow.)
    if (polar) {
      // POLAR FOLLOW. The boom angle is sprung above; the boom LENGTH is
      // sprung here with the same world constants (pull-back with speed and
      // release when a clip clears are the only things that move it). The
      // eye is then the kart plus the sprung boom - it rides WITH the kart,
      // so a moving kart never leaves it behind, and it still swings and
      // breathes, which is what a spring-damped chase camera is for.
      const eL = dist - this._boomLen;
      const accL = CAM_SPRING * eL - CAM_DAMP * this._boomLenVel;
      this._boomLenVel += accL * dt;
      this._boomLen += this._boomLenVel * dt;
      if (this._boomLen < CAM_MIN_DIST) { this._boomLen = CAM_MIN_DIST; this._boomLenVel = 0; }
      this._pos.set(x + Math.sin(boomYaw) * this._boomLen, this._eye.y, z + Math.cos(boomYaw) * this._boomLen);
      this._prevDesired.set(x, 0, z);
      this._hasPrevDesired = true;
    } else {
      if (this._hasPrevDesired && this.feedForward) {
        this._tmp.set(x - this._prevDesired.x, 0, z - this._prevDesired.z);
        this._pos.add(this._tmp);
      }
      this._prevDesired.set(x, 0, z);
      this._hasPrevDesired = true;

      // --- CRITICALLY DAMPED WORLD SPRING (negative-control path) ------------
      // acc = k*(desired - pos) - c*vel, integrated semi-implicitly. No
      // allocation: _tmp is reused.
      this._tmp.copy(this._desired).sub(this._pos).multiplyScalar(CAM_SPRING);
      this._tmp.addScaledVector(this._vel, -CAM_DAMP);
      this._vel.addScaledVector(this._tmp, dt);
      this._pos.addScaledVector(this._vel, dt);
    }

    // --- IMPACT IMPULSE (step requirement 5) ---------------------------------
    if (this._impT > 0) {
      this._impT -= dt;
      if (this._impT < 0) this._impT = 0;
      this.impulseX = Math.sin(this._t * 53.0) * this._impMag * this._impT;
      this.impulseY = Math.sin(this._t * 71.0) * this._impMag * this._impT * 0.7;
    } else {
      this.impulseX = 0; this.impulseY = 0;
    }

    this.camera.position.set(
      this._pos.x + this.impulseX,
      this._pos.y + this.impulseY,
      this._pos.z
    );
    this._targetPt.set(this._look.x, this._look.y + y, this._look.z);
    this.camera.lookAt(this._targetPt);

    const baseFov = chaseFov(speed);
    // Preserve at least the square-view horizontal coverage on narrow screens.
    // Landscape framing and the collision-safe camera boom remain unchanged.
    const aspect = Math.max(0.25, this.camera.aspect);
    const fov = aspect < 1 ? Math.min(105,
      2 * Math.atan(Math.tan(baseFov * Math.PI / 360) / aspect) * 180 / Math.PI) : baseFov;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.lastFov = fov;
    return this;
  }

  addImpulse(mag, duration) {
    if (mag > this._impMag || this._impT <= 0) this._impMag = mag;
    this._impT = Math.max(this._impT, duration);
    return this;
  }

  // Framing report, so the "rear and top of the kart and the driver's back are
  // visible" claim is checkable rather than asserted.
  framing() {
    return {
      distKarts: CAM_DIST_KARTS,
      distBase: CAM_DIST_BASE,
      distMax: CAM_DIST_BASE + CAM_DIST_SPEED_GAIN,
      distMaxKarts: (CAM_DIST_BASE + CAM_DIST_SPEED_GAIN) / KART_L,
      kartRoofH: KART_ROOF_H,
      eyeH: CAM_HEIGHT_BASE,
      heightFactor: CAM_HEIGHT_FACTOR,
      lookAhead: LOOK_AHEAD_BASE,
      lookH: LOOK_HEIGHT,
      fovBase: FOV_BASE,
      fovMax: FOV_BASE + FOV_SPEED_GAIN
    };
  }
}
