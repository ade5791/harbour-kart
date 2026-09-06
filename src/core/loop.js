// Fixed-step simulation, interpolated render.
//
// Gameplay is NEVER driven off frame delta. The accumulator runs at DT and the
// renderer receives alpha in [0,1) to interpolate with.
//
// Two failure modes this guards against explicitly, both previously paid for:
//  1. A visibility pause hands back a multi-second delta on the resumed frame.
//     Clamp to MAX_DELTA BEFORE the accumulator, or the substep cap blows.
//  2. After MAX_SUBSTEPS the accumulator is DRAINED, not carried. Carrying it
//     converts one slow frame into a permanent death spiral.
//
// The loop is driveable headlessly: `step(delta)` is pure and has no RAF or DOM
// dependency, so tools/smoke.mjs can pump it deterministically.

import { DT, MAX_SUBSTEPS, MAX_DELTA } from './config.js';

export class FixedLoop {
  constructor(registry, opts) {
    const o = opts || {};
    this.registry = registry;
    this.bus = o.bus || null;
    this.dt = o.dt !== undefined ? o.dt : DT;
    this.maxSubsteps = o.maxSubsteps !== undefined ? o.maxSubsteps : MAX_SUBSTEPS;
    this.maxDelta = o.maxDelta !== undefined ? o.maxDelta : MAX_DELTA;

    this.accumulator = 0;
    this.time = 0;              // total SIMULATED time; never wall time
    this.frames = 0;
    this.steps = 0;
    this.alpha = 0;

    // Diagnostics, preallocated. No object is created per frame.
    this.stat = {
      lastSubsteps: 0,
      clampedFrames: 0,         // frames whose delta hit MAX_DELTA
      drainedFrames: 0,         // frames that hit the substep cap
      maxSubstepsSeen: 0
    };
    this._running = false;
    this._raf = 0;
    this._lastMs = 0;
    this._onVisibility = null;
    this._tick = null;
  }

  // Pure, headless-safe. delta is SECONDS of wall time since the last frame.
  step(delta) {
    let d = delta;
    if (!(d > 0)) d = 0;                       // also traps NaN
    if (d > this.maxDelta) {                   // rule 1: clamp BEFORE accumulate
      d = this.maxDelta;
      this.stat.clampedFrames++;
    }

    this.accumulator += d;

    let n = 0;
    while (this.accumulator >= this.dt && n < this.maxSubsteps) {
      this.registry.fixedUpdate(this.dt);
      this.accumulator -= this.dt;
      this.time += this.dt;
      this.steps++;
      n++;
    }
    if (n === this.maxSubsteps && this.accumulator >= this.dt) {
      this.accumulator = 0;                    // rule 2: DRAIN, never carry
      this.stat.drainedFrames++;
    }

    this.stat.lastSubsteps = n;
    if (n > this.stat.maxSubstepsSeen) this.stat.maxSubstepsSeen = n;

    this.alpha = this.accumulator / this.dt;
    this.registry.update(d, this.alpha);
    this.registry.lateUpdate(d);
    this.frames++;
    return n;
  }

  // ---- browser driving (no-ops headlessly) --------------------------------
  start() {
    if (this._running) return this;
    if (typeof requestAnimationFrame !== 'function') return this;
    this._running = true;
    this._lastMs = 0;

    this._tick = (ms) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(this._tick);
      if (this._lastMs === 0) { this._lastMs = ms; return; }
      const delta = (ms - this._lastMs) / 1000;
      this._lastMs = ms;
      this.step(delta);
    };
    this._raf = requestAnimationFrame(this._tick);

    if (typeof document !== 'undefined' && document.addEventListener) {
      this._onVisibility = () => {
        const hidden = document.hidden;
        // Reset the frame clock so the resumed frame reports a small delta
        // rather than the whole hidden duration.
        if (!hidden) this._lastMs = 0;
        if (this.bus) {
          this.bus.emit('visibility', { hidden, clampedDelta: this.maxDelta });
        }
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
    return this;
  }

  stop() {
    this._running = false;
    if (this._raf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._raf);
    }
    this._raf = 0;
    if (this._onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = null;
    }
    this._tick = null;
    return this;
  }

  // Snapshot/restore for simulation-transparent shader prewarm. Prewarm must
  // not move the clock or the accumulator, or downstream captures drift and the
  // pixel gate reports phantom regressions.
  snapshot() {
    return { accumulator: this.accumulator, time: this.time, steps: this.steps, frames: this.frames, alpha: this.alpha };
  }

  restore(s) {
    this.accumulator = s.accumulator;
    this.time = s.time;
    this.steps = s.steps;
    this.frames = s.frames;
    this.alpha = s.alpha;
    return this;
  }

  dispose() { this.stop(); }
}
