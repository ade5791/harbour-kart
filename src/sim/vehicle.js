// =============================================================================
// Harbour Kart - vehicle dynamics. Fixed-step, zero-allocation, SI units.
// =============================================================================
//
// WHY THIS IS A REAL TYRE MODEL AND NOT A KINEMATIC CHEAT
//
// The cheap way to make a kart game is: rotate the mesh by a steering input and
// translate it along its own forward axis. That is a KINEMATIC cheat and it is
// forbidden here for one specific, non-aesthetic reason - it has no GRIP LIMIT.
// A cheat corners at any radius you ask for at any speed you like. But
// SIGHT_LINE_MIN, the derived difficulty constant this entire mission hangs off,
// is computed FROM the grip limit:
//
//     v_corner = sqrt(mu * g * R)  ->  d_brake  ->  SIGHT_LINE_MIN
//
// If the sim has no grip limit, none of that is true inside the game. The
// numbers would still be printed in config.js and the track would still be built
// to them, but nothing the player drives would obey them. The difficulty
// contract would be decoration.
//
// So: a bicycle model with per-axle slip angles, a Pacejka-style magic-formula
// lateral tyre curve, a friction ellipse coupling longitudinal demand to lateral
// capacity, and yaw dynamics integrated against a real yaw inertia. The grip
// limit is then an EMERGENT property of the model, and tools/vehgate.mjs measures
// it by driving an actual steady-state skidpad rather than by reading a constant.
//
// A CONSEQUENCE WORTH STATING, because it is the reason the skidpad test can be
// exact rather than approximate: config.js sets
//     CG_TO_FRONT = L * rear_frac    and    CG_TO_REAR = L * front_frac
// so b/a = front_frac/rear_frac = Fz_front/Fz_rear. The steady-state yaw-moment
// balance Fyf*a = Fyr*b is therefore satisfied exactly when both axles run at the
// SAME friction utilisation. Both saturate together, total lateral force at the
// limit is mu*(Fzf+Fzr) = mu*m*g, and the skidpad limit is exactly sqrt(mu*g*R).
// That is a designed property of the mass layout, not a happy accident, and the
// gate asserts it.
//
// COORDINATE FRAME - GameBlocks WorldBasis default: right=+X, up=+Y, forward=-Z.
// Yaw is measured about +Y, right-hand rule, so yaw=0 faces -Z:
//     forward = (-sin(yaw), 0, -cos(yaw))
//     right   = ( cos(yaw), 0, -sin(yaw))
//     right x forward = +Y  (this is what WorldBasis.validateAxes enforces)
// Positive yaw rate therefore turns LEFT, and positive steer input turns left.
//
// ZERO ALLOCATION: step() creates no objects. Every scratch value is a numeric
// field on the instance, preallocated in the constructor. No Vector3, no object
// literal, no array, no closure, no string concatenation on the hot path.
// tools/_allocprobe.mjs measures the marginal allocation slope to prove it.
//
// NO Math.random(): this module is fully deterministic. Any stochastic behaviour
// (AI decisions, surface noise) is injected by the caller from a seeded stream.

import {
  G, DT,
  MU_LAT, MU_LONG, A_BRAKE, V_TOP,
  MASS, I_ZZ, WHEELBASE, CG_TO_FRONT, CG_TO_REAR, FZ_FRONT, FZ_REAR,
  AIR_RHO, CD_A, C_RR, ENGINE_POWER, F_DRIVE_MAX, F_BRAKE_MAX, V_POWER_REF,
  TYRE_B, TYRE_C, TYRE_E, V_SLIP_MIN,
  STEER_MAX, STEER_RATE, STEER_RETURN, STEER_SPEED_FALLOFF,
  STEER_GRIP_TARGET, STEER_SLIP_ALLOWANCE, CORNER_POWER_RESERVE,
  DRIFT_MIN_SPEED, DRIFT_STARTUP, DRIFT_MIN_STEER_FRAC, DRIFT_REAR_GRIP,
  DRIFT_SUSTAIN_STEER_FRAC, DRIFT_SUSTAIN_REAR_SAT, DRIFT_SPIN_BETA,
  DRIFT_CHARGE_RATE, DRIFT_TIER_1, DRIFT_TIER_2, DRIFT_MAX_CHARGE,
  DRIFT_BOOST_1_S, DRIFT_BOOST_2_S, DRIFT_BOOST_FORCE,
  SURFACE_GRIP, SURFACE_DRAG
} from '../core/config.js';

// -----------------------------------------------------------------------------
// The magic formula, NORMALISED to peak at 1.0.
//
//   mf(a) = sin( C * atan( B*a - E*(B*a - atan(B*a)) ) )
//
// Returned in [-1, 1]; the caller multiplies by that axle's available lateral
// capacity. Normalising here rather than folding Fz*mu into the curve is what
// lets the friction ellipse shrink capacity without distorting the curve SHAPE.
// -----------------------------------------------------------------------------
export function magicFormula(alpha) {
  const ba = TYRE_B * alpha;
  const inner = ba - TYRE_E * (ba - Math.atan(ba));
  return Math.sin(TYRE_C * Math.atan(inner));
}

// Slip angle at which magicFormula peaks. Solved once at module load by a
// deterministic bisection on the derivative sign - NOT hand-typed, because a
// hand-typed peak location is exactly the kind of unchecked number this project
// keeps paying for. 200 fixed iterations, no RNG, no allocation beyond three
// locals.
export const ALPHA_PEAK = (function solvePeak() {
  let lo = 0, hi = 0.6;                       // rad; the peak is inside this band
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const h = 1e-7;
    const slope = magicFormula(mid + h) - magicFormula(mid - h);
    if (slope > 0) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
})();

// Input record. Allocated ONCE by the caller and mutated in place - never
// rebuilt per frame. makeInput() exists so every call site uses the same shape
// and a typo becomes undefined rather than a silently ignored extra field.
export function makeInput() {
  return { throttle: 0, brake: 0, steer: 0, drift: false };
}

export const DRIFT_STATE = Object.freeze({ NONE: 0, STARTUP: 1, SUSTAIN: 2, PAYOFF: 3 });

export class Vehicle {
  constructor(id = 0) {
    this.id = id | 0;

    // ---- pose, world frame (metres, radians) ----
    this.x = 0; this.z = 0; this.yaw = 0;

    // ---- velocity, BODY frame ----
    this.u = 0;          // m/s along forward
    // LATERAL VELOCITY IS POSITIVE TO THE LEFT. The rigid-body equations below
    // are the standard y-LEFT bicycle model (m(v' + u r) = Fy with r positive
    // to the LEFT), so the same lateral force that yaws the kart left also makes
    // v positive. The pose integrator and every world-frame consumer MUST add v
    // along LEFT = (-cos yaw, 0, +sin yaw). MEASURED defect (S4, _s4_betaprobe2):
    // this field was documented and integrated as "positive = right", so at 3 m/s
    // in a left turn (tyres at 6% utilisation) the CG velocity came out RIGHT of
    // the nose - the mirror image of the kinematic bicycle - and a kart pressed
    // into a barrier could not free itself (3 of 5 AI stuck 42-55 s of a 90 s run).
    this.v = 0;          // m/s along LEFT (positive = sliding left, see above)
    this.r = 0;          // rad/s yaw rate (positive = turning left)

    // ---- steering ----
    this.steerAngle = 0; // rad at the road wheels, after rate limiting

    // ---- drift resource ----
    this._driftRecovery = false;
    this.driftState = DRIFT_STATE.NONE;
    this.driftHeld = 0;      // s of qualifying input held
    this.driftCharge = 0;    // s of accumulated sustain
    this.driftDir = 0;       // +1 left, -1 right; locked at commitment
    this.boostTimer = 0;     // s of boost remaining
    this.lastBoostTier = 0;

    // ---- surface ----
    this.surface = 'boardwalk';
    this.gripScale = 1;
    this.dragScale = 1;

    // ---- telemetry, read-only to the outside; preallocated numbers only ----
    this.alphaF = 0; this.alphaR = 0;
    this.fyF = 0; this.fyR = 0; this.fx = 0;
    this.ay = 0;             // lateral acceleration, m/s^2
    this.utilF = 0; this.utilR = 0;   // friction utilisation per axle, 0..1
    this.airborne = false;
    this.simTime = 0;
    this.steps = 0;

    // ---- scratch. Every temporary the integrator needs, preallocated. ----
    this._s = 0; this._c = 0;
    this._du = 0; this._dv = 0; this._dr = 0;
    this._capF = 0; this._capR = 0;
    this._fxF = 0; this._fxR = 0;
    this._t0 = 0; this._t1 = 0; this._t2 = 0;
  }

  reset(x = 0, z = 0, yaw = 0, speed = 0) {
    this.x = x; this.z = z; this.yaw = yaw;
    this.u = speed; this.v = 0; this.r = 0;
    this.steerAngle = 0;
    this._driftRecovery = false;
    this.driftState = DRIFT_STATE.NONE;
    this.driftHeld = 0; this.driftCharge = 0; this.driftDir = 0;
    this.boostTimer = 0; this.lastBoostTier = 0;
    this.setSurface('boardwalk');
    this.alphaF = 0; this.alphaR = 0;
    this.fyF = 0; this.fyR = 0; this.fx = 0; this.ay = 0;
    this.utilF = 0; this.utilR = 0;
    this.simTime = 0; this.steps = 0;
    return this;
  }

  // Surface is set by the caller (track system) from the SURFACES closed set in
  // bus.js. Grip and drag scales come from config, never from a literal here.
  setSurface(name) {
    const g = SURFACE_GRIP[name];
    if (g === undefined) {
      throw new Error(
        'Vehicle.setSurface: unknown surface "' + name + '". The set is closed - ' +
        'add it to SURFACES in bus.js AND to SURFACE_GRIP/SURFACE_DRAG in config.js.'
      );
    }
    this.surface = name;
    this.gripScale = g;
    this.dragScale = SURFACE_DRAG[name];
    return this;
  }

  get speed() { return Math.sqrt(this.u * this.u + this.v * this.v); }
  get speedKmh() { return this.speed * 3.6; }

  // Steering authority available AT THE CURRENT SPEED. Exposed because the drift
  // commitment gate is a FRACTION of this, not an absolute angle - an absolute
  // threshold above the authority that exists at top speed can never be met, and
  // drift would be silently dead exactly where a player wants it most.
  steerAuthority() {
    return STEER_MAX / (1 + STEER_SPEED_FALLOFF * Math.abs(this.u));
  }

  // ---------------------------------------------------------------------------
  // ONE FIXED STEP. dt is ALWAYS the fixed DT from config - never a frame delta.
  // Driving vehicle physics off a variable frame delta changes the handling with
  // framerate, which is a difficulty bug, not a performance detail.
  // ---------------------------------------------------------------------------
  step(input, dt) {
    const h = dt === undefined ? DT : dt;

    // Preserve the deliberate-drift force balance through release recovery.
    // Clear only once lateral motion and yaw settle, not on the button edge.
    if (input.drift) this._driftRecovery = true;
    else if (Math.abs(this.v) < 0.5 && Math.abs(this.r) < 0.2) this._driftRecovery = false;
    const driftControl = input.drift || this._driftRecovery;

    // ---- 1. STEERING: rate-limited toward the commanded angle ----------------
    const auth = this.steerAuthority();
    let cmd = input.steer;
    if (cmd > 1) cmd = 1; else if (cmd < -1) cmd = -1;
    // Cap normal full-lock demand to a grip-aware angle. Low-speed hairpins
    // keep the original lock; deliberate drift keeps countersteering authority.
    const safeAuth = Math.min(auth, Math.atan(WHEELBASE * MU_LAT * G *
      this.gripScale * STEER_GRIP_TARGET / Math.max(1, this.u * this.u)) + STEER_SLIP_ALLOWANCE);
    // Preserve small-input gain for both people and AI; only clip excess lock.
    const target = driftControl ? cmd * auth : Math.max(-safeAuth, Math.min(safeAuth, cmd * auth));
    const rate = (cmd === 0 ? STEER_RETURN : STEER_RATE) * h;
    if (this.steerAngle < target) {
      this.steerAngle = Math.min(target, this.steerAngle + rate);
    } else if (this.steerAngle > target) {
      this.steerAngle = Math.max(target, this.steerAngle - rate);
    }
    const delta = this.steerAngle;

    // ---- 2. DRIFT RESOURCE ---------------------------------------------------
    // Startup -> sustain -> payoff. It is a TRADE: while sliding, rear grip is
    // multiplied by DRIFT_REAR_GRIP (< 1), so it COSTS cornering speed. And the
    // payoff never applies under braking, which is what keeps the stopping
    // distance - and therefore SIGHT_LINE_MIN - honest.
    this._updateDrift(input, h, auth);

    // ---- 3. LONGITUDINAL FORCE ----------------------------------------------
    const spd = Math.abs(this.u);
    let fx = 0;

    if (input.throttle > 0) {
      // Constant-power curve above V_POWER_REF, traction-limited below it, so the
      // launch force is finite and top speed EMERGES from power vs resistance
      // instead of being clamped.
      //
      // F_DRIVE_MAX is the REAR AXLE's budget, not the whole vehicle's - a kart
      // is rear-drive, and sizing this from total mass demanded 1.82x what the
      // driven tyres could supply, which zeroed rear lateral grip through the
      // friction ellipse and turned every corner into a spin. See the defect note
      // in config.js section 7.
      // POWER/SPEED SINGULARITY. `spd` here is Math.abs(this.u) - FORWARD velocity,
      // not the kart's speed. A kart that is sliding sideways has u near zero while
      // still moving fast, so ENGINE_POWER / spd diverges: the constant-power curve
      // is only valid along the direction of travel, and dividing by a component
      // that crosses zero is a singularity, not a physics model.
      //
      // MEASURED (kart 2, t=11.742 s - the K17 spike): entering at u=8.59, v=9.55
      // (48 deg of sideslip, r=-2.71 rad/s), u crossed zero within the step while
      // the tyre forces stayed bounded. Speed fell 12.835 -> 2.772 m/s in one
      // 8.33 ms step = 1207 m/s^2, 112x A_BRAKE, with ZERO barrier events and ZERO
      // kart contacts. Replaying the same entry state with a FIXED fx conserved
      // speed to 4 dp (12.8452), which is what proved the divergence is in fx and
      // not in the integrator.
      //
      // The Math.min(fEngine, F_DRIVE_MAX) below LOOKS like it caps this, and it
      // does cap the magnitude - but only after the division has already produced a
      // huge number, and the cap is applied to a force whose direction is the body
      // x-axis while the kart is travelling 48 deg away from it. The fix is to
      // evaluate the power curve against the speed ALONG THE DRIVE DIRECTION with a
      // floor, so it can never divide by a vanishing quantity.
      const vDrive = Math.max(Math.abs(this.u), V_POWER_REF);
      const fEngine = Math.abs(this.u) < V_POWER_REF ? F_DRIVE_MAX : ENGINE_POWER / vDrive;
      fx += input.throttle * Math.min(fEngine, F_DRIVE_MAX);
    } else if (input.throttle < 0) {
      // REVERSE. Negative throttle drives the rear axle backwards under the same
      // traction cap; there is no separate reverse power curve because reverse is
      // only ever used at walking pace (AI stall recovery, ai.js). Bounded at -1.
      const rev = input.throttle < -1 ? -1 : input.throttle;
      fx += rev * F_DRIVE_MAX;
    }
    if (input.brake > 0) {
      const dir = this.u > 0 ? 1 : (this.u < 0 ? -1 : 0);
      fx -= input.brake * F_BRAKE_MAX * dir;
    }
    // Drift payoff. NEVER while braking - see the defect note in config.js s10.
    if (this.boostTimer > 0 && input.brake <= 0) {
      fx += DRIFT_BOOST_FORCE;
    }

    // Rear-drive traction control trades drive force for corner grip. Both
    // actual yaw demand and rack demand count, so lifting steering does not
    // instantly unload the rear tyres while the kart is still rotating.
    // Do not alter braking, reverse, or the deliberate drift resource.
    if (fx > 0 && this.u > 1 && !driftControl && this.boostTimer <= 0) {
      const demand = Math.max(Math.abs(this.u * this.r),
        this.u * this.u * Math.abs(Math.tan(delta)) / WHEELBASE);
      const slipDemand = Math.abs(Math.atan2(this.v - CG_TO_REAR * this.r, this.u)) / ALPHA_PEAK;
      const lateral = Math.min(CORNER_POWER_RESERVE, Math.max(slipDemand,
        demand / (MU_LAT * G * Math.max(0.1, this.gripScale))));
      const driveCap = MU_LONG * FZ_REAR * Math.sqrt(1 - lateral * lateral);
      fx = Math.min(fx, driveCap);
    }

    // Resistance. Drag is quadratic; rolling resistance is constant and opposes
    // motion, scaled by the surface.
    const fDrag = 0.5 * AIR_RHO * CD_A * this.u * Math.abs(this.u);
    const fRoll = C_RR * MASS * G * this.dragScale * (this.u > 0 ? 1 : (this.u < 0 ? -1 : 0));
    fx -= fDrag;
    fx -= fRoll;
    this.fx = fx;

    // Longitudinal force is delivered at the REAR axle on a kart (live axle, no
    // differential) under power, and split by static load under braking.
    if (fx >= 0) { this._fxR = fx; this._fxF = 0; }
    else { this._fxF = fx * 0.45; this._fxR = fx * 0.55; }

    // ---- 4. LATERAL TYRE FORCES ---------------------------------------------
    const muF = MU_LAT * this.gripScale;
    const muR = MU_LAT * this.gripScale *
                (this.driftState === DRIFT_STATE.SUSTAIN ? DRIFT_REAR_GRIP : 1);

    // Gate on the FULL planar speed, not |u|. `spd` above is Math.abs(this.u) -
    // forward speed only - so a kart sliding sideways (small u, large v) fell into
    // this branch and line `this.v = 0` DELETED its lateral velocity outright.
    // Measured signature: speed 12.845 -> 2.767 m/s in one 8.33 ms step (112x
    // A_BRAKE) with ZERO barrier events and ZERO kart contacts, while the kart
    // still moved 0.1041 m of the 0.1070 m its speed implied - the pose stayed
    // continuous because only the velocity state was destroyed. The original
    // justification ("0.5 m/s is far below any observable speed") is true of the
    // kart's speed but NOT of |u| alone, which is what was actually tested.
    // Math.sqrt of the sum of squares, NOT Math.hypot: hypot is variadic and
    // allocates an arguments object on the hot path, which failed Z7 (zero
    // allocation per fixed step) the moment it was introduced here.
    if (this.u * this.u + this.v * this.v < V_SLIP_MIN * V_SLIP_MIN) {
      // Below V_SLIP_MIN the slip angle is atan of ~0/0 and carries no
      // information, so the tyre model is bypassed and the kart is steered
      // kinematically. At this speed the kart is genuinely at rest, so zeroing
      // the lateral component discards nothing physical.
      this.alphaF = 0; this.alphaR = 0;
      this.fyF = 0; this.fyR = 0;
      this.r = WHEELBASE > 0 ? (this.u * Math.tan(delta)) / WHEELBASE : 0;
      // DECAY the lateral component, never snap it to zero. `this.v = 0` here is a
      // velocity DISCONTINUITY: a kart entering this branch at v = 0.382 m/s lost
      // all of it inside one 8.33 ms step, which a finite-difference probe reads as
      // 31.55 m/s^2 (2.92x A_BRAKE) even though only 0.26 m/s was removed. That was
      // the last K17 failure, and it was a real defect - a discontinuity is not
      // made acceptable by being small, because the same code path runs when the
      // kart is spinning at 121.6 deg of sideslip (measured, kart 2 step 1466).
      //
      // Bleeding it off at the friction limit is both physical and continuous: the
      // tyres can remove at most mu*g of lateral acceleration, so cap the change at
      // MU_LAT * G * h and let it reach zero over a few steps instead of one.
      const vMaxDrop = MU_LAT * G * h;
      if (Math.abs(this.v) <= vMaxDrop) this.v = 0;
      else this.v -= Math.sign(this.v) * vMaxDrop;
      this._du = fx / MASS;
      this.u += this._du * h;
      this.ay = 0;
      this.utilF = 0; this.utilR = 0;
    } else {
      // Slip angles. atan2 against |u| keeps the sign meaningful in reverse.
      this.alphaF = Math.atan2(this.v + CG_TO_FRONT * this.r, spd) - delta;
      this.alphaR = Math.atan2(this.v - CG_TO_REAR * this.r, spd);

      // Friction ellipse: longitudinal demand eats lateral capacity.
      //   cap_lat = mu_lat * Fz * sqrt(1 - (Fx / (mu_long * Fz))^2)
      // At a steady-state skidpad the longitudinal demand is only drag plus
      // rolling resistance - about 5% of the traction budget at R=12 m - so this
      // costs roughly 0.1% of lateral capacity. That is why the skidpad probe
      // can land within a fraction of a percent of sqrt(mu*g*R) rather than
      // needing a loose tolerance.
      this._t0 = MU_LONG * FZ_FRONT;
      this._t1 = this._fxF / this._t0;
      if (this._t1 > 1) this._t1 = 1; else if (this._t1 < -1) this._t1 = -1;
      this._capF = muF * FZ_FRONT * Math.sqrt(1 - this._t1 * this._t1);

      this._t0 = MU_LONG * FZ_REAR;
      this._t2 = this._fxR / this._t0;
      if (this._t2 > 1) this._t2 = 1; else if (this._t2 < -1) this._t2 = -1;
      this._capR = muR * FZ_REAR * Math.sqrt(1 - this._t2 * this._t2);

      // Lateral force OPPOSES slip, hence the minus sign.
      this.fyF = -this._capF * magicFormula(this.alphaF);
      this.fyR = -this._capR * magicFormula(this.alphaR);

      this.utilF = this._capF > 0 ? Math.abs(this.fyF) / this._capF : 0;
      this.utilR = this._capR > 0 ? Math.abs(this.fyR) / this._capR : 0;

      // Rigid-body equations in the body frame.
      //   m(u' - v r) = Fx - Fyf sin(delta)
      //   m(v' + u r) = Fyf cos(delta) + Fyr
      //   Izz r'      = a Fyf cos(delta) - b Fyr
      const cd = Math.cos(delta), sd = Math.sin(delta);
      this._du = (fx - this.fyF * sd) / MASS + this.v * this.r;
      this._dv = (this.fyF * cd + this.fyR) / MASS - this.u * this.r;
      this._dr = (CG_TO_FRONT * this.fyF * cd - CG_TO_REAR * this.fyR) / I_ZZ;

      // INTEGRATION STABILITY. The v*r and -u*r terms above are frame-rotation
      // (centripetal) terms: they transport velocity between the body axes and
      // must not change the SPEED at all. Explicit Euler does not respect that.
      // When the kart is spinning hard the rotation angle within one step,
      // |r| * h, stops being small and the pair injects energy instead of
      // rotating the vector.
      //
      // MEASURED failure (kart 2, t=11.742 s, the K17 spike): entering the step
      // spinning at r = -2.71 rad/s with u = 8.59, v = 9.55 (48 deg of sideslip),
      // _du = -20.01 m/s^2 - dominated by v*r = -25.8, not by any tyre force.
      // Over a single 8.33 ms step u overshot THROUGH zero to -1.97, so planar
      // speed fell 12.845 -> 2.767 m/s: 1209 m/s^2, 112x A_BRAKE, produced by the
      // integrator rather than by a force. That is why the earlier probes found
      // zero barrier events, zero kart contacts, and a kart that still moved the
      // full distance its speed implied.
      //
      // Substep only when the step is actually stiff, so ordinary driving keeps
      // bit-identical results and the fixed-step determinism contract holds: the
      // substep count is a pure function of the state, never of wall-clock time.
      const rot = Math.abs(this.r) * h;
      let sub = 1;
      if (rot > 0.02) {                     // ~1.15 deg of body rotation per step
        sub = Math.ceil(rot / 0.02);
        if (sub > 8) sub = 8;               // bounded: cost stays predictable
      }
      const hs = h / sub;
      for (let q = 0; q < sub; q++) {
        // Recompute the rotation coupling each substep from the CURRENT state.
        // The tyre forces are held constant across the substeps - they are slow
        // relative to the rotation term that causes the stiffness.
        const du = (fx - this.fyF * sd) / MASS + this.v * this.r;
        const dv = (this.fyF * cd + this.fyR) / MASS - this.u * this.r;
        const dr = (CG_TO_FRONT * this.fyF * cd - CG_TO_REAR * this.fyR) / I_ZZ;
        this.u += du * hs;
        this.v += dv * hs;
        this.r += dr * hs;
      }

      this.ay = (this.fyF * cd + this.fyR) / MASS;
    }

    // A brake cannot reverse the kart. Without this, holding the brake at a
    // standstill accelerates backwards through the braking force.
    // Clamp ONLY the forward component, and only across the zero crossing. The
    // original form also zeroed v and r, which annihilated the entire motion
    // state of any kart that was sliding or spinning while the brake was held -
    // a genuine velocity discontinuity measured at 1202 m/s^2 (111x A_BRAKE) and
    // the reason AI karts froze at 0.0 km/h mid-lap. Lateral velocity and yaw
    // rate are not the brake's to cancel: they decay through the tyre model.
    if (input.brake > 0 && input.throttle <= 0) {
      if (this.u < 0 && this._du > 0) this.u = 0;
    }

    // ---- 5. INTEGRATE POSE (semi-implicit: velocities first, then pose) ------
    this.yaw += this.r * h;
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;

    this._s = Math.sin(this.yaw);
    this._c = Math.cos(this.yaw);
    // forward = (-sin, 0, -cos);  LEFT = (-cos, 0, +sin)  (v is positive LEFT)
    this.x += (this.u * -this._s + this.v * -this._c) * h;
    this.z += (this.u * -this._c + this.v * this._s) * h;

    this.simTime += h;
    this.steps++;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Drift as a RESOURCE: startup, sustain, payoff. Not a speed cheat.
  // ---------------------------------------------------------------------------
  _updateDrift(input, h, auth) {
    if (this.boostTimer > 0) {
      this.boostTimer -= h;
      if (this.boostTimer < 0) this.boostTimer = 0;
    }

    const spd = Math.abs(this.u);
    // Commitment gate is a FRACTION of the authority available at this speed.
    const steerMag = Math.abs(this.steerAngle);
    const frac = auth > 0 ? steerMag / auth : 0;
    // Sideslip: used only for the SPIN cutoff, which is a large-angle test.
    const beta = Math.abs(Math.atan2(this.v, this.u));
    const sliding = this.driftState === DRIFT_STATE.SUSTAIN;
    // Rear-tyre saturation: how far past its peak slip angle the rear axle is.
    // alphaR is from the PREVIOUS step because drift is resolved before the
    // tyre forces this step - a one-step lag at 1/120 s, which cannot change
    // the outcome of a threshold crossing at these rates and keeps the update
    // order (and therefore determinism) unchanged.
    const rearSat = Math.abs(this.alphaR) / ALPHA_PEAK;

    // ENTRY and SUSTAIN are DIFFERENT conditions, and conflating them made the
    // mechanic unreachable - see the defect note in config.js. Entering demands
    // a deliberate hard turn-in; HOLDING the slide only demands that the slide
    // still exists, because the correct input to hold a drift is COUNTER-STEER,
    // which necessarily reduces the steering fraction.
    const spun = beta > DRIFT_SPIN_BETA;      // slide lost - this is a spin now
    const qualifies = input.drift === true &&
                      spd >= DRIFT_MIN_SPEED &&
                      auth > 0 && !spun &&
                      (sliding
                        // HOLDING a slide is proven by the REAR TYRE being past
                        // its peak slip angle - the one quantity that stays
                        // large through a counter-steer, which necessarily
                        // takes the steering angle through zero. Either the
                        // rear is still sliding, or the driver is still holding
                        // lock; both keep the drift alive.
                        ? (rearSat >= DRIFT_SUSTAIN_REAR_SAT ||
                           frac >= DRIFT_SUSTAIN_STEER_FRAC)
                        : frac >= DRIFT_MIN_STEER_FRAC);

    if (!qualifies) {
      // A SPIN forfeits the charge. Paying a boost for losing the car would
      // make the risk half of the resource free, and drift would become a
      // strictly-better input with no downside.
      if (this.driftState === DRIFT_STATE.SUSTAIN && spun) {
        this.lastBoostTier = 0;
      } else if (this.driftState === DRIFT_STATE.SUSTAIN) {
        // PAYOFF - awarded on release, sized by how long the slide was held.
        if (this.driftCharge >= DRIFT_TIER_2) {
          this.boostTimer = DRIFT_BOOST_2_S; this.lastBoostTier = 2;
        } else if (this.driftCharge >= DRIFT_TIER_1) {
          this.boostTimer = DRIFT_BOOST_1_S; this.lastBoostTier = 1;
        } else {
          this.lastBoostTier = 0;      // released too early: the grip was spent
        }                              // for nothing. That is the risk half.
      }
      this.driftState = DRIFT_STATE.NONE;
      this.driftHeld = 0;
      this.driftCharge = 0;
      this.driftDir = 0;
      return;
    }

    this.driftHeld += h;
    if (this.driftHeld < DRIFT_STARTUP) {
      this.driftState = DRIFT_STATE.STARTUP;
      return;
    }
    if (this.driftState !== DRIFT_STATE.SUSTAIN) {
      this.driftState = DRIFT_STATE.SUSTAIN;
      this.driftDir = this.steerAngle >= 0 ? 1 : -1;
    }
    this.driftCharge += DRIFT_CHARGE_RATE * h;
    if (this.driftCharge > DRIFT_MAX_CHARGE) this.driftCharge = DRIFT_MAX_CHARGE;
  }

  // ---------------------------------------------------------------------------
  // Determinism support. Exact snapshot/restore, and a stable state hash.
  // The hash is FNV-1a over the raw IEEE-754 bytes of every state field, so a
  // one-ulp difference in any field changes it. Comparing formatted decimals
  // would silently tolerate divergence below the print precision.
  // ---------------------------------------------------------------------------
  snapshot(out) {
    const o = out || new Float64Array(17);
    if (o.length < 17) throw new Error('Vehicle snapshot needs 17 fields');
    o[16] = this._driftRecovery ? 1 : 0;
    o[0] = this.x; o[1] = this.z; o[2] = this.yaw;
    o[3] = this.u; o[4] = this.v; o[5] = this.r;
    o[6] = this.steerAngle; o[7] = this.driftHeld; o[8] = this.driftCharge;
    o[9] = this.boostTimer; o[10] = this.driftState; o[11] = this.driftDir;
    o[12] = this.simTime; o[13] = this.steps;
    o[14] = this.alphaF; o[15] = this.alphaR;
    return o;
  }

  restore(o) {
    this._driftRecovery = o.length > 16 ? o[16] === 1 : o[10] !== DRIFT_STATE.NONE;
    this.x = o[0]; this.z = o[1]; this.yaw = o[2];
    this.u = o[3]; this.v = o[4]; this.r = o[5];
    this.steerAngle = o[6]; this.driftHeld = o[7]; this.driftCharge = o[8];
    this.boostTimer = o[9]; this.driftState = o[10]; this.driftDir = o[11];
    this.simTime = o[12]; this.steps = o[13];
    this.alphaF = o[14]; this.alphaR = o[15];
    return this;
  }
}

// FNV-1a over the IEEE-754 bytes of a Float64Array. Allocation-free given a
// caller-supplied scratch buffer; used only by probes, never on the hot path.
const _hashBuf = new Float64Array(17);
const _hashBytes = new Uint8Array(_hashBuf.buffer);
export function stateHash(veh) {
  veh.snapshot(_hashBuf);
  let hh = 2166136261 >>> 0;
  for (let i = 0; i < _hashBytes.length; i++) {
    hh ^= _hashBytes[i];
    hh = Math.imul(hh, 16777619) >>> 0;
  }
  return hh >>> 0;
}
