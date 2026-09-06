// xoshiro128** seeded PRNG with forkable NAMED streams.
// Ported VERBATIM from ../floppy-bird/src/rng.js - the algorithm is bit-for-bit
// identical on purpose, so a seed that produced a given course in 2D produces
// the same course in 3D and the two builds can be compared directly.
//
// No Math.random() anywhere in gameplay or visuals. Determinism is a feature:
// it is what makes a reproducible capture, a pixel gate, and a replay probe
// possible at all.

function splitmix32(a) {
  return function () {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0);
  };
}

export class RNG {
  constructor(seed = 1) {
    const sm = splitmix32(seed | 0);
    this.s0 = sm(); this.s1 = sm(); this.s2 = sm(); this.s3 = sm();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  next() {
    const r = Math.imul(this.s1 * 5 >>> 0, 7) >>> 0;
    const result = (((r << 7) | (r >>> 25)) >>> 0) * 9 >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0; this.s3 ^= this.s1;
    this.s1 ^= this.s2; this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result >>> 0;
  }

  float() { return this.next() / 4294967296; }
  range(lo, hi) { return lo + this.float() * (hi - lo); }
  int(lo, hi) { return Math.floor(this.range(lo, hi + 1)); }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.float() * arr.length))]; }

  // Named fork: two streams drawn from the same seed never share a sequence, so
  // adding a decor roll can never shift the spawn sequence.
  fork(name) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0;
    }
    return new RNG((this.s0 ^ h) >>> 0);
  }

  state() { return [this.s0, this.s1, this.s2, this.s3]; }
  setState(s) { this.s0 = s[0]; this.s1 = s[1]; this.s2 = s[2]; this.s3 = s[3]; }
}

// The declared stream set. ARCHITECTURE.md section 8 owns this list; adding a
// stream is a contract change, not a call-site decision. Requesting an
// undeclared stream throws, so a typo fails loudly instead of silently
// producing a second, unnamed, unreproducible sequence.
// S4 CONTRACT CHANGE: 'ai' added. AI racer decisions (braking-point bias, apex
// accuracy, aggression, mistake rolls) MUST come from a seeded stream or no race
// is reproducible and every later gate - playability, fps distribution, pixel
// diff - is worthless. It is its OWN stream rather than a reuse of 'spawn' so
// that adding a rival, or changing how many rolls a driver makes, cannot shift
// the course the track was validated against.
// S9 CONTRACT CHANGE: 'items' added. The ItemSystem existed from S5 but was
// never wired into a playable page, so it had no declared stream and threw on
// rngHub.get('items'). Adding a stream is safe for determinism BY CONSTRUCTION:
// fork(name) hashes the NAME (FNV-1a) rather than consuming from the root, so a
// new stream cannot shift the sequence any existing stream produces. Verified
// by tools/s9/qagate.mjs check Q2, which asserts the pre-existing six streams
// emit byte-identical sequences with and without 'items' declared.
export const STREAMS = Object.freeze(['spawn', 'decor', 'fx', 'material', 'audio', 'ai', 'items']);

export class RngHub {
  constructor(seed = 12345) {
    this.seed = seed;
    this.streams = Object.create(null);
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    const root = new RNG(seed);
    for (const name of STREAMS) this.streams[name] = root.fork(name);
    return this;
  }

  get(name) {
    const s = this.streams[name];
    if (!s) {
      throw new Error(
        'RngHub: undeclared stream "' + name + '". Declared: ' + STREAMS.join(', ') +
        '. Add it to STREAMS and to ARCHITECTURE.md section 8.'
      );
    }
    return s;
  }

  // Prewarm must be simulation-transparent. Snapshot every stream before
  // compiling shaders, restore after, or downstream captures drift and the
  // pixel gate reports phantom regressions.
  snapshot() {
    const out = Object.create(null);
    for (const name of STREAMS) out[name] = this.streams[name].state();
    return out;
  }

  restore(snap) {
    for (const name of STREAMS) {
      if (snap[name]) this.streams[name].setState(snap[name]);
    }
    return this;
  }
}
