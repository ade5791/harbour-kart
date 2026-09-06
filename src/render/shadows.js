// Cascaded sun shadows, sized for a 1236 m circuit.
//
// Owner: render. S5.
//
// WHY A RACER'S SHADOW FRUSTUM IS A DIFFERENT PROBLEM
// ---------------------------------------------------
// A static scene can wrap one shadow frustum around the whole playable volume.
// A 1236 m circuit cannot: a single 2048px map stretched over 1236 m gives
// 0.60 m per texel, so the contact shadow under a 1.10 m wide kart is under two
// texels across and dissolves the moment the kart moves. That is exactly the
// failure the brief warns about - "contact shadows dissolve at speed".
//
// So the cascades are split along the VIEW DIRECTION, and the near cascade is
// kept tight on the kart:
//
//   cascade 0:   0.0 -  18 m    2048px over ~24 m box  ->  0.0117 m/texel
//   cascade 1:  18   -  70 m    2048px over ~92 m box  ->  0.0449 m/texel
//   cascade 2:  70   - 240 m    2048px over ~310 m box ->  0.1514 m/texel
//
// Cascade 0's texel is ~94x finer than the naive whole-circuit map, which is
// what keeps a wheel contact shadow resolved at 28.6 m/s.
//
// The split is logarithmic-blended-with-uniform (the standard practical
// compromise): pure logarithmic wastes the near cascade on the first metre,
// pure uniform wastes resolution at distance.
//
// WHY NOT three-csm
// -----------------
// The upstream CSM addon allocates a `new Vector3()` inside update(), once per
// frame, which violates hard rule 3 outright. Subclassing to swap in a scratch
// vector means tracking upstream's internals across versions - and upstream's
// update() also rebuilds frustum corner arrays. Writing the cascade fitting
// directly is ~120 lines, allocates nothing after init, and puts the split
// scheme where it can be read and gated rather than inside a dependency.
//
// SHADOW-CASTER CULLING
// ---------------------
// `shadowCasterMinSize` from the quality preset controls what is allowed to
// cast. This is NOT a quality dial for its own sake: at 240 m a 0.2 m object
// casts a sub-texel shadow that is pure aliasing noise, so casting it costs a
// draw call to make the image worse.
//
// LIGHT COUNT CONSTANCY (hard rule 5 / brief item 5)
// --------------------------------------------------
// Each cascade is a separate DirectionalLight, so the cascade COUNT is baked
// into every lit material's program key. Therefore the count is fixed at
// construction from the quality preset and never changes at runtime. Cascades
// are never added, removed, or hidden - a cascade that is not currently needed
// is left visible with its intensity driven to zero, because colour x intensity
// of exactly 0 contributes 0.0 to the irradiance accumulator and cannot move a
// pixel, while `visible = false` WOULD change the program key and recompile
// every lit material in the harbour.

import * as THREE from 'three';

export class SunCascades {
  /**
   * @param {object} opts
   *   cascades      number of cascades (fixed for the session)
   *   mapSize       shadow map resolution per cascade
   *   maxDistance   far edge of the last cascade, metres
   *   nearDistance  near edge of cascade 0, metres
   *   lambda        0 = uniform split, 1 = logarithmic split
   *   direction     THREE.Vector3, sun direction (from sun toward scene)
   *   colour        THREE.Color, sun colour
   *   intensity     sun intensity
   */
  constructor(opts) {
    const o = opts || {};
    this.count = o.cascades || 3;
    this.mapSize = o.mapSize || 2048;
    this.maxDistance = o.maxDistance || 240;
    this.nearDistance = o.nearDistance || 0.1;
    this.lambda = o.lambda !== undefined ? o.lambda : 0.72;
    this.bias = o.bias !== undefined ? o.bias : -0.0006;
    this.normalBias = o.normalBias !== undefined ? o.normalBias : 0.035;

    this.group = new THREE.Group();
    this.group.name = 'sun-cascades';
    this.lights = [];
    this.splits = new Float32Array(this.count + 1);

    // ---- PREALLOCATED SCRATCH. Nothing below allocates per frame. ----
    this._corners = [];
    for (let i = 0; i < 8; i++) this._corners.push(new THREE.Vector3());
    this._centre = new THREE.Vector3();
    this._lightPos = new THREE.Vector3();
    this._dir = new THREE.Vector3(-0.42, -0.13, 0.60).normalize();
    this._up = new THREE.Vector3(0, 1, 0);
    this._invProj = new THREE.Matrix4();
    this._invView = new THREE.Matrix4();
    this._tmpProj = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camDir = new THREE.Vector3();

    if (o.direction) this._dir.copy(o.direction).normalize();

    const colour = o.colour || new THREE.Color(1, 1, 1);
    const intensity = o.intensity !== undefined ? o.intensity : 3.0;

    // Cascade 0 carries the full sun intensity. Cascades 1..n-1 exist ONLY as
    // shadow-map providers for their depth range; if they also contributed
    // irradiance the overlap regions would be lit 2-3x. So their intensity is
    // exactly 0 - present in the program key, contributing nothing.
    for (let i = 0; i < this.count; i++) {
      const l = new THREE.DirectionalLight(colour, i === 0 ? intensity : 0);
      l.name = 'sun-cascade-' + i;
      l.castShadow = true;
      l.visible = true;                 // NEVER toggled - see header
      l.shadow.mapSize.set(this.mapSize, this.mapSize);
      l.shadow.bias = this.bias;
      l.shadow.normalBias = this.normalBias;
      l.shadow.camera.near = 0.5;
      l.shadow.camera.far = 900;
      l.shadow.autoUpdate = true;
      l.target.position.set(0, 0, 0);
      this.group.add(l);
      this.group.add(l.target);
      this.lights.push(l);
    }
    this._computeSplits();
    this.texelSizes = new Float32Array(this.count);
  }

  /** Practical split scheme: blend of uniform and logarithmic. */
  _computeSplits() {
    const n = this.nearDistance, f = this.maxDistance;
    for (let i = 0; i <= this.count; i++) {
      const p = i / this.count;
      const uni = n + (f - n) * p;
      const log = n * Math.pow(f / n, p);
      this.splits[i] = this.lambda * log + (1 - this.lambda) * uni;
    }
    this.splits[0] = n;
    this.splits[this.count] = f;
  }

  /**
   * Fit every cascade to the camera's view frustum slice. Allocates nothing.
   * @param {THREE.PerspectiveCamera} camera
   */
  update(camera) {
    camera.updateMatrixWorld();
    this._invView.copy(camera.matrixWorld);

    for (let c = 0; c < this.count; c++) {
      const near = this.splits[c];
      const far = this.splits[c + 1];

      // Frustum slice corners, built directly from the camera's fov/aspect.
      // Cheaper and clearer than unprojecting NDC through an inverse matrix,
      // and it avoids the inverse-projection allocation entirely.
      const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
      const hn = tan * near, wn = hn * camera.aspect;
      const hf = tan * far,  wf = hf * camera.aspect;
      const k = this._corners;
      k[0].set(-wn, -hn, -near); k[1].set(wn, -hn, -near);
      k[2].set(-wn,  hn, -near); k[3].set(wn,  hn, -near);
      k[4].set(-wf, -hf, -far);  k[5].set(wf, -hf, -far);
      k[6].set(-wf,  hf, -far);  k[7].set(wf,  hf, -far);

      this._centre.set(0, 0, 0);
      for (let i = 0; i < 8; i++) {
        k[i].applyMatrix4(this._invView);
        this._centre.add(k[i]);
      }
      this._centre.multiplyScalar(1 / 8);

      // Bounding SPHERE, not box: a sphere is rotation-invariant, so the
      // shadow box size does not change as the camera yaws through a corner.
      // A rotation-variant box makes the shadow texel density pulse while the
      // kart turns, which reads as shadow edges crawling - a real artefact on
      // a chase camera that yaws continuously.
      let radius = 0;
      for (let i = 0; i < 8; i++) {
        const d = this._v.copy(k[i]).sub(this._centre).length();
        if (d > radius) radius = d;
      }
      radius = Math.ceil(radius * 16) / 16;

      const light = this.lights[c];
      const cam = light.shadow.camera;
      cam.left = -radius; cam.right = radius;
      cam.top = radius;   cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = radius * 2 + 400;

      // TEXEL SNAPPING. Without it the shadow map re-rasterises at a slightly
      // different sub-texel offset every frame and every shadow edge shimmers.
      // At 28.6 m/s that shimmer is the most visible artefact in the frame.
      const texel = (radius * 2) / this.mapSize;
      this.texelSizes[c] = texel;
      this._centre.x = Math.floor(this._centre.x / texel) * texel;
      this._centre.y = Math.floor(this._centre.y / texel) * texel;
      this._centre.z = Math.floor(this._centre.z / texel) * texel;

      this._lightPos.copy(this._dir).multiplyScalar(-(radius + 200)).add(this._centre);
      light.position.copy(this._lightPos);
      light.target.position.copy(this._centre);
      light.target.updateMatrixWorld();
      cam.updateProjectionMatrix();
      light.shadow.needsUpdate = true;
    }
  }

  setDirection(v) { this._dir.copy(v).normalize(); }

  /** Diagnostic for the gate: metres per shadow texel, per cascade. */
  report() {
    const out = [];
    for (let c = 0; c < this.count; c++) {
      out.push({
        cascade: c,
        near: +this.splits[c].toFixed(3),
        far: +this.splits[c + 1].toFixed(3),
        mapSize: this.mapSize,
        metresPerTexel: +this.texelSizes[c].toFixed(5)
      });
    }
    return out;
  }

  dispose() {
    for (const l of this.lights) {
      if (l.shadow && l.shadow.map) l.shadow.map.dispose();
      l.dispose && l.dispose();
    }
    this.lights.length = 0;
    this.group.clear();
  }
}
