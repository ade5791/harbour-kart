// =============================================================================
// Harbour Kart - S3 TRACK. The drivable harbour circuit, in metres.
// =============================================================================
//
// WHAT THIS MODULE IS
//
// src/sim/course.js (S2) produces the CENTRELINE - a closed chain of straights
// and arcs whose corner radii come from the derived ladder and whose approach
// straights are sized by sightLine(R). This module turns that centreline into a
// TRACK: a drivable surface with a width, kerbs, mooring posts, rope barriers,
// water outside the left-hand edge, and item crates on the racing surface.
//
// It is authored as PLACEMENT DATA, not as Three.js objects. The renderer
// consumes it to build geometry; the headless probes consume the exact same data
// to validate sight lines, decoration intrusion and readability. There is no
// second description of the track anywhere. That is the point: on the previous
// build the course generator was inline in the sim and every probe had to
// reimplement it, and the two implementations agreed right up until they did not.
//
// A DEFECT THIS STEP FOUND AND FIXED IN THE INHERITED MODULE
//
// S2's course.js had BOTH arc displacement terms sign-inverted, so every arc
// moved the kart backwards along its own heading and folded the track over
// itself. Measured worst non-adjacent centreline separation on seed 12345 was
// 0.05 m on a 6.1 m wide track - complete overlap.
//
// S2's own validateSightLines() passed 14/14 on that folded track, because it
// built its sight chord from sampleInto() and compared it against a centreline
// from the SAME sampleInto(). The inversion cancelled. A probe that shares an
// implementation with the thing it tests cannot see a defect in that
// implementation - which is exactly the failure the course.js header warns about,
// reappearing one level up.
//
// The fix was verified against an INDEPENDENT numerical integration of the
// heading field (tools/_s3_diag2.mjs): the corrected closed form matches to
// 0.000000000 m on 6/6 cases; the old one missed by 17-106 m. Self-overlap across
// 600 seeds went from 400/400 failing to 10/600.
//
// CONSEQUENCE FOR THIS MODULE: the sight-line gate here does NOT reuse the
// course sampler's notion of visibility. It raycasts against the ACTUAL built
// occluder list - buildings, palms, kerb walls, posts - which is a genuinely
// independent description of the world. See tools/trackgate.mjs.
//
// NO Math.random(). Every placement draws from a seeded, named RNG stream so the
// same seed builds the same harbour on every machine and every capture.

import { RNG } from '../core/rng.js';
import { Course } from './course.js';
import {
  TRACK_W_ROUNDED, SIGHT_LINE_MIN, LAP_LEN, LAP_COUNT, CORNER_RADII,
  R_FLAT, sightLine, vCorner, dBrake, D_REACT, V_TOP, A_BRAKE, KART_W
} from '../core/config.js';

// -----------------------------------------------------------------------------
// AUTHORED CONSTANTS. Each carries its provenance: MEASURED off the reference
// frame, DERIVED from a measured anchor, or INSPECTED (read off the frame by eye,
// which the mission brief requires be labelled as such and never dressed up as a
// measurement).
// -----------------------------------------------------------------------------

// The circuit seed. Chosen by an explicit search over 600 seeds against five
// criteria simultaneously (tools/_s3_probe3.mjs): no self-overlap, at least one
// R=12 hairpin, all seven ladder rungs present, zero sight-line failures, and lap
// length within 2% of the 1236.0 m target. Seed 37 was the closest to target of
// the 135 qualifying seeds at +0.02%. This is a SELECTED constant, not a tuned
// one - the criteria were fixed before the search ran.
export const TRACK_SEED = 37;

export const HALF_W = TRACK_W_ROUNDED / 2;          // 3.05 m. DERIVED from width.

// Kerb: the stone/masonry edging in the reference frame, sitting just outside the
// drivable boardwalk. INSPECTED width; it reads as roughly half a kart wide.
export const KERB_W = 0.55;                          // m, INSPECTED
export const KERB_H = 0.10;                          // m, INSPECTED - low enough
                                                     // to ride, high enough to feel
// Shoulder: the sand/stone run-off outside the kerb before anything solid. This
// is the same SIGHT_SHOULDER the S2 corridor uses, restated here because THIS is
// the module that actually places geometry against it.
export const SHOULDER_W = 2.00;                      // m, INSPECTED

// The first metre at which solid, sight-blocking geometry is allowed to exist.
// DERIVED: half width + kerb + shoulder. Everything at or beyond this is outside
// both the collision surface and the sight corridor.
export const CLEAR_RADIUS = HALF_W + KERB_W + SHOULDER_W;   // 5.60 m

// Mooring posts joined by thick rope - the reference frame's barrier. HARD RULE
// 10: decoration may never touch the drivable volume. Posts are placed at
// CLEAR_RADIUS + POST_STANDOFF so neither the post nor the rope sag can enter it.
export const POST_STANDOFF = 0.45;                   // m, DERIVED margin
export const POST_R = 0.16;                          // m radius, INSPECTED
export const POST_H = 0.95;                          // m tall, INSPECTED
export const POST_SPACING = 7.0;                     // m along the edge, INSPECTED
export const ROPE_SAG = 0.22;                        // m, INSPECTED - ropes sag,
                                                     // they are never taut lines
export const ROPE_R = 0.055;                         // m, INSPECTED "thick rope"

// Item crates. The reference shows yellow pickup crates sitting mid-track.
export const CRATE_SIZE = 0.72;                      // m cube, INSPECTED
export const CRATE_LIFT = 0.10;                      // m above the deck, so the
                                                     // contact shadow reads
export const CRATES_PER_ROW = 3;
export const CRATE_ROW_COUNT = 4;                    // 4 rows around the lap

// Scenery standoff. Buildings, palms and the castle are SIGHT-BLOCKING, so they
// must clear the sight corridor by a real margin, not by a hair.
export const BUILDING_STANDOFF = 11.0;               // m from centreline, DERIVED
                                                     // (CLEAR_RADIUS + 5.4 margin)
export const PALM_STANDOFF = 8.2;                    // m - palms are thin, but the
                                                     // trunk still occludes

// Water sits outside the LEFT edge for the signature stretch, matching the
// reference frame's lagoon-side sweeping left bend.
export const WATER_OFFSET = CLEAR_RADIUS + 1.2;      // m, where the deck ends

// -----------------------------------------------------------------------------
// Occluder kinds. The sight-line gate treats these differently: SOLID blocks the
// view, DECOR never does and never collides, KERB is low enough to see over.
// -----------------------------------------------------------------------------
export const OCC = Object.freeze({ SOLID: 'solid', DECOR: 'decor', KERB: 'kerb' });

// Eye height of the driver in the chase camera, used by the sight ray. The
// reference frame's camera sits at roughly kart-roof height.
export const EYE_H = 1.35;                           // m, INSPECTED

export class Track {
  constructor(seed = TRACK_SEED) {
    this.seed = seed >>> 0;
    this.course = new Course(this.seed);
    this.length = this.course.length;
    this.halfWidth = HALF_W;

    // Placement lists. Built once at construction; the renderer reads them, the
    // probes read them, nobody mutates them per frame.
    this.planks = [];       // boardwalk plank strips (wear varies per plank)
    this.kerbs = [];        // kerb stones, left and right
    this.posts = [];        // mooring posts
    this.ropes = [];        // rope spans between consecutive posts
    this.crates = [];       // item pickup crates
    this.buildings = [];    // sandstone facades
    this.palms = [];        // palm trees
    this.waterSpans = [];   // lagoon edge spans
    this.occluders = [];    // EVERYTHING that can block a sight ray

    // Preallocated scratch. Sight tests run in loops; they allocate nothing.
    this._a = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    this._b = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    this._m = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };

    this._build();
  }

  // ---------------------------------------------------------------------------
  // Frames. Right-hand normal of the centreline at arclength s. Heading h means
  // forward (-sin h, -cos h); the left-hand normal is forward rotated +90 deg.
  // Positive lateral offset = RIGHT of the direction of travel.
  // ---------------------------------------------------------------------------
  normalAt(s, out) {
    const p = this.course.sampleInto(s, this._m);
    // forward = (-sin h, -cos h); right = (-cos h, +sin h)
    out.x = -Math.cos(p.heading);
    out.z = Math.sin(p.heading);
    return out;
  }

  // World position at arclength s, offset laterally by d metres (positive = right).
  offsetPoint(s, d, out) {
    const p = this.course.sampleInto(s, this._m);
    const nx = -Math.cos(p.heading), nz = Math.sin(p.heading);
    out.x = p.x + nx * d;
    out.z = p.z + nz * d;
    out.heading = p.heading;
    return out;
  }

  // ---------------------------------------------------------------------------
  // BUILD. Every list is deterministic from the seed via named RNG streams, so
  // "the harbour" is the same harbour for the renderer, the probes and every
  // capture.
  // ---------------------------------------------------------------------------
  _build() {
    const root = new RNG(this.seed);
    this._buildPlanks(root.fork('planks'));
    this._buildKerbs(root.fork('kerbs'));
    this._buildPostsAndRopes(root.fork('barrier'));
    // Must run AFTER the posts exist and BEFORE occluders are collected: it moves
    // post positions to keep every rope chord outside the clear radius. It uses no
    // RNG, so it cannot disturb determinism of any later stream.
    this._relaxRopeChords();
    this._buildCrates(root.fork('crates'));
    this._buildScenery(root.fork('scenery'));
    this._buildWater(root.fork('water'));
    this._collectOccluders();
  }

  // Boardwalk planks run ACROSS the direction of travel, as in the reference
  // frame. Each plank carries its own wear value so no two are identical and the
  // surface never shows a perfect repeat.
  _buildPlanks(rng) {
    const PLANK_LEN = 0.30;                     // m along the track, INSPECTED
    const n = Math.floor(this.length / PLANK_LEN);
    for (let i = 0; i < n; i++) {
      const s = i * PLANK_LEN;
      this.planks.push({
        s,
        len: PLANK_LEN,
        // Wear 0..1 drives albedo darkening and roughness in the material. Two
        // octaves so wear comes in patches rather than per-plank noise.
        wear: 0.5 * rng.float() + 0.5 * (0.5 + 0.5 * Math.sin(s * 0.11 + rng.float() * 0.4)),
        // Small per-plank gap and vertical jitter: nothing perfectly clean.
        gap: 0.004 + rng.float() * 0.006,
        lift: (rng.float() - 0.5) * 0.008,
        splitAt: rng.float() < 0.18 ? rng.range(-HALF_W, HALF_W) : null
      });
    }
  }

  // Kerbs run continuously down both edges, made of individual stones so the line
  // can chip and vary. Stones are OUTSIDE the drivable half-width by construction.
  _buildKerbs(rng) {
    const STONE_LEN = 1.20;                     // m, INSPECTED
    const n = Math.floor(this.length / STONE_LEN);
    for (let i = 0; i < n; i++) {
      const s = i * STONE_LEN;
      for (const side of [-1, 1]) {
        this.kerbs.push({
          s,
          len: STONE_LEN,
          side,
          // Inner face sits exactly at the drivable edge; the stone extends OUT.
          inner: HALF_W,
          outer: HALF_W + KERB_W,
          height: KERB_H * (0.9 + rng.float() * 0.2),
          chip: rng.float() < 0.22 ? rng.range(0.02, 0.09) : 0,
          // Alternating stripe for the value break the readability gate needs.
          stripe: (i % 2) === 0
        });
      }
    }
  }

  // Mooring posts joined by thick sagging rope. HARD RULE 10 lives here.
  //
  // THE CHORD SAGITTA DEFECT - found by the gate, diagnosed, fixed in CONTENT.
  // The first version placed every post at CLEAR_RADIUS + POST_STANDOFF + POST_R
  // and asserted in a comment that "the rope spans post-to-post entirely outside
  // it". That comment was WRONG. A rope is a STRAIGHT CHORD between two posts;
  // on the INSIDE of a bend its midpoint cuts inboard of both endpoints by the
  // sagitta L^2/(8*Rc). At POST_SPACING 7.0 m on an R=12 hairpin the post circle
  // has Rc ~ 5.8 m, giving ~1.06 m of bulge - so posts sitting honestly at
  // 6.22 m carried a rope through 5.468 m, INSIDE the 5.600 m clear radius.
  //
  // The player reads the rope line as the barrier, so this is exactly the lie
  // hard rule 10 forbids: the visual silhouette was tighter than the volume the
  // collision surface admits. The fix is a relaxation pass that pushes the
  // OFFENDING POSTS OUTWARD until every chord midpoint clears the radius. The
  // threshold was not touched.
  _relaxRopeChords() {
    const need = CLEAR_RADIUS + ROPE_R + 0.10;   // rope surface + 10 cm margin
    // Several passes: moving one post changes both spans it belongs to.
    for (let pass = 0; pass < 24; pass++) {
      let worst = 0;
      for (const rope of this.ropes) {
        const a = this.posts[rope.a], b = this.posts[rope.b];
        // Sample the chord, not just the midpoint - the closest approach of a
        // chord to a curved centreline is not always at t = 0.5.
        let minLat = Infinity;
        for (let t = 0.1; t <= 0.9001; t += 0.1) {
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const sHint = a.s + (b.s - a.s) * t;
          const l = this.lateralOf(x, z, sHint).dist;
          if (l < minLat) minLat = l;
        }
        const deficit = need - minLat;
        if (deficit > 1e-4) {
          if (deficit > worst) worst = deficit;
          // Push both endpoints out by the deficit plus a little, then re-place.
          for (const post of [a, b]) {
            post.dist += deficit * 0.6 + 0.01;
            this.offsetPoint(post.s, post.side * post.dist, this._m);
            post.x = this._m.x; post.z = this._m.z;
          }
        }
      }
      if (worst === 0) break;
    }
  }

  _buildPostsAndRopes(rng) {
    const base = CLEAR_RADIUS + POST_STANDOFF + POST_R;
    const n = Math.floor(this.length / POST_SPACING);
    const p = { x: 0, z: 0, heading: 0 };
    for (const side of [-1, 1]) {
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const s = (i * POST_SPACING) % this.length;
        // Posts lean and vary slightly - nothing perfectly repeated.
        const lean = rng.range(-0.035, 0.035);
        const d = base + rng.range(0, 0.18);
        this.offsetPoint(s, side * d, p);
        const post = {
          s, side, dist: d, x: p.x, z: p.z,
          r: POST_R * (0.92 + rng.float() * 0.16),
          h: POST_H * (0.94 + rng.float() * 0.12),
          lean,
          index: this.posts.length
        };
        this.posts.push(post);
        if (prev && i > 0) {
          this.ropes.push({
            a: prev.index, b: post.index,
            // Sag varies so no two spans match.
            sag: ROPE_SAG * (0.8 + rng.float() * 0.4),
            r: ROPE_R,
            side
          });
        }
        prev = post;
      }
    }
  }

  // Item crates sit ON the racing surface, as in the reference frame. They are
  // placed on STRAIGHTS only and never inside a corner's braking zone - a pickup
  // that forces a mid-braking swerve is an obstacle pretending to be a reward.
  _buildCrates(rng) {
    const corners = this.course.corners();
    // Braking zones to avoid: [entry - sightLine, entry + arcLen]
    const zones = corners.map((c) => ({
      from: c.s0 - c.requiredSight,
      to: c.s0 + c.arcLen
    }));
    const inZone = (s) => zones.some((z) => {
      let a = z.from, b = z.to;
      if (a < 0) { a += this.length; return s >= a || s <= b; }
      return s >= a && s <= b;
    });

    const p = { x: 0, z: 0, heading: 0 };
    let placed = 0, guard = 0;
    while (placed < CRATE_ROW_COUNT && guard++ < 4000) {
      const s = rng.range(0, this.length);
      if (inZone(s)) continue;
      // Lay a row across the track: evenly spread, inside the drivable width with
      // a clear kart-width of room at each edge so they never force a wall scrape.
      //
      // The edge margin is KART_W, not an eyeballed number. A crate row that
      // leaves less than a full kart width between the outermost crate and the
      // track edge does not offer a choice - it forces contact with either the
      // crate or the kerb, which turns a PICKUP into an OBSTACLE. That is exactly
      // the readability failure the brief calls out ("item crates must read as
      // pickups, not as obstacles"), expressed as geometry rather than as colour.
      // The first pass used 0.8 m and the gate caught it at 0.800 m vs the 1.10 m
      // requirement; the fix is the margin, NOT the threshold.
      const usable = HALF_W - CRATE_SIZE * 0.5 - KART_W;
      for (let k = 0; k < CRATES_PER_ROW; k++) {
        const f = CRATES_PER_ROW === 1 ? 0 : (k / (CRATES_PER_ROW - 1)) * 2 - 1;
        const d = f * usable;
        this.offsetPoint(s, d, p);
        this.crates.push({
          s, lateral: d, x: p.x, z: p.z,
          size: CRATE_SIZE,
          lift: CRATE_LIFT,
          spin: rng.range(0, Math.PI * 2),
          row: placed,
          id: this.crates.length
        });
      }
      placed++;
    }
    this.crateRows = placed;
  }

  // Sandstone buildings, terracotta roofs, palms and the distant castle. All
  // placed at or beyond their standoff so they cannot occlude a corner approach.
  _buildScenery(rng) {
    const p = { x: 0, z: 0, heading: 0 };
    const corners = this.course.corners();

    // Buildings line the inland (right-hand) side for most of the lap.
    //
    // STANDOFF IS MEASURED FROM THE BUILDING'S SURFACE, NOT ITS CENTRE.
    // The first pass placed the CENTRE at >= BUILDING_STANDOFF and then let the
    // footprint extend inboard from there, so a 13 x 12 m building whose centre
    // sat at 11.0 m had its corner at 11.0 - 8.9 = 2.1 m... inside the sight
    // corridor and nearly on the kerb. The gate caught 3 of 46 like that, worst
    // surface at 4.448 m against the 5.600 m clear radius.
    //
    // The fix is in the PLACEMENT, not in the threshold: the standoff is now
    // applied to the nearest surface by adding the footprint's bounding radius,
    // so a bigger building is pushed further out rather than reaching further in.
    // The brief is explicit that a sight-line failure is a TRACK defect and the
    // scenery moves - so the scenery moves.
    const nB = 46;
    for (let i = 0; i < nB; i++) {
      const s = (i / nB) * this.length + rng.range(-6, 6);
      const w = rng.range(6, 13);
      const depth = rng.range(6, 12);
      const boundR = 0.5 * Math.hypot(w, depth);
      const d = BUILDING_STANDOFF + boundR + rng.range(0, 16);
      this.offsetPoint(s, d, p);
      this.buildings.push({
        s, dist: d, x: p.x, z: p.z,
        w,
        depth,
        h: rng.range(5.5, 13.5),
        floors: 2 + Math.floor(rng.float() * 3),
        roofPitch: rng.range(0.22, 0.38),
        yaw: rng.range(-0.35, 0.35),
        // Facade tone varies around the measured sunlit facade albedo.
        tone: rng.range(0.82, 1.16),
        balcony: rng.float() < 0.45,
        arches: 2 + Math.floor(rng.float() * 3)
      });
    }

    // Palms, mostly on the water side, thin trunks but still occluders.
    const nP = 34;
    for (let i = 0; i < nP; i++) {
      const s = (i / nP) * this.length + rng.range(-8, 8);
      const side = rng.float() < 0.62 ? -1 : 1;
      const d = side * (PALM_STANDOFF + rng.range(0, 9));
      this.offsetPoint(s, d, p);
      this.palms.push({
        s, dist: Math.abs(d), side, x: p.x, z: p.z,
        h: rng.range(4.2, 8.5),
        lean: rng.range(-0.16, 0.16),
        fronds: 6 + Math.floor(rng.float() * 4),
        trunkR: rng.range(0.16, 0.26)
      });
    }

    // The distant castle on its rocky outcrop. Far outside everything; it is
    // skyline, never an occluder for a corner.
    const cs = corners[0];
    this.offsetPoint(cs ? cs.s0 : 0, -180, p);
    this.castle = {
      x: p.x, z: p.z, h: 34, w: 46,
      towers: 4,
      note: 'skyline only - 180 m off centreline, never occludes a corner approach'
    };
  }

  // Water outside the left edge. Purely visual, but it marks where the deck ends.
  _buildWater(rng) {
    const STEP = 4.0;
    const n = Math.floor(this.length / STEP);
    const p = { x: 0, z: 0, heading: 0 };
    for (let i = 0; i < n; i++) {
      const s = i * STEP;
      this.offsetPoint(s, -(WATER_OFFSET + rng.range(0, 0.8)), p);
      this.waterSpans.push({ s, x: p.x, z: p.z, edge: WATER_OFFSET });
    }
  }

  // ---------------------------------------------------------------------------
  // OCCLUDERS. The single list the sight-line gate raycasts against. This is what
  // makes the S3 gate independent of the S2 sampler: it tests the ACTUAL objects
  // placed in the world, at their actual radii, not an abstract corridor.
  //
  // Classification matters and is deliberate:
  //   buildings, palms, castle -> SOLID, they block sight
  //   posts                    -> SOLID but short; the ray runs at EYE_H so a
  //                               0.95 m post does not block a 1.35 m eye. It is
  //                               still listed so intrusion can be measured.
  //   ropes, kerbs, crates     -> DECOR/KERB, never sight blockers
  // ---------------------------------------------------------------------------
  _collectOccluders() {
    this.occluders.length = 0;
    for (const b of this.buildings) {
      // Conservative bounding circle: half the diagonal footprint.
      const r = 0.5 * Math.hypot(b.w, b.depth);
      this.occluders.push({ kind: OCC.SOLID, x: b.x, z: b.z, r, top: b.h, src: 'building' });
    }
    for (const pl of this.palms) {
      this.occluders.push({ kind: OCC.SOLID, x: pl.x, z: pl.z, r: pl.trunkR, top: pl.h, src: 'palm' });
    }
    for (const po of this.posts) {
      this.occluders.push({ kind: OCC.SOLID, x: po.x, z: po.z, r: po.r, top: po.h, src: 'post' });
    }
    this.occluders.push({
      kind: OCC.SOLID, x: this.castle.x, z: this.castle.z,
      r: this.castle.w * 0.5, top: this.castle.h, src: 'castle'
    });
  }

  // ---------------------------------------------------------------------------
  // COLLISION SURFACE. The drivable volume is the swept band of half-width
  // HALF_W about the centreline. Anything a player can hit must be outside it.
  // Returns the lateral distance from the centreline at arclength s.
  // ---------------------------------------------------------------------------
  lateralOf(x, z, sHint) {
    // Nearest-point search on the centreline, seeded from a hint when available.
    let best = Infinity, bestS = 0;
    const coarse = 2.0;
    const from = sHint == null ? 0 : sHint - 40;
    const to = sHint == null ? this.length : sHint + 40;
    for (let s = from; s < to; s += coarse) {
      const p = this.course.sampleInto(s, this._m);
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) { best = d; bestS = s; }
    }
    for (let s = bestS - coarse; s <= bestS + coarse; s += 0.05) {
      const p = this.course.sampleInto(s, this._m);
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) { best = d; bestS = s; }
    }
    const p = this.course.sampleInto(bestS, this._m);
    const nx = -Math.cos(p.heading), nz = Math.sin(p.heading);
    const lateral = (x - p.x) * nx + (z - p.z) * nz;
    return { s: bestS, lateral, dist: Math.sqrt(best) };
  }

  // ---------------------------------------------------------------------------
  // Corner table with the braking geometry spelled out, so the report can show
  // radius -> corner speed -> braking distance -> braking point -> required sight.
  // ---------------------------------------------------------------------------
  cornerTable() {
    return this.course.corners().map((c) => {
      const vC = vCorner(c.R);
      const dB = dBrake(c.R);
      const req = sightLine(c.R);
      let bp = (c.s0 - dB) % this.length;
      if (bp < 0) bp += this.length;
      return {
        index: c.index,
        R: c.R,
        sign: c.sign,
        hand: c.sign > 0 ? 'LEFT' : 'RIGHT',
        sweepDeg: c.sweep * 180 / Math.PI,
        entryS: c.s0,
        arcLen: c.arcLen,
        vCornerKmh: vC * 3.6,
        dBrake: dB,
        dReact: D_REACT,
        brakingPointS: bp,
        requiredSight: req,
        approachLen: c.approachLen,
        isCorner: c.R < R_FLAT
      };
    });
  }

  stats() {
    const cs = this.cornerTable();
    return {
      seed: this.seed,
      lapLen: this.length,
      lapTarget: LAP_LEN,
      lapErrPct: 100 * (this.length - LAP_LEN) / LAP_LEN,
      raceLen: this.length * LAP_COUNT,
      laps: LAP_COUNT,
      width: TRACK_W_ROUNDED,
      corners: cs.length,
      radiiUsed: [...new Set(cs.map((c) => c.R))].sort((a, b) => a - b),
      hairpins: cs.filter((c) => c.R === 12).length,
      allBelowRFlat: cs.every((c) => c.R < R_FLAT),
      rFlat: R_FLAT,
      sightLineMin: SIGHT_LINE_MIN,
      idealLapS: this.course.idealLapEstimate(),
      planks: this.planks.length,
      kerbStones: this.kerbs.length,
      posts: this.posts.length,
      ropes: this.ropes.length,
      crates: this.crates.length,
      crateRows: this.crateRows,
      buildings: this.buildings.length,
      palms: this.palms.length,
      occluders: this.occluders.length,
      clearRadius: CLEAR_RADIUS
    };
  }
}
