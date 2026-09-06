// =============================================================================
// Harbour Kart - IMPACT FEEDBACK. Every impact carries weight.
// =============================================================================
//
// Step requirement 5: "Every impact carries weight: chassis shake, tyre squeal,
// dust/spark, and a camera impulse. Kerb strikes rumble."
//
// The sim already EMITS the racing vocabulary (collision.barrier,
// collision.kart, surface.change) and the kart/camera already EXPOSE
// addShake()/addImpulse() - but until this module nothing subscribed, so an
// impact moved the vehicle state and nothing else. This is the binding layer:
//
//   bus event            -> chassis shake (that kart)   [Kart.addShake]
//                        -> camera impulse (player only) [ChaseCamera.addImpulse]
//                        -> dust burst at the contact    [DustPool, 'fx' stream]
//   per-frame kerb state -> low-amplitude rumble shake   (continuous, not an event)
//   per-frame tyre scrub -> trickle of dust at the rear wheels
//
// Tyre SQUEAL is audio and lives in src/audio/tyres.js (audio owns its
// directory); it reads the same vehicle utilisation numbers this module reads,
// so the ear and the eye agree about when the tyres are at the limit.
//
// DETERMINISM: every dust particle's spread, size and lifetime comes from a
// forked 'fx' stream. Never Math.random. Two runs on the same seed produce the
// same dust.
//
// ZERO ALLOCATION per frame: the pool, the scratch matrix and the scratch
// vectors are built once. spawn() and update() write into them.
//
// The bus forwards ONE pooled payload object by reference and the listener must
// read it synchronously and never retain it (race.js). These handlers read the
// fields they need and return.

import * as THREE from 'three';
import { KART_W, V_TOP } from '../core/config.js';

// Shake magnitudes in metres of throw at the chassis, scaled by impact speed.
// A 28.6 m/s wall hit throws the chassis a visible 0.06 m; a 2 m/s nudge 0.004 m.
export const SHAKE_PER_MS   = 0.0021;   // m per (m/s) of impact speed
export const SHAKE_MAX      = 0.060;    // m, clamp
export const SHAKE_T_MIN    = 0.12;     // s
export const SHAKE_T_MAX    = 0.42;     // s
export const IMPULSE_PER_MS = 0.0060;   // camera m per (m/s)
export const IMPULSE_MAX    = 0.17;     // m
export const STRIKE_MIN     = 1.0;      // m/s outward closing speed: below this a
                                        // barrier contact is a grind, not a strike
export const KERB_RUMBLE_MAG = 0.006;   // m, continuous while on the kerb
export const KERB_RUMBLE_T   = 0.05;    // s, re-armed every frame on the kerb
export const SCRUB_UTIL_MIN  = 0.92;    // utilisation above which tyres shed dust
export const DUST_POOL       = 96;      // particles, fixed pool
export const DUST_LIFE       = [0.35, 0.80];   // s
export const DUST_SIZE       = [0.10, 0.34];   // m
export const DUST_ALBEDO     = '#8a7a62';      // warm boardwalk dust, lum ~0.19

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// -----------------------------------------------------------------------------
// DUST POOL - one InstancedMesh, fixed size, ring-allocated.
// -----------------------------------------------------------------------------
export class DustPool {
  constructor(rng, count) {
    this.rng = rng;
    this.n = count || DUST_POOL;
    const n = this.n;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.life = new Float32Array(n); this.life0 = new Float32Array(n);
    this.size = new Float32Array(n);
    this.head = 0;
    this.alive = 0;
    this.spawned = 0;

    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const c = new THREE.Color(DUST_ALBEDO);
    this.material = new THREE.MeshLambertMaterial({
      color: c, transparent: true, opacity: 0.55, depthWrite: false
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, n);
    this.mesh.name = 'dust_pool';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    // Park every instance at zero scale so an unused slot draws nothing.
    this._s.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Emit `count` particles at (x, y, z) with a base velocity and a spread.
  spawn(count, x, y, z, bvx, bvy, bvz, spread) {
    const r = this.rng;
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.n;
      this.px[i] = x + r.range(-spread, spread);
      this.py[i] = y + r.range(0, spread * 0.5);
      this.pz[i] = z + r.range(-spread, spread);
      this.vx[i] = bvx + r.range(-1.2, 1.2);
      this.vy[i] = bvy + r.range(0.6, 2.2);
      this.vz[i] = bvz + r.range(-1.2, 1.2);
      const l = r.range(DUST_LIFE[0], DUST_LIFE[1]);
      this.life[i] = l; this.life0[i] = l;
      this.size[i] = r.range(DUST_SIZE[0], DUST_SIZE[1]);
      this.spawned++;
    }
  }

  update(dt) {
    let alive = 0;
    const m = this._m, p = this._p, s = this._s, q = this._q;
    for (let i = 0; i < this.n; i++) {
      let l = this.life[i];
      if (l <= 0) continue;
      l -= dt;
      if (l <= 0) {
        this.life[i] = 0;
        s.set(0, 0, 0); p.set(0, 0, 0);
        m.compose(p, q, s); this.mesh.setMatrixAt(i, m);
        continue;
      }
      this.life[i] = l;
      this.vy[i] -= 2.4 * dt;                 // light, drifting - not a stone
      this.vx[i] *= (1 - 1.8 * dt); this.vz[i] *= (1 - 1.8 * dt);
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.02) { this.py[i] = 0.02; this.vy[i] = 0; }
      // Grows as it fades, like real dust.
      const t = 1 - l / this.life0[i];
      const sz = this.size[i] * (0.6 + 1.1 * t);
      p.set(this.px[i], this.py[i], this.pz[i]);
      s.set(sz, sz * 0.7, sz);
      m.compose(p, q, s);
      this.mesh.setMatrixAt(i, m);
      alive++;
    }
    this.alive = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// -----------------------------------------------------------------------------
// THE BINDING. Construct with the bus, the race, the field of visual karts,
// the chase camera, and the 'fx' stream. Call update(dt) once per frame.
// -----------------------------------------------------------------------------
export class ImpactFeedback {
  constructor(o) {
    this.bus = o.bus;
    this.race = o.race;
    this.field = o.field;       // Kart[] visual instances, index == kart id
    this.chase = o.chase;       // ChaseCamera for the player, may be null headless
    this.dust = o.dust || null; // DustPool, may be null headless
    this.playerId = o.playerId === undefined ? 0 : o.playerId;

    // Counters, so a gate can prove the wiring fired rather than assume it.
    this.audio = o.audio || null;   // TyreAudio, may be null headless
    this.stats = { barrier: 0, strikes: 0, grindFrames: 0, kart: 0, kerbEnter: 0, sandEnter: 0,
                   rumbleFrames: 0, scrubFrames: 0 };

    // Bound once, stored so dispose() can off() the SAME references.
    this._onBarrier = (ev) => this._barrier(ev);
    this._onKart = (ev) => this._kart(ev);
    this._onSurface = (ev) => this._surface(ev);
    this.bus.on('collision.barrier', this._onBarrier);
    this.bus.on('collision.kart', this._onKart);
    this.bus.on('surface.change', this._onSurface);

    this._wp = new THREE.Vector3();   // scratch for wheel world position
  }

  _kartOf(id) {
    return (id >= 0 && id < this.field.length) ? this.field[id] : null;
  }

  _barrier(ev) {
    // race.js emits collision.barrier on EVERY step the kart is inside the wall
    // band, with `impulse` = the outward closing speed (0 when the kart is
    // already scrubbing along the wall). So one event is not one hit. Two
    // regimes, split on the outward speed the sim actually measured:
    //   impulse >= STRIKE_MIN  -> a STRIKE: sharp shake, camera hit, dust burst,
    //                             thump.
    //   impulse <  STRIKE_MIN  -> a GRIND along the kerb wall: continuous
    //                             low-amplitude rumble re-armed each step. This
    //                             IS the "kerb strike rumbles" channel - the
    //                             wall sits at HALF_W - COLLIDER_R, so a kart
    //                             body touching the kerb is exactly this state.
    this.stats.barrier++;
    const rk = this.race.karts[ev.kartId];
    const k = this._kartOf(ev.kartId);
    const isPlayer = ev.kartId === this.playerId;
    if (ev.impulse >= STRIKE_MIN) {
      this.stats.strikes++;
      const spd = ev.impulse;
      const mag = clamp(spd * SHAKE_PER_MS, 0, SHAKE_MAX);
      const dur = clamp(SHAKE_T_MIN + spd * 0.01, SHAKE_T_MIN, SHAKE_T_MAX);
      if (k) k.addShake(mag, dur);
      if (isPlayer && this.chase) this.chase.addImpulse(clamp(spd * IMPULSE_PER_MS, 0, IMPULSE_MAX), dur);
      if (this.audio && isPlayer) this.audio.thump(spd);
      if (this.dust && rk) {
        const v = rk.veh;
        const n = 4 + Math.min(14, Math.floor(spd * 0.6));
        // Burst thrown back along the contact normal, at deck height.
        this.dust.spawn(n, v.x, 0.08, v.z, ev.normalX * spd * 0.25, 0.4, ev.normalZ * spd * 0.25, 0.35);
      }
    } else if (rk && rk.veh.speed > 2) {
      this.stats.grindFrames++;
      const f = Math.min(1, rk.veh.speed / V_TOP);
      if (k) k.addShake(KERB_RUMBLE_MAG * (0.4 + 0.6 * f), KERB_RUMBLE_T);
      if (isPlayer && this.chase) this.chase.addImpulse(KERB_RUMBLE_MAG * 0.9 * f, KERB_RUMBLE_T);
      if (this.dust && (this.stats.grindFrames & 3) === 0) {
        this.dust.spawn(1, rk.veh.x + ev.normalX * -0.5, 0.05, rk.veh.z + ev.normalZ * -0.5, 0, 0.3, 0, 0.15);
      }
    }
  }

  _kart(ev) {
    this.stats.kart++;
    const spd = ev.closingSpeed;
    const mag = clamp(spd * SHAKE_PER_MS * 0.8, 0, SHAKE_MAX);
    const dur = clamp(SHAKE_T_MIN + spd * 0.008, SHAKE_T_MIN, SHAKE_T_MAX);
    const a = this._kartOf(ev.kartId), b = this._kartOf(ev.otherId);
    if (a) a.addShake(mag, dur);
    if (b) b.addShake(mag, dur);
    if (ev.kartId === this.playerId || ev.otherId === this.playerId) {
      if (this.chase) this.chase.addImpulse(clamp(spd * IMPULSE_PER_MS * 0.8, 0, IMPULSE_MAX), dur);
      if (this.audio) this.audio.thump(spd);
    }
    if (this.dust) {
      const rk = this.race.karts[ev.kartId];
      if (rk) this.dust.spawn(3 + Math.min(8, Math.floor(spd * 0.5)), rk.veh.x, 0.10, rk.veh.z, 0, 0.5, 0, 0.30);
    }
  }

  _surface(ev) {
    // Entering the kerb or the sand is a strike: a single sharp shake plus a
    // puff. Staying on it is handled per frame as a rumble.
    if (ev.to === 'kerb') this.stats.kerbEnter++;
    else if (ev.to === 'sand') this.stats.sandEnter++;
    else return;
    const rk = this.race.karts[ev.kartId];
    const spd = rk ? rk.veh.speed : 0;
    const mag = clamp(0.004 + spd * 0.0006, 0, 0.022);
    const k = this._kartOf(ev.kartId);
    if (k) k.addShake(mag, 0.16);
    if (ev.kartId === this.playerId && this.chase) this.chase.addImpulse(mag * 1.6, 0.16);
    if (this.dust && rk) {
      this.dust.spawn(ev.to === 'sand' ? 8 : 4, rk.veh.x, 0.06, rk.veh.z, 0, 0.3, 0, KART_W * 0.5);
    }
  }

  // Per-frame: kerb rumble and tyre-scrub dust. Both are STATES, not events, so
  // they are read off the sim each frame rather than waiting for an emit.
  update(dt) {
    const karts = this.race.karts;
    for (let i = 0; i < karts.length; i++) {
      const rk = karts[i], k = this.field[i];
      if (!k) continue;
      const v = rk.veh;
      if (rk.surface === 'kerb' && v.speed > 2) {
        this.stats.rumbleFrames++;
        // Re-armed every frame: a low continuous buzz whose amplitude follows
        // speed, so a slow kerb crawl barely moves and a 100 km/h kerb ride
        // shakes hard.
        k.addShake(KERB_RUMBLE_MAG * (0.4 + 0.6 * Math.min(1, v.speed / V_TOP)), KERB_RUMBLE_T);
        if (i === this.playerId && this.chase) {
          this.chase.addImpulse(KERB_RUMBLE_MAG * 0.9 * Math.min(1, v.speed / V_TOP), KERB_RUMBLE_T);
        }
      }
      const util = v.utilR > v.utilF ? v.utilR : v.utilF;
      if (this.dust && util >= SCRUB_UTIL_MIN && v.speed > 4) {
        this.stats.scrubFrames++;
        // Trickle from the rear wheels, alternating sides by frame parity, so a
        // long slide sheds a continuous plume without a per-frame burst.
        const w = k.sockets[(this.race.time * 120 | 0) & 1 ? 'wheel_rl' : 'wheel_rr'];
        if (w) {
          w.getWorldPosition(this._wp);
          this.dust.spawn(1, this._wp.x, 0.05, this._wp.z, -Math.sin(v.yaw) * -2, 0.2, -Math.cos(v.yaw) * -2, 0.12);
        }
      }
    }
    if (this.dust) this.dust.update(dt);
  }

  dispose() {
    this.bus.off('collision.barrier', this._onBarrier);
    this.bus.off('collision.kart', this._onKart);
    this.bus.off('surface.change', this._onSurface);
    if (this.dust) this.dust.dispose();
  }
}
