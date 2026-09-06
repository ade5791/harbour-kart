// =============================================================================
// Harbour Kart - THE GAME. Shipping entry point.
// =============================================================================
//
// This is the first module in the project that is a GAME rather than a
// measurement harness. It owns no simulation and no rendering of its own: every
// number it shows and every pixel it draws comes from the modules S1-S8 built
// and gated. Its whole job is the player journey - menu, countdown, race,
// pause, results - plus the input layer and the review states.
//
// WIRING ORDER IS LOAD-BEARING (S8 recorded the defect):
//   build the FULL scene graph (harbour + six karts + dust) BEFORE sys.warm().
// Prewarm compiles against `this.scene`; any material added afterwards is
// invisible to it and gets compiled lazily during play, which is a multi-second
// stall on a cold GPU. The order below is: RenderSystem.init -> field -> dust ->
// warm(). Do not reorder.
//
// FIXED-STEP SIM, INTERPOLATED RENDER (hard rule 4): the sim advances only
// inside FixedLoop.step(), never off the frame delta. Camera, dust, HUD and
// crate spin are PRESENTATION and run on wall delta - they cannot change
// handling.
//
// ZERO ALLOCATION PER FRAME (hard rule 3): every vector, sample and input object
// is built in the constructor. The frame callback allocates nothing.

import * as THREE from 'three';
import { Track } from '../sim/track.js';
import { Race } from '../sim/race.js';
import { ItemSystem } from '../sim/items.js';
import { AIDriver } from '../sim/ai.js';
import { makeInput } from '../sim/vehicle.js';
import { RngHub } from '../core/rng.js';
import { FixedLoop } from '../core/loop.js';
import { EventBus } from '../core/bus.js';
import { RenderSystem } from '../render/index.js';
import { KartResources, buildField } from '../render/kart.js';
import { ChaseCamera } from '../render/chasecam.js';
import { DustPool, ImpactFeedback } from '../render/feedback.js';
import { HUD, formatTime } from '../render/hud.js';
import { WaypointArrow } from '../render/waypoint.js';
import { TyreAudio } from '../audio/tyres.js';
import { DT, LAP_COUNT, V_TOP, SIGHT_LINE_MIN, LAST_MAN_GRACE_S } from '../core/config.js';
import { GAME_STATE, COUNTDOWN_STEPS, COUNTDOWN_TOTAL, COUNTDOWN_GO_HOLD } from './states.js';
import { InputSystem } from './input.js';

const LANE_OFFSET = 1.35;   // m, lateral stagger when the field is teleported

export class Game {
  /**
   * @param {object} o { root, review }
   *   root:   the DOM element the canvas and UI live in
   *   review: parsed review-state descriptor (see states.js)
   */
  constructor(o) {
    const opts = o || {};
    this.root = opts.root;
    this.review = opts.review;
    this.ui = opts.ui || null;      // UI adapter, injected (see main.js)

    this.state = GAME_STATE.LOADING;
    this.quality = this.review.quality || 'high';
    this.reduced = this.review.reduced;
    this.autopilot = this.review.autopilot;

    // ---- PREALLOCATED SCRATCH. Nothing below is created per frame. ----
    this._smp = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    this._aiSmp = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    this._input = makeInput();
    this._zeroInput = makeInput();

    this._raf = 0;
    this._last = 0;
    this._countdownT = 0;
    this._goHold = 0;
    this._firstFrame = true;
    this._disposed = false;

    // ---- telemetry the live QA harness reads off window.__HK ----
    this.telemetry = {
      built: false, warmMs: 0, buildMs: 0,
      frames: 0, frameMs: [], hitches: 0,
      drawCalls: 0, triangles: 0, programs: 0,
      lastLap: 1, laps: 0, overtakes: 0, itemPickups: 0, itemUses: 0,
      barrierHits: 0, kartHits: 0, respawns: 0, lostTime: 0, checkpoints: 0,
      startPosition: 0, bestPosition: 99, worstPosition: 0,
      audioUnlocked: false, orientationChanges: 0, resetsOnOrientation: 0,
      errors: []
    };
  }

  // ---------------------------------------------------------------------------
  // BUILD. Async because shader prewarm is async and must finish behind the
  // loading screen (hard rule 5).
  // ---------------------------------------------------------------------------
  async build() {
    const t0 = performance.now();
    const R = this.review;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hk-canvas';
    this.root.appendChild(this.canvas);

    // ONE SEED BUILDS BOTH. My first wiring called `new Track()` - which
    // defaults to TRACK_SEED 37 - while seeding the RngHub from the review seed,
    // so ?seed=N changed the field and the decor but NOT the course. Two roots
    // means "same seed = same race" is false, and every determinism claim
    // downstream of it is unprovable. tools/s7/harness.mjs pairs them; so does
    // this. (tools/s9/_diag6.mjs measured the pairing: track 37 + hub 37 in
    // traffic is 184.9 s, track 37 + hub 20260101 is 197.6 s - a genuinely
    // different race from the same URL.)
    this.track = new Track(R.seed);
    this.rngHub = new RngHub(R.seed);
    this.bus = new EventBus({});
    this.loop = new FixedLoop(null, { bus: this.bus });

    this.sys = new RenderSystem({
      canvas: this.canvas,
      track: this.track,
      rngHub: this.rngHub,
      loop: this.loop,
      quality: this.quality,
      post: R.post
    });
    await this.sys.init();
    this._applySize();

    // renderer.info auto-resets per internal render() call; post issues six of
    // them, so the counters must be driven manually to be meaningful (S8).
    this.sys.renderer.info.autoReset = false;

    // ---- SIM ----
    this.race = new Race(this.track, this.rngHub, {
      bus: this.bus,
      laps: R.laps || LAP_COUNT
    });
    this.items = new ItemSystem(this.race, this.track, this.rngHub.get('items'), this.bus);

    // ---- FULL SCENE GRAPH BEFORE PREWARM ----
    this.kres = new KartResources(); this.kres.build();
    this.field = buildField(this.kres, this.rngHub, this.race.fieldSize);
    for (const k of this.field) this.sys.scene.add(k.root);
    this.chase = new ChaseCamera(this.sys.camera);
    const particles = Math.min(96, this.sys.preset.maxParticles);
    this.dust = new DustPool(this.rngHub.get('fx'), particles);
    this.sys.scene.add(this.dust.mesh);

    const wt0 = performance.now();
    this.warmReport = await this.sys.warm();
    this.telemetry.warmMs = performance.now() - wt0;

    this.feedback = new ImpactFeedback({
      bus: this.bus, race: this.race, field: this.field,
      chase: this.chase, dust: this.dust, playerId: 0
    });
    this.hud = new HUD(this.root);
    // Waypoint arrow over the track (reference frame). Built from the REAL
    // course corner list and projected through the REAL chase camera every
    // frame. See src/render/waypoint.js for the S9 defect this repairs.
    this.waypoint = new WaypointArrow(this.track.course);

    // Player autopilot (review state ai=1). This is a QA instrument, not a
    // player: it exists so the live harness can drive a real verification lap.
    //
    // TRAITS ARE PINNED, and this was a MEASURED defect in my first wiring.
    // tools/s7/harness.mjs makeAutopilot() pins brakeBias 1.0 / apexError 0.0 /
    // throttleTrim 1.0 / aggression 0.0 / apexSign +1, because tierIndex 4 only
    // sets the ROLL RANGE - a rolled 'master' still draws aggression up to 0.92,
    // which is a drift-happy racer, not a reference lap. Leaving them rolled
    // (tools/s9/_diag5.mjs) covered 60.5 m in 15 s against a pinned 94.8 m, and
    // the rolled pilot spent the opening seconds pinned against the barrier.
    // Pinned, it reproduces the P1 result exactly: 3711 m / 177.8 s solo.
    // The rivals are deliberately NOT pinned - their rolled traits are what
    // makes the field a field.
    // Grace timer for the race-termination safety net (see _fixedUpdate).
    // Preallocated here, never allocated per frame.
    this._lastManT = 0;

    this.pilot = null;
    if (this.autopilot) {
      const ap = new AIDriver(0, this.rngHub.get('ai').fork('probe:autopilot'), 4);
      ap.brakeBias = 1.0;
      ap.apexError = 0.0;
      ap.throttleTrim = 1.0;
      ap.aggression = 0.0;
      ap.apexSign = 1;
      this.pilot = ap;
    }

    // ---- INPUT ----
    this.input = new InputSystem({
      target: window,
      onPause: () => this.togglePause(),
      onItem: () => this.useItem(),
      onFirstInput: () => this._unlockAudio()
    });
    this.input.attach();
    if (this.ui) this.ui.bindTouchZones(this.input);

    // ---- EVENT WIRING. The racing vocabulary, not the retired flap one. ----
    this._wireEvents();

    // ---- FIXED LOOP ADAPTER (registry-shaped, same contract as core) ----
    this.loop.registry = {
      fixedUpdate: (dt) => this._fixedUpdate(dt),
      update: (dt, alpha) => this._update(dt, alpha),
      lateUpdate: () => {}
    };

    this._onResize = () => this._applySize();
    this._onOrientation = () => this._handleOrientation();
    this._onVisibility = () => this._handleVisibility();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onOrientation);
    document.addEventListener('visibilitychange', this._onVisibility);

    this.telemetry.buildMs = performance.now() - t0;
    this.telemetry.built = true;
    return this;
  }

  _wireEvents() {
    const T = this.telemetry;
    this._offs = [];
    const on = (name, fn) => { this.bus.on(name, fn); this._offs.push([name, fn]); };

    on('lap.complete', (ev) => {
      if (ev.kartId !== 0) return;
      T.laps++;
      T.lastLap = ev.lap;
      if (this.ui) this.ui.flashLap(ev.lap, this.race.lapCount, ev.lapTime);
    });
    on('checkpoint.pass', (ev) => { if (ev.kartId === 0) T.checkpoints++; });
    on('collision.barrier', (ev) => {
      if (ev.kartId !== 0) return;
      T.barrierHits++;
      if (this.ui) this.ui.flashHit('barrier');
    });
    on('collision.kart', (ev) => {
      if (ev.kartId !== 0 && ev.otherId !== 0) return;
      T.kartHits++;
      if (this.ui) this.ui.flashHit('kart');
    });
    on('respawn', (ev) => {
      if (ev.kartId !== 0) return;
      T.respawns++;
      T.lostTime += ev.lostTime;
      if (this.ui) this.ui.flashBanner('RESPAWN  -' + ev.lostTime.toFixed(1) + 's');
    });
    on('item.pickup', (ev) => {
      if (ev.kartId !== 0) return;
      T.itemPickups++;
      if (this.ui) this.ui.setItem(ev.item);
    });
    on('item.use', (ev) => {
      if (ev.kartId !== 0) return;
      T.itemUses++;
      if (this.ui) { this.ui.setItem(null); this.ui.flashBanner(ev.item.toUpperCase() + '!'); }
    });
    // RACE END. `race.finish` is emitted PER KART (race.js), so an unfiltered
    // handler ends the race the instant the FIRST kart crosses the line.
    //
    // MEASURED DEFECT (tools/s9/_finishdiag.mjs, seed 37): AI kart 1 finished at
    // t=178.45 s and the game went straight to RESULTS while the player was on
    // LAP 3 at s=1113.1 m - 123 m from the line - with playerFinished=false and
    // race.finished=false. The results screen then showed the player a position
    // they never actually raced to, and the player's own 3rd lap was never
    // completed, so no lap.complete and no race.finish was ever emitted for
    // kart 0. Every other handler in this block already filters on kartId; this
    // one did not. A racer must let the human finish their own race.
    //
    // The race now ends when the PLAYER finishes. Karts still racing behind are
    // classified by their standing at that moment (race.standings() already
    // orders finished karts by finishTime ahead of unfinished karts by
    // progress), which is the normal arcade-racer convention.
    on('race.finish', (ev) => { if (ev.kartId === 0) this.toResults(); });
  }

  // ---------------------------------------------------------------------------
  // REVIEW-STATE APPLICATION. Every jump the brief asks for, applied to the
  // REAL sim state rather than faked in the UI.
  // ---------------------------------------------------------------------------
  applyReview() {
    const R = this.review;
    const course = this.track.course;
    const len = course.length;

    // ---- station: explicit s, or a corner's braking point ----
    let startS = null;
    if (R.s !== null) {
      startS = ((R.s % len) + len) % len;
    } else if (R.corner >= 0) {
      // API TRUTH-CHECK (tools/s9/_api.mjs): there is no `track.corners`. The
      // corner list lives on the COURSE and is a method, `course.corners()`,
      // whose entries carry `s0` (arc start station), `R` and `requiredSight`.
      // My first draft assumed `track.corners[i].sStart` and would have silently
      // fallen through to station 0 for every corner review URL - a review state
      // that lies is worse than one that throws.
      const cs = course.corners();
      const c = cs[((R.corner % cs.length) + cs.length) % cs.length];
      // Place the player exactly SIGHT_LINE_MIN before the corner's ENTRY -
      // the braking point the whole difficulty surface is derived from. This is
      // what makes "review the R=12 hairpin at its braking point" a one-URL
      // operation instead of a three-lap drive.
      startS = ((c.s0 - SIGHT_LINE_MIN) % len + len) % len;
      this._reviewCorner = { index: c.index, R: c.R, requiredSight: c.requiredSight };
    }

    // S9 DEFECT FIX (measured on the live build, not inferred).
    // This block was gated on `startS !== null` ALONE, so the grid was only ever
    // reordered when the URL also carried `s=` or `corner=`. A bare `?pos=6`
    // parsed correctly (review.pos === 6), reached this line, and then did
    // nothing at all - the field kept the default `race.js` grid, which places
    // karts by INDEX (row = i>>1), so the player (kart 0) sat on the front row
    // and the race scored them P1. Measured live: `?pos=6` gave player s=1233.71
    // (the front station) and position 1. The review state silently reported the
    // exact opposite of what was asked for, which is the same class of lie the
    // station-sign comment below was already written to prevent.
    //
    // `pos=` is an independent axis from station: it must reorder the field
    // whether or not a station was named. When no station is given, anchor the
    // reorder on the player's existing grid station so a bare `?pos=n` keeps the
    // field on the real starting grid and only changes WHO is where.
    if (startS === null && R.pos > 0) startS = this.race.karts[0].s;

    if (startS !== null) {
      // Rivals AHEAD of the player, matching the reference frame (player 4th of
      // 6 with rivals ahead) and giving the chase camera something to look at.
      //
      // STATION SIGN IS LOAD-BEARING (S9 defect, measured). `_reviewOrder`
      // returns the field FRONT-FIRST: index 0 of the array is the leader and
      // the player sits at slot (pos-1). Progress along the course INCREASES
      // with s, so the leader must get the HIGHEST station. The original loop
      // used `startS + n * SPACING`, which handed the highest station to the
      // LAST entry - i.e. it placed the "rivals ahead" BEHIND the player. A
      // `?pos=4` URL therefore produced P3, and the review state was lying
      // about the one thing it was asked to set.
      //
      // The player must also stay exactly on `startS`, because for a `corner=`
      // URL that station IS the derived braking point (c.s0 - SIGHT_LINE_MIN).
      // Anchoring on the leader instead would slide the player off the braking
      // point by a spacing-dependent amount and quietly weaken the one review
      // state the difficulty surface depends on.
      const order = this._reviewOrder(R.pos);
      const meSlot = order.indexOf(0);            // where the player sits
      for (let n = 0; n < order.length; n++) {
        const i = order[n];
        // Ahead of the player => further along the course => larger s.
        const s = ((startS + (meSlot - n) * 4.4) % len + len) % len;
        course.sampleInto(s, this._smp);
        const lane = ((n % 2) ? 1 : -1) * LANE_OFFSET;
        const k = this.race.karts[i];
        k.veh.reset(this._smp.x + Math.cos(this._smp.heading) * lane,
                    this._smp.z - Math.sin(this._smp.heading) * lane,
                    this._smp.heading, V_TOP * 0.72);
        k.s = s; k.prevS = s;
      }
      this.chase.reset(this.race.karts[0].veh.x, this.race.karts[0].veh.z,
                       this.race.karts[0].veh.yaw, this.race.karts[0].veh.speed);
    }

    // ---- lap ----
    if (R.lap > 0) {
      const lap = Math.max(1, Math.min(this.race.lapCount, R.lap));
      for (const k of this.race.karts) { k.lap = lap; }
    }

    // ---- item in hand ----
    if (R.item) {
      this.items.held[0] = R.item;
      if (this.ui) this.ui.setItem(R.item);
    }

    // ---- damaged / spun-out ----
    if (R.damaged) { this.items.spinT[0] = 1.2; }

    this.telemetry.startPosition = this.race.karts[0].position;
    return this;
  }

  // Grid order for a requested player position. pos=4 means four karts occupy
  // slots 0..3 with the PLAYER at index 3 of the running order.
  _reviewOrder(pos) {
    const n = this.race.karts.length;
    const out = [];
    const want = (pos > 0) ? Math.max(1, Math.min(n, pos)) : 1;
    for (let i = 1; i < want; i++) out.push(i);       // rivals ahead
    out.push(0);                                       // the player
    for (let i = want; i < n; i++) out.push(i);        // rivals behind
    return out;
  }

  // ---------------------------------------------------------------------------
  // STATE TRANSITIONS
  // ---------------------------------------------------------------------------
  setState(s) {
    this.state = s;
    if (this.ui) this.ui.onState(s, this);
  }

  toMenu() { this.setState(GAME_STATE.MENU); }

  startRace() {
    if (this.review.noCountdown) { this.setState(GAME_STATE.RACING); return; }
    this._countdownT = 0;
    this._goHold = 0;
    this.setState(GAME_STATE.COUNTDOWN);
  }

  togglePause() {
    if (this.state === GAME_STATE.RACING) this.setState(GAME_STATE.PAUSED);
    else if (this.state === GAME_STATE.PAUSED) this.setState(GAME_STATE.RACING);
  }

  toResults() {
    if (this.state === GAME_STATE.RESULTS) return;
    this.setState(GAME_STATE.RESULTS);
  }

  restart() {
    this.race.reset();
    this.items.reset();
    // FixedLoop has no reset(); its accumulator is restored via snapshot/restore.
    // Zeroing the accumulator here prevents a restart from immediately burning
    // leftover time as substeps on the new race's first frame.
    this.loop.restore({ accumulator: 0, time: 0, steps: 0, frames: 0, alpha: 0 });
    const p = this.race.karts[0];
    this.chase.reset(p.veh.x, p.veh.z, p.veh.yaw, 0);
    this.telemetry.laps = 0;
    this.telemetry.overtakes = 0;
    this._lastManT = 0;   // or a restart inherits the previous race's grace clock
    if (this.ui) this.ui.setItem(null);
    this.startRace();
  }

  useItem() {
    if (this.state !== GAME_STATE.RACING) return null;
    return this.items.use(0);
  }

  setQualityLive(name) {
    // Quality is a BUILD-TIME preset here (shadow map sizes, cascade count and
    // post targets are allocated in init). Changing it live would recompile
    // every lit material mid-race - the exact permutation trap rule 5 forbids.
    // Settings therefore reloads with the new preset in the URL, which is
    // honest about the cost rather than pretending it is free.
    const q = new URLSearchParams(location.search);
    q.set('quality', name);
    location.search = q.toString();
  }

  // ---------------------------------------------------------------------------
  // AUDIO. Unlocked on first input, per browser autoplay policy.
  // ---------------------------------------------------------------------------
  _unlockAudio() {
    if (this.telemetry.audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      this.tyres = new TyreAudio(this.audioCtx, this.rngHub.get('fx'), this.race.fieldSize);
      this.telemetry.audioUnlocked = true;
    } catch (e) {
      // Audio is never allowed to break the race.
      this.telemetry.errors.push('audio: ' + e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // SIZING. DPR is capped by the preset; the canvas fills the root.
  // ---------------------------------------------------------------------------
  _applySize() {
    const w = Math.max(1, this.root.clientWidth || window.innerWidth);
    const h = Math.max(1, this.root.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.sys.preset.dprCap);
    this.sys.renderer.setPixelRatio(dpr);
    this.sys.setSize(w, h);
    this.viewport = { w, h, dpr };
  }

  // ORIENTATION CHANGE MUST NOT RESET THE RACE. The only thing that may change
  // is the viewport; sim state, lap, position and clock are untouched. The
  // telemetry counter below is what the QA harness asserts against.
  _handleOrientation() {
    const before = {
      lap: this.race.karts[0].lap,
      s: this.race.karts[0].s,
      t: this.race.time
    };
    this.telemetry.orientationChanges++;
    this._applySize();
    const after = this.race.karts[0];
    if (after.lap !== before.lap || Math.abs(after.s - before.s) > 1e-6 ||
        Math.abs(this.race.time - before.t) > 1e-9) {
      this.telemetry.resetsOnOrientation++;
    }
  }

  // Backgrounding: pause the race and stop the RAF so a returning tab does not
  // resume with a huge delta. FixedLoop clamps too, but not scheduling the frame
  // at all is cheaper and stops the audio.
  _handleVisibility() {
    if (document.hidden) {
      this._wasRacing = (this.state === GAME_STATE.RACING);
      if (this._wasRacing) this.setState(GAME_STATE.PAUSED);
      if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend();
    } else {
      this._last = performance.now();   // discard the gap
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
    }
  }

  // ---------------------------------------------------------------------------
  // SIM STEP (fixed) - the ONLY place race state advances.
  // ---------------------------------------------------------------------------
  _fixedUpdate(dt) {
    let inp = this._zeroInput;
    if (this.state === GAME_STATE.RACING) {
      if (this.pilot) {
        const p = this.race.karts[0];
        const d = this.pilot.update(this.track.course, p.veh, p.s, this._aiSmp);
        this._input.throttle = d.throttle; this._input.brake = d.brake;
        this._input.steer = d.steer; this._input.drift = d.drift;
        inp = this._input;
      } else {
        inp = this._input;   // filled from InputSystem.read() in _frame
      }
      // Control loss from a shell or an oil slick: steering authority is cut,
      // which is the whole point of the item. Applied here so it cannot be
      // bypassed by the autopilot.
      if (this.items.spinT[0] > 0) {
        inp.steer *= 0.15;
        inp.throttle *= 0.35;
      }
    }
    this.race.step(inp, dt);
    this.items.step(dt);

    // Overtake bookkeeping on the player, measured on the sorted running order.
    const pos = this.race.karts[0].position;
    const T = this.telemetry;
    if (T._prevPos === undefined) T._prevPos = pos;
    if (pos < T._prevPos) T.overtakes += (T._prevPos - pos);
    T._prevPos = pos;
    if (pos < T.bestPosition) T.bestPosition = pos;
    if (pos > T.worstPosition) T.worstPosition = pos;

    // SAFETY NET for the race-end rule above. Ending on the PLAYER's finish is
    // correct, but on its own it means a player who never finishes never sees a
    // results screen - the race would hang indefinitely. The respawn system
    // (race.js _checkRecovery) makes permanent stranding very unlikely, but
    // "very unlikely" is not a termination guarantee.
    //
    // So: once EVERY OTHER kart has finished, the player gets a grace window to
    // complete their own lap, and then the race is classified anyway. This
    // preserves the fix (the player is never cut off mid-lap by a rival's
    // finish) while keeping the state machine total.
    if (this.state === GAME_STATE.RACING && !this.race.karts[0].finished) {
      const others = this.race.karts.length - 1;
      if (this.race.finishOrder.length >= others) {
        this._lastManT += dt;
        if (this._lastManT >= LAST_MAN_GRACE_S) this.toResults();
      } else {
        this._lastManT = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PRESENTATION STEP (wall delta) - camera, meshes, HUD. Never simulation.
  // ---------------------------------------------------------------------------
  _update(dt) {
    for (let j = 0; j < this.field.length; j++) {
      const k = this.race.karts[j];
      this.field[j].update(dt, k.veh.speed, k.veh.steerAngle,
                           k.veh.x, 0, k.veh.z, k.veh.yaw);
    }
  }

  // ---------------------------------------------------------------------------
  // THE FRAME
  // ---------------------------------------------------------------------------
  start() {
    this._last = performance.now();
    const frame = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(frame);
      this._frame();
    };
    this._raf = requestAnimationFrame(frame);
    return this;
  }

  _frame() {
    const now = performance.now();
    let dtWall = (now - this._last) / 1000;
    this._last = now;
    if (this._firstFrame) { dtWall = DT; this._firstFrame = false; }
    if (dtWall > 0.25) dtWall = 0.25;    // same clamp the fixed loop applies

    const T = this.telemetry;
    const racing = this.state === GAME_STATE.RACING;

    // ---- INPUT (wall time; a UI ramp, not simulation) ----
    if (racing && !this.pilot) {
      const s = this.input.read(dtWall);
      this._input.throttle = s.throttle;
      this._input.brake = s.brake;
      this._input.steer = s.steer;
      this._input.drift = s.drift;
    } else if (!racing) {
      this.input.read(dtWall);   // keep the ramp decaying while paused
    }

    // ---- COUNTDOWN ----
    if (this.state === GAME_STATE.COUNTDOWN) {
      this._countdownT += dtWall;
      if (this.ui) this.ui.setCountdown(this._countdownT);
      if (this._countdownT >= COUNTDOWN_TOTAL) {
        this._goHold += dtWall;
        if (this._goHold >= COUNTDOWN_GO_HOLD) this.setState(GAME_STATE.RACING);
      }
    }

    // ---- SIM ----
    if (racing || this.state === GAME_STATE.COUNTDOWN) {
      // During the countdown the sim still steps with a ZERO input so the
      // rivals settle on the grid and the physics is warm at lights-out, but
      // nothing can move under power.
      this.loop.step(dtWall);
    }

    // ---- CAMERA / FX / HUD (presentation) ----
    const p0 = this.race.karts[0];
    this.chase.update(dtWall, p0.veh.x, 0, p0.veh.z, p0.veh.yaw,
                      p0.veh.speed, this.track.occluders);
    if (!this.reduced) {
      this.feedback.update(dtWall);
      this.dust.update(dtWall);
    }
    if (this.tyres && racing) this.tyres.update(dtWall, this.race, 0);

    // The waypoint MUST be computed after chase.update() above, because it
    // projects through that camera's freshly-written matrices. Passing a literal
    // 0 here (the original code) silently produced NaN positions and opacity 0.
    const wp = this.waypoint.update(p0.s, this.sys.camera);
    this.hud.update(p0.position, this.race.fieldSize, p0.lap, this.race.lapCount,
                    this.race.time, p0.veh.speedKmh, wp);
    if (this.ui) this.ui.tick(this, dtWall);

    // ---- RENDER ----
    this.sys.renderer.info.reset();
    this.sys.render(0, this.race.time);

    T.frames++;
    const ms = performance.now() - now;
    if (T.frameMs.length < 20000) T.frameMs.push(ms);
    if (ms > 33.3 && T.frames > 30) T.hitches++;
    T.drawCalls = this.sys.renderer.info.render.calls;
    T.triangles = this.sys.renderer.info.render.triangles;
    T.programs = this.sys.renderer.info.programs.length;
  }

  // race.standings() already returns ORDERED rows carrying position, id,
  // isPlayer, lap, speedKmh, bestLap, tier, finished, finishTime. This wrapper
  // only formats for display - it does not re-sort, because re-sorting here
  // would be a second definition of the running order and the two would drift.
  standings() {
    const rows = this.race.standings();
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      out.push({
        position: r.position,
        id: r.id,
        isPlayer: r.isPlayer,
        lap: r.lap,
        tier: r.tier,
        best: (Number.isFinite(r.bestLap) && r.bestLap > 0) ? formatTime(r.bestLap) : '--:--.--',
        finished: r.finished,
        time: r.finished ? formatTime(r.finishTime) : ''
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // TEARDOWN. Every listener, tween, pool and GPU resource. Leak-audited in S8.
  // ---------------------------------------------------------------------------
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onOrientation);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._offs) { for (const [n, f] of this._offs) this.bus.off(n, f); this._offs.length = 0; }
    if (this.input) this.input.dispose();
    if (this.tyres) this.tyres.dispose();
    if (this.audioCtx && this.audioCtx.close) this.audioCtx.close();
    if (this.feedback) this.feedback.dispose();
    if (this.hud) this.hud.dispose();
    if (this.dust) this.dust.dispose();
    if (this.field) for (const k of this.field) { if (k.dispose) k.dispose(); }
    if (this.kres) this.kres.dispose();
    if (this.items) this.items.dispose();
    if (this.loop) this.loop.dispose();
    if (this.sys) this.sys.dispose();
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}
