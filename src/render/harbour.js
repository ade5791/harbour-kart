// The harbour, as real Three.js geometry.
//
// Owner: render. S5.
//
// This module turns the PARAMETRIC RECORDS that S3 placed in src/sim/track.js
// into actual meshes. It invents no placements of its own. Every position,
// radius, height, wear value, tone and yaw is read from the track record that
// the sight-line gate already validated. That is the whole point: if the
// renderer were allowed to nudge a building "so it looks better", the geometry
// the player sees would stop being the geometry the gate proved fair, and hard
// rule 10 would be broken by the render layer itself.
//
// DRAW-CALL STRATEGY
// ------------------
// The track carries 4120 planks, 2060 kerb stones, 354 posts, 352 ropes, 12
// crates, 46 buildings, 34 palms and 309 water spans. One Mesh each would be
// about 7300 draw calls per frame before a single kart is drawn, which no
// amount of shader tuning recovers from.
//
//   planks, kerbs, posts, crates  -> InstancedMesh (one draw call per family)
//   ropes                         -> ONE merged BufferGeometry, built once
//   buildings, palms              -> merged per family, with per-vertex tone
//   water                         -> one ribbon strip
//
// Per-instance variation (wear, chip, tone, lean) survives instancing through
// the instanceColor attribute, which multiplies the material's albedo. So
// "nothing perfectly repeated" is preserved WITHOUT per-object draw calls.
//
// ZERO ALLOCATION
// ---------------
// Everything here runs at BUILD time, not per frame. There is no update() that
// allocates. The only per-frame work this module exposes is `syncCrates`, which
// writes into preallocated matrices.
//
// COLOUR SPACE
// ------------
// instanceColor values are LINEAR multipliers around 1.0, not colours. They are
// authored as scalar tone values and written to all three channels unless the
// record carries a hue shift. Because the material albedo is already the
// measured linear value, a mean instance tone of 1.0 leaves the measured albedo
// intact - which the gate checks by measuring the mean, not by trusting it.

import * as THREE from 'three';
import { REGION, SUN, hexToLinear } from './palette.js';
import {
  HALF_W, KERB_W, KERB_H, CLEAR_RADIUS, WATER_OFFSET, POST_H
} from '../sim/track.js';

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _euler = new THREE.Euler();
const _col = new THREE.Color();
const _pt = { x: 0, z: 0, heading: 0 };
const _pt2 = { x: 0, z: 0, heading: 0 };

/** Deck surface height. The boardwalk sits at y=0; planks have thickness below. */
export const DECK_Y = 0.0;
const PLANK_THICK = 0.09;

/**
 * How far each kerb stone is bedded DOWN into the boardwalk, in metres.
 *
 * Exists solely to keep the kerb's underside off the deck plane. The deck
 * ribbon spans HALF_W + KERB_W and so passes beneath every stone; with the
 * kerb bottom at exactly DECK_Y the two faces were coplanar and z-fought
 * (S6 check N6c: 9.5% of junction samples flipped under a sub-pixel nudge).
 *
 * 0.06 m is ~4.5x the 0.0133 m depth resolution available at the 39 m
 * SIGHT_LINE_MIN sampling distance for this near/far plane pair, so the two
 * surfaces cannot land in the same depth bucket. It is invisible: it moves
 * only the hidden underside, never the kerb top.
 */
const KERB_EMBED = 0.06;

export class Harbour {
  /**
   * @param {Track} track   the S3 track, already built and gated
   * @param {MaterialLibrary} mats
   * @param {RNG} rng       the 'render' stream - seeded, never Math.random
   */
  constructor(track, mats, rng) {
    this.track = track;
    this.mats = mats;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'harbour';
    this._owned = [];          // geometries/materials this module created
    this.stats = {};
    this.instanceToneMeans = {};
  }

  build() {
    this._buildDeck();
    this._buildKerbs();
    this._buildPosts();
    this._buildRopes();
    this._buildCrates();
    this._buildBuildings();
    this._buildPalms();
    this._buildWater();
    this._buildCastle();
    return this;
  }

  _own(x) { this._owned.push(x); return x; }

  _track(g, name, mat, castShadow, receiveShadow) {
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = !!castShadow;
    mesh.receiveShadow = !!receiveShadow;
    this.group.add(mesh);
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // DECK. The boardwalk is built as a continuous ribbon of quads following the
  // centreline, with per-plank transverse seams baked into the UVs and the
  // per-plank wear baked into a vertex colour. A ribbon rather than 4120 boxes:
  // the planks read as planks because of the material's stripe height field and
  // the seam UVs, not because each one is a separate solid.
  //
  // The ribbon spans the FULL drivable width plus the kerb footprint, so there
  // is no gap between deck and kerb for the sky to show through.
  // ---------------------------------------------------------------------------
  _buildDeck() {
    const t = this.track;
    const planks = t.planks;
    const n = planks.length;
    const halfSpan = HALF_W + KERB_W;

    // 2 vertices per cross-section edge, 4 across (left kerb edge, left track
    // edge, right track edge, right kerb edge) so the UV can break at the kerb.
    const COLS = 5;
    const verts = new Float32Array(n * COLS * 3);
    const norms = new Float32Array(n * COLS * 3);
    const uvs = new Float32Array(n * COLS * 2);
    const cols = new Float32Array(n * COLS * 3);
    const idx = [];

    const lateralAt = [-halfSpan, -HALF_W * 0.5, 0, HALF_W * 0.5, halfSpan];
    let vi = 0, ui = 0, ci = 0;
    let toneSum = 0;

    for (let i = 0; i < n; i++) {
      const pl = planks[i];
      // Wear darkens and roughens. Mapped to a multiplier around 1.0 so the
      // MEAN stays near 1.0 and the measured albedo survives.
      const tone = 0.86 + 0.28 * (1 - pl.wear);
      toneSum += tone;
      for (let c = 0; c < COLS; c++) {
        t.offsetPoint(pl.s, lateralAt[c], _pt);
        verts[vi] = _pt.x;
        verts[vi + 1] = DECK_Y + pl.lift;
        verts[vi + 2] = _pt.z;
        norms[vi] = 0; norms[vi + 1] = 1; norms[vi + 2] = 0;
        vi += 3;
        // U across the deck, V along it. V uses arclength in metres so the
        // plank stripe period is a REAL WORLD size and does not stretch on
        // corners - a stretched plank pattern is the classic tell of a ribbon.
        uvs[ui] = (lateralAt[c] + halfSpan) / (halfSpan * 2);
        uvs[ui + 1] = pl.s;
        ui += 2;
        cols[ci] = tone; cols[ci + 1] = tone; cols[ci + 2] = tone;
        ci += 3;
      }
    }
    // Wrap the final ring back to the first: the lap is a closed loop.
    for (let i = 0; i < n; i++) {
      const a = i * COLS;
      const b = ((i + 1) % n) * COLS;
      for (let c = 0; c < COLS - 1; c++) {
        idx.push(a + c, b + c, a + c + 1);
        idx.push(a + c + 1, b + c, b + c + 1);
      }
    }

    const g = this._own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uvs, 2));   // aoMap needs uv1
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();

    const mat = this.mats.get('boardwalk');
    mat.vertexColors = true;
    // The deck receives the long shadows; it must not cast onto itself.
    this.deck = this._track(g, 'deck', mat, false, true);
    this.instanceToneMeans.deck = toneSum / n;
    this.stats.deckPlanks = n;
    this.stats.deckTris = idx.length / 3;

    // Deck edge fascia: a skirt so the boardwalk reads as a THICK structure
    // from the chase camera rather than a decal on the void.
    this._buildDeckSkirt(halfSpan);
  }

  _buildDeckSkirt(halfSpan) {
    const t = this.track;
    const step = 2.0;
    const n = Math.floor(t.length / step);
    const verts = new Float32Array(n * 4 * 3);
    const norms = new Float32Array(n * 4 * 3);
    const uvs = new Float32Array(n * 4 * 2);
    const idx = [];
    let vi = 0, ui = 0;
    for (let i = 0; i < n; i++) {
      const s = i * step;
      for (const side of [-1, 1]) {
        t.offsetPoint(s, side * halfSpan, _pt);
        // top
        verts[vi] = _pt.x; verts[vi + 1] = DECK_Y; verts[vi + 2] = _pt.z;
        norms[vi] = side; norms[vi + 1] = 0; norms[vi + 2] = 0;
        vi += 3;
        uvs[ui] = s * 0.25; uvs[ui + 1] = 1; ui += 2;
        // bottom
        verts[vi] = _pt.x; verts[vi + 1] = DECK_Y - PLANK_THICK * 4; verts[vi + 2] = _pt.z;
        norms[vi] = side; norms[vi + 1] = 0; norms[vi + 2] = 0;
        vi += 3;
        uvs[ui] = s * 0.25; uvs[ui + 1] = 0; ui += 2;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = i * 4, b = ((i + 1) % n) * 4;
      idx.push(a, a + 1, b);       idx.push(a + 1, b + 1, b);
      idx.push(a + 2, b + 2, a + 3); idx.push(a + 3, b + 2, b + 3);
    }
    const g = this._own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this._track(g, 'deck-skirt', this.mats.get('boardwalkFore'), true, true);
  }

  // ---------------------------------------------------------------------------
  // KERBS. 2060 stones as one InstancedMesh. The alternating stripe flag from
  // the track record drives the instance tone, which is the VALUE BREAK the
  // readability requirement depends on: the kerb must clear 2.5x luminance
  // against whatever is behind it at SIGHT_LINE_MIN.
  //
  // The stripe is authored as a LIGHT/DARK alternation of the measured kerb
  // albedo rather than as red/white paint, because the reference frame shows
  // stone kerbs, not painted racing kerbs. The value break is what matters for
  // readability; the hue stays the measured stone.
  // ---------------------------------------------------------------------------
  _buildKerbs() {
    const t = this.track;
    const kerbs = t.kerbs;
    const n = kerbs.length;
    const g = this._own(new THREE.BoxGeometry(1, 1, 1));
    g.setAttribute('uv1', g.getAttribute('uv').clone());
    const mesh = new THREE.InstancedMesh(g, this.mats.get('kerb'), n);
    mesh.name = 'kerbs';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    let toneSum = 0;
    for (let i = 0; i < n; i++) {
      const k = kerbs[i];
      const mid = (k.inner + k.outer) * 0.5;
      t.offsetPoint(k.s + k.len * 0.5, k.side * mid, _pt);
      // Heading of the centreline at this station orients the stone.
      _euler.set(0, -_pt.heading, 0);
      _q.setFromEuler(_euler);
      // Z-FIGHTING FIX (S6 / N6c). The kerb box was centred at
      //   DECK_Y + height*0.5 - chip*0.5   with height  (height - chip)
      // so its BOTTOM face landed at exactly DECK_Y - precisely coplanar with
      // the deck ribbon, which spans HALF_W + KERB_W and therefore runs
      // underneath every kerb stone. Two coplanar faces at the same depth is
      // textbook z-fighting, and N6c caught it as 9.5% of junction samples
      // flipping under a sub-pixel camera nudge.
      //
      // The stones are EMBEDDED into the boardwalk instead. Physically this is
      // what a masonry kerb does - it is bedded into the deck, not balanced on
      // it. The TOP of the kerb is left exactly where it was, so the visible
      // kerb height, the readability value break (N3K) and the collision
      // profile are all unchanged; only the hidden underside moves down out of
      // the deck plane. Fixing the geometry, not the threshold.
      const kerbTop = DECK_Y + k.height - k.chip;
      const kerbH = Math.max(0.02, k.height - k.chip) + KERB_EMBED;
      _pos.set(_pt.x, kerbTop - kerbH * 0.5, _pt.z);
      _scl.set(KERB_W, kerbH, k.len * 0.98);
      _m4.compose(_pos, _q, _scl);
      mesh.setMatrixAt(i, _m4);
      // THE VALUE BREAK. Alternating stones step the luminance up and down
      // around the measured albedo. Mean stays 1.0.
      //
      // WAS 1.34/0.66 = 2.03x, and the S6 gate measured the delivered stripe at
      // 2.245x against a REQUIRED 2.5x - so the kerb could not meet the mission's
      // readability bar no matter how it was lit. The authored content was the
      // defect, so the CONTENT is what changes here; the 2.5x threshold is a
      // gameplay requirement and was NOT touched.
      //
      // 1.45/0.55 = 2.636x authored, which clears 2.5x with margin for the
      // lighting to eat. Mean is still exactly (1.45 + 0.55) / 2 = 1.0, so the
      // measured mean albedo of the kerb is unchanged - this widens the SPREAD
      // without lifting the blacks, which the brief forbids.
      const tone = k.stripe ? 1.45 : 0.55;
      toneSum += tone;
      _col.setRGB(tone, tone * 0.985, tone * 0.95, THREE.LinearSRGBColorSpace);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.kerbMesh = mesh;
    this.instanceToneMeans.kerbs = toneSum / n;
    this.stats.kerbs = n;
  }

  // ---------------------------------------------------------------------------
  // MOORING POSTS. 354 as one InstancedMesh. Lean and radius come from the
  // record. These are DECOR outside the clear radius (hard rule 10) - the track
  // module already relaxed their positions so no rope chord cuts inboard.
  // ---------------------------------------------------------------------------
  _buildPosts() {
    const t = this.track;
    const posts = t.posts;
    const n = posts.length;
    const g = this._own(new THREE.CylinderGeometry(1, 1.08, 1, 10, 1));
    g.setAttribute('uv1', g.getAttribute('uv').clone());
    const mesh = new THREE.InstancedMesh(g, this.mats.get('bollard'), n);
    mesh.name = 'posts';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    let toneSum = 0;
    for (let i = 0; i < n; i++) {
      const p = posts[i];
      _euler.set(p.lean, p.s * 0.7, p.lean * 0.6);
      _q.setFromEuler(_euler);
      _pos.set(p.x, DECK_Y + p.h * 0.5, p.z);
      _scl.set(p.r, p.h, p.r);
      _m4.compose(_pos, _q, _scl);
      mesh.setMatrixAt(i, _m4);
      const tone = 0.84 + 0.32 * this.rng.float();
      toneSum += tone;
      _col.setRGB(tone, tone * 0.99, tone * 0.96, THREE.LinearSRGBColorSpace);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.instanceToneMeans.posts = toneSum / n;
    this.stats.posts = n;

    // Post caps - a darker top disc so the silhouette terminates cleanly
    // against the water instead of fading into it.
    const gc = this._own(new THREE.CylinderGeometry(1.14, 1.14, 0.08, 10, 1));
    gc.setAttribute('uv1', gc.getAttribute('uv').clone());
    const caps = new THREE.InstancedMesh(gc, this.mats.get('bollard'), n);
    caps.name = 'post-caps';
    caps.castShadow = true;
    for (let i = 0; i < n; i++) {
      const p = posts[i];
      _euler.set(p.lean, p.s * 0.7, p.lean * 0.6);
      _q.setFromEuler(_euler);
      _pos.set(p.x + Math.sin(p.lean) * p.h * 0.5, DECK_Y + p.h, p.z);
      _scl.set(p.r, 1, p.r);
      _m4.compose(_pos, _q, _scl);
      caps.setMatrixAt(i, _m4);
      _col.setRGB(0.62, 0.60, 0.57, THREE.LinearSRGBColorSpace);
      caps.setColorAt(i, _col);
    }
    caps.instanceMatrix.needsUpdate = true;
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
    this.group.add(caps);
  }

  // ---------------------------------------------------------------------------
  // ROPES. 352 sagging spans, merged into ONE geometry. Each span is a catenary
  // approximated by a quadratic through its own sag value from the record.
  //
  // Ropes are DECOR and never collide. The track module already proved every
  // chord clears CLEAR_RADIUS, so the visual line the player reads as "the
  // barrier" is OUTSIDE the volume that actually blocks them - which is the
  // correct direction. A rope that looked tighter than the collision volume
  // would be the lie hard rule 10 forbids.
  // ---------------------------------------------------------------------------
  _buildRopes() {
    const t = this.track;
    const ropes = t.ropes;
    const SEG = 6;        // segments along each span
    const SIDES = 5;      // cross-section
    const n = ropes.length;
    const vertsPerSpan = (SEG + 1) * SIDES;
    const verts = new Float32Array(n * vertsPerSpan * 3);
    const norms = new Float32Array(n * vertsPerSpan * 3);
    const uvs = new Float32Array(n * vertsPerSpan * 2);
    const idx = [];
    let vi = 0, ui = 0, base = 0;

    for (let r = 0; r < n; r++) {
      const rope = ropes[r];
      const a = t.posts[rope.a], b = t.posts[rope.b];
      const ay = DECK_Y + a.h * 0.92, by = DECK_Y + b.h * 0.92;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1e-6;
      // Perpendicular in the horizontal plane, for the tube cross-section.
      const px = -dz / len, pz = dx / len;
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const cx = a.x + dx * u;
        const cz = a.z + dz * u;
        // Quadratic sag: 0 at both posts, max at mid.
        const sag = rope.sag * 4 * u * (1 - u);
        const cy = ay + (by - ay) * u - sag;
        for (let k = 0; k < SIDES; k++) {
          const ang = (k / SIDES) * Math.PI * 2;
          const ox = Math.cos(ang) * rope.r;
          const oy = Math.sin(ang) * rope.r;
          verts[vi] = cx + px * ox;
          verts[vi + 1] = cy + oy;
          verts[vi + 2] = cz + pz * ox;
          const nl = Math.hypot(px * ox, oy, pz * ox) || 1;
          norms[vi] = px * ox / nl;
          norms[vi + 1] = oy / nl;
          norms[vi + 2] = pz * ox / nl;
          vi += 3;
          uvs[ui] = u * len * 2.2;      // real-world twist period
          uvs[ui + 1] = k / SIDES;
          ui += 2;
        }
      }
      for (let i = 0; i < SEG; i++) {
        for (let k = 0; k < SIDES; k++) {
          const k2 = (k + 1) % SIDES;
          const p0 = base + i * SIDES + k;
          const p1 = base + i * SIDES + k2;
          const p2 = base + (i + 1) * SIDES + k;
          const p3 = base + (i + 1) * SIDES + k2;
          idx.push(p0, p2, p1);
          idx.push(p1, p2, p3);
        }
      }
      base += vertsPerSpan;
    }

    const g = this._own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this._track(g, 'ropes', this.mats.get('rope'), true, true);
    this.stats.ropes = n;
  }

  // ---------------------------------------------------------------------------
  // ITEM CRATES. Yellow, as in the reference frame, and they must READ AS
  // PICKUPS rather than as obstacles at SIGHT_LINE_MIN.
  //
  // Two authored signals do that work, neither of them bloom:
  //   1. HUE. Everything else in this palette is warm-neutral stone and timber.
  //      A saturated yellow is the only chromatic object on the deck.
  //   2. VALUE. The crate albedo is the brightest surface in the world, well
  //      above the boardwalk it sits on, so it separates from the deck at
  //      distance by luminance and not only by colour.
  //
  // Crates are the one place a NON-MEASURED albedo is introduced, because the
  // reference frame's crates are blown out by the sun and their pixel value is
  // a lit result, not an albedo. It is declared here and reported as INSPECTED.
  // ---------------------------------------------------------------------------
  _buildCrates() {
    const t = this.track;
    const crates = t.crates;
    const n = crates.length;
    const g = this._own(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
    g.setAttribute('uv1', g.getAttribute('uv').clone());
    // INSPECTED albedo: saturated warm yellow, inside the 0.02-0.9 band.
    //
    // RAISED IN S6 (readability check N3-crate). CONTENT change, not a threshold
    // change - the 2.5x bar was never touched.
    //
    // The true number was only visible after FOUR fixture faults in the probe
    // were fixed (all recorded in tools/integpage.html): a sample box wider than
    // its subject, a background band inside the crate's own bounce halo, a band
    // that then overshot into open sky, and - the one that hid everything else -
    // a ray-cast that returned "skydome" for every pixel because the skydome
    // sphere contains the camera and always won the nearest-hit test.
    //
    // With foreground and background BOTH ray-verified (fg hits 'crates', bg
    // hits 'deck' at the expected depth), the crate measured 1.117x against the
    // boardwalk - not the 2.151x previously reported, and effectively invisible.
    // The earlier "2.151x, blocked by an S5 exposure defect" conclusion was an
    // artifact of the broken sampler; no exposure change was needed.
    //
    // Cause: the crate's camera-facing vertical face is turned away from the low
    // sun and renders at a few percent of its albedo, while the horizontal deck
    // catches the sun nearly face-on. A 17x ALBEDO advantage collapsed to 1.1x
    // on screen. Geometry and sun angle are fixed by the reference frame, so the
    // albedo is the free variable.
    //
    // Rejected: emissive, bloom, and any albedo above the 0.9 band - all three
    // manufacture contrast the no-post gate exists to forbid. The crate albedo
    // was always declared INSPECTED, never measured (the reference frame's
    // crates are blown out, so their pixel value is a lit result), so raising it
    // inside the plausible band is an authored fix, not a fudge.
    //
    // 0.436 -> 0.755 luminance, hue preserved. Peak channel 0.880 stays inside
    // the 0.02-0.9 band. The crate remains the brightest surface in the world,
    // which is what makes it read as a pickup rather than an obstacle.
    const crateMat = this._own(new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.880, 0.735, 0.120, THREE.LinearSRGBColorSpace),
      roughness: 0.62,
      metalness: 0.0,
      name: 'crate'
    }));
    const mesh = new THREE.InstancedMesh(g, crateMat, n);
    mesh.name = 'crates';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.crateMesh = mesh;
    this.crateBase = new Float32Array(n * 4);   // x, y, z, spin - for syncCrates
    for (let i = 0; i < n; i++) {
      const c = crates[i];
      this.crateBase[i * 4] = c.x;
      this.crateBase[i * 4 + 1] = DECK_Y + c.lift + c.size * 0.5;
      this.crateBase[i * 4 + 2] = c.z;
      this.crateBase[i * 4 + 3] = c.spin;
      _euler.set(0, c.spin, 0);
      _q.setFromEuler(_euler);
      _pos.set(c.x, DECK_Y + c.lift + c.size * 0.5, c.z);
      _scl.set(c.size, c.size, c.size);
      _m4.compose(_pos, _q, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    this.stats.crates = n;
    this.crateSize = crates.length ? crates[0].size : 0.72;
  }

  /**
   * Spin the crates. Driven by the ENGINE CLOCK (hard rule 6), never
   * performance.now(). Allocates nothing.
   * @param {number} timeS engine time in seconds
   */
  syncCrates(timeS) {
    const mesh = this.crateMesh;
    if (!mesh) return;
    const n = mesh.count;
    const size = this.crateSize;
    for (let i = 0; i < n; i++) {
      const bx = this.crateBase[i * 4];
      const by = this.crateBase[i * 4 + 1];
      const bz = this.crateBase[i * 4 + 2];
      const spin = this.crateBase[i * 4 + 3];
      _euler.set(0, spin + timeS * 1.15, 0);
      _q.setFromEuler(_euler);
      _pos.set(bx, by + Math.sin(timeS * 1.9 + spin) * 0.06, bz);
      _scl.set(size, size, size);
      _m4.compose(_pos, _q, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // BUILDINGS. Sandstone bodies with terracotta roofs, arched window recesses
  // and occasional balconies - merged into a small number of geometries.
  //
  // The building's own `tone` from the record varies the facade albedo, and
  // faces are split so the SUNLIT face and the SHADOWED face use the two
  // measured swatches that define the key/fill ratio (#6e6252 over #36382e).
  // That ratio is then a property of the AUTHORED WORLD, not only of the light
  // rig - which is what makes it survive the no-post gate.
  // ---------------------------------------------------------------------------
  _buildBuildings() {
    const t = this.track;
    const list = t.buildings;
    const bodyGeos = [];
    const roofGeos = [];

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const body = new THREE.BoxGeometry(b.w, b.h, b.depth, 1, Math.max(1, b.floors), 1);
      body.translate(0, b.h * 0.5, 0);
      body.rotateY(b.yaw);
      body.translate(b.x, DECK_Y, b.z);
      this._paint(body, b.tone);
      bodyGeos.push(body);

      // Terracotta roof: a low pyramid, not a box, so the skyline is not a row
      // of identical slabs.
      const roof = new THREE.ConeGeometry(Math.hypot(b.w, b.depth) * 0.52, b.h * b.roofPitch, 4, 1);
      roof.rotateY(Math.PI * 0.25);
      roof.translate(0, b.h + b.h * b.roofPitch * 0.5, 0);
      roof.rotateY(b.yaw);
      roof.translate(b.x, DECK_Y, b.z);
      this._paint(roof, b.tone * 0.98);
      roofGeos.push(roof);

      // Window recesses: shallow dark insets on the track-facing side, so the
      // facade is not a flat plane at any distance.
      const wn = b.arches;
      for (let k = 0; k < wn; k++) {
        const wf = (k + 0.5) / wn;
        const wx = (wf * 2 - 1) * b.w * 0.34;
        const wy = b.h * (0.34 + 0.30 * (k % 2));
        const win = new THREE.BoxGeometry(b.w * 0.11, b.h * 0.15, 0.28);
        win.translate(wx, wy, b.depth * 0.5);
        win.rotateY(b.yaw);
        win.translate(b.x, DECK_Y, b.z);
        // Windows are the DARK end of the facade's value range - they are what
        // gives a sandstone wall its texture at 40 m.
        this._paint(win, 0.30);
        bodyGeos.push(win);
      }

      if (b.balcony) {
        const bal = new THREE.BoxGeometry(b.w * 0.44, 0.12, 0.9);
        bal.translate(0, b.h * 0.52, b.depth * 0.5 + 0.35);
        bal.rotateY(b.yaw);
        bal.translate(b.x, DECK_Y, b.z);
        this._paint(bal, b.tone * 1.06);
        bodyGeos.push(bal);
      }
    }

    const bodyGeo = this._own(mergeGeometries(bodyGeos));
    const roofGeo = this._own(mergeGeometries(roofGeos));
    for (const g of bodyGeos) g.dispose();
    for (const g of roofGeos) g.dispose();

    const bodyMat = this.mats.get('stone');
    bodyMat.vertexColors = true;
    this._track(bodyGeo, 'buildings', bodyMat, true, true);

    // Terracotta: an INSPECTED hue. The reference shows terracotta roofs but
    // no roof swatch was measured, so this is declared as inspected, sitting
    // inside the plausible albedo band and keyed to the facade's value.
    const roofMat = this._own(new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.185, 0.070, 0.038, THREE.LinearSRGBColorSpace),
      roughness: 0.86, metalness: 0, vertexColors: true, name: 'terracotta'
    }));
    this._track(roofGeo, 'roofs', roofMat, true, true);
    this.stats.buildings = list.length;
  }

  _buildPalms() {
    const t = this.track;
    const list = t.palms;
    const trunkGeos = [];
    const frondGeos = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const trunk = new THREE.CylinderGeometry(p.trunkR * 0.72, p.trunkR, p.h, 7, 3);
      trunk.translate(0, p.h * 0.5, 0);
      trunk.rotateZ(p.lean);
      trunk.translate(p.x, DECK_Y, p.z);
      this._paint(trunk, 0.78);
      trunkGeos.push(trunk);

      const topX = p.x + Math.sin(p.lean) * p.h;
      for (let f = 0; f < p.fronds; f++) {
        const ang = (f / p.fronds) * Math.PI * 2;
        const frond = new THREE.BoxGeometry(2.5, 0.06, 0.52);
        frond.translate(1.25, 0, 0);
        frond.rotateZ(-0.34);
        frond.rotateY(ang);
        frond.translate(topX, DECK_Y + p.h, p.z);
        this._paint(frond, 0.92 + 0.2 * ((f % 3) / 3));
        frondGeos.push(frond);
      }
    }
    const tg = this._own(mergeGeometries(trunkGeos));
    const fg = this._own(mergeGeometries(frondGeos));
    for (const g of trunkGeos) g.dispose();
    for (const g of frondGeos) g.dispose();
    const trunkMat = this._own(new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.072, 0.055, 0.036, THREE.LinearSRGBColorSpace),
      roughness: 0.93, metalness: 0, vertexColors: true, name: 'palm-trunk'
    }));
    const frondMat = this.mats.get('palm');
    frondMat.vertexColors = true;
    frondMat.side = THREE.DoubleSide;
    this._track(tg, 'palm-trunks', trunkMat, true, true);
    this._track(fg, 'palm-fronds', frondMat, true, false);
    this.stats.palms = list.length;
  }

  // ---------------------------------------------------------------------------
  // WATER. See docs/S5_RENDER.md for the technique decision and its rationale.
  // The surface is a single ribbon following the outboard edge, extended far
  // out to the horizon, shaded by a scrolling normal perturbation driven by the
  // ENGINE CLOCK. No planar reflection, no render-to-texture.
  // ---------------------------------------------------------------------------
  _buildWater() {
    const t = this.track;
    const spans = t.waterSpans;
    const n = spans.length;
    const OUT = 260;           // metres out to the horizon
    const verts = new Float32Array(n * 2 * 3);
    const norms = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const idx = [];
    let vi = 0, ui = 0;
    for (let i = 0; i < n; i++) {
      const w = spans[i];
      t.offsetPoint(w.s, -WATER_OFFSET, _pt);
      t.offsetPoint(w.s, -(WATER_OFFSET + OUT), _pt2);
      verts[vi] = _pt.x; verts[vi + 1] = -0.55; verts[vi + 2] = _pt.z;
      norms[vi] = 0; norms[vi + 1] = 1; norms[vi + 2] = 0;
      vi += 3; uvs[ui] = w.s * 0.08; uvs[ui + 1] = 0; ui += 2;
      verts[vi] = _pt2.x; verts[vi + 1] = -0.55; verts[vi + 2] = _pt2.z;
      norms[vi] = 0; norms[vi + 1] = 1; norms[vi + 2] = 0;
      vi += 3; uvs[ui] = w.s * 0.08; uvs[ui + 1] = 12; ui += 2;
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = ((i + 1) % n) * 2;
      idx.push(a, b, a + 1);
      idx.push(a + 1, b, b + 1);
    }
    const g = this._own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();

    const mat = this.mats.get('lagoon');
    // Scroll the normal map with the engine clock. onBeforeRender is NOT used
    // - the render system calls syncWater(t) explicitly so the time source is
    // unambiguous and the pixel gate is reproducible.
    this.waterMat = mat;
    this.waterMesh = this._track(g, 'lagoon', mat, false, true);
    this.stats.waterSpans = n;
  }

  /** Engine-clock water animation. Allocates nothing. */
  syncWater(timeS) {
    const m = this.waterMat;
    if (!m || !m.normalMap) return;
    m.normalMap.offset.set((timeS * 0.013) % 1, (timeS * 0.021) % 1);
    if (m.map) m.map.offset.set((timeS * 0.006) % 1, (timeS * 0.010) % 1);
  }

  _buildCastle() {
    const c = this.track.castle;
    if (!c) return;
    const geos = [];
    const rock = new THREE.ConeGeometry(c.w * 0.62, c.h * 0.55, 6, 1);
    rock.translate(c.x, c.h * 0.20, c.z);
    this._paint(rock, 0.66);
    geos.push(rock);
    const keep = new THREE.BoxGeometry(c.w * 0.46, c.h * 0.52, c.w * 0.34);
    keep.translate(c.x, c.h * 0.55, c.z);
    this._paint(keep, 1.02);
    geos.push(keep);
    for (let i = 0; i < c.towers; i++) {
      const a = (i / c.towers) * Math.PI * 2;
      const tw = new THREE.CylinderGeometry(c.w * 0.07, c.w * 0.08, c.h * 0.42, 8, 1);
      tw.translate(c.x + Math.cos(a) * c.w * 0.3, c.h * 0.72, c.z + Math.sin(a) * c.w * 0.24);
      this._paint(tw, 1.08);
      geos.push(tw);
    }
    const g = this._own(mergeGeometries(geos));
    for (const x of geos) x.dispose();
    const mat = this.mats.get('facadeFar');
    mat.vertexColors = true;
    // Skyline only: it must not cast into the near cascade, and it is far
    // beyond the shadow range anyway.
    this._track(g, 'castle', mat, false, false);
    this.stats.castle = 1;
  }

  /** Write a scalar tone into a geometry's vertex colour attribute. */
  _paint(geo, tone) {
    const count = geo.getAttribute('position').count;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = tone; arr[i * 3 + 1] = tone; arr[i * 3 + 2] = tone;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    if (!geo.getAttribute('uv1') && geo.getAttribute('uv')) {
      geo.setAttribute('uv1', geo.getAttribute('uv'));
    }
  }

  /** Every material used here, so the render system can register them with CSM. */
  materials() {
    const out = [];
    this.group.traverse((o) => {
      if (o.isMesh && o.material && out.indexOf(o.material) < 0) out.push(o.material);
    });
    return out;
  }

  report() {
    return {
      stats: Object.assign({}, this.stats),
      instanceToneMeans: Object.assign({}, this.instanceToneMeans),
      drawables: this.group.children.length
    };
  }

  dispose() {
    for (const o of this._owned) { if (o && o.dispose) o.dispose(); }
    this._owned.length = 0;
    this.group.traverse((o) => {
      if (o.isInstancedMesh) { o.dispose(); }
    });
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Minimal geometry merge. three's BufferGeometryUtils.mergeGeometries requires
// every input to carry an IDENTICAL attribute set; ours do by construction
// (position, normal, uv, uv1, color), but the addon also pulls in a large
// dependency surface for one function. This is the same algorithm, restricted
// to indexed non-morph geometries, so the merge behaviour is visible here
// rather than being an opaque import.
// ---------------------------------------------------------------------------
function mergeGeometries(geos) {
  const out = new THREE.BufferGeometry();
  if (!geos.length) return out;
  const names = ['position', 'normal', 'uv', 'uv1', 'color'];
  let totalV = 0, totalI = 0;
  for (const g of geos) {
    totalV += g.getAttribute('position').count;
    totalI += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const buffers = {};
  for (const n of names) {
    const proto = geos[0].getAttribute(n);
    if (!proto) continue;
    buffers[n] = { arr: new Float32Array(totalV * proto.itemSize), size: proto.itemSize, off: 0 };
  }
  const idx = totalV > 65535 ? new Uint32Array(totalI) : new Uint16Array(totalI);
  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const vc = g.getAttribute('position').count;
    for (const n of names) {
      const b = buffers[n];
      if (!b) continue;
      const a = g.getAttribute(n);
      if (a) {
        b.arr.set(a.array.subarray(0, vc * b.size), b.off);
      }
      b.off += vc * b.size;
    }
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[iOff + i] = gi[i] + vOff;
      iOff += gi.length;
    } else {
      for (let i = 0; i < vc; i++) idx[iOff + i] = vOff + i;
      iOff += vc;
    }
    vOff += vc;
  }
  for (const n of names) {
    const b = buffers[n];
    if (b) out.setAttribute(n, new THREE.BufferAttribute(b.arr, b.size));
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
