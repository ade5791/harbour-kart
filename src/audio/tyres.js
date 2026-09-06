// =============================================================================
// Harbour Kart - TYRE SQUEAL + IMPACT AUDIO. Procedural, Web Audio, no assets.
// =============================================================================
//
// Step requirement 5 names "tyre squeal" as one of the four channels of impact
// weight. This module is the audio channel; src/render/feedback.js is the
// visual one. They read the SAME vehicle utilisation numbers, so the ear and
// the eye agree about when a tyre is at its limit.
//
// Model: squeal starts when the higher of the two axle utilisations crosses
// SQUEAL_UTIL_ON (a tyre near its friction circle scrubs before it lets go) and
// its loudness rises with utilisation and with speed. Above the limit the sim
// saturates the force (vehicle.js), so utilisation pins at 1.0 - that is a full
// slide and full squeal. Below SQUEAL_UTIL_OFF it stops. The hysteresis band
// keeps a kart riding the limit from chattering on and off every frame.
//
// Kerb strikes rumble: a low band-passed noise burst, retriggered while on the
// kerb, amplitude with speed. Barrier and kart contacts thump.
//
// DETERMINISM: the audio graph is driven by the sim's numbers only. The one
// stochastic input - the noise buffer - is filled ONCE at init from the 'audio'
// stream. No Math.random. Headless (no AudioContext) the module still runs its
// state machine so gates can assert WHEN it would squeal without a sound card.

import { V_TOP } from '../core/config.js';

export const SQUEAL_UTIL_ON  = 0.90;   // utilisation to start
export const SQUEAL_UTIL_OFF = 0.80;   // utilisation to stop (hysteresis)
export const SQUEAL_MIN_SPEED = 3.0;   // m/s - a parked kart cannot squeal
export const SQUEAL_F_LO = 900;        // Hz at low speed
export const SQUEAL_F_HI = 1900;       // Hz at V_TOP
export const RUMBLE_F = 55;            // Hz kerb rumble centre
export const NOISE_SECONDS = 2.0;

export class TyreAudio {
  // ctx: an AudioContext or null. rng: forked 'audio' stream (used once).
  constructor(ctx, rng, fieldSize) {
    this.ctx = ctx || null;
    this.n = fieldSize;
    this.squealing = new Uint8Array(fieldSize);
    this.level = new Float32Array(fieldSize);     // 0..1 squeal envelope
    this.rumble = new Float32Array(fieldSize);
    this.stats = { squealOn: 0, squealOff: 0, thumps: 0 };
    this.masterGain = 0.5;

    if (this.ctx) {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * NOISE_SECONDS);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = rng.range(-1, 1);
      this._noise = buf;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterGain;
      this.master.connect(this.ctx.destination);
      this._voices = [];
      for (let i = 0; i < fieldSize; i++) this._voices.push(this._voice());
    } else {
      // Consume the same draws headless so the 'audio' stream position matches
      // a browser run on the same seed.
      const len = Math.floor(48000 * NOISE_SECONDS);
      for (let i = 0; i < len; i++) rng.range(-1, 1);
    }
  }

  _voice() {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noise; src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = SQUEAL_F_LO; bp.Q.value = 6;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start();
    const rsrc = c.createBufferSource();
    rsrc.buffer = this._noise; rsrc.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = RUMBLE_F * 2; lp.Q.value = 2;
    const rg = c.createGain(); rg.gain.value = 0;
    rsrc.connect(lp); lp.connect(rg); rg.connect(this.master);
    rsrc.start();
    return { bp, g, rg };
  }

  // Called once per frame with the race. Distance attenuation is by arclength
  // gap to the player, which is what the player can see anyway.
  update(dt, race, playerId) {
    const karts = race.karts;
    const p = karts[playerId];
    for (let i = 0; i < karts.length; i++) {
      const v = karts[i].veh;
      const util = v.utilR > v.utilF ? v.utilR : v.utilF;
      const spd = v.speed;
      const on = this.squealing[i] === 1;
      if (!on && util >= SQUEAL_UTIL_ON && spd >= SQUEAL_MIN_SPEED) { this.squealing[i] = 1; this.stats.squealOn++; }
      else if (on && (util < SQUEAL_UTIL_OFF || spd < SQUEAL_MIN_SPEED)) { this.squealing[i] = 0; this.stats.squealOff++; }
      const target = this.squealing[i] ? Math.min(1, (util - SQUEAL_UTIL_OFF) / (1 - SQUEAL_UTIL_OFF)) * Math.min(1, spd / (V_TOP * 0.5)) : 0;
      // Fast attack, slower release.
      const k = target > this.level[i] ? 18 : 6;
      this.level[i] += (target - this.level[i]) * Math.min(1, k * dt);

      const rt = (karts[i].surface === 'kerb' && spd > 1) ? Math.min(1, spd / V_TOP) : 0;
      this.rumble[i] += (rt - this.rumble[i]) * Math.min(1, 12 * dt);

      if (this.ctx) {
        const ds = Math.abs(karts[i].s - p.s);
        const gap = Math.min(ds, race.course.length - ds);
        const att = i === playerId ? 1 : 1 / (1 + gap * gap * 0.004);
        const vo = this._voices[i];
        vo.g.gain.value = this.level[i] * 0.35 * att;
        vo.bp.frequency.value = SQUEAL_F_LO + (SQUEAL_F_HI - SQUEAL_F_LO) * Math.min(1, spd / V_TOP);
        vo.rg.gain.value = this.rumble[i] * 0.6 * att;
      }
    }
  }

  // One-shot thump for a contact. speed in m/s.
  thump(speed) {
    this.stats.thumps++;
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const g = c.createGain();
    const a = Math.min(1, 0.15 + speed / 25);
    g.gain.setValueAtTime(a, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.3);
  }

  dispose() {
    if (this.ctx && this.master) this.master.disconnect();
  }
}
