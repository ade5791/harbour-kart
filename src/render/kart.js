// =============================================================================
// Harbour Kart - PROCEDURAL KART FACTORY. Open-wheel buggy + seated driver.
// =============================================================================
//
// WHY PROCEDURAL AND NOT IMAGE-TO-3D
//
// The asset-strategy rule routes assets by what the project needs to CONTROL.
// Hero characters with authored animation go through the generation pipeline.
// Vehicles do not, and this one especially does not, for four concrete reasons:
//
//   1. SOCKETS. The wheels must be addressable parts that steer and spin at a
//      rate derived from ground speed. A generated mesh returns a fused blob
//      with no wheel transform to drive.
//   2. COLLISION. kartsize.js asserts the mesh footprint IS the collider
//      footprint. A generated mesh has whatever bounds it has, and the sizing
//      contract could not be asserted at all.
//   3. CODE-DRIVEN COLOUR VARIANTS. Six karts, six deterministic liveries, one
//      geometry. Generating six meshes would produce six different silhouettes
//      and six different collision footprints for karts that must be mechanically
//      identical.
//   4. DETERMINISM. Every visual detail is drawn from a named seeded stream so a
//      capture is reproducible. A generated asset is a fixed binary that cannot
//      vary per instance at all.
//
// NAMED PARTS AND STABLE SOCKETS (step requirement 1). Every kart exposes:
//     sockets.wheel_fl / wheel_fr / wheel_rl / wheel_rr
//     sockets.seat, sockets.flag, sockets.exhaust
//     sockets.steer_fl / steer_fr   (steering pivots, PARENTS of the front wheels)
// Sockets are Object3D nodes, dumped from the real hierarchy by name - never
// assumed. The controller drives sockets, never mesh children by index.
//
// ZERO ALLOCATION: build() allocates (it is setup). update() allocates nothing -
// it writes into preallocated transforms only.
//
// GEOMETRY/MATERIAL SHARING: one shared geometry set and one shared material set
// per LIVERY, created once. Six karts do not create six copies of a tyre.

import * as THREE from 'three';
import {
  W, L, WB,
  TYRE_W_FRONT, TYRE_W_REAR, TYRE_R_FRONT, TYRE_R_REAR,
  HUB_HALF_FRONT, HUB_HALF_REAR,
  BODY_W, BODY_L, BODY_H, BODY_Y,
  AXLE_Z_FRONT, AXLE_Z_REAR,
  SEAT_Z, SEAT_Y, TORSO_H, SHOULDER_W, HELMET_R,
  FLAG_Z, FLAG_H, FLAG_W, EXHAUST_Z, EXHAUST_X,
  ROLL_R_FRONT, ROLL_R_REAR
} from '../sim/kartsize.js';
import { hexToLinear } from './palette.js';

// -----------------------------------------------------------------------------
// LIVERIES. Six karts: the reference frame shows the player TEAL in the
// lower-centre foreground with purple, dark-red and green rivals ahead. Those
// three are taken from the frame; the remaining two extend the set with hues
// that stay separable against the harbour's warm sandstone-and-wood background.
//
// Albedos are all inside the physically plausible 0.02-0.9 band, checked by the
// gate rather than asserted here.
// -----------------------------------------------------------------------------
export const LIVERIES = Object.freeze([
  // index 0 is ALWAYS the player. Teal, from the reference frame.
  Object.freeze({ id: 'player', name: 'Teal',    body: '#1f9e96', accent: '#0d5b58', helmet: '#e8e2d4', suit: '#166b66' }),
  Object.freeze({ id: 'ai1',    name: 'Purple',  body: '#6b4a9e', accent: '#3a2760', helmet: '#d8cfc0', suit: '#4a3370' }),
  Object.freeze({ id: 'ai2',    name: 'Crimson', body: '#8e2f2a', accent: '#521a17', helmet: '#e0d6c6', suit: '#6a2320' }),
  Object.freeze({ id: 'ai3',    name: 'Green',   body: '#4a7d33', accent: '#2a481d', helmet: '#dbd2c2', suit: '#375c26' }),
  Object.freeze({ id: 'ai4',    name: 'Ochre',   body: '#b5822c', accent: '#6b4c19', helmet: '#e5dccb', suit: '#87611f' }),
  Object.freeze({ id: 'ai5',    name: 'Slate',   body: '#3d5670', accent: '#22303f', helmet: '#ded5c5', suit: '#2d4053' })
]);

// Rubber and metal. Shared across every kart - tyres are tyres.
const TYRE_ALBEDO = '#2a2724';       // dark rubber, lum ~0.026 - inside 0.02-0.9
const METAL_ALBEDO = '#8a8378';

// -----------------------------------------------------------------------------
// SHARED RESOURCE POOL. Built once, disposed once.
// -----------------------------------------------------------------------------
export class KartResources {
  constructor() {
    this.geo = Object.create(null);
    this.mat = Object.create(null);
    this._built = false;
  }

  build() {
    if (this._built) return this;
    const g = this.geo;

    // --- TYRES. Cylinders laid on their side (rotated about Z at build time so
    // the runtime spin is a clean rotation about the local X axis).
    g.tyreF = new THREE.CylinderGeometry(TYRE_R_FRONT, TYRE_R_FRONT, TYRE_W_FRONT, 16, 1);
    g.tyreR = new THREE.CylinderGeometry(TYRE_R_REAR, TYRE_R_REAR, TYRE_W_REAR, 16, 1);
    g.tyreF.rotateZ(Math.PI / 2);
    g.tyreR.rotateZ(Math.PI / 2);

    // Hub faces, so a spinning wheel READS as spinning. A featureless black
    // cylinder rotating about its own axis is visually identical to a stationary
    // one - the wheel-rate tell only works if the wheel has angular features.
    g.hubF = new THREE.CylinderGeometry(TYRE_R_FRONT * 0.52, TYRE_R_FRONT * 0.52, TYRE_W_FRONT * 1.04, 6, 1);
    g.hubR = new THREE.CylinderGeometry(TYRE_R_REAR * 0.52, TYRE_R_REAR * 0.52, TYRE_W_REAR * 1.04, 6, 1);
    g.hubF.rotateZ(Math.PI / 2);
    g.hubR.rotateZ(Math.PI / 2);

    // --- CHASSIS. A floor pan, a tapered nose cone, and two side pods. Rounded
    // and slightly exaggerated, per the stylized-arcade direction - not a box.
    g.pan = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_L);
    g.nose = new THREE.ConeGeometry(BODY_W * 0.46, L * 0.30, 4, 1);
    g.nose.rotateX(-Math.PI / 2);
    g.nose.rotateY(Math.PI / 4);
    g.pod = new THREE.BoxGeometry(W * 0.13, BODY_H * 0.95, BODY_L * 0.46);
    // Roll hoop behind the driver.
    g.hoop = new THREE.TorusGeometry(SHOULDER_W * 0.62, W * 0.026, 6, 14, Math.PI);

    // --- DRIVER. Low detail on purpose: at chase distance only helmet and
    // shoulders read, so no rig is spent (step instruction 1).
    g.torso = new THREE.CapsuleGeometry(SHOULDER_W * 0.44, TORSO_H * 0.52, 4, 8);
    g.helmet = new THREE.SphereGeometry(HELMET_R, 14, 10);
    g.visor = new THREE.SphereGeometry(HELMET_R * 1.005, 12, 8,
      Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.34, Math.PI * 0.34);
    g.arm = new THREE.CapsuleGeometry(W * 0.055, TORSO_H * 0.30, 3, 6);
    g.wheelRim = new THREE.TorusGeometry(W * 0.115, W * 0.020, 5, 12);

    // --- FLAG. Mast plus pennant, as in the reference frame.
    g.mast = new THREE.CylinderGeometry(W * 0.012, W * 0.014, FLAG_H, 5, 1);
    g.pennant = new THREE.PlaneGeometry(FLAG_W, FLAG_W * 0.42);

    // --- EXHAUST.
    g.exhaust = new THREE.CylinderGeometry(W * 0.032, W * 0.036, L * 0.30, 7, 1);

    // --- CONTACT SHADOW. One quad per wheel. Step requirement 5: without these
    // the kart floats. A blob shadow is used rather than relying on the shadow
    // map alone because at 28 m/s the cascade nearest the camera still cannot
    // resolve a crisp contact under a 0.23 m tyre, and "floating" is exactly the
    // artefact the reference direction calls out.
    g.shadow = new THREE.PlaneGeometry(1, 1);
    g.shadow.rotateX(-Math.PI / 2);

    // Materials that do not vary by livery.
    this.mat.tyre = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...hexToLinear(TYRE_ALBEDO)),
      roughness: 0.92, metalness: 0.0
    });
    this.mat.metal = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...hexToLinear(METAL_ALBEDO)),
      roughness: 0.42, metalness: 1.0     // metal is 0 or 1, never in between
    });
    this.mat.visor = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.05, 0.06, 0.07),
      roughness: 0.12, metalness: 0.0
    });
    this.mat.shadow = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.42,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2
    });

    // Per-livery materials, built once each.
    this.liveryMats = LIVERIES.map((lv) => ({
      body: new THREE.MeshStandardMaterial({
        color: new THREE.Color(...hexToLinear(lv.body)),
        roughness: 0.38, metalness: 0.0
      }),
      accent: new THREE.MeshStandardMaterial({
        color: new THREE.Color(...hexToLinear(lv.accent)),
        roughness: 0.52, metalness: 0.0
      }),
      helmet: new THREE.MeshStandardMaterial({
        color: new THREE.Color(...hexToLinear(lv.helmet)),
        roughness: 0.26, metalness: 0.0
      }),
      suit: new THREE.MeshStandardMaterial({
        color: new THREE.Color(...hexToLinear(lv.suit)),
        roughness: 0.72, metalness: 0.0
      })
    }));

    this._built = true;
    return this;
  }

  dispose() {
    for (const k in this.geo) this.geo[k].dispose();
    for (const k in this.mat) this.mat[k].dispose();
    if (this.liveryMats) {
      for (const set of this.liveryMats) for (const k in set) set[k].dispose();
    }
    this.geo = Object.create(null);
    this.mat = Object.create(null);
    this.liveryMats = null;
    this._built = false;
  }
}

// -----------------------------------------------------------------------------
// ONE KART. Root Object3D + named sockets + a per-frame update that is fed
// ground speed and steering, so the wheels can never disagree with the physics.
// -----------------------------------------------------------------------------
export class Kart {
  // rng: a forked seeded stream. Used ONLY for cosmetic per-instance variation
  // (flag lean, decal offset). Never for anything the sim reads.
  constructor(res, liveryIndex, rng) {
    this.res = res;
    this.liveryIndex = liveryIndex % LIVERIES.length;
    this.livery = LIVERIES[this.liveryIndex];
    const lm = res.liveryMats[this.liveryIndex];

    // TWO NODES, NOT ONE. This split is a DEFECT FIX, not a style choice.
    //
    //   root  - PLACEMENT. Carries only the kart's position on the boardwalk and
    //           its yaw. Never shakes, never rolls.
    //   body  - BODY MOTION. Child of root. Carries the impact shake (vertical
    //           throw + roll) from step requirement 5.
    //
    // The contact shadows hang off ROOT, everything physical off BODY. When both
    // lived on one node the shadow quads inherited the shake and lifted off the
    // deck: measured by tools/_s4_shadowmax.mjs at 52.52 mm of travel on 23 of 71
    // frames when driven at the authored SHAKE_MAX. A contact shadow that leaves
    // the ground is not a contact shadow - it is the exact "kart floats" read the
    // requirement exists to prevent, and it appeared at the one moment the player
    // is looking hardest: the impact.
    //
    // Found only because the first probe's 2 mm in-race shake was replaced with
    // the authored maximum. A green result from a weak stimulus is not evidence.
    this.root = new THREE.Object3D();
    this.root.name = 'kart_' + this.livery.id;

    this.body = new THREE.Object3D();
    this.body.name = 'kart_body';
    this.root.add(this.body);

    this.sockets = Object.create(null);
    this.wheels = [];          // in FL, FR, RL, RR order - fixed, never sorted
    this.shadows = [];

    const g = res.geo, m = res.mat;

    // ---- CHASSIS ----
    const pan = new THREE.Mesh(g.pan, lm.body);
    pan.name = 'chassis_pan';
    pan.position.set(0, BODY_Y + BODY_H / 2, 0);
    pan.castShadow = true; pan.receiveShadow = true;
    this.body.add(pan);

    const nose = new THREE.Mesh(g.nose, lm.body);
    nose.name = 'chassis_nose';
    nose.position.set(0, BODY_Y + BODY_H * 0.55, -BODY_L * 0.5 - L * 0.10);
    nose.castShadow = true;
    this.body.add(nose);

    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(g.pod, lm.accent);
      pod.name = 'sidepod_' + (side < 0 ? 'l' : 'r');
      pod.position.set(side * (BODY_W / 2 + W * 0.07), BODY_Y + BODY_H * 0.5, L * 0.02);
      pod.castShadow = true;
      this.body.add(pod);
    }

    const hoop = new THREE.Mesh(g.hoop, m.metal);
    hoop.name = 'roll_hoop';
    hoop.position.set(0, SEAT_Y + TORSO_H * 0.66, SEAT_Z + L * 0.12);
    hoop.castShadow = true;
    this.body.add(hoop);

    // ---- WHEELS, via STEERING PIVOTS. -------------------------------------
    // The front wheels are children of steer_* pivots. Rotating the PIVOT steers;
    // rotating the WHEEL spins. Two separate transforms, so a steering input can
    // never be mistaken for a spin and vice versa. This is the structural reason
    // the wheel rate can be asserted independently of the steering angle.
    const wheelSpecs = [
      { key: 'wheel_fl', steer: 'steer_fl', x: -HUB_HALF_FRONT, z: AXLE_Z_FRONT, geo: g.tyreF, hub: g.hubF, r: TYRE_R_FRONT, tyreW: TYRE_W_FRONT, front: true },
      { key: 'wheel_fr', steer: 'steer_fr', x: +HUB_HALF_FRONT, z: AXLE_Z_FRONT, geo: g.tyreF, hub: g.hubF, r: TYRE_R_FRONT, tyreW: TYRE_W_FRONT, front: true },
      { key: 'wheel_rl', steer: null,       x: -HUB_HALF_REAR,  z: AXLE_Z_REAR,  geo: g.tyreR, hub: g.hubR, r: TYRE_R_REAR,  tyreW: TYRE_W_REAR,  front: false },
      { key: 'wheel_rr', steer: null,       x: +HUB_HALF_REAR,  z: AXLE_Z_REAR,  geo: g.tyreR, hub: g.hubR, r: TYRE_R_REAR,  tyreW: TYRE_W_REAR,  front: false }
    ];

    for (const spec of wheelSpecs) {
      let parent = this.body;
      if (spec.steer) {
        const pivot = new THREE.Object3D();
        pivot.name = spec.steer;
        pivot.position.set(spec.x, spec.r, spec.z);
        this.body.add(pivot);
        this.sockets[spec.steer] = pivot;
        parent = pivot;
      }
      const wheel = new THREE.Object3D();
      wheel.name = spec.key;
      if (!spec.steer) wheel.position.set(spec.x, spec.r, spec.z);
      parent.add(wheel);

      const tyre = new THREE.Mesh(spec.geo, m.tyre);
      tyre.name = spec.key + '_tyre';
      tyre.castShadow = true;
      wheel.add(tyre);

      // HUB INBOARD OFFSET - fixes a real 7.7 mm sizing-contract breach found by
      // the S6 integration gate (N1b) and named by tools/bboxdiag.mjs.
      //
      // The hub disc is deliberately TYRE_W * 1.04 so its faces stand proud of
      // the tyre and the wheel READS as spinning. But it was built CENTRED on
      // the wheel, so 2% of the tyre width protruded on EACH side - 0.00385 m
      // outboard per wheel, making the rendered kart 1.1077 m across against a
      // 1.1000 m constant and a 1.1000 m collider.
      //
      // That is hard rule 10 inverted: the silhouette the player reads was WIDER
      // than the volume that actually blocks them, so a wheel could visually
      // overlap a barrier with no contact. Small, but it is exactly the class of
      // silent size drift the sizing contract exists to catch, and the gate was
      // right to fire.
      //
      // Fix: slide the hub INBOARD by the full 4% so its OUTER face is flush
      // with the tyre's outer face and the whole 4% of proudness lands on the
      // inboard side, where it is still fully visible between the wheel and the
      // chassis. Spin readability is preserved; the silhouette is now exactly
      // KART_W.
      const hub = new THREE.Mesh(spec.hub, lm.accent);
      hub.name = spec.key + '_hub';
      hub.position.x = -Math.sign(spec.x) * (spec.tyreW * 0.02);
      wheel.add(hub);

      this.sockets[spec.key] = wheel;
      this.wheels.push({ node: wheel, rollR: spec.front ? ROLL_R_FRONT : ROLL_R_REAR, front: spec.front });

      // Contact shadow, one per wheel (step requirement 5).
      const sh = new THREE.Mesh(g.shadow, m.shadow);
      sh.name = spec.key + '_contact_shadow';
      sh.scale.set(spec.r * 2.1, 1, spec.r * 2.6);
      sh.position.set(spec.x, 0.012, spec.z);
      sh.renderOrder = 2;
      this.root.add(sh);
      this.shadows.push(sh);
    }

    // ---- DRIVER (seat socket) ---------------------------------------------
    const seat = new THREE.Object3D();
    seat.name = 'seat';
    seat.position.set(0, SEAT_Y, SEAT_Z);
    this.body.add(seat);
    this.sockets.seat = seat;

    const torso = new THREE.Mesh(g.torso, lm.suit);
    torso.name = 'driver_torso';
    torso.position.set(0, TORSO_H * 0.42, 0);
    torso.rotation.x = -0.30;       // leaned forward into the seat
    torso.castShadow = true;
    seat.add(torso);

    const helmetPivot = new THREE.Object3D();
    helmetPivot.name = 'driver_head';
    helmetPivot.position.set(0, TORSO_H * 0.86, -L * 0.02);
    seat.add(helmetPivot);
    this.sockets.driver_head = helmetPivot;

    const helmet = new THREE.Mesh(g.helmet, lm.helmet);
    helmet.name = 'driver_helmet';
    helmet.castShadow = true;
    helmetPivot.add(helmet);

    const visor = new THREE.Mesh(g.visor, m.visor);
    visor.name = 'driver_visor';
    helmetPivot.add(visor);

    // Arms reaching to the wheel. They are parented to the STEERING WHEEL rim so
    // they follow the steering input rather than sitting rigid while the kart
    // corners - a rigid driver at full lock is the second-cheapest fake tell.
    const steerRimPivot = new THREE.Object3D();
    steerRimPivot.name = 'driver_steer';
    steerRimPivot.position.set(0, TORSO_H * 0.58, -L * 0.155);
    steerRimPivot.rotation.x = -0.55;
    seat.add(steerRimPivot);
    this.sockets.driver_steer = steerRimPivot;

    const rim = new THREE.Mesh(g.wheelRim, m.metal);
    rim.name = 'steering_wheel';
    steerRimPivot.add(rim);

    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(g.arm, lm.suit);
      arm.name = 'driver_arm_' + (side < 0 ? 'l' : 'r');
      arm.position.set(side * W * 0.105, 0, W * 0.10);
      arm.rotation.set(1.15, 0, side * -0.22);
      steerRimPivot.add(arm);
    }

    // ---- FLAG socket ------------------------------------------------------
    const flag = new THREE.Object3D();
    flag.name = 'flag';
    flag.position.set(W * 0.20, BODY_Y + BODY_H, FLAG_Z);
    this.body.add(flag);
    this.sockets.flag = flag;

    const mast = new THREE.Mesh(g.mast, m.metal);
    mast.name = 'flag_mast';
    mast.position.set(0, FLAG_H / 2, 0);
    flag.add(mast);

    this.pennantMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...hexToLinear(this.livery.body)),
      roughness: 0.68, metalness: 0.0, side: THREE.DoubleSide
    });
    const pennant = new THREE.Mesh(g.pennant, this.pennantMat);
    pennant.name = 'flag_pennant';
    pennant.position.set(FLAG_W * 0.5, FLAG_H * 0.86, 0);
    pennant.rotation.y = Math.PI / 2;
    flag.add(pennant);
    this._pennant = pennant;

    // Deterministic per-instance variation - "nothing perfectly clean or
    // repeated". Drawn from the injected seeded stream, never Math.random.
    this._flagPhase = rng ? rng.range(0, Math.PI * 2) : 0;
    this._flagLean = rng ? rng.range(-0.06, 0.06) : 0;
    flag.rotation.z = this._flagLean;

    // ---- EXHAUST socket ---------------------------------------------------
    const exhaust = new THREE.Object3D();
    exhaust.name = 'exhaust';
    exhaust.position.set(EXHAUST_X, BODY_Y + BODY_H * 0.85, EXHAUST_Z);
    exhaust.rotation.x = Math.PI / 2 - 0.22;
    this.body.add(exhaust);
    this.sockets.exhaust = exhaust;

    const pipe = new THREE.Mesh(g.exhaust, m.metal);
    pipe.name = 'exhaust_pipe';
    pipe.position.set(0, L * 0.13, 0);
    exhaust.add(pipe);

    // ---- runtime state, ALL preallocated ----------------------------------
    this.wheelSpin = 0;          // rad, accumulated
    this.steerVisual = 0;        // rad at the road wheels
    this.shakeX = 0; this.shakeY = 0;
    this._shakeMag = 0; this._shakeT = 0;
    this._t = 0;
  }

  // ---------------------------------------------------------------------------
  // PER-FRAME UPDATE. Allocation-free.
  //
  // groundSpeed is the kart's actual speed along the ground, in m/s, taken from
  // the sim. The wheel spin rate is omega = v / r - the rolling constraint - so
  // the wheels CANNOT spin at a rate inconsistent with the physics. That is the
  // whole point of step requirement 1's "a wheel spinning at the wrong rate is
  // the cheapest possible tell that the physics is fake".
  // ---------------------------------------------------------------------------
  update(dt, groundSpeed, steerAngle, x, y, z, yaw) {
    this._t += dt;

    // Rolling constraint per axle. Front and rear radii differ, so they spin at
    // DIFFERENT rates for the same ground speed - which is correct, and which a
    // single shared spin value would get wrong.
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.node.rotation.x -= (groundSpeed / w.rollR) * dt;
    }
    this.wheelSpin -= (groundSpeed / ROLL_R_REAR) * dt;

    // Steering pivots. Ackermann is not modelled - the physics is a bicycle
    // model, so both front wheels take the same angle, and claiming Ackermann in
    // the mesh while the sim runs a single track angle would be a lie about the
    // model.
    this.steerVisual = steerAngle;
    const sfl = this.sockets.steer_fl, sfr = this.sockets.steer_fr;
    if (sfl) sfl.rotation.y = steerAngle;
    if (sfr) sfr.rotation.y = steerAngle;
    // Driver's hands follow, at a road-to-wheel ratio.
    const ds = this.sockets.driver_steer;
    if (ds) ds.rotation.z = -steerAngle * 2.1;

    // Chassis shake decay - impact weight (step requirement 5).
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      if (this._shakeT < 0) this._shakeT = 0;
      const k = this._shakeT > 0 ? this._shakeT : 0;
      // Deterministic oscillation, not a random jitter: a seeded-noise shake
      // would still be reproducible, but a decaying sinusoid is cheaper and
      // reads identically at 60 Hz.
      this.shakeX = Math.sin(this._t * 61.0) * this._shakeMag * k;
      this.shakeY = Math.sin(this._t * 47.0) * this._shakeMag * k * 0.6;
    } else {
      this.shakeX = 0; this.shakeY = 0;
    }

    // Flag flutter, scaled by speed. Deterministic phase from the seeded stream.
    const flutter = Math.min(1, groundSpeed / 20) * 0.34;
    this._pennant.rotation.z = Math.sin(this._t * 13.0 + this._flagPhase) * flutter;

    // PLACEMENT on root: where the kart is on the boardwalk, and which way it
    // faces. No shake here - the contact shadows are children of root and must
    // stay welded to the deck.
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, yaw, 0);

    // BODY MOTION on body: the impact throw and roll. Everything the player
    // reads as the kart's mass reacting lives on this node, and nothing that
    // touches the ground does.
    this.body.position.y = this.shakeY;
    this.body.rotation.set(this.shakeX * 0.5, 0, this.shakeX);
    return this;
  }

  // Impact weight: called from collision events. Magnitude in metres of throw.
  addShake(mag, duration) {
    if (mag > this._shakeMag || this._shakeT <= 0) this._shakeMag = mag;
    this._shakeT = Math.max(this._shakeT, duration);
    return this;
  }

  // Sockets are DUMPED from the real hierarchy, never assumed - the same rule
  // the rigging pipeline applies to bone names.
  socketNames() {
    return Object.keys(this.sockets).sort();
  }

  dispose() {
    this.pennantMat.dispose();
    this.root.traverse(() => {});    // geometry/materials are shared and owned by
    this.root.clear();               // KartResources; only the instance material
    return this;                     // (pennant) is per-kart.
  }
}

// Build the whole field in one deterministic pass.
export function buildField(res, rngHub, count) {
  res.build();
  const n = count === undefined ? LIVERIES.length : count;
  const out = [];
  for (let i = 0; i < n; i++) {
    // Per-kart cosmetic stream, forked by index off the DECOR stream - not the
    // ai stream. Cosmetics must never consume draws the AI depends on.
    const rng = rngHub.get('decor').fork('kart:' + i);
    out.push(new Kart(res, i, rng));
  }
  return out;
}
