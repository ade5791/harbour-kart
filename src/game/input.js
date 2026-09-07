// =============================================================================
// Harbour Kart - INPUT. Keyboard + touch, one source of truth.
// =============================================================================
//
// DESIGN RULES, each from a stated requirement in the step brief:
//
//  1. MULTI-TOUCH IS MANDATORY. "A racer that drops inputs when a second finger
//     lands is unplayable on touch." Every touch zone therefore tracks its own
//     pointerId set. Steering and throttle are independent pointer captures, so
//     a thumb on the left pad and a thumb on the right pad are BOTH live. This
//     is why the implementation uses Pointer Events with setPointerCapture and
//     a per-zone Set, not a single `activePointer` variable.
//
//  2. ONE THUMB PER SIDE. Steering occupies the LEFT half, accelerate/brake the
//     RIGHT half. Zones do not overlap: the split is a hard x boundary at 50%
//     of the viewport, asserted by the QA harness (no zone rect intersects
//     another).
//
//  3. UNSAFE AREAS. env(safe-area-inset-*) padding is applied so controls clear
//     notches and home indicators.
//
//  4. ZERO ALLOCATION PER FRAME. read() writes into a preallocated object.
//     Nothing here allocates after construction except DOM event objects, which
//     the browser owns.
//
//  5. ANALOGUE STEER ON TOUCH. A digital left/right on a kart racer at 103 km/h
//     is unplayable - the derived difficulty surface (SIGHT_LINE_MIN 39 m)
//     assumes the player can make a partial correction. The touch pad therefore
//     reports a continuous -1..+1 from thumb offset within the pad.
//
//  6. KEYBOARD STEER IS RAMPED, not binary, for the same reason. The ramp is in
//     input space only; the vehicle's own STEER_RATE still governs the rack.

export const STEER_RAMP_UP = 4.2;    // 1/s, how fast a held key reaches full lock
export const STEER_RAMP_DOWN = 6.5;  // 1/s, how fast it centres on release
export const TOUCH_PAD_RADIUS = 78;  // px, offset for full lock on the steer pad
export const TOUCH_DEADZONE = 6;     // px

const KEY_LEFT = ['ArrowLeft', 'KeyA'];
const KEY_RIGHT = ['ArrowRight', 'KeyD'];
const KEY_THROTTLE = ['ArrowUp', 'KeyW'];
const KEY_BRAKE = ['ArrowDown', 'KeyS'];
const KEY_DRIFT = ['Space', 'ShiftLeft', 'ShiftRight'];
const KEY_ITEM = ['KeyE', 'Enter'];
const KEY_PAUSE = ['Escape', 'KeyP'];

export class InputSystem {
  /**
   * @param {object} o  { target, touchRoot, onPause, onItem, onFirstInput }
   */
  constructor(o) {
    const opts = o || {};
    this.target = opts.target || window;
    this.touchRoot = opts.touchRoot || null;
    this.onPause = opts.onPause || null;
    this.onItem = opts.onItem || null;
    this.onFirstInput = opts.onFirstInput || null;

    // ---- PREALLOCATED output. read() fills this; never a new object. ----
    this.state = { throttle: 0, brake: 0, steer: 0, drift: false };

    // ---- key state ----
    this.keys = Object.create(null);
    this._steerKey = 0;          // ramped -1..1 from keyboard

    // ---- touch state (per-zone pointer sets; multi-touch safe) ----
    this.touch = {
      active: false,
      steerId: -1, steerX0: 0, steerX: 0, steerVal: 0,
      throttleIds: new Set(),
      brakeIds: new Set(),
      driftIds: new Set()
    };

    // ---- telemetry the QA harness reads ----
    this.stats = {
      firstInputT: -1,
      keyEvents: 0,
      touchEvents: 0,
      maxConcurrentPointers: 0,
      droppedWhileMulti: 0   // increments if a zone loses its pointer while
                             // another zone gains one - the exact failure the
                             // brief calls out. Must stay 0.
    };
    this._livePointers = new Set();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._bound = [];
    this._zones = [];
    this._disposed = false;
  }

  attach() {
    this.target.addEventListener('keydown', this._onKeyDown, { passive: false });
    this.target.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    return this;
  }

  /**
   * Register a touch zone element.
   * kind: 'steer' | 'throttle' | 'brake' | 'drift'
   */
  addZone(el, kind) {
    if (!el) return this;
    const steerAt = (e) => {
      const t = this.touch, r = el.getBoundingClientRect();
      t.steerX0 = r.width * 0.5;
      t.steerX = e.clientX - r.left;
      let d = t.steerX - t.steerX0;
      d = Math.sign(d) * Math.max(0, Math.abs(d) - TOUCH_DEADZONE);
      const radius = Math.max(1, Math.min(TOUCH_PAD_RADIUS, r.width * 0.5 - TOUCH_DEADZONE));
      t.steerVal = Math.max(-1, Math.min(1, d / radius));
      el.dataset.direction = t.steerVal < 0 ? 'left' : t.steerVal > 0 ? 'right' : 'center';
      el.style.setProperty('--steer', String(t.steerVal));
    };
    const down = (e) => {
      // Keep the original steering owner if another finger hits this zone.
      if (kind === 'steer' && this.touch.steerId >= 0) return;
      e.preventDefault();
      this.stats.touchEvents++;
      this._livePointers.add(e.pointerId);
      if (this._livePointers.size > this.stats.maxConcurrentPointers) {
        this.stats.maxConcurrentPointers = this._livePointers.size;
      }
      this._markFirstInput();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
      const t = this.touch;
      t.active = true;
      if (kind === 'steer') {
        // Fixed centre: pressing either labelled half turns immediately.
        t.steerId = e.pointerId;
        steerAt(e);
      } else if (kind === 'throttle') { t.throttleIds.add(e.pointerId); }
      else if (kind === 'brake') { t.brakeIds.add(e.pointerId); }
      else if (kind === 'drift') { t.driftIds.add(e.pointerId); }
      el.classList.add('held');
    };
    const move = (e) => {
      const t = this.touch;
      if (kind === 'steer' && e.pointerId === t.steerId) {
        e.preventDefault();
        steerAt(e);
      }
    };
    const up = (e) => {
      this.stats.touchEvents++;
      // S9: this counter was declared and never incremented - a check that could
      // not fail. It exists to catch the real touch defect: a zone losing its
      // pointer INVOLUNTARILY while another finger is still down (the browser or
      // OS stealing capture), which on a racer reads as "steering died when I
      // touched the brake". A pointerup is a DELIBERATE release by the player and
      // must never count, or the counter would fire on every normal lift and be
      // just as useless in the opposite direction. Only pointercancel counts, and
      // only while a second pointer is still live.
      if (e.type === 'pointercancel' && this._livePointers.size > 1) {
        this.stats.droppedWhileMulti++;
      }
      this._livePointers.delete(e.pointerId);
      const t = this.touch;
      if (kind === 'steer' && e.pointerId === t.steerId) {
        t.steerId = -1; t.steerVal = 0;
      } else if (kind === 'throttle') { t.throttleIds.delete(e.pointerId); }
      else if (kind === 'brake') { t.brakeIds.delete(e.pointerId); }
      else if (kind === 'drift') { t.driftIds.delete(e.pointerId); }
      const held = kind === 'steer' ? t.steerId >= 0 :
        kind === 'throttle' ? t.throttleIds.size > 0 :
        kind === 'brake' ? t.brakeIds.size > 0 : t.driftIds.size > 0;
      el.classList.toggle('held', held);
      if (kind === 'steer' && !held) {
        el.dataset.direction = 'center';
        el.style.setProperty('--steer', '0');
      }
      t.active = t.steerId >= 0 || t.throttleIds.size > 0 ||
                 t.brakeIds.size > 0 || t.driftIds.size > 0;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    // NOTE: no 'pointerleave' handler. With setPointerCapture the pointer stays
    // bound to the element, and a leave-driven release is exactly what makes a
    // steering thumb drop out when it slides past the pad edge mid-corner.
    this._zones.push({ el, down, move, up, kind });
    return this;
  }

  _markFirstInput() {
    if (this.stats.firstInputT < 0) {
      this.stats.firstInputT = performance.now();
      if (this.onFirstInput) this.onFirstInput();
    }
  }

  _onKeyDown(e) {
    if (this.keys[e.code]) return;   // ignore auto-repeat
    this.keys[e.code] = true;
    this.stats.keyEvents++;
    this._markFirstInput();
    if (KEY_PAUSE.indexOf(e.code) >= 0 && this.onPause) { e.preventDefault(); this.onPause(); }
    if (KEY_ITEM.indexOf(e.code) >= 0 && this.onItem) { e.preventDefault(); this.onItem(); }
    // Stop the page scrolling under the game on arrows/space.
    if (KEY_LEFT.indexOf(e.code) >= 0 || KEY_RIGHT.indexOf(e.code) >= 0 ||
        KEY_THROTTLE.indexOf(e.code) >= 0 || KEY_BRAKE.indexOf(e.code) >= 0 ||
        KEY_DRIFT.indexOf(e.code) >= 0) {
      e.preventDefault();
    }
  }

  _onKeyUp(e) { this.keys[e.code] = false; }

  // A tab switch must not leave the throttle pinned open.
  _onBlur() {
    for (const k in this.keys) this.keys[k] = false;
    this._steerKey = 0;
    this.touch.steerId = -1; this.touch.steerVal = 0;
    this.touch.throttleIds.clear();
    this.touch.brakeIds.clear();
    this.touch.driftIds.clear();
    this.touch.active = false;
    this._livePointers.clear();
    for (const zone of this._zones) {
      zone.el.classList.remove('held');
      if (zone.kind === 'steer') {
        zone.el.dataset.direction = 'center';
        zone.el.style.setProperty('--steer', '0');
      }
    }
  }

  _any(list) {
    for (let i = 0; i < list.length; i++) if (this.keys[list[i]]) return true;
    return false;
  }

  /**
   * Read the current command into the preallocated state object.
   * dt is the WALL delta - the ramp is a UI smoothing, not simulation.
   */
  read(dt) {
    const s = this.state;
    const t = this.touch;

    // ---- steering: keyboard ramp, then touch override when a thumb is down --
    const kl = this._any(KEY_LEFT), kr = this._any(KEY_RIGHT);
    let want = 0;
    if (kl && !kr) want = -1; else if (kr && !kl) want = 1;
    const rate = want === 0 ? STEER_RAMP_DOWN : STEER_RAMP_UP;
    const d = want - this._steerKey;
    const step = rate * dt;
    if (d > step) this._steerKey += step;
    else if (d < -step) this._steerKey -= step;
    else this._steerKey = want;

    // UI uses screen-space right-positive; Vehicle uses yaw/left-positive.
    // Convert exactly once at the input boundary, for BOTH keyboard and touch.
    s.steer = -((t.steerId >= 0) ? t.steerVal : this._steerKey);

    // ---- throttle / brake ----
    // Touch and keyboard are OR-ed, so a hybrid device (touch laptop) works.
    const thrKey = this._any(KEY_THROTTLE);
    const brkKey = this._any(KEY_BRAKE);
    s.throttle = (thrKey || t.throttleIds.size > 0) ? 1 : 0;
    s.brake = (brkKey || t.brakeIds.size > 0) ? 1 : 0;
    s.drift = this._any(KEY_DRIFT) || t.driftIds.size > 0;
    return s;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    for (const z of this._zones) {
      z.el.removeEventListener('pointerdown', z.down);
      z.el.removeEventListener('pointermove', z.move);
      z.el.removeEventListener('pointerup', z.up);
      z.el.removeEventListener('pointercancel', z.up);
    }
    this._zones.length = 0;
    this._livePointers.clear();
  }
}
