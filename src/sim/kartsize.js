// =============================================================================
// Harbour Kart - THE SIZING CONTRACT. Single source of truth for kart geometry.
// =============================================================================
//
// STEP REQUIREMENT 6, stated plainly: the kart width 1.10 m used by the visual
// mesh must be the SAME number the track width 6.1 m was reasoned from, and the
// SAME number the collision volume uses. "Three copies of a kart width is how a
// track silently becomes narrower than its spec."
//
// The defect this prevents is specific and it is silent. Suppose the renderer
// authors a chassis 1.20 m wide because it looked better in isolation, while
// config.js still says KART_W = 1.10. Then:
//   - the track is still built 6.1 m wide, reasoned as 5.5 kart widths
//   - but the karts on it are 5.08 kart widths wide
//   - four-abreast racing, which the width was CHOSEN to permit, silently stops
//     fitting, and nothing in the build reports an error
// The track did not change. The spec did not change. The game changed, and no
// probe would see it, because the two numbers live in different files and
// nothing compares them.
//
// So there is exactly ONE place a kart dimension may be written: config.js.
// This module re-exports those values under the names the mesh builder, the
// collision volume and the AI all use, and asserts the identity AT MODULE LOAD.
// Import-time is deliberate: a mismatch cannot reach a probe, a capture or a
// player, because nothing that imports this module can even finish loading.
//
// Everything here is DERIVED. There is not a single new magic number in this
// file - each proportion below is a ratio applied to KART_W / KART_L /
// WHEELBASE, so changing config.js moves the mesh, the collider and the track
// reasoning together, by construction.

import {
  KART_W, KART_L, WHEELBASE, TRACK_W_ROUNDED, TRACK_KART_WIDTHS,
  OVERTAKE_MIN_KARTS, FIELD_SIZE
} from '../core/config.js';

// -----------------------------------------------------------------------------
// THE CANONICAL DIMENSIONS. Re-exported, never redefined.
// -----------------------------------------------------------------------------
export const W = KART_W;              // 1.10 m across the tyres - THE number
export const L = KART_L;              // 1.85 m nose to tail
export const WB = WHEELBASE;          // 1.05 m front axle to rear axle

// -----------------------------------------------------------------------------
// DERIVED MESH PROPORTIONS. All ratios of W / L / WB. INSPECTED proportions
// (they come from looking at the reference frame's open-wheel buggy), but they
// are expressed as ratios so they cannot drift away from the canonical size.
// -----------------------------------------------------------------------------

// Wheels. An open-wheel kart's tyres sit OUTSIDE the chassis, and the overall
// width W is measured across them - so the chassis body must be narrower than W
// by two tyre widths, not equal to it. Getting this backwards is what makes a
// kart look like a shoebox with wheels buried in it.
export const TYRE_W_FRONT = 0.135 * W;      // 0.1485 m
export const TYRE_W_REAR  = 0.175 * W;      // 0.1925 m - rears are wider, as in
                                            // the reference frame
export const TYRE_R_FRONT = 0.125 * L;      // 0.23125 m radius
export const TYRE_R_REAR  = 0.145 * L;      // 0.26825 m - bigger rears

// Track (axle width) measured hub-to-hub. The OUTER edge of the widest tyre
// must land exactly at W/2, so:  hubHalf + tyreW/2 = W/2
export const HUB_HALF_REAR  = W / 2 - TYRE_W_REAR / 2;    // 0.45375 m
export const HUB_HALF_FRONT = W / 2 - TYRE_W_FRONT / 2;   // 0.47575 m

// Chassis body. Sits inboard of the tyres.
export const BODY_W = W - 2 * TYRE_W_REAR - 0.02 * W;     // 0.6930 m
export const BODY_L = 0.86 * L;                            // 1.591 m
export const BODY_H = 0.115 * L;                           // 0.21275 m
export const BODY_Y = TYRE_R_REAR * 0.42;                  // floor pan height

// Axle longitudinal positions, measured from the CG (which sits between them at
// the mass split config.js declares). Front is -Z (forward), rear is +Z.
export const AXLE_Z_FRONT = -WB * 0.55;    // -0.5775 m == -CG_TO_FRONT
export const AXLE_Z_REAR  = +WB * 0.45;    // +0.4725 m == +CG_TO_REAR

// Driver. Low-detail seated figure: at chase-camera distance only the helmet and
// shoulders read, so no rig is spent on it (step instruction 1).
export const SEAT_Z = 0.10 * L;             // 0.185 m behind CG
export const SEAT_Y = BODY_Y + BODY_H;
export const TORSO_H = 0.26 * L;            // 0.481 m
export const SHOULDER_W = 0.42 * W;         // 0.462 m
export const HELMET_R = 0.115 * L;          // 0.21275 m

// Pennant flag at the rear, as in the reference frame.
export const FLAG_Z = 0.46 * L;             // 0.851 m behind CG
export const FLAG_H = 0.55 * L;             // 1.0175 m mast height
export const FLAG_W = 0.20 * L;             // 0.37 m

// Exhaust socket, rear-left.
export const EXHAUST_Z = 0.40 * L;
export const EXHAUST_X = -0.28 * W;

// -----------------------------------------------------------------------------
// COLLISION VOLUME. The same W and L - not a second, "tuned" pair.
//
// Hard rule 10 in reverse: the silhouette the player reads must not be TIGHTER
// than the volume that blocks them, and equally the collider must not be wider
// than the kart they see, or they will be stopped by nothing. So the collider is
// exactly the visual footprint, expressed as a capsule along the kart's long
// axis (a capsule, not a box, because box-vs-box at 28 m/s produces corner
// snagging that reads as the track grabbing the player).
// -----------------------------------------------------------------------------
export const COLLIDER_R = W / 2;                       // 0.55 m
export const COLLIDER_HALF_LEN = L / 2 - COLLIDER_R;   // 0.375 m spine half-length

// -----------------------------------------------------------------------------
// STARTING GRID SPACING. Derived from L, for the same reason everything else
// here is: a grid authored in bare metres silently stacks the field when the
// kart length changes.
//
// DEFECT THIS FIXES (found by tools/_diag_frame.mjs, not by eye): race.js
// declared GRID_ROW_GAP = 2.1 with the comment "kart lengths between rows", but
// consumed it directly as METRES. With L = 1.85 m that is a 2.1 m row pitch for
// a 1.85 m kart - 0.25 m of clear air nose-to-tail. The field started
// interpenetrating, and at t = 2.208 s the projection probe found the Crimson
// rival 0.98 m from the camera while the player's own kart was 3.09 m away: a
// rival rendering NEARER than the player it was supposed to be racing.
//
// Real karting grids run about 2 kart lengths of pitch, giving roughly one clear
// kart length of gap. Expressed as a ratio of L so it cannot desynchronise.
//
// DECLARED ABOVE assertSizing() DELIBERATELY: check 6 reads GRID_ROW_GAP_M, and
// a `const` declared after the call site is in its temporal dead zone, which
// threw "Cannot access before initialization" at module load.
export const GRID_ROW_PITCH_L = 2.15;               // in KART LENGTHS
export const GRID_ROW_GAP_M = GRID_ROW_PITCH_L * L; // 3.9775 m
export const GRID_FIRST_ROW_BACK_M = 1.35 * L;      // 2.4975 m behind the line
export const GRID_COL_OFFSET = 0.62;                // fraction of half-width

// -----------------------------------------------------------------------------
// IMPORT-TIME ASSERTIONS. These run once, on load, and throw.
// -----------------------------------------------------------------------------
function assertSizing() {
  const errs = [];

  // 1. The track width really is the declared multiple of THIS kart width.
  const impliedWidths = TRACK_W_ROUNDED / W;
  if (!(impliedWidths >= OVERTAKE_MIN_KARTS)) {
    errs.push('track width ' + TRACK_W_ROUNDED + ' m is only ' +
      impliedWidths.toFixed(3) + ' kart widths, below the ' + OVERTAKE_MIN_KARTS +
      ' floor at which side-by-side racing stops existing');
  }
  // The authored 6.1 m must not have drifted from KART_W * TRACK_KART_WIDTHS by
  // more than the rounding that produced it (6.05 -> 6.1 is 0.05 m).
  const reasoned = W * TRACK_KART_WIDTHS;
  if (Math.abs(TRACK_W_ROUNDED - reasoned) > 0.0500001) {
    errs.push('authored track width ' + TRACK_W_ROUNDED +
      ' m is more than a rounding step from the reasoned ' + reasoned.toFixed(4) +
      ' m (= KART_W ' + W + ' x ' + TRACK_KART_WIDTHS + ')');
  }

  // 2. The mesh really is W wide across the tyres. This is the assertion that
  //    catches a renderer author widening the chassis "because it looked right".
  const meshWidthRear = 2 * (HUB_HALF_REAR + TYRE_W_REAR / 2);
  const meshWidthFront = 2 * (HUB_HALF_FRONT + TYRE_W_FRONT / 2);
  if (Math.abs(meshWidthRear - W) > 1e-9) {
    errs.push('rear mesh width ' + meshWidthRear.toFixed(9) + ' != KART_W ' + W);
  }
  if (Math.abs(meshWidthFront - W) > 1e-9) {
    errs.push('front mesh width ' + meshWidthFront.toFixed(9) + ' != KART_W ' + W);
  }

  // 3. The collider really is the same footprint.
  const colliderWidth = 2 * COLLIDER_R;
  const colliderLength = 2 * (COLLIDER_HALF_LEN + COLLIDER_R);
  if (Math.abs(colliderWidth - W) > 1e-9) {
    errs.push('collider width ' + colliderWidth + ' != KART_W ' + W);
  }
  if (Math.abs(colliderLength - L) > 1e-9) {
    errs.push('collider length ' + colliderLength + ' != KART_L ' + L);
  }

  // 4. The chassis body must be strictly inside the tyres, or it is not an
  //    open-wheel kart - it is a box, and the reference frame shows exposed
  //    wheels.
  if (!(BODY_W < W - 2 * TYRE_W_REAR + 1e-9)) {
    errs.push('body width ' + BODY_W.toFixed(4) +
      ' m does not leave the rear tyres exposed');
  }

  // 5. Axle spacing must equal the wheelbase the physics integrates against. If
  //    the visual wheels sit at a different spacing than CG_TO_FRONT/REAR, the
  //    wheels will not track the yaw the sim produces.
  const meshWB = AXLE_Z_REAR - AXLE_Z_FRONT;
  if (Math.abs(meshWB - WB) > 1e-9) {
    errs.push('mesh wheelbase ' + meshWB.toFixed(9) + ' != WHEELBASE ' + WB);
  }

  // 6. The starting grid must leave real clear air between rows. A grid pitch
  //    below one kart length means the field is authored interpenetrating, and
  //    the first frames of every race are karts inside each other.
  const clearAir = GRID_ROW_GAP_M - L;
  if (!(clearAir >= 0.75 * L)) {
    errs.push('grid row pitch ' + GRID_ROW_GAP_M.toFixed(4) + ' m leaves only ' +
      clearAir.toFixed(4) + ' m nose-to-tail for a ' + L +
      ' m kart (need >= ' + (0.75 * L).toFixed(4) + ' m)');
  }

  if (errs.length) {
    throw new Error('kartsize.js SIZING CONTRACT VIOLATED:\n  - ' + errs.join('\n  - '));
  }
}
assertSizing();

// Exposed so the gate can re-run the identity externally rather than trusting
// that the import-time assertion ran.
export function sizingReport() {
  return {
    kartW: W, kartL: L, wheelbase: WB,
    trackW: TRACK_W_ROUNDED,
    trackKartWidths: TRACK_W_ROUNDED / W,
    reasonedTrackW: W * TRACK_KART_WIDTHS,
    meshWidthRear: 2 * (HUB_HALF_REAR + TYRE_W_REAR / 2),
    meshWidthFront: 2 * (HUB_HALF_FRONT + TYRE_W_FRONT / 2),
    colliderWidth: 2 * COLLIDER_R,
    colliderLength: 2 * (COLLIDER_HALF_LEN + COLLIDER_R),
    meshWheelbase: AXLE_Z_REAR - AXLE_Z_FRONT,
    bodyWidth: BODY_W,
    fieldSize: FIELD_SIZE,
    // Four abreast is what 5.5 kart widths was chosen to permit. Report it so
    // the claim is checkable rather than asserted.
    abreastCapacity: Math.floor(TRACK_W_ROUNDED / W)
  };
}

// (STARTING GRID SPACING is declared ABOVE assertSizing, not here - see the
// GRID_ROW_PITCH_L block. It was originally written at the bottom of this file
// and check 6 read it through a temporal dead zone, throwing at import.)
// -----------------------------------------------------------------------------
// _MOVED_GRID_BLOCK_PLACEHOLDER_

// Rolling radius the WHEEL SPIN RATE must be computed from. Exported here
// because "a wheel spinning at the wrong rate is the cheapest possible tell that
// the physics is fake" (step instruction 1) - so the rate must come from the
// same radius the mesh is built at, not from a separate constant.
export const ROLL_R_REAR = TYRE_R_REAR;
export const ROLL_R_FRONT = TYRE_R_FRONT;
