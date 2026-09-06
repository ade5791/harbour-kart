// =============================================================================
// Harbour Kart - RACE SYSTEM. Six karts, lap/position tracking, impact events.
// =============================================================================
//
// Owns the FIELD: one player vehicle plus five AI vehicles, all stepped by the
// SAME Vehicle.step() at the SAME fixed DT. There is no separate "AI physics".
// That is the structural guarantee behind step instruction 2 - the AI cannot
// exceed sqrt(mu*g*R) or A_BRAKE because it never integrates anything; it only
// presses pedals on a vehicle governed by the same tyre model as the player's.
//
// Emits the racing event vocabulary from bus.js:
//   lap.complete, checkpoint.pass, collision.barrier, collision.kart,
//   item.pickup, race.finish, respawn, surface.change
// (The flap vocabulary - death{cause: ground|pipe} - is retired; see
// docs/GENRE_CORRECTION.md.)
//
// ZERO ALLOCATION per step: every kart record, every scratch sample and the
// position-sort scratch are preallocated in the constructor.

import { Vehicle, makeInput } from './vehicle.js';
import { AIDriver, FIELD_TIERS } from './ai.js';
import { Course } from './course.js';
import {
  COLLIDER_R, COLLIDER_HALF_LEN, W as KART_W,
  GRID_ROW_GAP_M, GRID_FIRST_ROW_BACK_M, GRID_COL_OFFSET
} from './kartsize.js';
import {
  DT, LAP_COUNT, FIELD_SIZE, CHECKPOINTS_PER_LAP, V_TOP,
  TRACK_W_ROUNDED,
  RESPAWN_STUCK_TIME, RESPAWN_MIN_PROGRESS, RESPAWN_OFFTRACK_TIME,
  RESPAWN_LOST_TIME, RESPAWN_SPEED
} from '../core/config.js';
import { KERB_W } from './track.js';

const HALF_W = TRACK_W_ROUNDED / 2;

// Outer edge of the stone kerb. The kerb is RIDEABLE run-off, not decoration:
// SURFACE_GRIP.kerb (0.88) exists precisely so that leaving the boardwalk costs
// something measurable. See the KERB_OUTER note at the surface classifier below.
const KERB_OUTER = HALF_W + KERB_W;                 // 3.60 m

// Grid: two columns, staggered, behind the start line. The spacing constants
// live in kartsize.js because they are KART-LENGTH-derived quantities and this
// file previously got that exactly wrong: it declared 2.1 "kart lengths" and
// then consumed it as metres, stacking a 1.85 m kart on a 2.1 m pitch.

export class Race {
  constructor(track, rngHub, opts) {
    this.track = track;
    this.course = track.course;
    this.rngHub = rngHub;
    this.lapCount = (opts && opts.laps) || LAP_COUNT;
    this.fieldSize = (opts && opts.fieldSize) || FIELD_SIZE;

    this.bus = (opts && opts.bus) || null;
    this.time = 0;
    this.finished = false;
    this.finishOrder = [];

    // ---- karts ----
    this.karts = [];
    for (let i = 0; i < this.fieldSize; i++) {
      const veh = new Vehicle(i);
      this.karts.push({
        id: i,
        isPlayer: i === 0,
        veh,
        input: makeInput(),
        ai: i === 0 ? null : null,     // filled below
        s: 0,                          // arclength along the centreline
        prevS: 0,
        lap: 1,
        lapStart: 0,
        lapStartPrev: 0,      // restored on a backward crossing of the line
        lastLapTime: 0,
        bestLapTime: Infinity,
        nextCp: 0,
        cpHits: 0,
        totalProgress: 0,              // laps*len + s, the sort key
        position: i + 1,
        finished: false,
        finishTime: 0,
        surface: 'boardwalk',
        offTrack: false,
        // impact bookkeeping (read by the renderer for shake/dust/squeal)
        lastImpact: 0,
        lastImpactSpeed: 0,
        lastKerb: 0,
        respawns: 0,
        // --- recovery bookkeeping (see _checkRecovery) ---
        stuckT: 0,          // s accumulated with no meaningful progress
        offTrackT: 0,       // s accumulated continuously off the drivable band
        progressRef: 0,     // arclength progress at the start of the window
        lostTime: 0         // s of penalty attributed by respawns
      });
    }

    // ---- AI drivers, on the declared seeded stream ----
    const ai = rngHub.get('ai');
    for (let i = 1; i < this.fieldSize; i++) {
      this.karts[i].ai = new AIDriver(i, ai, FIELD_TIERS[(i - 1) % FIELD_TIERS.length]);
    }

    // ---- preallocated scratch ----
    this._smp = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    this._smp2 = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    // Pooled event payload - see _emit(). One object for the whole race; listeners
    // must read it synchronously and never retain it.
    this._evt = {
      kartId: -1, from: null, to: null, grip: 0,
      speed: 0, normalX: 0, normalZ: 0, impulse: 0,
      lap: 0, lapTime: 0, index: 0, position: 0, total: 0,
      totalTime: 0, t: 0, otherId: -1, closingSpeed: 0,
      checkpoint: 0, lostTime: 0
    };
    this._order = new Int32Array(this.fieldSize);
    this._prog = new Float64Array(this.fieldSize);

    this.reset();
  }

  reset() {
    this.time = 0;
    this.finished = false;
    this.finishOrder.length = 0;
    const len = this.course.length;

    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      // Grid slot: row i>>1, column i&1. Behind the start line (negative s).
      const row = i >> 1, col = (i & 1) ? 1 : -1;
      const sGrid = -(row * GRID_ROW_GAP_M + GRID_FIRST_ROW_BACK_M);
      const lat = col * HALF_W * GRID_COL_OFFSET;
      const p = this.course.sampleInto((sGrid + len) % len, this._smp);
      const nx = -Math.cos(p.heading), nz = Math.sin(p.heading);
      k.veh.reset(p.x + nx * lat, p.z + nz * lat, p.heading, 0);
      k.s = (sGrid + len) % len;
      k.prevS = k.s;
      // LAP 0 = the formation segment between the grid and the start line.
      // The grid is deliberately BEHIND s=0 (real racing practice), so the first
      // crossing of s=0 is the START of lap 1, not the completion of it. Starting
      // this at 1 made that first wrap score as a finished lap - measured as a
      // 0.87 s "best lap" on a 1236 m track, and it stole one full lap from the
      // race distance. Lap 1 begins when lap 0 ends, and no lap.complete event is
      // emitted for lap 0 (see step(): the crossing that ends lap 0 only starts
      // the clock).
      k.lap = 0; k.lapStart = 0; k.lapStartPrev = 0; k.lastLapTime = 0; k.bestLapTime = Infinity;
      k.nextCp = 0; k.cpHits = 0;
      k.totalProgress = k.s - len;      // still behind the line
      k.position = i + 1;
      k.finished = false; k.finishTime = 0;
      k.surface = 'boardwalk'; k.offTrack = false;
      k.lastImpact = 0; k.lastImpactSpeed = 0; k.lastKerb = 0; k.respawns = 0;
      k.stuckT = 0; k.offTrackT = 0; k.progressRef = k.totalProgress; k.lostTime = 0;
      // lastContact: set on every step that APPLIES a contact impulse (barrier or
      // kart-kart), whether or not it was large enough to raise an event. This is
      // the flag any "tyre forces only" analysis must filter on. Declared here so
      // it is never undefined - an undefined field compares false and would
      // silently disable the filter rather than failing loudly.
      k.lastContact = -1;
      k.input.throttle = 0; k.input.brake = 0; k.input.steer = 0; k.input.drift = false;
      if (k.ai) k.ai.reset();
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  // ONE FIXED STEP. playerInput is the caller-owned input record for kart 0.
  // ---------------------------------------------------------------------------
  step(playerInput, dt) {
    const h = dt === undefined ? DT : dt;
    const len = this.course.length;

    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (k.finished) continue;

      // --- decide ---
      let input;
      if (k.isPlayer) {
        input = playerInput;
      } else {
        input = k.ai.update(this.course, k.veh, k.s, this._smp2);
      }

      // --- integrate: SAME step() for every kart, no exceptions ---
      k.veh.step(input, h);

      // --- where are we now ---
      const prevS = k.s;
      k.s = this._projectS(k.veh.x, k.veh.z, prevS);
      k.prevS = prevS;

      // --- surface + off-track ---
      const lat = this._lateralAt(k.veh.x, k.veh.z, k.s);
      const absLat = Math.abs(lat);
      // SURFACE IS CLASSIFIED ON THE KART BODY EDGE, NOT ITS CENTRE.
      //
      // S9 defect (MEASURED, tools/s9/_diagkerb.mjs): the classifier tested the
      // kart CENTRE against HALF_W (3.05 m) while the barrier below clamped that
      // same CENTRE at HALF_W - COLLIDER_R (2.50 m). Two rules, two different
      // frames of reference, 0.55 m apart - so `kerb`, `sand` and `offTrack` were
      // ALL structurally unreachable by driving. A 40 s probe pinning full steer
      // into both walls recorded maxAbsLat exactly 2.5000 m and surfacesSeen
      // ['boardwalk'] only. SURFACE_GRIP.kerb (0.88) and OFFTRACK_GRIP were dead
      // constants, and config.js's stated intent - "leaving the boardwalk must
      // COST something measurable, or the track edge is decorative and the sight
      // line stops mattering" - was silently false.
      //
      // The fix is to make both rules speak about the same thing. The player sees
      // the kart's WHEELS touch the kerb, so the body edge is the honest frame
      // (hard rule 10 in reverse: the volume that governs must match the
      // silhouette the player reads). The wall then moves out to the kerb's outer
      // edge, so the kerb becomes the rideable run-off band it was authored as.
      const bodyEdge = absLat + COLLIDER_R;
      let surf = 'boardwalk';
      if (bodyEdge > KERB_OUTER) surf = 'sand';
      else if (bodyEdge > HALF_W) surf = 'kerb';
      if (surf !== k.surface) {
        const from = k.surface;
        k.surface = surf;
        k.veh.setSurface(surf);
        if (surf === 'kerb') k.lastKerb = this.time;
        const ev = this._evtReset();
        ev.kartId = k.id; ev.from = from; ev.to = surf; ev.grip = k.veh.gripScale;
        this._emit('surface.change');
      }
      // Off the DRIVABLE band = the body has left the boardwalk proper. The kerb
      // is still a legal (slower) surface, so riding it is not "off track"; being
      // beyond it is. Same body-edge frame as the classifier above.
      k.offTrack = bodyEdge > KERB_OUTER;

      // --- barrier collision: the clear radius is the wall ---
      // THE WALL IS THE TRACK EDGE, not the scenery clear-radius. The old value
      // (5.60 - COLLIDER_R = 5.05 m) sat 2.03 m OUTSIDE the 3.025 m half-width, so
      // there was a 2 m band where a kart was already off the boardwalk but nothing
      // stopped it - and _diag_s4r caught a kart frozen at exactly lateral -5.050 m,
      // full throttle, u/v/lateral identical to 4 dp for 12 consecutive steps.
      // The barrier belongs where the drivable surface ends, offset by the kart's
      // own half-width so the BODY stops at the edge rather than its centre.
      // S9: the wall moves from the boardwalk edge to the KERB'S OUTER edge, so
      // the authored kerb band is actually drivable (at 0.88 grip) instead of
      // being fenced off 0.55 m before the player ever reaches it. Still
      // expressed as a CENTRE limit, but now derived from the same body-edge rule
      // the classifier uses: body edge stops at KERB_OUTER.
      const wall = KERB_OUTER - COLLIDER_R;
      if (absLat > wall) {
        const sign = lat > 0 ? 1 : -1;
        const p = this.course.sampleInto(k.s, this._smp);
        const nx = -Math.cos(p.heading), nz = Math.sin(p.heading);
        // Push back onto the legal band and kill the outward velocity component.
        // Push back to just INSIDE the wall, not exactly onto it. Landing exactly
        // on the boundary leaves the kart re-triggering the clamp every step, and
        // because the correction is an absolute position write it erases whatever
        // motion the tyres produced - the kart is welded in place (measured:
        // frozen to 4 dp for 12 consecutive steps at full throttle). The 1 mm
        // inset means a kart that steers away is genuinely free on the next step,
        // while one still pressing into the wall is simply re-clamped.
        // Compute the outward velocity BEFORE moving anything: the position
        // correction must only fire when the kart is actually driving INTO the
        // wall. Applying it unconditionally also teleports a kart that is already
        // leaving, and since the gate derives speed by finite-differencing the
        // pose, that teleport reads as deceleration no force produced (measured
        // 12.85 -> 2.75 m/s in one 8.33 ms step = 112x A_BRAKE, at lateral
        // -2.4990 m, i.e. exactly on the wall).
        const onx0 = nx * sign, onz0 = nz * sign;
        const wvx0 = k.veh.u * -Math.sin(k.veh.yaw) + k.veh.v * -Math.cos(k.veh.yaw);
        const wvz0 = k.veh.u * -Math.cos(k.veh.yaw) + k.veh.v * Math.sin(k.veh.yaw);
        const approaching = (wvx0 * onx0 + wvz0 * onz0) > 0;

        // Depenetrate GRADUALLY. A single-step snap to the boundary is a position
        // discontinuity; resolving a fraction per step keeps the pose continuous
        // while still ejecting the kart in a few milliseconds.
        const over = (absLat - wall + 0.001) * (approaching ? 1.0 : 0.25);
        k.veh.x -= nx * sign * over;
        k.veh.z -= nz * sign * over;
        // Remove the OUTWARD component of world velocity, not an axis-aligned
        // guess. Scaling veh.v alone is wrong whenever the kart is not travelling
        // parallel to the centreline: the outward motion is a projection onto the
        // track normal, and leaving it in place lets the kart grind along the wall
        // being re-clamped every step - which a finite-difference probe reads as
        // hundreds of m/s^2 of phantom deceleration.
        const onx = nx * sign, onz = nz * sign;          // outward unit normal
        const wvx = k.veh.u * -Math.sin(k.veh.yaw) + k.veh.v * -Math.cos(k.veh.yaw);
        const wvz = k.veh.u * -Math.cos(k.veh.yaw) + k.veh.v * Math.sin(k.veh.yaw);
        const outward = wvx * onx + wvz * onz;
        const impact = Math.max(0, outward);
        if (outward > 0) {
          // Restitution 0.05, NOT 0.28. Measured: at 0.28 the barrier reflects
          // enough outward speed to throw the kart across the 6.1 m boardwalk into
          // the opposite barrier, which reflects it back - a ping-pong that drove
          // off-track from 28% to 54% of steps. An arcade kart SCRUBS along a wall;
          // it does not bounce. Near-zero restitution kills the outward component
          // and lets the along-wall component survive, which is the behaviour the
          // reference frame shows.
          const dv = -1.05 * outward;
          const fx = -Math.sin(k.veh.yaw), fz = -Math.cos(k.veh.yaw);
          const rx = -Math.cos(k.veh.yaw), rz = Math.sin(k.veh.yaw);   // LEFT: v is positive left
          k.veh.u += dv * (onx * fx + onz * fz);
          k.veh.v += dv * (onx * rx + onz * rz);

          // Along-wall scrub, INSIDE the outward>0 branch and proportional to how
          // hard the kart actually hit. The previous form ran an unconditional
          // *= 0.94 on every step the kart was inside the wall - including steps
          // where it was already leaving - so a kart grinding along a barrier lost
          // 6% of its speed per 8.33 ms step, compounding to a measured 1202 m/s^2
          // (111x A_BRAKE) while s advanced only 0.10 m. That is the spike K17 was
          // correctly reporting. A glancing hit must cost almost nothing; only a
          // near-perpendicular hit scrubs hard.
          const bite = Math.min(1, outward / 8);   // 8 m/s outward = full scrub
          k.veh.u *= (1 - 0.10 * bite);
          // Same bookkeeping rule as the kart-kart path: this branch CHANGED the
          // velocity, so this is a contact step. lastImpact is set below on every
          // in-band step (including ones already leaving the wall), which makes it
          // wrong in the other direction - too broad there, too narrow here.
          k.lastContact = this.time;
        }
        k.lastImpact = this.time;
        k.lastImpactSpeed = impact;
        const ev = this._evtReset();
        ev.kartId = k.id; ev.speed = k.veh.speed;
        ev.normalX = -nx * sign; ev.normalZ = -nz * sign; ev.impulse = impact;
        this._emit('collision.barrier');
      }

      // --- checkpoints and laps ---
      const cpStep = len / CHECKPOINTS_PER_LAP;

      // SIM DEFECT (found by tools/_s7_lapbug.mjs during S7 P2).
      // _crossedForward() credited a lap on EVERY forward crossing of s=0 but
      // nothing handled the BACKWARD crossing, so the line was a ratchet. A
      // kart that drifts back over the line under high input latency and then
      // re-crosses banked a whole free lap: measured on seed 1234 at 650 ms,
      // one backward crossing turned into a credited lap with lastLapTime
      // 4.017 s against a physical floor of 1236.2 m / 28.6111 m/s = 43.21 s,
      // and that fiction became bestLapTime. This is a REAL scoring exploit,
      // not a probe artefact - reversing over the line is a classic racing-game
      // cheat and the sim had no defence.
      // Fix: make the line SYMMETRIC. A backward crossing un-credits the lap
      // and restores the previous lap's start time, so the kart must re-earn
      // the crossing and the lap time keeps accumulating across the wobble.
      if (this._crossedBackward(prevS, k.s, len) && k.lap > 0) {
        k.lap--;
        k.lapStart = k.lapStartPrev;
      }

      const crossed = this._crossedForward(prevS, k.s, len);
      if (crossed) {
        // Lap line at s = 0.
        const wasFormation = k.lap === 0;
        k.lap++;
        if (wasFormation) {
          // End of the formation segment: this crossing STARTS lap 1. There is no
          // completed lap to report and no lap time to record - the kart has only
          // covered the few metres from its grid slot to the line.
          k.lapStartPrev = k.lapStart;
          k.lapStart = this.time;
        } else {
        const lt = this.time - k.lapStart;
        k.lastLapTime = lt;
        if (lt < k.bestLapTime) k.bestLapTime = lt;
        k.lapStartPrev = k.lapStart;
        k.lapStart = this.time;
        const ev = this._evtReset();
        ev.kartId = k.id; ev.lap = k.lap - 1; ev.lapTime = lt;
        ev.totalTime = this.time; ev.position = k.position;
        this._emit('lap.complete');
        }
        if (!wasFormation && k.lap > this.lapCount) {
          k.finished = true;
          k.finishTime = this.time;
          this.finishOrder.push(k.id);
          const ev = this._evtReset();
          ev.kartId = k.id; ev.position = this.finishOrder.length; ev.totalTime = this.time;
          this._emit('race.finish');
        }
      }
      const cpIdx = Math.floor(k.s / cpStep) % CHECKPOINTS_PER_LAP;
      if (cpIdx === k.nextCp) {
        k.nextCp = (k.nextCp + 1) % CHECKPOINTS_PER_LAP;
        k.cpHits++;
        const ev = this._evtReset();
        ev.kartId = k.id; ev.index = cpIdx; ev.lap = k.lap; ev.t = this.time;
        this._emit('checkpoint.pass');
      }

      // lap is 0 on the formation segment, so lap 1 contributes 0*len. A kart on
      // the grid therefore has NEGATIVE progress (s is near len, minus one lap),
      // which sorts it correctly behind a kart that has already taken the flag.
      k.totalProgress = (k.lap - 1) * len + k.s;

      // --- RECOVERY / RESPAWN ---------------------------------------------
      // Runs for every kart, player included, and only after totalProgress is
      // current for this step.
      if (!k.finished) this._checkRecovery(k, h, len);
    }

    // --- kart-vs-kart contact -------------------------------------------------
    this._resolveKartContacts();

    // --- positions ------------------------------------------------------------
    this._updatePositions();

    this.time += h;
    if (!this.finished && this.finishOrder.length >= this.karts.length) {
      this.finished = true;
    }
    return this;
  }

  // Capsule-vs-capsule along each kart's long axis. Cheap, allocation-free, and
  // it uses COLLIDER_R / COLLIDER_HALF_LEN from the sizing contract - not a
  // second radius.
  // ---------------------------------------------------------------------------
  // RECOVERY / RESPAWN. The missing system S9 found: `offTrack` was computed and
  // `respawn` was declared in the bus vocabulary, but nothing ever emitted it, so
  // a stranded kart stayed stranded for the whole race (MEASURED: player at rest
  // at s=1147.4 m for 120 s, race finished around it).
  //
  // TWO independent triggers, because they are genuinely different failures:
  //   (a) NO PROGRESS for RESPAWN_STUCK_TIME - wedged, spun, or facing the wrong
  //       way. Measured on ARCLENGTH, not speed: a kart can be moving fast and
  //       making no progress, and a hairpin can be slow but productive.
  //   (b) OFF THE DRIVABLE BAND for RESPAWN_OFFTRACK_TIME - in the water or deep
  //       on the sand. Caught even while still making progress, because driving
  //       through the lagoon must not be a viable line.
  //
  // The kart is re-placed on the centreline at its LAST CHECKPOINT, facing the
  // track, at RESPAWN_SPEED. Placing it at its current `s` would let a player
  // cut a corner by deliberately beaching; going back to the checkpoint means
  // recovery always costs distance as well as time.
  _checkRecovery(k, h, len) {
    // (a) progress window
    let prog = k.totalProgress - k.progressRef;
    if (prog < -len * 0.5) prog += len;      // lap wrap
    if (prog >= RESPAWN_MIN_PROGRESS) {
      k.progressRef = k.totalProgress;
      k.stuckT = 0;
    } else {
      k.stuckT += h;
    }

    // (b) off-track window
    if (k.offTrack) k.offTrackT += h; else k.offTrackT = 0;

    const stuck = k.stuckT >= RESPAWN_STUCK_TIME;
    const drowned = k.offTrackT >= RESPAWN_OFFTRACK_TIME;
    if (!stuck && !drowned) return;

    // Re-place at the last checkpoint the kart actually passed.
    const cpStep = len / CHECKPOINTS_PER_LAP;
    const cpIdx = (k.nextCp - 1 + CHECKPOINTS_PER_LAP) % CHECKPOINTS_PER_LAP;
    const sCp = (cpIdx * cpStep + len) % len;
    const p = this.course.sampleInto(sCp, this._smp);
    k.veh.reset(p.x, p.z, p.heading, RESPAWN_SPEED);
    k.s = sCp;
    k.prevS = sCp;
    k.totalProgress = (k.lap - 1) * len + k.s;
    k.progressRef = k.totalProgress;
    k.stuckT = 0;
    k.offTrackT = 0;
    k.surface = 'boardwalk';
    k.offTrack = false;
    k.veh.setSurface('boardwalk');
    k.respawns++;
    k.lostTime += RESPAWN_LOST_TIME;

    const ev = this._evtReset();
    ev.kartId = k.id;
    ev.checkpoint = cpIdx;
    ev.lostTime = RESPAWN_LOST_TIME;
    this._emit('respawn');
  }

  _resolveKartContacts() {
    const n = this.karts.length;
    for (let i = 0; i < n; i++) {
      const a = this.karts[i];
      if (a.finished) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.karts[j];
        if (b.finished) continue;
        const dx = b.veh.x - a.veh.x, dz = b.veh.z - a.veh.z;
        const d2 = dx * dx + dz * dz;
        const rr = (COLLIDER_R * 2 + COLLIDER_HALF_LEN);   // conservative
        if (d2 > rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const overlap = rr - d;
        if (overlap <= 0) continue;
        const ux = dx / d, uz = dz / d;
        const push = overlap * 0.5;
        a.veh.x -= ux * push; a.veh.z -= uz * push;
        b.veh.x += ux * push; b.veh.z += uz * push;
        // Closing speed along the contact normal.
        const avx = a.veh.u * -Math.sin(a.veh.yaw) + a.veh.v * -Math.cos(a.veh.yaw);
        const avz = a.veh.u * -Math.cos(a.veh.yaw) + a.veh.v * Math.sin(a.veh.yaw);
        const bvx = b.veh.u * -Math.sin(b.veh.yaw) + b.veh.v * -Math.cos(b.veh.yaw);
        const bvz = b.veh.u * -Math.cos(b.veh.yaw) + b.veh.v * Math.sin(b.veh.yaw);
        const closing = (avx - bvx) * ux + (avz - bvz) * uz;

        // VELOCITY RESOLUTION. Separating the karts positionally without changing
        // their velocities is not a collision - they simply drive back into each
        // other on the next step, and the position correction re-fires forever.
        // Two consequences, both measured before this was added:
        //   - a finite-difference probe reads the repeated positional shove as
        //     476 m/s^2 of "deceleration" (K17 failed at 44x A_BRAKE),
        //   - the contact absorbs no energy, so a pile-up never resolves and the
        //     field jams (off-track 28% of steps).
        // Equal-mass 1D impulse along the contact normal with restitution e:
        //     dv = -(1 + e) * closing / 2   applied to A, and +dv to B.
        // e = 0.25 is INSPECTED (arcade karts bounce a little, not like billiards);
        // what is NOT inspected is that the exchange conserves momentum and can
        // only ever REMOVE closing speed, which is what makes it physical.
        if (closing > 0) {
          // BOOKKEEPING, not dynamics: any step that alters velocity IS a contact
          // step and must be recorded as one. Previously lastImpact was only set
          // below at closing > 0.5, so a light touch (measured: kart 4, step 10780,
          // closing 0.35 m/s) applied a real -18.03 m/s^2 impulse while leaving the
          // kart flagged as clean. Every downstream consumer that filters "tyre
          // braking only" then read that contact as tyre deceleration - which is
          // exactly what K17 was reporting at 2.06x A_BRAKE. The 0.5 threshold
          // below still gates the EVENT (a 0.35 m/s nudge is not worth a bus
          // message); it must not gate the FACT that contact occurred.
          a.lastContact = this.time;
          b.lastContact = this.time;
          const e = 0.25;
          const dv = -(1 + e) * closing * 0.5;
          // Convert the world-frame normal impulse into each kart's body frame.
          // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
          const afx = -Math.sin(a.veh.yaw), afz = -Math.cos(a.veh.yaw);
          const arx = -Math.cos(a.veh.yaw), arz = Math.sin(a.veh.yaw);   // LEFT
          a.veh.u += dv * (ux * afx + uz * afz);
          a.veh.v += dv * (ux * arx + uz * arz);
          const bfx = -Math.sin(b.veh.yaw), bfz = -Math.cos(b.veh.yaw);
          const brx = -Math.cos(b.veh.yaw), brz = Math.sin(b.veh.yaw);   // LEFT
          b.veh.u -= dv * (ux * bfx + uz * bfz);
          b.veh.v -= dv * (ux * brx + uz * brz);
        }

        if (closing > 0.5) {
          a.lastImpact = this.time; a.lastImpactSpeed = closing;
          b.lastImpact = this.time; b.lastImpactSpeed = closing;
          const ev = this._evtReset();
          ev.kartId = a.id; ev.otherId = b.id;
          ev.closingSpeed = closing; ev.impulse = closing * 0.5;
          this._emit('collision.kart');
        }
      }
    }
  }

  _updatePositions() {
    const n = this.karts.length;
    for (let i = 0; i < n; i++) {
      this._order[i] = i;
      this._prog[i] = this.karts[i].finished
        ? 1e9 - this.karts[i].finishTime      // finished karts hold their order
        : this.karts[i].totalProgress;
    }
    // Insertion sort on a 6-element array: allocation-free and faster than
    // Array.prototype.sort, which allocates a comparator closure context.
    for (let i = 1; i < n; i++) {
      const idx = this._order[i], p = this._prog[idx];
      let j = i - 1;
      while (j >= 0 && this._prog[this._order[j]] < p) {
        this._order[j + 1] = this._order[j]; j--;
      }
      this._order[j + 1] = idx;
    }
    for (let i = 0; i < n; i++) this.karts[this._order[i]].position = i + 1;
  }

  _projectS(x, z, hint) {
    // Candidates are normalised into [0, len) BEFORE sampling, not after. The
    // previous version normalised only the RESULT, so with the grid at s=1234 on
    // a 1236 m loop the coarse window sampled s = 1235..1254 - arclengths past
    // the end of the spline - and picked a "nearest" point from garbage geometry.
    let bestS = hint, bestD2 = Infinity;
    const len = this.course.length;
    for (let d = -8; d <= 20; d += 1.0) {
      let s = hint + d;
      if (s < 0) s += len; else if (s >= len) s -= len;
      const p = this.course.sampleInto(s, this._smp);
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestS = s; }
    }
    for (let d = -1.0; d <= 1.0; d += 0.1) {
      let s = bestS + d;
      if (s < 0) s += len; else if (s >= len) s -= len;
      const p = this.course.sampleInto(s, this._smp);
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestS = s; }
    }
    let out = bestS % len;
    if (out < 0) out += len;
    return out;
  }

  _lateralAt(x, z, s) {
    const p = this.course.sampleInto(s, this._smp);
    const nx = -Math.cos(p.heading), nz = Math.sin(p.heading);
    return (x - p.x) * nx + (z - p.z) * nz;
  }

  // Did we cross s=0 going forward? Guarded against the projection jumping.
  _crossedForward(prev, now, len) {
    if (prev > len * 0.75 && now < len * 0.25) return true;
    return false;
  }

  // The mirror image: did we cross s=0 going BACKWARD? Same wrap guard, sides
  // swapped. Without this the start line is a ratchet that only ever adds laps
  // (see the lap-credit block in step()).
  _crossedBackward(prev, now, len) {
    if (prev < len * 0.25 && now > len * 0.75) return true;
    return false;
  }

  // ZERO-ALLOCATION EVENT EMIT.
  //
  // The old form was `_emit(name, { ...fields })` at each call site. The object
  // literal is built by the CALLER, so it is allocated on every emitting step
  // whether or not a bus is attached - and the gate runs the sim with no bus at
  // all, making every one of those objects pure garbage. MEASURED: 66 GC events
  // over 60,000 race steps, against 2 for the same number of raw vehicle.step
  // calls; bisecting vehicle vs AI vs race glue localised all of it here.
  //
  // Fix: one preallocated payload, refilled per emit. Listeners must therefore
  // READ what they need synchronously and never retain the payload - that is the
  // standard contract for a pooled event object, and it is documented on the bus.
  // A `fill` CALLBACK would not fix this: an arrow function that captures locals
  // is itself a per-call allocation, trading an object for a closure. So call
  // sites write directly onto the pooled payload via _evt() and then _emit(name).
  _evtReset() {
    const p = this._evt;
    // Clear every slot so a stale field from a previous, differently-shaped event
    // can never leak into this one.
    p.kartId = -1; p.from = null; p.to = null; p.grip = 0;
    p.speed = 0; p.normalX = 0; p.normalZ = 0; p.impulse = 0;
    p.lap = 0; p.lapTime = 0; p.index = 0; p.position = 0; p.total = 0;
    p.totalTime = 0; p.t = 0; p.otherId = -1; p.closingSpeed = 0;
    p.checkpoint = 0; p.lostTime = 0;
    return p;
  }

  _emit(name) {
    if (this.bus) this.bus.emit(name, this._evt);
  }

  standings() {
    const out = [];
    for (let i = 0; i < this._order.length; i++) {
      const k = this.karts[this._order[i]];
      out.push({
        position: i + 1, id: k.id, isPlayer: k.isPlayer,
        // HUD reads "LAP n/3". On the formation segment (lap 0) the board shows 1,
      // because the driver is on their way to start lap 1.
      lap: Math.min(Math.max(k.lap, 1), this.lapCount), s: k.s,
        speedKmh: k.veh.speedKmh, bestLap: k.bestLapTime,
        tier: k.ai ? k.ai.tierName : 'player',
        finished: k.finished, finishTime: k.finishTime
      });
    }
    return out;
  }
}
