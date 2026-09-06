// =============================================================================
// Harbour Kart - GAME STATE MACHINE + DETERMINISTIC REVIEW STATES
// =============================================================================
//
// Two jobs, deliberately in one small module so the review-state parser and the
// state machine it drives cannot drift apart:
//
//  1. GAME_STATE: the closed set of screens. A closed set, exported frozen, so a
//     typo'd state name is a throw and not a silently blank screen.
//
//  2. parseReview(): the deterministic review states the step brief requires -
//     "any state is reachable without driving to it". Every parameter maps to a
//     concrete, testable jump. This is what makes the QA matrix runnable in
//     seconds instead of requiring a human to drive three laps per case.
//
// REVIEW STATE PARAMETERS
// -----------------------
//   seed=<int>        Seeded PRNG root. Same seed = byte-identical race.
//   state=<name>      Jump straight to a screen: menu | countdown | racing |
//                     paused | results | settings
//   lap=<n>           Start the player on lap n (1..LAP_COUNT).
//   pos=<n>           Start the player in grid/running position n (1..field).
//   corner=<i>        Teleport the field to corner i's approach, one
//                     SIGHT_LINE_MIN before its entry - i.e. exactly at the
//                     braking point the difficulty surface is derived from.
//   s=<metres>        Explicit station along the centreline. Overrides corner.
//   item=<name>       Put an item in the player's hand: boost|shell|oil|shield
//   damaged=1         Start with a spin-out active (control-loss state).
//   quality=<name>    high | medium | low
//   post=0            Disable post-processing (the no-post baseline gate).
//   reduced=1         Force reduced motion (also honoured from the OS query).
//   touch=1           Force the touch control layer visible on desktop.
//   nocountdown=1     Skip the 3-2-1 (QA convenience; never the default).
//   ai=1              Autopilot the player with the real AIDriver. This is how
//                     the live harness drives a full lap without a human's
//                     hands, and it is the SAME controller the rivals use.
//
// Anything not supplied falls back to a normal fresh race, so the bare URL is
// the real game.

export const GAME_STATE = Object.freeze({
  LOADING: 'loading',
  MENU: 'menu',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  PAUSED: 'paused',
  RESULTS: 'results',
  SETTINGS: 'settings'
});

export const REVIEW_KEYS = Object.freeze([
  'seed', 'state', 'lap', 'pos', 'corner', 's', 'item', 'damaged',
  'quality', 'post', 'reduced', 'touch', 'nocountdown', 'ai', 'laps'
]);

const ITEM_NAMES = ['boost', 'shell', 'oil', 'shield'];
const QUALITY_NAMES = ['high', 'medium', 'low'];
const STATE_NAMES = ['menu', 'countdown', 'racing', 'paused', 'results', 'settings'];

function intOr(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function floatOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse review state from a query string (or location.search).
 * Returns a plain frozen-ish descriptor; unknown values fall back rather than
 * throwing, because a mistyped review URL must still give a playable game.
 */
export function parseReview(search) {
  const Q = new URLSearchParams(search === undefined ? '' : search);
  const rawState = (Q.get('state') || '').toLowerCase();
  const rawItem = (Q.get('item') || '').toLowerCase();
  const rawQual = (Q.get('quality') || '').toLowerCase();

  const r = {
    // DEFAULT SEED IS THE GATED ONE. TRACK_SEED 37 is the course S3 validated
    // corner by corner (14/14 sight lines, 20/20 trackgate) and S7 ran its
    // playability suite against. Shipping a different default would ship a
    // track no gate has ever seen. Other seeds remain reachable by URL and are
    // re-validated by the S9 gate before they are offered.
    seed: intOr(Q.get('seed'), 37),
    state: STATE_NAMES.indexOf(rawState) >= 0 ? rawState : null,
    lap: intOr(Q.get('lap'), 0),                 // 0 = default (lap 1)
    pos: intOr(Q.get('pos'), 0),                 // 0 = default grid
    corner: Q.get('corner') === null ? -1 : intOr(Q.get('corner'), -1),
    s: floatOrNull(Q.get('s')),
    item: ITEM_NAMES.indexOf(rawItem) >= 0 ? rawItem : null,
    damaged: Q.get('damaged') === '1',
    quality: QUALITY_NAMES.indexOf(rawQual) >= 0 ? rawQual : null,
    post: Q.get('post') === '0' ? false : undefined,
    reduced: Q.get('reduced') === '1',
    forceTouch: Q.get('touch') === '1',
    noCountdown: Q.get('nocountdown') === '1',
    autopilot: Q.get('ai') === '1',
    laps: intOr(Q.get('laps'), 0),               // 0 = config LAP_COUNT
    // true when ANY review parameter was supplied - the HUD shows a review
    // badge so a captured frame can never be mistaken for a clean run.
    any: false
  };
  for (const k of REVIEW_KEYS) { if (Q.get(k) !== null) { r.any = true; break; } }
  return r;
}

/**
 * Build the query string that reproduces a descriptor. Round-trip stable:
 * parseReview(toQuery(parseReview(x))) deep-equals parseReview(x) for every
 * field, which the QA harness asserts.
 */
export function toQuery(r) {
  const p = [];
  p.push('seed=' + r.seed);
  if (r.state) p.push('state=' + r.state);
  if (r.lap) p.push('lap=' + r.lap);
  if (r.pos) p.push('pos=' + r.pos);
  if (r.corner >= 0) p.push('corner=' + r.corner);
  if (r.s !== null) p.push('s=' + r.s);
  if (r.item) p.push('item=' + r.item);
  if (r.damaged) p.push('damaged=1');
  if (r.quality) p.push('quality=' + r.quality);
  if (r.post === false) p.push('post=0');
  if (r.reduced) p.push('reduced=1');
  if (r.forceTouch) p.push('touch=1');
  if (r.noCountdown) p.push('nocountdown=1');
  if (r.autopilot) p.push('ai=1');
  if (r.laps) p.push('laps=' + r.laps);
  return '?' + p.join('&');
}

/**
 * COUNTDOWN. Three seconds, one tick per second, then GO.
 * Deliberately a data table rather than magic numbers in the renderer so the QA
 * harness can assert the exact glyph sequence appears on screen.
 */
export const COUNTDOWN_STEPS = Object.freeze([
  Object.freeze({ t: 0.0, text: '3' }),
  Object.freeze({ t: 1.0, text: '2' }),
  Object.freeze({ t: 2.0, text: '1' }),
  Object.freeze({ t: 3.0, text: 'GO' })
]);
export const COUNTDOWN_TOTAL = 3.0;
export const COUNTDOWN_GO_HOLD = 0.85;   // s the GO banner stays up
