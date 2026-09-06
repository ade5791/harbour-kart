// =============================================================================
// Harbour Kart - WAYPOINT ARROW. The next corner, projected to screen space.
// =============================================================================
//
// WHY THIS MODULE EXISTS (a MEASURED S9 defect, not a feature request):
//
// The reference frame carries "a small waypoint arrow over the track", and
// hud.js has always had the arrow node, tagged data-hud-box="waypoint" and
// positioned from a `waypointNorm` argument. Gate check K33 asserted all of
// that - and passed - because K33 reads the HUD SOURCE: node exists, tag
// present, /waypointNorm/ referenced, /waypointNorm\.visible/ referenced.
//
// But game.js called:
//     this.hud.update(pos, field, lap, laps, time, speedKmh, 0);
//                                                            ^ literal ZERO
// `0` is neither undefined nor null, so hud.js's guard
//     if (waypointNorm !== undefined && waypointNorm !== null)
// PASSED, and then read (0).x and (0).y -> undefined. The arrow was positioned
// at "NaN%" (which CSS rejects, so left/top silently kept their 50%/46%
// defaults - masking the bug visually) and opacity was set from
// (0).visible -> undefined -> falsy -> '0'.
//
// MEASURED in the live DOM by tools/s9/_diagarrow.mjs on the shipping page:
//     inlineLeft "50%", inlineTop "46%", inlineOpacity "0", computedOpacity "0"
// i.e. the arrow was present in the DOM, correctly tagged, gated as PASS, and
// INVISIBLE IN EVERY FRAME THE GAME HAS EVER RENDERED.
//
// This is exactly the failure class hard rule 6 names: a static check is not
// proof that something rendered. K33 checked the source; nothing checked the
// pixels. S9 adds a RUNTIME visibility check (Q-WAYPOINT) alongside it.
//
// WHAT IT POINTS AT
// The next corner's ENTRY station (c.s0) - the same station the whole difficulty
// surface is derived from, since SIGHT_LINE_MIN is defined as the distance
// before exactly that point at which the corner must be visible. So the arrow is
// not decoration: it marks the braking reference the player is being asked to
// judge. It is aimed at the corner entry raised to roughly kart-roof height so
// it sits OVER the track surface rather than buried in it.
//
// ZERO ALLOCATION PER FRAME (hard rule 3): every vector and the output record
// are preallocated in the constructor. update() writes into them and returns the
// same object every time.

import * as THREE from 'three';
import { KART_ROOF_H } from './chasecam.js';

// How far ahead a corner may be and still be worth pointing at. Beyond this the
// arrow is hidden, or it would sit on the horizon for most of a long straight
// and stop meaning "prepare for this".
export const WAYPOINT_MAX_AHEAD = 140;   // m

// Height above the track surface at which the arrow is aimed. Kart-roof height
// keeps it over the deck and clear of the boardwalk plane.
export const WAYPOINT_Y = KART_ROOF_H * 1.15;

export class WaypointArrow {
  /**
   * @param {Course} course  the real course (owns corners() and sampleInto)
   */
  constructor(course) {
    this.course = course;
    this.corners = course.corners();          // built once; the course is static
    this.len = course.length;

    // ---- PREALLOCATED. Nothing below is created per frame. ----
    this._smp = { x: 0, z: 0, heading: 0, curvature: 0, R: 0, segIndex: 0, sLocal: 0 };
    this._world = new THREE.Vector3();
    this._out = { x: 0.5, y: 0.46, visible: false, cornerIndex: -1, distance: 0, R: 0 };
  }

  /**
   * @param {number} playerS  player station along the centreline (m)
   * @param {THREE.Camera} camera  the REAL chase camera, already updated
   * @returns {{x:number,y:number,visible:boolean,cornerIndex:number,distance:number,R:number}}
   *          x,y are NORMALISED 0..1 screen coordinates (what hud.js wants).
   */
  update(playerS, camera) {
    const o = this._out;
    o.visible = false;
    o.cornerIndex = -1;

    const cs = this.corners;
    if (!cs.length) return o;

    // ---- nearest corner ENTRY ahead of the player, wrapping the lap ----
    let best = -1, bestD = Infinity;
    for (let i = 0; i < cs.length; i++) {
      let d = cs[i].s0 - playerS;
      if (d < 0) d += this.len;               // wrap: it is ahead next lap
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > WAYPOINT_MAX_AHEAD) return o;

    const c = cs[best];
    this.course.sampleInto(c.s0, this._smp);
    this._world.set(this._smp.x, WAYPOINT_Y, this._smp.z);

    // ---- project through the REAL camera ----
    // MATRIX FRESHNESS IS LOAD-BEARING. Vector3.project() reads
    // camera.matrixWorldInverse, and THAT is only recomputed inside
    // renderer.render(). This module runs BEFORE sys.render() in the frame (it
    // has to - the HUD is written before the draw), so relying on the renderer
    // would project through LAST frame's camera and the arrow would lag the
    // view by one frame at 103 km/h. chasecam.lookAt() also only writes the
    // quaternion, not the world matrix. So both are refreshed here, in place
    // and without allocating.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    // .project() mutates in place and returns NDC in -1..1.
    this._world.project(camera);
    const ndcX = this._world.x, ndcY = this._world.y, ndcZ = this._world.z;

    // Behind the camera (z outside the clip range) or outside the frame: hide.
    // Hiding rather than clamping is deliberate - an arrow pinned to the screen
    // edge points at nothing and teaches the player the wrong thing.
    if (ndcZ < -1 || ndcZ > 1) return o;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return o;

    o.x = (ndcX + 1) * 0.5;
    o.y = (1 - ndcY) * 0.5;                   // NDC +Y is up; screen +Y is down
    o.visible = true;
    o.cornerIndex = c.index;
    o.distance = bestD;
    o.R = c.R;
    return o;
  }
}
