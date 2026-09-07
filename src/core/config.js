// =============================================================================
// Harbour Kart - simulation constants. ALL SI: metres, seconds, kilograms.
// =============================================================================
//
// GENRE CORRECTION IS IN FORCE (docs/GENRE_CORRECTION.md).
//
// This file was previously authored in PIXELS, converted through PPU = 50,
// because the project began as a 3D re-skin of a 2D flap game. That is RETIRED.
// PPU is gone. GAP_H, PIPE_W, PIPE_PERIOD, FLAP_V, GRAVITY, MAX_FALL, CEIL_Y,
// SAWTOOTH, BIRD_HIT_H, SCROLL_V and every other flap constant are gone. A racer
// is authored in METRES against real physics; it is never converted from a canvas
// resolution. There is no bird, no flap, no pipe and no gap in this file.
//
// EVERY constant below carries its derivation in a comment. A number without
// visible arithmetic is a number nobody can check, and an unchecked number is
// exactly how a difficulty surface gets CHOSEN by eye instead of DERIVED.
//
// PROVENANCE - three tiers, NOT interchangeable. Section 14 restates them:
//   MEASURED  read off the reference frame by a probe that passed its own
//             self-check. Exactly one kinematic quantity qualifies: V_TOP.
//   DERIVED   computed from a MEASURED anchor, arithmetic visible here and
//             INDEPENDENTLY re-derived in tools/vehgate.mjs.
//   INSPECTED judged by eye from the frame, or a stated design decision.
//             TRACK_W is the one to watch: three probes failed to measure it
//             and all three are discarded, so it must NEVER be quoted as
//             measured.
//
// The upstream derivation with its own 8 self-checks is tools/kartderive.mjs
// (exit 0). tools/vehgate.mjs re-derives these values from the anchors instead
// of importing them, so a typo here cannot agree with a matching typo there.

// -----------------------------------------------------------------------------
// 0. UNIVERSAL
// -----------------------------------------------------------------------------

export const G = 9.81;                          // m/s^2, standard gravity

export const kmh2ms = (kmh) => kmh / 3.6;
export const ms2kmh = (ms) => ms * 3.6;

// -----------------------------------------------------------------------------
// 1. THE LOOP CONTRACT - UNCHANGED FROM S1, DELIBERATELY
// -----------------------------------------------------------------------------
// S1 proved byte-identical state after 600 frames on the same seed with exactly
// these three numbers, and the loop contract is genre-independent: it is about
// integration stability, not about what is being integrated.

export const DT = 1 / 120;        // s. Fixed sim step. 120 Hz, not 60, because a
                                  // tyre model integrated at 60 Hz visibly shifts
                                  // its own grip limit with step size - and the
                                  // whole difficulty contract hangs off the grip
                                  // limit. Verified in the gate (check S3).
export const MAX_SUBSTEPS = 5;    // 5 * DT = 41.67 ms of sim per frame; past that
                                  // we drop time rather than spiral.
export const MAX_DELTA = 0.25;    // s. Delta clamp after a visibility pause.
                                  // 0.25 / DT = 30 steps requested against a cap
                                  // of 5, so the clamp is what stops a resumed
                                  // frame from blowing the cap.

// -----------------------------------------------------------------------------
// 2. ANCHOR - THE ONLY MEASURED KINEMATIC NUMBER
// -----------------------------------------------------------------------------
// The reference frame's in-game speedometer reads "103 KM/H". That is the single
// hard kinematic fact the screenshot yields. Everything kinematic below descends
// from it.
//
// The HUD LAYOUT was also measured (position/lap/timer boxes) but that is a UI
// concern and belongs to the S5 HUD spec, not here. The speedometer's own BOX was
// INSPECTED as bottom-right, not measured: it is warm-tinted and never cleared the
// 0.86 luminance threshold refhud.py uses.

export const V_TOP_KMH = 103;                   // MEASURED off the reference HUD
export const V_TOP = kmh2ms(V_TOP_KMH);         // 103 / 3.6 = 28.611111... m/s

// -----------------------------------------------------------------------------
// 3. GRIP AND BRAKING - the physical envelope
// -----------------------------------------------------------------------------

// Lateral friction coefficient. INSPECTED design decision: 1.35 sits above a real
// road tyre (~0.9-1.1) and below a hot slick (~1.6). Arcade karts should feel
// planted and the reference art is "stylized arcade", not a simulator. This single
// number sets how tight a corner can be at a given speed, so it is stated once
// here and never re-typed anywhere else in the codebase.
export const MU_LAT = 1.35;

// Longitudinal friction under power. Deliberately BELOW lateral, so an arcade kart
// loses drive before it loses cornering and a mistake reads as "spun the wheels"
// rather than "understeered into the water".
export const MU_LONG = 1.20;

// Braking deceleration, 1.10 g. Above pure friction (which would be MU_LONG * g)
// because a kart brakes on all four wheels with forward weight transfer, and
// because arcade braking that cannot beat arcade grip feels broken.
export const A_BRAKE_G = 1.10;                  // in g
export const A_BRAKE = A_BRAKE_G * G;           // 1.10 * 9.81 = 10.791 m/s^2

// Human reaction slack. THE ONE CONSTANT THAT SURVIVES THE GENRE CHANGE, and it
// survives for a principled reason: it is a property of the PLAYER, not of the
// game. The same 0.26 s that sized the flap gap now sizes the sight line. It was
// not re-derived because nothing about the human changed.
export const T_REACT = 0.26;                    // s

// -----------------------------------------------------------------------------
// 4. THE DERIVED DIFFICULTY SPINE
// -----------------------------------------------------------------------------
// This section is the structural equivalent of the old GAP_H block. In the
// one-button flap game the GAP was the entire difficulty surface and was COMPUTED,
// never chosen. In a racer the equivalent single quantity is the SIGHT LINE: the
// distance over which a corner must be visible before its braking point. A corner
// revealed later than that CANNOT be made, and no amount of grip or track-width
// tuning fixes it - the corner is unfair BY CONSTRUCTION.

// FLAT-OUT RADIUS. The boundary between "corner" and "scenery".
//   R_flat = v_top^2 / (mu * g)
//          = 28.611111^2 / (1.35 * 9.81)
//          = 818.5957 / 13.2435
//          = 61.8111 m
// (S1 re-run: the comment previously read 818.7959 / 61.8195 - a hand-typed
//  square, wrong in the 4th digit. The exported VALUE was always computed and
//  was always 61.8111; only the comment lied. tools/archtable.mjs now generates
//  every printed number from the live constants so this cannot recur.)
// At or above this radius the kart holds top speed through the bend, so the bend
// costs the player nothing and teaches nothing. EVERY real corner must be tighter.
export const R_FLAT = (V_TOP * V_TOP) / (MU_LAT * G);

// REACTION DISTANCE. Ground covered before the player has reacted at all.
//   d_react = v_top * t_react = 28.611111 * 0.26 = 7.438889 m
export const D_REACT = V_TOP * T_REACT;

// Per-corner arithmetic, exported as FUNCTIONS rather than a transcribed table so
// a probe can evaluate them at any radius and so the ladder below is genuinely
// computed rather than typed:
//   v_corner = sqrt(mu * g * R)                steady state on the friction circle
//   d_brake  = (v_top^2 - v_corner^2) / (2a)   constant-deceleration kinematics
//   sight    = d_react + d_brake
export const vCorner = (R) => Math.sqrt(MU_LAT * G * R);
export const dBrake = (R) => {
  const vc = vCorner(R);
  return vc >= V_TOP ? 0 : (V_TOP * V_TOP - vc * vc) / (2 * A_BRAKE);
};
export const sightLine = (R) => D_REACT + dBrake(R);

// THE CORNER LADDER. Seven rungs, all strictly inside R_FLAT.
//
// A CHECK THAT FIRED, RECORDED RATHER THAN QUIETLY FIXED: the first draft of this
// ladder ended at R = 62 m. kartderive.mjs check K5 FAILED, because R_FLAT is
// 61.82 m - a 62 m "corner" is taken flat out and is not a corner at all. K7
// confirmed it computed to 103.2 km/h against a 103 km/h top speed: the ARITHMETIC
// was right and the DESIGN was wrong. The top rung moved to 56 m and a NEW check
// K8 was added requiring every rung to need SOME braking. K5 was NOT relaxed. A
// threshold that bends to accommodate bad content is not a check.
export const CORNER_RADII = Object.freeze([12, 16, 20, 26, 34, 45, 56]);

export const LADDER = Object.freeze(CORNER_RADII.map((R) => Object.freeze({
  R,
  vCorner: vCorner(R),
  vCornerKmh: ms2kmh(vCorner(R)),
  dBrake: dBrake(R),
  tBrake: (V_TOP - vCorner(R)) / A_BRAKE,
  sightLine: sightLine(R)
})));

// THE DERIVED CONSTANT - this game's GAP_H.
// The tightest corner needs the longest sight line, so the floor is set by R=12:
//   d_brake(12) = (28.611111^2 - (sqrt(1.35 * 9.81 * 12))^2) / (2 * 10.791)
//               = (818.5957 - 158.9220) / 21.5820
//               = 659.6737 / 21.5820
//               = 30.5659 m
//   SIGHT_LINE_MIN_RAW = 7.438889 + 30.5659 = 38.0048 m
//   -> ROUNDED UP to 39 m.
// Round UP, always. Rounding down removes fairness margin, and the margin is the
// entire point of the number.
export const SIGHT_LINE_MIN_RAW = sightLine(Math.min(...CORNER_RADII));
export const SIGHT_LINE_MIN = Math.ceil(SIGHT_LINE_MIN_RAW);

// -----------------------------------------------------------------------------
// 5. LAP AND TRACK GEOMETRY
// -----------------------------------------------------------------------------
// Target lap TIME drives track LENGTH, not the other way round.

export const LAP_TARGET_S = 60;         // INSPECTED. Arcade laps read well at
                                        // 45-75 s; 60 s is the design centre.
export const LAP_MEAN_FRAC = 0.72;      // INSPECTED. Mean speed as a fraction of
                                        // top speed over a mixed lap. Validated
                                        // downstream: course.js measures the
                                        // achieved lap time of the generated
                                        // track and it must land in band.

//   v_avg   = 28.611111 * 0.72 = 20.6000 m/s = 74.16 km/h
//   LAP_LEN = 20.6000 * 60     = 1236.0 m
export const V_AVG = V_TOP * LAP_MEAN_FRAC;
export const LAP_LEN = V_AVG * LAP_TARGET_S;

export const LAP_COUNT = 3;             // MEASURED-adjacent: the reference HUD
                                        // reads "LAP 1/3".
export const RACE_LEN = LAP_LEN * LAP_COUNT;    // 1236.0 * 3 = 3708 m

export const CHECKPOINTS_PER_LAP = 12;  // INSPECTED. 1236 / 12 = 103 m apart:
                                        // close enough that a respawn never
                                        // rewinds more than about 5 s of driving,
                                        // sparse enough to stay cheap to test.

// KART DIMENSIONS. INSPECTED off the frame (open-wheel arcade buggy proportions).
export const KART_W = 1.10;             // m, track width across the tyres
export const KART_L = 1.85;             // m, nose to tail

// TRACK WIDTH - INSPECTED, NOT MEASURED. THIS MATTERS.
// Three separate probes tried to measure road width off the reference frame and
// ALL THREE FAILED, for reasons that are structural rather than tunable:
//   reftrack.py  v1 - classified any warm pixel as boardwalk, so terracotta roofs
//                     and sunlit sandstone were counted as road. Tell: width per
//                     scanline came out NON-MONOTONIC with depth, and a
//                     perspective road must narrow monotonically. Its vanishing
//                     point and its "kart box" are both DISCARDED.
//   reftrack2.py v2 - added a luminance ceiling, correctly rejecting the
//                     architecture, but still demanded a CONTIGUOUS run; karts
//                     and item crates sitting ON the road cut it into fragments.
//                     Two monotonicity violations. DISCARDED.
//   reftrack3.py v3 - gap-tolerant with a coverage floor. Still one violation.
//                     DISCARDED.
// MIN_COVER was NOT loosened to force a pass - that would have blinded a check
// that was working correctly. The frame does not support this measurement, so the
// number below is INSPECTED ("roughly 5-6 kart widths") and must never be
// reported as measured.
export const TRACK_KART_WIDTHS = 5.5;                       // INSPECTED midpoint
export const TRACK_W = KART_W * TRACK_KART_WIDTHS;          // 1.10 * 5.5 = 6.05 m
export const TRACK_W_ROUNDED = 6.1;                         // m, authored value

// Below 3.0 kart widths side-by-side racing stops existing and the field becomes
// a queue. This is the floor the width must clear.
export const OVERTAKE_MIN_KARTS = 3.0;

export const FIELD_SIZE = 6;            // MEASURED-adjacent: the reference HUD
                                        // reads position "4/6", so the field is 6.

// -----------------------------------------------------------------------------
// 6. VEHICLE MASS AND GEOMETRY
// -----------------------------------------------------------------------------

export const MASS = 165;                // kg, kart + driver. INSPECTED: a real
                                        // 125cc shifter kart is ~80 kg dry plus a
                                        // ~75 kg driver.
export const WHEELBASE = 1.05;          // m. INSPECTED from the frame's chassis
                                        // proportions (KART_L 1.85 less nose and
                                        // tail overhang).

// Weight distribution 45 front / 55 rear - engine and driver mass sit behind the
// midpoint on a kart. CG distances follow directly from that split:
//   a (CG to front axle) = WHEELBASE * rear_frac  = 1.05 * 0.55 = 0.5775 m
//   b (CG to rear axle)  = WHEELBASE * front_frac = 1.05 * 0.45 = 0.4725 m
// They cross on purpose: a larger REAR mass fraction puts the CG NEARER the rear
// axle, so the distance to the FRONT axle is the larger of the two.
const FRONT_MASS_FRAC = 0.45;
export const CG_TO_FRONT = WHEELBASE * (1 - FRONT_MASS_FRAC);   // 0.5775 m
export const CG_TO_REAR = WHEELBASE * FRONT_MASS_FRAC;          // 0.4725 m

// Static axle loads, N:
//   Fz_front = m * g * front_frac = 165 * 9.81 * 0.45 = 728.42 N
//   Fz_rear  = m * g * rear_frac  = 165 * 9.81 * 0.55 = 890.29 N
export const FZ_FRONT = MASS * G * FRONT_MASS_FRAC;
export const FZ_REAR = MASS * G * (1 - FRONT_MASS_FRAC);

// Yaw inertia, uniform-rectangle approximation about the vertical axis:
//   I_zz = m * (L^2 + W^2) / 12
//        = 165 * (1.85^2 + 1.10^2) / 12
//        = 165 * (3.4225 + 1.21) / 12
//        = 165 * 4.6325 / 12 = 63.697 kg*m^2
export const I_ZZ = MASS * (KART_L * KART_L + KART_W * KART_W) / 12;

// -----------------------------------------------------------------------------
// 7. LONGITUDINAL MODEL
// -----------------------------------------------------------------------------
// Top speed must EMERGE from power against resistance, never be clamped. A clamp
// gives a kart that accelerates identically at 20 and at 100 km/h and then hits a
// wall - which reads as broken, and worse, corrupts the braking model that
// SIGHT_LINE_MIN depends on.

export const AIR_RHO = 1.225;           // kg/m^3, sea-level air
export const CD_A = 0.70;               // m^2 drag area (Cd ~0.8 x A ~0.9 m^2).
                                        // INSPECTED: an open kart with an upright
                                        // driver is very nearly a flat plate.
export const C_RR = 0.015;              // rolling resistance coefficient

// ENGINE POWER is DERIVED, not chosen: it is exactly the power required to hold
// V_TOP against drag plus rolling resistance, so V_TOP falls OUT of the physics
// rather than being imposed on it.
//   F_drag(v_top) = 0.5 * rho * CdA * v^2
//                 = 0.5 * 1.225 * 0.70 * 818.5957 = 350.973 N
//   F_roll        = C_rr * m * g = 0.015 * 165 * 9.81 = 24.280 N
//   F_total       = 375.253 N
//   P             = F * v = 375.253 * 28.611111 = 10736.40 W  (about 14.4 hp)
// (S1 re-run: this comment inherited the 818.7959 typo and read 10739.9 W; the
//  exported value was always 10736.40 W. Generated tables now own the digits.)
// A real 125cc shifter kart makes roughly 30 hp, so this is comfortably
// conservative - correct, because CD_A is a deliberate over-estimate for an open
// kart with an upright driver.
const F_DRAG_TOP = 0.5 * AIR_RHO * CD_A * V_TOP * V_TOP;
const F_ROLL = C_RR * MASS * G;
export const ENGINE_POWER = (F_DRAG_TOP + F_ROLL) * V_TOP;      // W

// Below this speed a constant-power curve (F = P/v) divides by nearly zero and
// produces an infinite launch force, so traction is capped by the friction limit
// instead.
//
// A DEFECT THAT THE SIM CAUGHT, RECORDED RATHER THAN QUIETLY FIXED.
// The first draft wrote this cap as the WHOLE-VEHICLE friction limit:
//   F_traction_max = mu_long * m * g = 1.20 * 165 * 9.81 = 1942.38 N     WRONG
// A kart is rear-drive on a live axle. All of the drive force is delivered at the
// REAR axle, which only carries 55% of the mass:
//   rear longitudinal capacity = mu_long * Fz_rear = 1.20 * 890.29 = 1068.31 N
// So the draft demanded 1942 / 1068 = 1.82x what the driven axle could actually
// supply. Inside vehicle.js the friction ellipse clamps that ratio to 1, and
//   cap_lat = mu * Fz * sqrt(1 - 1^2) = 0
// meant the rear axle produced ZERO lateral force under throttle. Every
// full-throttle corner was a spin, and the S2 gate measured cornering speeds of
// 7.2 km/h against a derived 45-98 km/h.
//
// This is exactly hard rule 8 running the other way: the probe was RIGHT, the
// code was wrong, and the diagnostic that proved it (tools/_diag_skidpad.mjs,
// open-loop, no controller) reported utilR = 0.000 at 38 deg of sideslip. The
// fix is the physics - drive traction is limited by the DRIVEN AXLE - not a
// loosened tolerance.
// DRIVE_TRACTION_FRAC is the second half of the fix. Even at exactly 100% of the
// rear axle's longitudinal capacity the ellipse gives sqrt(1 - 1^2) = 0 lateral
// grip, so a kart at full throttle would still have no cornering force at all.
// Holding drive to 92% of the budget leaves sqrt(1 - 0.92^2) = 0.392 of lateral
// capacity at full throttle - enough to steer under power, still a real cost.
// INSPECTED tuning value; the physical cap it scales is DERIVED.
export const DRIVE_TRACTION_FRAC = 0.92;
export const F_DRIVE_MAX = DRIVE_TRACTION_FRAC * MU_LONG * FZ_REAR;   // 982.84 N
export const V_POWER_REF = ENGINE_POWER / F_DRIVE_MAX;  // 10736.4 / 982.84 = 10.92 m/s

// The rear axle's absolute longitudinal capacity, used by the friction ellipse.
export const F_REAR_LONG_CAP = MU_LONG * FZ_REAR;       // 1068.31 N

// Braking force from the derived deceleration:
//   F_brake = m * a_brake = 165 * 10.791 = 1780.5 N
export const F_BRAKE_MAX = MASS * A_BRAKE;

// -----------------------------------------------------------------------------
// 8. TYRE MODEL - Pacejka-style magic formula, lateral
// -----------------------------------------------------------------------------
// THIS IS NOT DECORATION. The brief is explicit: a "turn the mesh and translate
// forward" kinematic cheat cannot produce a grip LIMIT, and SIGHT_LINE_MIN is
// derived FROM the grip limit. With a cheat the entire difficulty contract becomes
// decorative - the numbers would still print, but nothing in the game would obey
// them.
//
//   Fy = Fz * mu * sin( C * atan( B*a - E*(B*a - atan(B*a)) ) )
//
// Coefficients are chosen so the curve PEAKS at a physically plausible slip angle.
// B = 9.5 (1/rad) puts the peak near 9.5 deg, right for a kart tyre. The gate
// probes the peak location directly (check T1) rather than trusting the comment.
export const TYRE_B = 9.5;              // stiffness factor, 1/rad
export const TYRE_C = 1.45;             // shape factor (>1 gives peak then falloff)
export const TYRE_E = -0.11;            // curvature factor
export const TYRE_ALPHA_PEAK = 9.5 * Math.PI / 180;     // rad, expected peak

// Below this speed slip angle is numerically meaningless (atan of ~0/0), so the
// tyre model is bypassed and the kart is steered kinematically. 0.5 m/s is far
// below any speed at which cornering behaviour is observable.
export const V_SLIP_MIN = 0.5;          // m/s

// Cornering stiffness at zero slip, N/rad - used only for the low-speed kinematic
// blend, and derived from the same curve so it cannot disagree with it:
//   dFy/da |_0 = Fz * mu * B * C = 728.42 * 1.35 * 9.5 * 1.45 = 13544 N/rad
export const CORNERING_STIFFNESS_FRONT = FZ_FRONT * MU_LAT * TYRE_B * TYRE_C;

// -----------------------------------------------------------------------------
// 9. STEERING
// -----------------------------------------------------------------------------
// Max steer angle at the road wheels, sized from the tightest ladder corner via
// the bicycle model so the kart can physically achieve the geometry it is asked
// for:
//   delta = atan(WHEELBASE / R_min) = atan(1.05 / 12) = 0.08727 rad = 5.0 deg
// That is the SUSTAINED angle at the 12 m corner. Peak authority is set well above
// it so slow hairpins, recovery and drift remain possible; the SPEED FALLOFF below
// is what keeps high-speed steering sane.
export const STEER_MAX = 0.52;          // rad (about 30 deg)
export const STEER_RATE = 3.2;          // rad/s, how fast the wheel moves
export const STEER_RETURN = 4.5;        // rad/s, self-centring when released

// Steering authority shrinks with speed or top-speed twitch flips the kart.
//   authority = 1 / (1 + STEER_SPEED_FALLOFF * v)
// At V_TOP: 1 / (1 + 0.075 * 28.611) = 0.318, so 0.52 * 0.318 = 0.165 rad
// (9.5 deg) of usable lock at top speed - comfortably more than the 5.0 deg the
// tightest corner needs, with margin left for correction.
export const STEER_SPEED_FALLOFF = 0.075;   // s/m

// Normal-driving assists: reserve rear grip under power, never add tyre force.
// Explicit drift retains its own steering and traction trade-off.
export const STEER_GRIP_TARGET = 0.82;
export const STEER_SLIP_ALLOWANCE = 0.010; // rad, tyre slip above geometric steer
export const CORNER_POWER_RESERVE = 0.995; // maximum lateral budget reserved
export const KART_RESTITUTION = 0.08;     // soft contact, rather than billiards

// STALL RECOVERY (AI). A kart pressed nose-first into a barrier cannot drive
// forward out of it: the barrier removes the outward velocity component every
// step, and forward IS outward when the heading error is past 90 deg. A human
// reverses. Without this the field silently stalled - MEASURED (S4,
// tools/_s4_fieldhealth.mjs, 90 s, seed 37): 3 of 5 AI stationary under full
// throttle for 42-78 s at heading errors of 96-163 deg against the wall, and the
// S4 gate K18 did not see it because "progressed past s=50 m" is true of a kart
// that stalls at s=120 m. The recovery is a state machine in ai.js and is driven
// by these constants alone. All three INSPECTED; none of them can make a driver
// faster - reversing costs time by construction.
export const AI_STALL_SPEED = 0.6;      // m/s. Below this, under throttle,
                                        // the kart counts as not moving.
export const AI_STALL_TIME = 0.75;      // s of stall before reversing. Longer
                                        // than a hard standing-start launch so a
                                        // clean getaway never triggers it.
export const AI_REVERSE_TIME = 1.4;     // s of reverse before trying forward
                                        // again. At F_DRIVE_MAX this backs the
                                        // kart ~2-3 m off the wall.
export const AI_REVERSE_THROTTLE = 0.7; // reverse pedal, fraction of drive.

// RESPAWN / RECOVERY - applies to EVERY kart including the player.
// The AI stall recovery above only covers a kart that can still reverse out.
// It does NOT cover a kart that is off the drivable surface entirely, or one
// wedged so the reverse manoeuvre never restores forward progress. MEASURED
// (S9, tools/s9/_diag9.mjs, seed 37, ai=1): the player kart came to rest at
// s=1147.4 m and stayed at 0.0 km/h for the remaining 120 s of a 200 s run -
// station identical to 1 dp across six 20 s samples. The race finished around
// it. `offTrack` was computed on every step and the `respawn` event was
// declared in the bus vocabulary, but NOTHING EVER EMITTED IT: there was no
// recovery system at all. A racer that can permanently strand the player is
// not shippable, so recovery is authored here as a real system.
//
// Progress, not speed, is the trigger. A kart can be moving fast and still be
// making no progress (spinning, or driving the wrong way), and a kart can be
// legitimately near-stationary for a moment in a slow hairpin. Measuring
// ARCLENGTH ADVANCE over a window catches every stranding case and none of the
// legitimate slow ones.
export const RESPAWN_STUCK_TIME = 3.0;      // s of no meaningful progress
                                            // before a respawn. Longer than
                                            // AI_STALL_TIME + AI_REVERSE_TIME
                                            // (2.15 s) so the cheaper reverse
                                            // recovery always gets to try first.
export const RESPAWN_MIN_PROGRESS = 4.0;    // m of arclength that must be
                                            // gained within the window. Below
                                            // V_TOP/7 - a genuinely slow hairpin
                                            // at 45 km/h still covers 37 m.
export const RESPAWN_OFFTRACK_TIME = 2.2;   // s continuously off the drivable
                                            // surface (in the water / on sand)
                                            // before recovery, regardless of
                                            // progress. A wide kerb-hop is far
                                            // shorter than this.
export const RESPAWN_LOST_TIME = 1.5;       // s penalty attributed to the
                                            // player on the results screen.
export const RESPAWN_SPEED = 6.0;           // m/s the kart is re-placed at, so
                                            // recovery is a real cost (down
                                            // from ~28 m/s) but never a full
                                            // standing restart.

// RACE TERMINATION GRACE. The race ends when the PLAYER crosses the line, not
// when the first AI does (S9 measured the defect: an unfiltered race.finish
// handler sent the player to RESULTS on lap 3 at s=1113.1 m, 123 m short of
// their own finish). That rule alone is not TOTAL - a player who never finishes
// would never see a results screen - so once every rival has finished, the
// player gets this long to complete their lap before the race is classified
// anyway. Chosen as ~half a lap at the 20.6 m/s mean pace (1236.2/2/20.6 = 30 s)
// so a player merely having a bad final lap is never cut off.
export const LAST_MAN_GRACE_S = 30.0;       // s after the last rival finishes

// -----------------------------------------------------------------------------
// 10. DRIFT - A RESOURCE, NOT A SPEED CHEAT
// -----------------------------------------------------------------------------
// The brief is explicit: drift must have STARTUP, SUSTAIN and PAYOFF, and it must
// not invalidate the braking model. Two rules make that true, both enforced in
// vehicle.js and both probed by the gate:
//   (a) drifting REDUCES rear grip, so it COSTS cornering speed while active. It
//       is a trade, not a free upgrade.
//   (b) the boost NEVER applies while the brake is held. Otherwise it corrupts
//       stopping distance and SIGHT_LINE_MIN silently stops being true.
// Rule (b) is not hypothetical - see the defect log in docs/S2_REPORT.md.

export const DRIFT_MIN_SPEED = 8.0;         // m/s. Below this a drift is a spin.
export const DRIFT_STARTUP = 0.18;          // s of held input before charge starts
export const DRIFT_MIN_STEER_FRAC = 0.35;   // fraction of the steering authority
                                            // AVAILABLE AT THE CURRENT SPEED - not
                                            // an absolute angle. An absolute angle
                                            // above 0.165 rad can never be reached
                                            // at top speed, which would make drift
                                            // silently dead exactly where a player
                                            // most wants it.
// SUSTAIN threshold, DISTINCT from the entry threshold above. This is a real
// design defect found by tools/_diag_counter.mjs, not a tuning preference:
// a drift is ENTERED by turning in hard, but it is HELD by COUNTER-STEERING
// against the slide. With a single threshold, the moment the player counter-
// steers - which is the correct and necessary input - steer drops below the
// entry gate and the drift instantly disqualifies. Measured: a counter-steered
// drift survived 0.042 s, while every FIXED-steer drift spun the kart to a
// sideslip of ~1.2 rad (about 70 deg) and died at 0.708-0.792 s of charge,
// just short of DRIFT_TIER_1 = 0.85 s. So tier 1 was UNREACHABLE BY ANY INPUT:
// hold the wheel and you spin before earning it, correct the slide and you
// lose the drift. The fix is to require commitment to ENTER and only an
// ongoing slide to SUSTAIN. DRIFT_TIER_1 was NOT lowered to make this pass -
// that would have hidden an unreachable mechanic behind a friendlier number.
// A DISCARDED CRITERION, RECORDED NOT HIDDEN.
// The first fix used sideslip as the proof that the rear was sliding:
// "sustain while beta >= DRIFT_SUSTAIN_MIN_BETA (0.12 rad)". tools/_diag_beta.mjs
// measured that assumption and DEMOLISHED it - a purely GRIPPING skidpad at the
// limit carries beta 0.1130 (R=12), 0.1425 (R=20) and 0.1948 (R=34), all at or
// ABOVE the 0.12 floor. So the test could not tell a drift from ordinary hard
// cornering, and any floor above the gripping peak (0.1948) would sit above the
// slip a counter-steered drift actually holds. Sideslip is NOT a usable
// discriminator on this vehicle. The criterion is deleted rather than retuned:
// nudging 0.12 until the probe passed would have shipped a test that fires on
// normal cornering.
// What survives is the part that measurement supports: a LOWER steering
// threshold to HOLD a slide than to ENTER one, which is what lets the player
// counter-steer without instantly disqualifying.
// THE SUSTAIN GATE IS MEASURED ON REAR-TYRE SATURATION, NOT ON STEERING.
// Steering angle is the WRONG variable to hold a drift open: a counter-steer
// necessarily takes the steering angle THROUGH ZERO as it reverses, so any
// |steerAngle|/authority threshold fires on precisely the input that saves the
// car. tools/_diag_authority.mjs proved it - counter-steer arrests the slide
// (beta stops at 0.09 instead of 0.92) but the drift ended after 0.050 s at the
// steer gate.
// The quantity that actually separates the two states is how far the REAR tyre
// is past its peak slip angle. Measured with tools/_diag_gatevar.mjs:
//     gripping hard corners peak at rearSat 0.801 / 0.879 / 1.099 / 0.605
//     a counter-steered drift runs 1.45 -> 2.17 -> 3.01 -> 3.98 and climbing
// Max gripping saturation is 1.099, so the threshold is set at 1.25 - above
// every measured gripping value with margin, far below the 1.45+ a real drift
// holds. Derived from measurement, not chosen by eye.
export const DRIFT_SUSTAIN_REAR_SAT = 1.25;    // |alphaR| / ALPHA_PEAK to HOLD
export const DRIFT_SUSTAIN_STEER_FRAC = 0.10;  // fallback fraction of authority
export const DRIFT_SPIN_BETA = 0.90;           // rad. Past this the kart is no
                                               // longer drifting, it is spinning:
                                               // the slide is lost, charge is
                                               // forfeit. This is the risk half
                                               // of the resource. Sits well above
                                               // the 0.1948 rad maximum a
                                               // gripping kart was measured to
                                               // carry, so it cannot fire during
                                               // ordinary cornering.
export const DRIFT_REAR_GRIP = 0.72;        // rear grip multiplier while sliding
export const DRIFT_CHARGE_RATE = 1.0;       // charge units per second
// TIER THRESHOLDS ARE DERIVED FROM THE MEASURED DRIFT DURATION, NOT CHOSEN.
// The original 0.85 / 1.70 s were picked by eye and were UNREACHABLE: the kart
// physically cannot hold a slide that long. tools/_diag_window.mjs swept 18
// entry moments x 15 controller gain/target combinations and the maximum charge
// achieved by ANY of them was 0.600 s - every run ended either with the slide
// collapsing (beta under 0.21, "gate lost") or the kart spinning past
// DRIFT_SPIN_BETA in ~0.59 s. A tier priced above the mechanic's physical
// duration is not "hard to reach", it is dead content: the player pays the
// rear-grip cost every time and can never be paid.
// -----------------------------------------------------------------------------
// S9 CORRECTION - THE CEILING ABOVE WAS WRONG AND THE TIERS WERE DEAD CONTENT.
// -----------------------------------------------------------------------------
// The paragraph above cites tools/_diag_window.mjs for a 0.600 s ceiling. THAT
// FILE DOES NOT EXIST IN THIS REPO, so the number was unreproducible. S9 found
// the QA drift case failing at charge 0.392 vs TIER_1 0.40 - an 8 ms near-miss,
// the exact signature of the "unreachable by any input" defect this very section
// warns about. Four probes re-measured it against the REAL shipping page:
//   tools/s9/_driftreach.mjs    keyboard, 3 strategies      -> max charge 0.383
//   tools/s9/_driftsweep2.mjs   analog touch, 6 magnitudes  -> max charge 0.350
//   tools/s9/_driftinstr.mjs    instrumented; counter-steer PROVEN to reach the
//                               rack (steerAngle +0.1935 -> -0.2659)
//                               -> still spun, charge forfeit at 0.292
//   tools/s9/_driftceiling.mjs  12 runs, 3 stations x 4 counter-steer profiles
//                               incl. proportional beta-feedback
//                               -> CEILING 0.358 s, 0 of 12 runs paid a boost
// Mechanism (measured, not inferred): charge accrues at DRIFT_CHARGE_RATE 1.0/s
// while sideslip climbs monotonically; beta crosses DRIFT_SPIN_BETA 0.90 at
// charge ~0.358, so the slide is ALWAYS lost before 0.40. The player paid the
// DRIFT_REAR_GRIP 0.72 cost on every drift and could never be paid.
//
// FIX: the tiers are re-derived from the MEASURED ceiling 0.358 s, preserving
// the design ratios this section already chose against its own claimed ceiling
// (0.40/0.60 = 0.667, 0.55/0.60 = 0.917, cap 0.65/0.60 = 1.083):
//   TIER_1 = 0.358 * 0.667 = 0.24   comfortably inside the sustainable slide
//   TIER_2 = 0.358 * 0.917 = 0.33   demands nearly the full slide, still a real
//                                   risk against DRIFT_SPIN_BETA (unchanged)
//   CAP    = 0.358 * 1.083 = 0.39   just above the measured maximum, as intended
// DRIFT_SPIN_BETA was NOT relaxed and DRIFT_CHARGE_RATE was NOT inflated - either
// would have made the risk half of the resource free. The content moved to fit
// the measured physics, exactly as check K5 did in the derivation.
export const DRIFT_TIER_1 = 0.24;           // s of sustain for the first tier
export const DRIFT_TIER_2 = 0.33;           // s for the second
export const DRIFT_MAX_CHARGE = 0.39;       // s, charge ceiling
export const DRIFT_BOOST_1_S = 0.45;        // s of boost from tier 1
export const DRIFT_BOOST_2_S = 1.05;        // s from tier 2
// Boost force as a fraction of the DRIVEN-AXLE traction budget (it is delivered
// through the same rear tyres as normal drive, so it cannot be sized off the
// whole vehicle's weight - that was the same defect fixed in section 7):
//   0.55 * 982.84 = 540.6 N, adding 540.6 / 165 = 3.28 m/s^2.
// Enough to be worth the grip you gave up, far too little to out-run the
// 10.791 m/s^2 brake. The gate asserts that inequality directly (check D6)
// rather than trusting this comment.
export const DRIFT_BOOST_FORCE = 0.55 * F_DRIVE_MAX;

// -----------------------------------------------------------------------------
// 11. SURFACES
// -----------------------------------------------------------------------------
// Grip and drag multipliers keyed to the SURFACES enum in bus.js. Leaving the
// boardwalk must COST something measurable, or the track edge is decorative and
// the sight line stops mattering.

export const SURFACE_GRIP = Object.freeze({
  boardwalk: 1.00,      // the reference surface - dark brown wooden planks
  kerb: 0.88,           // stone kerb: usable, but it costs you
  sand: 0.55,           // run-off
  grass: 0.62,          // verge
  water: 0.30           // hazard: effectively a respawn
});

export const SURFACE_DRAG = Object.freeze({
  boardwalk: 1.00,
  kerb: 1.15,
  sand: 2.60,
  grass: 2.10,
  water: 4.00
});

export const OFFTRACK_GRIP = SURFACE_GRIP.sand;
export const OFFTRACK_DRAG = SURFACE_DRAG.sand;

// -----------------------------------------------------------------------------
// 12. RENDER / READABILITY  (owned by S3+, declared here so it is single-source)
// -----------------------------------------------------------------------------

// Readability is a GAMEPLAY requirement, not a style note. The measured luminance
// ratio of sky over mid-ground posts in the reference frame is only 1.168 - they
// nearly merge. Beautiful in a photograph; fatal when the thing that nearly
// disappears is the barrier you are about to hit. The track edge and the next
// corner's apex must clear this ratio against whatever is behind them AT
// SIGHT_LINE_MIN, achieved with a value break, kerb striping or aerial
// perspective - NEVER by adding bloom.
export const READABILITY_MIN_RATIO = 2.5;

// The distance at which READABILITY_MIN_RATIO must ALREADY hold. It is the derived
// sight line, not an arbitrary render distance: contrast that only arrives closer
// than this arrives after the braking point, which is too late to be useful.
export const HAZARD_ENTRY_X = SIGHT_LINE_MIN;   // m

// Visible light count is baked into every lit material's program key, so ONE light
// crossing a cull radius recompiles every lit material in the scene. Hold it
// constant and drive intensity to zero instead of toggling visibility.
//
// The count is PER PRESET, not global: src/render/index.js builds one
// DirectionalLight per shadow cascade (cascade 0 carries the sun, the rest sit
// at intensity 0 as shadow-map providers) plus three non-cascade lights - the
// hemisphere fill, the warm sandstone bounce and the rim. So
//   visibleLights = cascades + NON_CASCADE_LIGHTS
// and it changes ONLY on a preset switch, which is a gated re-prewarm event,
// never mid-play. The value is stored on each preset so ARCHITECTURE.md, this
// file and the renderer's own light audit are all gated against ONE number.
export const NON_CASCADE_LIGHTS = 3;            // fill (hemisphere), bounce, rim
export const visibleLightsFor = (cascades) => cascades + NON_CASCADE_LIGHTS;
// Legacy alias: the non-cascade budget. Kept so an older import still resolves.
export const VISIBLE_LIGHT_COUNT = NON_CASCADE_LIGHTS;

// dprCap and anisotropy are READ BY THE RENDERER (src/render/index.js reads
// preset.dprCap, preset.anisotropy, preset.shadowMapSize) and must exist on
// EVERY preset. They were missing after the S2 config rewrite, and the failure
// was silent-then-fatal rather than a thrown error:
//   this.dpr = Math.min(opts.dpr || 1, this.preset.dprCap)  ->  Math.min(1, undefined)
//   = NaN -> renderer.setPixelRatio(NaN) -> setSize writes canvas.width = NaN
//   -> the backing store collapses to 0x0 while the CSS size stays 1280x720px,
//   so the page looks correctly sized and every drawImage throws
//   InvalidStateError: "canvas element with a width or height of 0".
// dprCap exists to bound fill cost: at DPR 3 a 390x844 phone would rasterise
// 2.96 Mpx, 9x the CSS area, which is a GPU-side fps cliff, not a quality win.
export const QUALITY = Object.freeze({
  high: Object.freeze({
    shadowMapSize: 2048, cascades: 3, visibleLights: visibleLightsFor(3), localShadowLights: 1,
    shadowCasterMinSize: 0.95, aoSamples: 16, post: true, maxParticles: 512,
    dprCap: 2, anisotropy: 8
  }),
  medium: Object.freeze({
    shadowMapSize: 1024, cascades: 2, visibleLights: visibleLightsFor(2), localShadowLights: 1,
    shadowCasterMinSize: 1.20, aoSamples: 8, post: true, maxParticles: 256,
    dprCap: 1.5, anisotropy: 4
  }),
  low: Object.freeze({
    shadowMapSize: 512, cascades: 1, visibleLights: visibleLightsFor(1), localShadowLights: 0,
    shadowCasterMinSize: 2.00, aoSamples: 0, post: false, maxParticles: 96,
    dprCap: 1, anisotropy: 1
  })
});
export const DEFAULT_QUALITY = 'high';

// -----------------------------------------------------------------------------
// 13. INVARIANTS - the claims this file makes about itself
// -----------------------------------------------------------------------------
// tools/vehgate.mjs re-derives every one of these from the anchors INDEPENDENTLY
// rather than importing them, so a typo here cannot agree with a matching typo in
// the gate.

export const INVARIANTS = Object.freeze({
  vTopKmh: V_TOP_KMH,
  vTopMs: V_TOP,
  rFlat: R_FLAT,
  dReact: D_REACT,
  sightLineMinRaw: SIGHT_LINE_MIN_RAW,
  sightLineMin: SIGHT_LINE_MIN,
  lapLen: LAP_LEN,
  raceLen: RACE_LEN,
  trackW: TRACK_W_ROUNDED,
  enginePower: ENGINE_POWER,
  // Every ladder rung must be strictly inside R_FLAT (K5) and must require SOME
  // braking (K8).
  ladderInsideRFlat: CORNER_RADII.every((R) => R < R_FLAT),
  ladderAllBrake: CORNER_RADII.every((R) => dBrake(R) > 0)
});

export const PROVENANCE = Object.freeze({
  MEASURED: ['V_TOP_KMH (reference HUD speedometer)', 'LAP_COUNT (HUD "LAP 1/3")',
             'FIELD_SIZE (HUD "4/6")'],
  DERIVED: ['V_TOP', 'R_FLAT', 'D_REACT', 'LADDER', 'SIGHT_LINE_MIN', 'LAP_LEN',
            'RACE_LEN', 'ENGINE_POWER', 'F_DRIVE_MAX', 'F_REAR_LONG_CAP', 'F_BRAKE_MAX', 'I_ZZ',
            'FZ_FRONT', 'FZ_REAR', 'CG_TO_FRONT', 'CG_TO_REAR', 'V_POWER_REF',
            'CORNERING_STIFFNESS_FRONT', 'DRIFT_BOOST_FORCE'],
  INSPECTED: ['MU_LAT', 'MU_LONG', 'A_BRAKE_G', 'TRACK_W (3 probes discarded)',
              'KART_W', 'KART_L', 'MASS', 'WHEELBASE', 'CD_A', 'C_RR',
              'LAP_TARGET_S', 'LAP_MEAN_FRAC', 'all DRIFT_* tuning',
              'all SURFACE_* multipliers', 'TYRE_B/C/E', 'STEER_* tuning'],
  CARRIED: ['T_REACT 0.26 s - a property of the player, not of the genre'],
  RETIRED: ['PPU', 'GAP_H', 'PIPE_W', 'PIPE_PERIOD', 'PIPE_HIT_W', 'PIPE_GAP_X',
            'FLAP_V', 'FLAP_COOLDOWN', 'GRAVITY', 'MAX_FALL', 'CEIL_Y',
            'GROUND_Y', 'SAWTOOTH', 'BIRD_HIT_H', 'SCROLL_V', 'SCORE_PIPE',
            'GAP_CENTER_MIN_Y', 'GAP_CENTER_MAX_Y', 'GAP_MAX_STEP', 'RAMP',
            'NEED', 'PARALLAX', 'EDGE_RIGHT', 'BIRD', 'CHAR_H', 'INPUT_BUFFER']
});
