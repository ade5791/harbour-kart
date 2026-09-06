// =============================================================================
// Harbour Kart - UI SHELL. Screens, banners, touch pads, results.
// =============================================================================
//
// SCREEN-VISIBLE FEEDBACK IS THE CONTRACT. The QA matrix asserts that after
// every meaningful action something CHANGES ON SCREEN. So every UI affordance
// here carries a stable data-testid and a deterministic text/class change - not
// an animation the harness has to guess at. If an action has no visible result,
// that is a QA failure, not a styling preference.
//
// REDUCED MOTION is honoured by removing transitions and shake, never by
// removing INFORMATION. A reduced-motion player still sees the banner text.
//
// TOUCH ZONE GEOMETRY: steering pad occupies the LEFT half, throttle/brake the
// RIGHT half, with a hard boundary at 50vw. The QA harness measures the actual
// client rects and asserts no two action zones intersect - the "no overlapping
// action zones" requirement, verified rather than asserted.

import { GAME_STATE } from './states.js';
import { formatTime } from '../render/hud.js';

const el = (tag, cls, testid) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (testid) e.setAttribute('data-testid', testid);
  return e;
};

export class UI {
  constructor(root, review) {
    this.root = root;
    this.review = review;
    this.reduced = review.reduced;
    this._bannerT = 0;
    this._lapFlashT = 0;
    this._hitFlashT = 0;
    this._build();
  }

  _build() {
    const R = this.root;

    // ---- loading ----
    this.loading = el('div', 'hk-screen hk-loading', 'screen-loading');
    this.loading.innerHTML =
      '<div class="hk-logo">HARBOUR KART</div>' +
      '<div class="hk-loadbar"><i data-testid="loadbar-fill"></i></div>' +
      '<div class="hk-loadtext" data-testid="loadtext">Building harbour...</div>';
    R.appendChild(this.loading);

    // ---- menu ----
    this.menu = el('div', 'hk-screen hk-menu hidden', 'screen-menu');
    this.menu.innerHTML =
      '<div class="hk-logo">HARBOUR KART</div>' +
      '<div class="hk-sub">3 laps - 6 karts - Mediterranean harbour</div>' +
      '<div class="hk-btns">' +
      '<button class="hk-btn hk-primary" data-testid="btn-race">RACE</button>' +
      '<button class="hk-btn" data-testid="btn-settings">SETTINGS</button>' +
      '</div>' +
      '<div class="hk-help" data-testid="menu-help">' +
      'Steer <b>A</b>/<b>D</b> or <b>&larr;</b>/<b>&rarr;</b> &middot; ' +
      'Throttle <b>W</b>/<b>&uarr;</b> &middot; Brake <b>S</b>/<b>&darr;</b> &middot; ' +
      'Drift <b>Space</b> &middot; Item <b>E</b> &middot; Pause <b>Esc</b></div>';
    R.appendChild(this.menu);

    // ---- settings ----
    this.settings = el('div', 'hk-screen hk-menu hidden', 'screen-settings');
    this.settings.innerHTML =
      '<div class="hk-logo sm">SETTINGS</div>' +
      '<div class="hk-row"><span>Quality</span><span class="hk-seg" data-testid="seg-quality">' +
      '<button data-q="high">HIGH</button><button data-q="medium">MED</button>' +
      '<button data-q="low">LOW</button></span></div>' +
      '<div class="hk-row"><span>Reduced motion</span>' +
      '<button class="hk-toggle" data-testid="toggle-reduced">OFF</button></div>' +
      '<div class="hk-row"><span>Touch controls</span>' +
      '<button class="hk-toggle" data-testid="toggle-touch">AUTO</button></div>' +
      '<div class="hk-note" data-testid="settings-note">Quality reloads the race: shadow ' +
      'maps and post targets are allocated once at build, so switching live would ' +
      'recompile every material mid-corner.</div>' +
      '<div class="hk-btns"><button class="hk-btn" data-testid="btn-settings-back">BACK</button></div>';
    R.appendChild(this.settings);

    // ---- countdown / banner ----
    this.countdown = el('div', 'hk-countdown hidden', 'countdown');
    R.appendChild(this.countdown);
    this.banner = el('div', 'hk-banner hidden', 'banner');
    R.appendChild(this.banner);

    // ---- item slot ----
    this.itemSlot = el('div', 'hk-item empty', 'item-slot');
    this.itemSlot.innerHTML = '<span data-testid="item-name">--</span>';
    R.appendChild(this.itemSlot);

    // ---- pause ----
    this.pause = el('div', 'hk-screen hk-menu hidden', 'screen-paused');
    this.pause.innerHTML =
      '<div class="hk-logo sm">PAUSED</div>' +
      '<div class="hk-btns">' +
      '<button class="hk-btn hk-primary" data-testid="btn-resume">RESUME</button>' +
      '<button class="hk-btn" data-testid="btn-restart">RESTART</button>' +
      '<button class="hk-btn" data-testid="btn-quit">MENU</button></div>';
    R.appendChild(this.pause);

    // ---- results ----
    this.results = el('div', 'hk-screen hk-menu hidden', 'screen-results');
    this.results.innerHTML =
      '<div class="hk-logo sm" data-testid="results-title">RESULTS</div>' +
      '<table class="hk-table" data-testid="results-table"><tbody></tbody></table>' +
      '<div class="hk-btns"><button class="hk-btn hk-primary" data-testid="btn-again">RACE AGAIN</button>' +
      '<button class="hk-btn" data-testid="btn-results-menu">MENU</button></div>';
    R.appendChild(this.results);

    // ---- touch controls ----
    this.touch = el('div', 'hk-touch hidden', 'touch-controls');
    this.padSteer = el('div', 'hk-pad hk-steer', 'pad-steer');
    this.padSteer.innerHTML = '<span>STEER</span>';
    this.padThrottle = el('div', 'hk-pad hk-throttle', 'pad-throttle');
    this.padThrottle.innerHTML = '<span>GO</span>';
    this.padBrake = el('div', 'hk-pad hk-brake', 'pad-brake');
    this.padBrake.innerHTML = '<span>BRAKE</span>';
    this.padDrift = el('div', 'hk-pad hk-drift', 'pad-drift');
    this.padDrift.innerHTML = '<span>DRIFT</span>';
    this.padItem = el('div', 'hk-pad hk-itembtn', 'pad-item');
    this.padItem.innerHTML = '<span>ITEM</span>';
    this.touch.appendChild(this.padSteer);
    this.touch.appendChild(this.padThrottle);
    this.touch.appendChild(this.padBrake);
    this.touch.appendChild(this.padDrift);
    this.touch.appendChild(this.padItem);
    R.appendChild(this.touch);

    // ---- pause button (always reachable on touch) ----
    this.pauseBtn = el('button', 'hk-pausebtn hidden', 'btn-pause');
    this.pauseBtn.textContent = 'II';
    R.appendChild(this.pauseBtn);

    // ---- review badge: a captured frame must never look like a clean run ----
    if (this.review.any) {
      this.badge = el('div', 'hk-review', 'review-badge');
      this.badge.textContent = 'REVIEW STATE';
      R.appendChild(this.badge);
    }
  }

  bindButtons(game) {
    this.game = game;
    const q = (id) => this.root.querySelector('[data-testid="' + id + '"]');
    q('btn-race').onclick = () => game.startRace();
    q('btn-settings').onclick = () => game.setState(GAME_STATE.SETTINGS);
    q('btn-settings-back').onclick = () => game.setState(GAME_STATE.MENU);
    q('btn-resume').onclick = () => game.togglePause();
    q('btn-restart').onclick = () => game.restart();
    q('btn-quit').onclick = () => game.setState(GAME_STATE.MENU);
    q('btn-again').onclick = () => game.restart();
    q('btn-results-menu').onclick = () => game.setState(GAME_STATE.MENU);
    this.pauseBtn.onclick = () => game.togglePause();
    this.padItem.onclick = () => game.useItem();

    const segs = this.settings.querySelectorAll('[data-q]');
    for (const b of segs) {
      if (b.getAttribute('data-q') === game.quality) b.classList.add('on');
      b.onclick = () => game.setQualityLive(b.getAttribute('data-q'));
    }
    const rt = q('toggle-reduced');
    rt.textContent = this.reduced ? 'ON' : 'OFF';
    rt.onclick = () => {
      this.reduced = !this.reduced;
      game.reduced = this.reduced;
      rt.textContent = this.reduced ? 'ON' : 'OFF';
      document.body.classList.toggle('reduced', this.reduced);
    };
    const tt = q('toggle-touch');
    tt.onclick = () => {
      this._touchForced = !this._touchForced;
      tt.textContent = this._touchForced ? 'ON' : 'AUTO';
      this.touch.classList.toggle('hidden', !(this._touchForced || this._touchAuto));
    };
    return this;
  }

  bindTouchZones(input) {
    input.addZone(this.padSteer, 'steer');
    input.addZone(this.padThrottle, 'throttle');
    input.addZone(this.padBrake, 'brake');
    input.addZone(this.padDrift, 'drift');
    return this;
  }

  showTouch(on) {
    this._touchAuto = on;
    this.touch.classList.toggle('hidden', !on);
    this.pauseBtn.classList.toggle('hidden', !on);
  }

  setLoading(pct, text) {
    const f = this.root.querySelector('[data-testid="loadbar-fill"]');
    if (f) f.style.width = Math.round(pct * 100) + '%';
    const t = this.root.querySelector('[data-testid="loadtext"]');
    if (t && text) t.textContent = text;
  }

  onState(s, game) {
    const show = (node, on) => node.classList.toggle('hidden', !on);
    show(this.loading, s === GAME_STATE.LOADING);
    show(this.menu, s === GAME_STATE.MENU);
    show(this.settings, s === GAME_STATE.SETTINGS);
    show(this.pause, s === GAME_STATE.PAUSED);
    show(this.results, s === GAME_STATE.RESULTS);
    show(this.countdown, s === GAME_STATE.COUNTDOWN);
    document.body.setAttribute('data-state', s);
    if (s === GAME_STATE.RESULTS && game) this._fillResults(game);
    // The HUD is a race instrument: hide it on menus so a menu screenshot can
    // never be mistaken for gameplay.
    if (game && game.hud && game.hud.root) {
      game.hud.root.style.display =
        (s === GAME_STATE.RACING || s === GAME_STATE.COUNTDOWN || s === GAME_STATE.PAUSED)
          ? '' : 'none';
    }
  }

  _fillResults(game) {
    const rows = game.standings();
    const tb = this.results.querySelector('tbody');
    let html = '<tr><th>POS</th><th>KART</th><th>CLASS</th><th>BEST LAP</th><th>TIME</th></tr>';
    for (const r of rows) {
      html += '<tr' + (r.isPlayer ? ' class="me" data-testid="results-player"' : '') + '>' +
        '<td>' + r.position + '</td>' +
        '<td>' + (r.isPlayer ? 'YOU' : 'KART ' + r.id) + '</td>' +
        '<td>' + r.tier + '</td>' +
        '<td>' + r.best + '</td>' +
        '<td>' + (r.time || '--') + '</td></tr>';
    }
    tb.innerHTML = html;
    const me = rows.find((r) => r.isPlayer);
    const title = this.results.querySelector('[data-testid="results-title"]');
    title.textContent = me ? ('FINISHED P' + me.position + ' OF ' + rows.length) : 'RESULTS';
  }

  setCountdown(t) {
    let txt = '';
    if (t < 1) txt = '3'; else if (t < 2) txt = '2';
    else if (t < 3) txt = '1'; else txt = 'GO';
    if (this.countdown.textContent !== txt) {
      this.countdown.textContent = txt;
      this.countdown.classList.remove('pop');
      if (!this.reduced) { void this.countdown.offsetWidth; this.countdown.classList.add('pop'); }
    }
  }

  flashBanner(text, ms) {
    this.banner.textContent = text;
    this.banner.classList.remove('hidden');
    this._bannerT = (ms === undefined ? 1200 : ms) / 1000;
  }

  flashLap(lap, total, lapTime) {
    this.flashBanner('LAP ' + Math.min(lap, total) + '/' + total +
      (lapTime > 0 ? '   ' + formatTime(lapTime) : ''), 1600);
  }

  flashHit(kind) {
    this._hitFlashT = 0.35;
    document.body.classList.add('hit-' + kind);
  }

  setItem(name) {
    const n = this.itemSlot.querySelector('[data-testid="item-name"]');
    n.textContent = name ? name.toUpperCase() : '--';
    this.itemSlot.classList.toggle('empty', !name);
    this.itemSlot.setAttribute('data-item', name || '');
  }

  tick(game, dt) {
    if (this._bannerT > 0) {
      this._bannerT -= dt;
      if (this._bannerT <= 0) this.banner.classList.add('hidden');
    }
    if (this._hitFlashT > 0) {
      this._hitFlashT -= dt;
      if (this._hitFlashT <= 0) {
        document.body.classList.remove('hit-barrier');
        document.body.classList.remove('hit-kart');
      }
    }
  }

  dispose() {
    for (const n of [this.loading, this.menu, this.settings, this.pause, this.results,
                     this.countdown, this.banner, this.itemSlot, this.touch,
                     this.pauseBtn, this.badge]) {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
  }
}
