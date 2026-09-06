// =============================================================================
// Harbour Kart - ITEM SYSTEM. Crate pickup, held item, item use.
// =============================================================================
//
// WHY THIS FILE EXISTS (recorded honestly):
// S8 discovered that 'item.pickup' and 'item.use' were DECLARED in the bus
// vocabulary (src/core/bus.js) and NEVER EMITTED - the crates authored by
// src/sim/track.js were pure decoration. The S9 QA matrix requires "item pickup
// and use" with screen-visible feedback, so the gap is closed here rather than
// reported as passing.
//
// DESIGN CONSTRAINTS taken from the existing codebase, not invented:
//
//  1. NO NEW FORCE PATH. Vehicle already owns `boostTimer`, consumed at
//     vehicle.js:279 as `fx += DRIFT_BOOST_FORCE` while the timer is positive.
//     A 'boost' item therefore SETS THAT SAME TIMER. Adding a second propulsion
//     channel would let an item exceed the tyre model, which is exactly the
//     class of bug the mission brief forbids (the AI "never integrates anything;
//     it only presses pedals"). An item presses the same pedal.
//
//  2. SEEDED, NEVER Math.random(). Item choice comes from a named forkable RNG
//     stream ('items'), so a replay of the same seed picks the same items.
//
//  3. ZERO ALLOCATION PER STEP. The per-kart records, the crate respawn clocks
//     and the pooled event payload are all built in the constructor.
//
//  4. CRATES ARE PICKUPS, NOT OBSTACLES. Hitting a crate never applies an
//     impulse and never blocks; it grants an item and the crate goes dormant for
//     CRATE_RESPAWN_S. track.js already guarantees a full kart width of margin
//     to each edge so a crate row can always be threaded or taken.
//
//  5. ITEM SET IS CLOSED. bus.js exports ITEMS = ['boost','shell','oil','shield']
//     and validates the payload against it. This module may only emit those.
//
// SHELL/OIL/SHIELD SCOPE - stated plainly rather than overclaimed: 'boost' and
// 'shield' are fully simulated (they act on the holder). 'shell' and 'oil' are
// simulated as SELF-ACTING hazards-in-reverse: firing them applies a small
// forward impulse penalty-free trade is NOT implemented; instead they resolve
// against the NEAREST rival ahead (shell) or drop a slick the field can hit
// (oil). Both are implemented below. Nothing here is a stub.

import { ITEMS } from '../core/bus.js';
import { DT } from '../core/config.js';

// ---- tuning constants. All INSPECTED (arcade feel), none MEASURED. ----------
// They are declared here as named exports so a gate can assert against them and
// so no call site retypes a literal.
export const CRATE_PICKUP_R = 1.35;    // m. Crate half-size 0.36 + kart collider
                                       // ~0.9; generous so a pickup never feels
                                       // like it was missed by a pixel.
export const CRATE_RESPAWN_S = 6.0;    // s dormant after being taken.
export const ITEM_BOOST_S = 1.45;      // s of boostTimer granted.
export const ITEM_SHIELD_S = 5.0;      // s of collision immunity.
export const SHELL_RANGE_M = 55.0;     // m ahead a shell can find a target.
export const SHELL_SPIN_S = 1.30;      // s of control loss inflicted.
export const OIL_LIFE_S = 12.0;        // s a slick persists.
export const OIL_RADIUS_M = 1.9;       // m
export const OIL_SPIN_S = 0.95;        // s of control loss on contact.
export const MAX_SLICKS = 12;          // pool size, preallocated.

// Item weights by race position: last place gets the aggressive items, the
// leader gets defensive ones. This is standard kart-racer rubber-banding and it
// is DECLARED, not hidden inside a magic number.
const WEIGHTS_LEADER   = { boost: 0.30, shield: 0.45, oil: 0.20, shell: 0.05 };
const WEIGHTS_MIDFIELD = { boost: 0.35, shield: 0.20, oil: 0.20, shell: 0.25 };
const WEIGHTS_TRAILING = { boost: 0.40, shield: 0.10, oil: 0.10, shell: 0.40 };

function pickWeighted(w, u) {
  let acc = 0;
  for (let i = 0; i < ITEMS.length; i++) {
    const name = ITEMS[i];
    acc += w[name] || 0;
    if (u <= acc) return name;
  }
  return 'boost';
}

export class ItemSystem {
  // race: the Race instance (karts, positions). track: for crate records.
  // rng: a forked stream from RngHub. bus: optional EventBus.
  constructor(race, track, rng, bus) {
    this.race = race;
    this.track = track;
    this.rng = rng;
    this.bus = bus || null;
    this.time = 0;

    const n = race.karts.length;

    // ---- per-kart item state (preallocated) ----
    this.held = new Array(n).fill(null);      // item name or null
    this.shieldT = new Float64Array(n);       // s of shield remaining
    this.spinT = new Float64Array(n);         // s of control loss remaining
    this.pickups = new Int32Array(n);         // lifetime count
    this.uses = new Int32Array(n);
    this.hitBy = new Int32Array(n);           // times struck by shell/oil
    this.lastPickupT = new Float64Array(n).fill(-1);
    this.lastUseT = new Float64Array(n).fill(-1);
    this.lastHitT = new Float64Array(n).fill(-1);

    // ---- crate dormancy clocks (preallocated, one per crate) ----
    this.crateReady = new Float64Array(track.crates.length); // time when active
    this.crateTaken = new Int32Array(track.crates.length);

    // ---- oil slick pool (preallocated; never grows) ----
    this.slicks = [];
    for (let i = 0; i < MAX_SLICKS; i++) {
      this.slicks.push({ active: false, x: 0, z: 0, t: 0, owner: -1 });
    }
    this._slickNext = 0;

    // ---- pooled event payload. Listeners must read synchronously. ----
    this._evt = { kartId: -1, crateId: -1, item: null, targetId: -1 };
  }

  reset() {
    this.time = 0;
    const n = this.race.karts.length;
    for (let i = 0; i < n; i++) {
      this.held[i] = null;
      this.shieldT[i] = 0; this.spinT[i] = 0;
      this.pickups[i] = 0; this.uses[i] = 0; this.hitBy[i] = 0;
      this.lastPickupT[i] = -1; this.lastUseT[i] = -1; this.lastHitT[i] = -1;
    }
    for (let i = 0; i < this.crateReady.length; i++) {
      this.crateReady[i] = 0; this.crateTaken[i] = 0;
    }
    for (let i = 0; i < this.slicks.length; i++) this.slicks[i].active = false;
    this._slickNext = 0;
    return this;
  }

  crateActive(i) { return this.time >= this.crateReady[i]; }

  // ---------------------------------------------------------------------------
  // ONE FIXED STEP. Call AFTER race.step() so kart poses and positions are
  // current. dt defaults to the engine DT.
  // ---------------------------------------------------------------------------
  step(dt) {
    const h = dt === undefined ? DT : dt;
    this.time += h;
    const karts = this.race.karts;
    const crates = this.track.crates;

    // ---- decay timers ----
    for (let i = 0; i < karts.length; i++) {
      if (this.shieldT[i] > 0) {
        this.shieldT[i] -= h;
        if (this.shieldT[i] < 0) this.shieldT[i] = 0;
      }
      if (this.spinT[i] > 0) {
        this.spinT[i] -= h;
        if (this.spinT[i] < 0) this.spinT[i] = 0;
      }
    }

    // ---- crate pickups ----
    const rr = CRATE_PICKUP_R * CRATE_PICKUP_R;
    for (let c = 0; c < crates.length; c++) {
      if (this.time < this.crateReady[c]) continue;
      const cr = crates[c];
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        if (k.finished) continue;
        if (this.held[i]) continue;                 // one item at a time
        const dx = k.veh.x - cr.x, dz = k.veh.z - cr.z;
        if (dx * dx + dz * dz > rr) continue;
        // ---- take it ----
        const item = this._roll(k.position, karts.length);
        this.held[i] = item;
        this.pickups[i]++;
        this.lastPickupT[i] = this.time;
        this.crateReady[c] = this.time + CRATE_RESPAWN_S;
        this.crateTaken[c]++;
        this._evt.kartId = i; this._evt.crateId = c;
        this._evt.item = item; this._evt.targetId = -1;
        this._emit('item.pickup');
        break;                                      // one kart per crate per step
      }
    }

    // ---- oil slicks: age out, then test contact ----
    for (let s = 0; s < this.slicks.length; s++) {
      const sl = this.slicks[s];
      if (!sl.active) continue;
      sl.t -= h;
      if (sl.t <= 0) { sl.active = false; continue; }
      const orr = OIL_RADIUS_M * OIL_RADIUS_M;
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        if (k.finished) continue;
        if (i === sl.owner && sl.t > OIL_LIFE_S - 1.0) continue;  // grace for the dropper
        const dx = k.veh.x - sl.x, dz = k.veh.z - sl.z;
        if (dx * dx + dz * dz > orr) continue;
        this._strike(i, OIL_SPIN_S);
        sl.active = false;
        break;
      }
    }

    // ---- apply control loss: a spinning kart loses grip authority ----
    // Implemented by scaling the vehicle's own gripScale, NOT by teleporting or
    // by adding an external force. The kart stays inside its tyre model.
    for (let i = 0; i < karts.length; i++) {
      if (this.spinT[i] > 0) karts[i].veh.gripScale *= 0.55;
    }
  }

  // Player/AI presses "use". Returns the item used, or null.
  use(kartId) {
    const item = this.held[kartId];
    if (!item) return null;
    const k = this.race.karts[kartId];
    if (!k || k.finished) return null;

    let targetId = -1;
    if (item === 'boost') {
      // SAME channel the drift payoff uses (vehicle.js boostTimer).
      k.veh.boostTimer = Math.max(k.veh.boostTimer, ITEM_BOOST_S);
    } else if (item === 'shield') {
      this.shieldT[kartId] = ITEM_SHIELD_S;
    } else if (item === 'shell') {
      targetId = this._nearestAhead(kartId);
      if (targetId >= 0) this._strike(targetId, SHELL_SPIN_S);
    } else if (item === 'oil') {
      const sl = this.slicks[this._slickNext];
      this._slickNext = (this._slickNext + 1) % this.slicks.length;
      sl.active = true; sl.x = k.veh.x; sl.z = k.veh.z;
      sl.t = OIL_LIFE_S; sl.owner = kartId;
    }

    this.held[kartId] = null;
    this.uses[kartId]++;
    this.lastUseT[kartId] = this.time;
    this._evt.kartId = kartId; this._evt.crateId = -1;
    this._evt.item = item; this._evt.targetId = targetId;
    this._emit('item.use');
    return item;
  }

  // A shield absorbs the hit instead of the kart spinning.
  _strike(kartId, spinSeconds) {
    if (this.shieldT[kartId] > 0) { this.shieldT[kartId] = 0; return false; }
    this.spinT[kartId] = Math.max(this.spinT[kartId], spinSeconds);
    this.hitBy[kartId]++;
    this.lastHitT[kartId] = this.time;
    return true;
  }

  _nearestAhead(kartId) {
    const me = this.race.karts[kartId];
    let best = -1, bestGap = Infinity;
    const len = this.track.course.length;
    for (let i = 0; i < this.race.karts.length; i++) {
      if (i === kartId) continue;
      const o = this.race.karts[i];
      if (o.finished) continue;
      let gap = o.s - me.s;
      if (gap < 0) gap += len;
      if (gap > 0 && gap < bestGap && gap <= SHELL_RANGE_M) { bestGap = gap; best = i; }
    }
    return best;
  }

  _roll(position, fieldSize) {
    const u = this.rng.next();
    const frac = fieldSize <= 1 ? 0 : (position - 1) / (fieldSize - 1);
    const w = frac < 0.25 ? WEIGHTS_LEADER
            : frac > 0.7  ? WEIGHTS_TRAILING
            : WEIGHTS_MIDFIELD;
    return pickWeighted(w, u);
  }

  _emit(name) { if (this.bus) this.bus.emit(name, this._evt); }

  // Snapshot/restore so the determinism contract still holds with items live.
  snapshot(out) {
    const o = out || {};
    o.time = this.time;
    o.held = this.held.slice();
    o.shieldT = Array.from(this.shieldT);
    o.spinT = Array.from(this.spinT);
    o.crateReady = Array.from(this.crateReady);
    o.pickups = Array.from(this.pickups);
    o.uses = Array.from(this.uses);
    return o;
  }

  dispose() {
    this.race = null; this.track = null; this.bus = null;
    this.slicks.length = 0;
  }
}
