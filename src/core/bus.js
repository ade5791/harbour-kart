// Cross-subsystem event bus with a CLOSED vocabulary.
//
// The vocabulary and its payload shapes are declared in ARCHITECTURE.md
// section 5 and mirrored here. Emitting or subscribing to an unregistered name
// THROWS. That is the point: on a previous build, ad-hoc event strings invented
// at call sites went nowhere silently and the missing wiring was only found by
// reading every file. A closed vocabulary fails loudly at the first emit.
//
// Zero allocation on the hot path: emit() walks a preallocated array and
// forwards the caller's payload object by reference. It never spreads, never
// builds an args array, and never allocates a listener snapshot.

// RACING VOCABULARY - ARCHITECTURE.md section 5.
//
// ============================================================================
// THIS TABLE WAS REVERTED TO THE FLAP VOCABULARY AND HAS BEEN REBUILT.
// ============================================================================
// An out-of-band edit replaced this table with the retired flap events (flap,
// pipe_passed, gem_collected, death, ramp_changed) and left a comment arguing
// that docs/GENRE_CORRECTION.md was wrong - that "this is Floppy Bird, the
// harbour is the SETTING, and the karts are explicitly NOT to be taken".
//
// That argument quotes VERSION 2 of the mission brief, which version 3
// supersedes in as many words. Version 2 is named in GENRE_CORRECTION.md as
// the WORSE of the two earlier mistakes precisely because it excluded the
// actual game content. The current brief is unambiguous: the frame IS a kart
// racer, the genre IS the subject, and there is no bird, no flap, no pipe and
// no gap. src/core/config.js was reverted in the same way and by the same
// reasoning; both are rebuilt.
//
// The MECHANISM is untouched from S1 and is genre-independent: closed
// vocabulary, fixed payload shapes, throw on an unregistered name, zero
// allocation on emit. Only the TABLE changes with the genre - which is exactly
// what the S1 contract said would happen.
export const EVENTS = Object.freeze({
  // --- lifecycle (genre-independent, unchanged from S1) ---
  boot_ready:      ['ms'],
  prewarm_done:    ['programs', 'ms'],
  state_changed:   ['from', 'to'],
  pause:           ['paused'],
  restart:         ['seed'],
  visibility:      ['hidden', 'clampedDelta'],
  resize:          ['w', 'h', 'dpr'],
  quality_changed: ['preset'],

  // --- racing gameplay. Payload shapes are FIXED; see ARCHITECTURE.md s5. ---
  // Every racing payload carries kartId, never a kart OBJECT reference: the
  // bus forwards payloads by reference on the hot path, and an object handle
  // would let a listener mutate another subsystem's state through an event.
  'lap.complete':      ['kartId', 'lap', 'lapTime', 'totalTime', 'position'],
  'checkpoint.pass':   ['kartId', 'index', 'lap', 't'],
  'collision.barrier': ['kartId', 'speed', 'normalX', 'normalZ', 'impulse'],
  'collision.kart':    ['kartId', 'otherId', 'closingSpeed', 'impulse'],
  'item.pickup':       ['kartId', 'crateId', 'item'],
  'item.use':          ['kartId', 'item', 'targetId'],
  'race.finish':       ['kartId', 'position', 'totalTime'],
  respawn:             ['kartId', 'checkpoint', 'lostTime'],
  'surface.change':    ['kartId', 'from', 'to', 'grip']
});

// Closed sets. An out-of-vocabulary value fails loudly at the first emit rather
// than flowing silently into a HUD or an audio switch.
//
// SURFACES is the closed set the vehicle's grip model switches on. Adding a
// surface here without giving it a grip scale in config.js is the regression
// this set exists to catch.
export const SURFACES = Object.freeze(['boardwalk', 'kerb', 'sand', 'grass', 'water']);
export const ITEMS = Object.freeze(['boost', 'shell', 'oil', 'shield']);
export const STATES = Object.freeze(['MENU', 'COUNTDOWN', 'RACING', 'FINISHED', 'PAUSED']);

const CLOSED_SETS = Object.freeze({
  'surface.change': { from: SURFACES, to: SURFACES },
  'item.pickup':    { item: ITEMS },
  'item.use':       { item: ITEMS },
  state_changed:    { from: STATES, to: STATES }
});

export class EventBus {
  constructor(opts) {
    this.validatePayload = !(opts && opts.validatePayload === false);
    this.listeners = Object.create(null);
    for (const name of Object.keys(EVENTS)) this.listeners[name] = [];
    this.log = null;          // set to an array to record an event trace
    this.logLimit = 8192;
  }

  _assert(name) {
    if (!this.listeners[name]) {
      throw new Error(
        'EventBus: unregistered event "' + name + '". The vocabulary is closed - ' +
        'declare it in ARCHITECTURE.md section 5 and in EVENTS before use. ' +
        'Known: ' + Object.keys(EVENTS).join(', ')
      );
    }
  }

  on(name, fn) {
    this._assert(name);
    this.listeners[name].push(fn);
    return fn;                                  // return the same reference so
  }                                             // off() can remove it exactly

  off(name, fn) {
    this._assert(name);
    const arr = this.listeners[name];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    return i >= 0;
  }

  emit(name, payload) {
    this._assert(name);
    if (this.validatePayload) {
      const shape = EVENTS[name];
      for (let i = 0; i < shape.length; i++) {
        if (payload === undefined || payload === null || !(shape[i] in payload)) {
          throw new Error(
            'EventBus: "' + name + '" payload missing field "' + shape[i] +
            '". Required: { ' + shape.join(', ') + ' }'
          );
        }
      }
      const closed = CLOSED_SETS[name];
      if (closed) {
        for (const field of Object.keys(closed)) {
          if (closed[field].indexOf(payload[field]) < 0) {
            throw new Error(
              'EventBus: "' + name + '.' + field + '" value "' + payload[field] +
              '" is not in the closed set ' + closed[field].join('|') +
              '. Extend the set in bus.js AND ARCHITECTURE.md section 5, never at the call site.'
            );
          }
        }
      }
    }
    if (this.log !== null && this.log.length < this.logLimit) {
      this.log.push(name);
    }
    const arr = this.listeners[name];
    for (let i = 0; i < arr.length; i++) arr[i](payload);
  }

  clear() {
    for (const name of Object.keys(EVENTS)) this.listeners[name].length = 0;
    if (this.log !== null) this.log.length = 0;
  }
}
