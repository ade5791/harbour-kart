// =============================================================================
// Harbour Kart - BOOT. The shipping entry point.
// =============================================================================
//
// Order matters and is the same order S8 measured:
//   parse review -> build UI shell -> Game.build() (RenderSystem.init, field,
//   dust, THEN warm()) -> applyReview() -> start rAF -> reveal the requested
//   screen. Prewarm happens behind the loading screen, never during play.
//
// window.__HK is the live QA surface. Every number the S9 harness asserts is
// read from here, and every one of them comes from the running game rather
// than from a parallel bookkeeping copy - a telemetry field that is computed
// twice is a field that will disagree with the game.

import { Game } from './game.js';
import { UI } from './ui.js';
import { parseReview, GAME_STATE } from './states.js';

// Scope boot references to a completed call, not the permanent ES module.
async function boot() {
const root = document.getElementById('hk-root');

const review = parseReview(location.search);
// OS-level reduced motion is honoured unless the URL forces it on.
if (!review.reduced && window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  review.reduced = true;
}
if (review.reduced) document.body.classList.add('reduced');

let ui = new UI(root, review);

window.__HK = {
  ready: false,
  error: null,
  review,
  game: null,
  ui,
  state: () => (window.__HK.game ? window.__HK.game.state : 'loading'),
  telemetry: () => (window.__HK.game ? window.__HK.game.telemetry : null),
  // Freeze the rAF loop so a screenshot cannot race the sim (hard rule 6).
  freeze: () => { const g = window.__HK.game; if (g && g._raf) { cancelAnimationFrame(g._raf); g._raf = 0; } },
  thaw: () => { const g = window.__HK.game; if (g && !g._raf && !g._disposed) g.start(); },
  // Render exactly one frame with the loop frozen - the capture primitive.
  renderOnce: () => { const g = window.__HK.game; if (g) g._frame(); }
};

// Any uncaught error must be VISIBLE, not a black canvas.
const onError = (e) => {
  window.__HK.error = String(e.message || e);
  ui.setLoading(1, 'ERROR: ' + window.__HK.error);
};
window.addEventListener('error', onError);
  try {
    ui.setLoading(0.08, 'Generating harbour course...');
    const game = new Game({ root, review, ui });
    window.__HK.game = game;
    game._onDispose = () => {
      window.removeEventListener('error', onError);
      // QA methods share this boot lexical environment; release its UI binding.
      ui = null;
      if (window.__HK?.game === game) {
        window.__HK.game = null;
        window.__HK.ui = null;
        window.__HK.ready = false;
        document.body.removeAttribute('data-ready');
      }
    };
    ui.bindButtons(game);

    ui.setLoading(0.25, 'Building scene graph...');
    await game.build();

    ui.setLoading(0.85, 'Compiling shaders...');
    // Touch controls: auto-enabled on a coarse pointer, forceable from the URL.
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    ui.showTouch(coarse || review.forceTouch);

    game.applyReview();
    ui.setLoading(1, 'Ready');

    game.start();

    // Reveal the requested screen. Default is the menu - the bare URL is the
    // real game, not a review state.
    const s = review.state;
    if (s === GAME_STATE.RACING) { game.setState(GAME_STATE.RACING); }
    else if (s === GAME_STATE.COUNTDOWN) { game.startRace(); }
    else if (s === GAME_STATE.PAUSED) { game.setState(GAME_STATE.RACING); game.togglePause(); }
    else if (s === GAME_STATE.RESULTS) { game.setState(GAME_STATE.RESULTS); }
    else if (s === GAME_STATE.SETTINGS) { game.setState(GAME_STATE.SETTINGS); }
    else { game.setState(GAME_STATE.MENU); }

    window.__HK.ready = true;
    document.body.setAttribute('data-ready', '1');
  } catch (e) {
    window.__HK.error = String((e && e.stack) || e);
    ui.setLoading(1, 'ERROR: ' + String(e && e.message || e));
    document.body.setAttribute('data-ready', 'error');
    throw e;
  }
}
boot();
