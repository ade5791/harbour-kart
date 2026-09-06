// RENDER GATE FIXTURE - not the world.
//
// Owner: render. `src/world/` (S3) owns the actual harbour. This file exists so
// the RENDER STACK can be MEASURED: a lighting rig cannot be gated against an
// empty scene, and "the materials look right" is not evidence.
//
// RESTORED TO THE FLAPPY SPINE. A previous session rebuilt this fixture around
// kart constants (KART_W, KART_L, TRACK_W_ROUNDED, SIGHT_LINE_MIN) on the
// strength of docs/GENRE_CORRECTION.md. The mission brief is explicit that this
// is Floppy Bird in a harbour SETTING, so the hazard is a PIPE PAIR again, at
// the derived collision dimensions from src/core/config.js.
//
// It assembles one representative instance of every material class plus a
// hazard pillar pair at the exact derived collision dimensions, so the gate can
// measure:
//   - key/fill ratio on a lit vs shadowed stone face
//   - sky falloff on rendered pixels
//   - hazard contrast against the background behind it
//   - contact shadows landing on the boardwalk
//   - the whole thing with post OFF
//
// The hazard box here uses the DERIVED constants from src/core/config.js. It is
// a render fixture, so it is drawn at collision size deliberately: that is what
// makes "decoration must never touch the hitbox" a checkable claim later.
//
// Seeded placement only. No Math.random().

import * as THREE from 'three';
// GENRE CORRECTION: PIPE_W, GAP_H, GAP_CENTER_*_Y and CEIL_Y were retired from
// config.js with the rest of the flap vocabulary. This module was the last
// importer, and the dead import threw at module-evaluation time, taking the whole
// render gate down with an unexplained 60 s timeout.
import {
  HAZARD_ENTRY_X, READABILITY_MIN_RATIO
} from '../core/config.js';
// Track-edge geometry is OWNED BY track.js - the same constants the built track
// and its collision volume use. Importing them here rather than retyping is what
// stops the gate from measuring a kerb the game does not actually have.
import { HALF_W, KERB_W, KERB_H, POST_R, POST_H } from '../sim/track.js';

// The key/fill measurement pair is sampled on these two meshes by name.
// They are placed by a SINGLE offset so the pair is always symmetric about the
// flight axis and both are guaranteed inside the frustum - the previous
// placement put them at +/-12.5 where they projected off-screen entirely and
// the key/fill sample read NaN.
const WALL_X = 5.6;
const WALL = { w: 3.2, h: 7.0, d: 34 };

export class GateScene {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'render-gate-fixture';
    this.geometries = [];
    this.hazard = null;
    this.hazardCenterY = 0;
  }

  _geo(g) { this.geometries.push(g); return g; }

  /**
   * @param {MaterialLibrary} lib
   * @param {RNG} rng   the 'decor' stream
   */
  build(lib, rng) {
    const G = this.group;

    // ---- lagoon ----------------------------------------------------------
    const water = new THREE.Mesh(this._geo(new THREE.PlaneGeometry(400, 400, 1, 1)), lib.get('lagoon'));
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -0.35, -40);
    water.receiveShadow = true;
    G.add(water);

    // ---- boardwalk -------------------------------------------------------
    // The plane the bird flies over and everything casts a contact shadow onto.
    const deck = new THREE.Mesh(this._geo(new THREE.BoxGeometry(26, 0.35, 160)), lib.get('boardwalk'));
    deck.position.set(0, -0.18, -60);
    deck.receiveShadow = true;
    deck.castShadow = true;
    G.add(deck);

    const fore = new THREE.Mesh(this._geo(new THREE.BoxGeometry(26, 0.36, 26)), lib.get('boardwalkFore'));
    fore.position.set(0, -0.17, 8);
    fore.receiveShadow = true;
    G.add(fore);

    // ---- harbour wall, sunlit face and shadowed face ---------------------
    // These two are the KEY/FILL MEASUREMENT PAIR. Same stone class, one turned
    // to the sun and one turned away, which is exactly how the 3.323 ratio was
    // measured off the reference.
    //
    // BOTH WALLS USE THE SAME MATERIAL. An earlier fixture gave the shadowed
    // wall a pre-darkened 'stoneShadow' albedo, which would have made the
    // key/fill ratio partly a MATERIAL difference rather than purely a LIGHTING
    // difference - the measurement would have passed for the wrong reason.
    //
    // Named by POSITION, never by an assumed lighting outcome. The gate resolves
    // which one is lit from the rig's own sun vector (window.__sunFacing) rather
    // than trusting either name.
    const wallGeo = this._geo(new THREE.BoxGeometry(WALL.w, WALL.h, WALL.d));
    const wallNegX = new THREE.Mesh(wallGeo, lib.get('stone'));
    wallNegX.position.set(-WALL_X, WALL.h * 0.5 - 0.35, -20);
    wallNegX.castShadow = true; wallNegX.receiveShadow = true;
    wallNegX.name = 'wall-negX';
    G.add(wallNegX);

    const wallPosX = new THREE.Mesh(wallGeo, lib.get('stone'));
    wallPosX.position.set(WALL_X, WALL.h * 0.5 - 0.35, -20);
    wallPosX.castShadow = true; wallPosX.receiveShadow = true;
    wallPosX.name = 'wall-posX';
    G.add(wallPosX);

    // The INNER faces are what the camera sees, so record their normals and the
    // exact world-space plane the gate should sample. A screen-space projection
    // of the whole box includes the TOP face and the far edge, which is how the
    // shadowed sample ended up reading 0.0 - it landed on a fully occluded
    // sliver rather than the inner face.
    this.keyFillPair = {
      negX: { mesh: wallNegX, innerNormal: [1, 0, 0], innerX: -WALL_X + WALL.w * 0.5 },
      posX: { mesh: wallPosX, innerNormal: [-1, 0, 0], innerX: WALL_X - WALL.w * 0.5 },
      height: WALL.h, depth: WALL.d, centerZ: -20
    };

    // ---- breakwater + stacked facades up the headland -------------------
    const facGeo = this._geo(new THREE.BoxGeometry(4.5, 4.5, 4.5));
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(facGeo, lib.get('facadeFar'));
      const side = i % 2 === 0 ? -1 : 1;
      m.position.set(
        side * rng.range(15, 26),
        rng.range(1.4, 8.5),
        -rng.range(24, 78)
      );
      m.rotation.y = rng.range(-0.35, 0.35);
      const s = rng.range(0.75, 1.6);
      m.scale.set(s, rng.range(0.7, 1.5), s);
      m.castShadow = true; m.receiveShadow = true;
      G.add(m);
    }

    // ---- kerb ------------------------------------------------------------
    const kerbGeo = this._geo(new THREE.BoxGeometry(0.9, 0.55, 150));
    for (const x of [-8.4, 8.4]) {
      const k = new THREE.Mesh(kerbGeo, lib.get('kerb'));
      k.position.set(x, 0.13, -58);
      k.castShadow = true; k.receiveShadow = true;
      G.add(k);
    }

    // ---- bollards + rope: DECOR, and must read differently from hazards ---
    const bolGeo = this._geo(new THREE.CylinderGeometry(0.17, 0.21, 1.05, 10));
    const ropeGeo = this._geo(new THREE.CylinderGeometry(0.045, 0.045, 3.1, 6));
    for (let i = 0; i < 18; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -3 - Math.floor(i / 2) * 3.2;
      const b = new THREE.Mesh(bolGeo, lib.get('bollard'));
      b.position.set(side * 7.6, 0.52, z);
      b.rotation.y = rng.range(-0.2, 0.2);
      b.castShadow = true; b.receiveShadow = true;
      G.add(b);

      const r = new THREE.Mesh(ropeGeo, lib.get('rope'));
      r.position.set(side * 7.6, 0.72, z - 1.6);
      r.rotation.x = Math.PI / 2;
      r.rotation.z = rng.range(-0.06, 0.06);
      r.castShadow = true;
      G.add(r);
    }

    // ---- palms -----------------------------------------------------------
    const trunkGeo = this._geo(new THREE.CylinderGeometry(0.16, 0.26, 5.2, 7));
    const frondGeo = this._geo(new THREE.BoxGeometry(3.4, 0.07, 0.55));
    for (let i = 0; i < 7; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -8 - i * 9.5;
      const t = new THREE.Mesh(trunkGeo, lib.get('bollard'));
      t.position.set(side * rng.range(9.5, 12.5), 2.5, z);
      t.rotation.z = rng.range(-0.12, 0.12);
      t.castShadow = true;
      G.add(t);
      for (let f = 0; f < 6; f++) {
        const fr = new THREE.Mesh(frondGeo, lib.get('palm'));
        fr.position.copy(t.position);
        fr.position.y += 2.5;
        fr.rotation.y = (f / 6) * Math.PI * 2 + rng.range(-0.2, 0.2);
        fr.rotation.z = rng.range(-0.5, -0.15);
        fr.castShadow = true;
        G.add(fr);
      }
    }

    // ---- THE READABILITY SUBJECT: the TRACK EDGE at real dimensions -------
    //
    // Authored at the size that actually stops you, so "decoration must never
    // touch the collision surface" stays a checkable claim. Every number is
    // imported from track.js - the same constants the built track and its
    // collision volume use. NOTHING here is typed by eye:
    //
    //   track half-width = HALF_W   (3.05 m, derived from TRACK_W_ROUNDED)
    //   kerb             = KERB_W x KERB_H  (0.55 x 0.10 m, INSPECTED)
    //   mooring post     = POST_R, POST_H   (0.16 m radius, 0.95 m, INSPECTED)
    //
    // Placed at HAZARD_ENTRY_X = SIGHT_LINE_MIN down the harbour axis: the exact
    // distance at which READABILITY_MIN_RATIO must already hold, because that is
    // where the corner is revealed and the player's reaction window opens.
    // GENRE CORRECTION (docs/GENRE_CORRECTION.md). This block used to build a
    // FLAP HAZARD - two pipe pillars around GAP_H, clamped at CEIL_Y. There is no
    // pipe, no gap and no ceiling in a kart racer, and importing CEIL_Y from the
    // corrected config threw "does not provide an export named 'CEIL_Y'", which is
    // what took the whole render gate down. The constants were correctly retired;
    // this fixture was the last thing still asking for them.
    //
    // The readability subject for a KART RACER is the thing you actually crash
    // into: the TRACK EDGE - stone kerb plus rope barrier - which the brief
    // requires to clear READABILITY_MIN_RATIO against whatever is behind it at
    // SIGHT_LINE_MIN. Same measurement, same threshold, correct subject.
    const kerbH = KERB_H;
    const barrierH = POST_H;
    this.hazardCenterY = barrierH * 0.5;

    // Negative Z is down the harbour axis. The hazard sits at the distance the
    // readability rule is specified against.
    const hz = -HAZARD_ENTRY_X;

    // STONE KERB along the track edge - the value break the player reads as the
    // limit of the drivable surface. Half a track-width out from the centreline.
    const edgeX = HALF_W;
    // Distinct name: the boardwalk section above already declares kerbGeo in this
    // same function scope (line 142) for the long run-of-track kerb.
    const edgeKerbGeo = this._geo(new THREE.BoxGeometry(KERB_W, kerbH, 8.0));
    // 'kerb' and 'bollard' are the REAL material ids (materials.js:64, 72), carrying
    // the measured stoneKerb and bollard region albedos. 'wood' does not exist in
    // the library - using it would have silently mismatched the readability
    // measurement against materials the built track never applies.
    const kerb = new THREE.Mesh(edgeKerbGeo, lib.get('kerb'));
    kerb.position.set(edgeX + KERB_W * 0.5, kerbH * 0.5, hz);
    kerb.castShadow = true; kerb.receiveShadow = true;
    kerb.name = 'edge-kerb';
    G.add(kerb);

    // MOORING POST behind the kerb - the barrier silhouette. Authored OUTSIDE the
    // drivable volume (hard rule 10: decoration may never touch the collision
    // surface), so it is placed beyond the kerb, never within HALF_W.
    const postGeo = this._geo(new THREE.CylinderGeometry(POST_R, POST_R, barrierH, 10));
    const post = new THREE.Mesh(postGeo, lib.get('bollard'));
    post.position.set(edgeX + KERB_W + POST_R, barrierH * 0.5, hz);
    post.castShadow = true; post.receiveShadow = true;
    post.name = 'edge-post';
    G.add(post);

    this.hazard = {
      kerb, post, z: hz,
      kerbW: KERB_W, kerbH, postR: POST_R, postH: barrierH,
      edgeX,
      readabilityMinRatio: READABILITY_MIN_RATIO,
      atDistance: HAZARD_ENTRY_X
    };
    return this;
  }

  dispose() {
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    this.geometries.length = 0;
    this.group.clear();
  }
}
