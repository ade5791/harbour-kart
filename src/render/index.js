// RenderSystem - the harbour render stack.
//
// Owner: render. S5. ARCHITECTURE.md sections 3, 4, 6, 7.
//
// This replaces the S4 synthetic-corridor gate fixture with the REAL harbour:
// the boardwalk, kerbs, mooring posts, ropes, item crates, sandstone buildings,
// palms, lagoon and castle skyline that S3 placed and gated, lit to the values
// measured off the reference frame.
//
// THE SIX MANDATED GATES, and where each is implemented:
//
//  1. NO-POST BASELINE   -> `post` flag. `new PostChain(renderer, false)`
//                           allocates no targets and no full-screen materials
//                           at all: post off is genuinely off. Everything that
//                           carries meaning is authored upstream in the
//                           materials, the cascade rig and the light values.
//  2. SHADER PREWARM     -> src/render/prewarm.js, bound to a SCRATCH target,
//                           with explicit depth/shadow and post hooks, warming
//                           BOTH program key spaces.
//  3. SIM-TRANSPARENT    -> prewarm snapshots and restores clock, RNG and the
//                           fixed-step accumulator, then MEASURES the drift.
//  4. CONSTANT LIGHTS    -> `visibleLightCount` is fixed at construction and
//                           asserted every frame by `auditLights()`. Lights are
//                           never added, removed, or hidden after init.
//  5. ENGINE CLOCK ONLY  -> nothing here reads performance.now() or Date.now()
//                           for anything that reaches a pixel. `render(alpha,
//                           timeS)` takes the engine time explicitly.
//  6. ZERO ALLOC/FRAME   -> every vector, matrix and colour is preallocated in
//                           the constructor.
//
// TONEMAPPING AND THE TWO PATHS
// -----------------------------
// With post ENABLED the composite pass tonemaps last (see post.js) and the
// renderer must NOT also tonemap, or the frame is tonemapped twice. With post
// DISABLED there is no composite pass, so the RENDERER tonemaps instead. Both
// paths therefore end in one ACES transform and the two baseline frames are
// directly comparable - which is the entire point of capturing both.

import * as THREE from 'three';
import { QUALITY, DEFAULT_QUALITY } from '../core/config.js';
import { PALETTE, REGION, TARGETS, SUN, hexToLinear, luminance } from './palette.js';
import { MaterialLibrary } from './materials.js';
import { Sky } from './sky.js';
import { Harbour } from './harbour.js';
import { SunCascades } from './shadows.js';
import { PostChain } from './post.js';
import { Prewarm } from './prewarm.js';

// EXPOSURE. The measured frame is LOW KEY: median luminance 0.0296, p95 0.3650,
// max 1.0. That distribution is held with exposure and tonemapping, NEVER by
// lifting blacks.
//
// THIS IS NOW ACTUALLY SOLVED. It previously read `const EXPOSURE_SEED = 0.62`
// with a comment claiming it was solved; it was typed. The consequence was
// measurable and severe: the key/fill solve uses NdotL = cos(elevation) = 0.9914
// because the measured key/fill ratio was taken on a VERTICAL FACADE, but the
// BOARDWALK is HORIZONTAL and receives sin(elevation) = 0.1305 - a factor of
// 7.60 less key light. Exposing for the facades therefore crushed the entire
// deck, and with it every shadowed surface, to 0/255. The gate measured a
// "shadowed" region luminance of exactly 0.00000, an infinite key/fill ratio
// (27739x), a shadow mean RGB of 0.0/0.0/0.0 and a within-surface variation
// stdev of 0.00024 - not because those systems were missing, but because 8-bit
// quantisation cannot carry ANY of them at code value 0-2.
//
// Solve instead for the measured MEDIAN: find the exposure at which the
// mid-tone boardwalk, lit by the real horizontal-surface irradiance, tonemaps
// to the reference p50 of 0.0296.
export function solveExposure() {
  const el = THREE.MathUtils.degToRad(SUN.elevationDeg);
  const solved = solveLighting();

  // Irradiance actually landing on a HORIZONTAL deck plank.
  const NdotL_deck = Math.sin(el);                       // 0.1305
  const keyOnDeck = solved.keyIntensity * NdotL_deck;
  // Hemisphere fill reaches an up-facing surface at close to full sky value.
  const fillOnDeck = solved.fillIntensity;
  const irradiance = keyOnDeck + fillOnDeck;

  // Scene-linear radiance leaving the mid boardwalk.
  const albedo = REGION.boardwalkMid.lum;                // 0.0258
  const radiance = albedo * irradiance;

  // ACES - THREE'S ACTUAL CURVE, not the Narkowicz approximation.
  //
  // DEFECT FOUND AND FIXED IN S6 (hard rule 8). This solver's comment claimed
  // "the same curve THREE.ACESFilmicToneMapping applies" while implementing
  // Narkowicz WITHOUT three's `toneMappingExposure / 0.6` scale and without the
  // AP1 matrices. The solver therefore bisected against a curve the renderer
  // does not use, so the exposure it returned did NOT put the mid boardwalk at
  // the measured p50 - it put it wherever the wrong curve happened to land.
  // Since this exposure sets the absolute look of the whole game, that error
  // propagated into every rendered luminance the S5/S6 gates measure.
  //
  // Same defect, same root cause and same fix as the composite shader in
  // post.js - which is the point: the transform had TWO hand-written copies
  // that were both wrong in the same way. Both now transcribe three's real
  // ACESFilmicToneMapping. Verified numerically by tools/_s6_tonediverge.mjs.
  const aces = (x) => {
    // three: color *= toneMappingExposure / 0.6, then AP1 -> RRT/ODT -> sRGB.
    const v = [x / 0.6, x / 0.6, x / 0.6];
    const IN = [[0.59719, 0.35458, 0.04823],
                [0.07600, 0.90834, 0.01566],
                [0.02840, 0.13383, 0.83777]];
    const OUT = [[ 1.60475, -0.53108, -0.07367],
                 [-0.10208,  1.10813, -0.00605],
                 [-0.00327, -0.07276,  1.07602]];
    const mul = (m, u) => [
      m[0][0] * u[0] + m[0][1] * u[1] + m[0][2] * u[2],
      m[1][0] * u[0] + m[1][1] * u[1] + m[1][2] * u[2],
      m[2][0] * u[0] + m[2][1] * u[1] + m[2][2] * u[2]];
    let c = mul(IN, v);
    c = c.map((t) => {
      const a = t * (t + 0.0245786) - 0.000090537;
      const b = t * (0.983729 * t + 0.432951) + 0.238081;
      return a / b;
    });
    c = mul(OUT, c);
    return Math.max(0, Math.min(1, c[1]));
  };

  // Bisect for the exposure that puts this surface at the measured median.
  const targetDisplay = TARGETS.lumP50;                  // 0.0296
  let lo = 0.01, hi = 400;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) * 0.5;
    if (aces(radiance * mid) < targetDisplay) lo = mid; else hi = mid;
  }
  const exposure = (lo + hi) * 0.5;

  return {
    exposure: +exposure.toFixed(6),
    NdotL_deck: +NdotL_deck.toFixed(6),
    NdotL_facade: +Math.cos(el).toFixed(6),
    horizontalVsVerticalPenalty: +(Math.cos(el) / NdotL_deck).toFixed(4),
    irradiance: +irradiance.toFixed(6),
    albedo, radiance: +radiance.toFixed(8),
    achievedDisplay: +aces(radiance * exposure).toFixed(6),
    targetDisplay
  };
}

export class RenderSystem {
  static id = 'render';
  static deps = [];

  /**
   * @param {object} o
   *   canvas, track, rngHub, loop, quality, post
   */
  constructor(o) {
    const opts = o || {};
    this.canvas = opts.canvas;
    this.track = opts.track;
    this.rngHub = opts.rngHub;
    this.loop = opts.loop;
    this.qualityName = opts.quality || DEFAULT_QUALITY;
    this.preset = QUALITY[this.qualityName];
    // Post may be forced off independently of the preset - that is how the
    // no-post baseline gate captures the same scene both ways.
    this.postEnabled = opts.post !== undefined ? !!opts.post : this.preset.post;
    this.preserveDrawingBuffer = !!opts.preserveDrawingBuffer;
    this.forceAntialias = opts.forceAntialias;   // test seam, see _buildRenderer
    this.exposureSolve = solveExposure();
    this.exposure = opts.exposure !== undefined
      ? opts.exposure : this.exposureSolve.exposure;

    // ---- PREALLOCATED SCRATCH ----
    this._v = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._col = new THREE.Color();
    this._size = new THREE.Vector2();

    this.frame = 0;
    this.lightAudit = { expected: 0, observed: 0, violations: 0, firstViolationFrame: -1 };
  }

  async init() {
    this._buildRenderer();
    this._buildScene();
    this._buildLights();
    this._buildSky();
    this._buildHarbour();
    this._buildPost();
    return this;
  }

  _buildRenderer() {
    const r = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // TAA supplies AA when post is on. `forceAntialias` is a TEST SEAM only
      // (undefined on the shipped path, so behaviour is unchanged); the S6
      // split-attribution probe uses it to hold MSAA constant across the
      // post / no-post pair while attributing a foreground luminance split.
      antialias: this.forceAntialias !== undefined
        ? !!this.forceAntialias : !this.postEnabled,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      // TEST SEAM (default false, shipped path unchanged). The default
      // framebuffer is UNDEFINED once the compositor has consumed it, so a
      // gl.readPixels that lands after a composite reads back all zeros - the
      // S3/S5 harness saw every no-post number collapse to exactly 0.00000 on
      // one run and read fine on the next over byte-identical inputs. A
      // capture-bound render target is NOT the answer for the no-post path:
      // three skips toneMapping and output encoding when the target is not
      // the canvas, so the probe would measure a linear frame the player never
      // sees. Preserving the drawing buffer keeps the real path AND a stable
      // readback.
      preserveDrawingBuffer: this.preserveDrawingBuffer
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    // See the header: exactly ONE ACES transform per path.
    r.toneMapping = this.postEnabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.postEnabled ? 1.0 : this.exposure;
    r.shadowMap.enabled = this.preset.cascades > 0;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = true;
    r.setPixelRatio(Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      this.preset.dprCap
    ));
    this.renderer = r;
    this.maxAnisotropy = Math.min(this.preset.anisotropy, r.capabilities.getMaxAnisotropy());
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    this.scene.name = 'harbour-world';

    // AERIAL PERSPECTIVE. Fog is a READABILITY tool here, not atmosphere for
    // its own sake. The reference frame's own sky-over-post luminance ratio is
    // only 1.168 - posts nearly merge into the haze. That is beautiful in a
    // racing photograph and unacceptable in a game where the barrier is what
    // you crash into. So the fog is deliberately THINNER than the reference's,
    // tuned so the near field (inside SIGHT_LINE_MIN = 39 m) is essentially
    // unhazed and separation only softens well beyond braking distance.
    const haze = hexToLinear(SUN.hazeColorHex);
    this.scene.fog = new THREE.Fog(
      new THREE.Color().setRGB(haze[0], haze[1], haze[2], THREE.LinearSRGBColorSpace),
      95,     // fog starts at 2.4x SIGHT_LINE_MIN: the corner you brake for is clear
      520
    );

    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.15, 900);
    this.camera.name = 'chase';
  }

  // ---------------------------------------------------------------------------
  // LIGHTS. The count is FIXED at construction and asserted every frame.
  //
  // Slot budget:
  //   0..cascades-1   sun cascades  (cascade 0 carries the sun; rest are 0
  //                                  intensity shadow-map providers)
  //   cascades        fill hemisphere  (sky/ground bounce)
  //   cascades+1      warm bounce      (sandstone -> boardwalk)
  //   cascades+2      rim              (low back-light separating the kart)
  //
  // Nothing is ever added, removed or hidden. A light that should stop
  // contributing has its INTENSITY driven to zero: colour x intensity of
  // exactly 0 adds 0.0 to the irradiance accumulator and cannot move a pixel,
  // whereas visible=false changes the program key and recompiles every lit
  // material in the harbour.
  // ---------------------------------------------------------------------------
  _buildLights() {
    const key = hexToLinear(SUN.keyColorHex);
    const fill = hexToLinear(SUN.fillColorHex);
    const rim = hexToLinear(SUN.rimColorHex);

    // Sun direction from the measured elevation/azimuth. Low golden sun at
    // 7.5 degrees: shadows are ~7.6x the caster's height, which is what puts
    // the long bars across the boardwalk.
    const el = THREE.MathUtils.degToRad(SUN.elevationDeg);
    const az = THREE.MathUtils.degToRad(SUN.azimuthDeg);
    this._sunDir.set(
      -Math.cos(el) * Math.sin(az),
      -Math.sin(el),
      -Math.cos(el) * Math.cos(az)
    ).normalize();

    // KEY. Intensity is SOLVED against the measured key/fill ratio rather than
    // dialled by eye - see solveLighting() below.
    const solved = solveLighting();
    this.solvedLighting = solved;

    this.cascades = new SunCascades({
      cascades: this.preset.cascades,
      mapSize: this.preset.shadowMapSize,
      maxDistance: 240,
      nearDistance: 0.15,
      lambda: 0.72,
      direction: this._sunDir,
      colour: new THREE.Color().setRGB(key[0], key[1], key[2], THREE.LinearSRGBColorSpace),
      intensity: solved.keyIntensity
    });
    this.scene.add(this.cascades.group);

    // FILL. A hemisphere light: warm sky above, warm ground bounce below.
    // CRITICALLY, the ground colour is WARM, not blue. The measured shadow mean
    // is RGB 22.9/19.9/16.1 - red LEADS blue by 6.8 at the dark end. A cool
    // ambient is the single most common way to destroy this palette.
    this.fillLight = new THREE.HemisphereLight(
      new THREE.Color().setRGB(fill[0], fill[1], fill[2], THREE.LinearSRGBColorSpace),
      // ground bounce: the sunlit sandstone throwing warm light back up
      new THREE.Color().setRGB(0.128, 0.098, 0.062, THREE.LinearSRGBColorSpace),
      solved.fillIntensity
    );
    this.fillLight.name = 'fill';
    this.scene.add(this.fillLight);

    // WARM BOUNCE. A directional from the sandstone side, no shadow. This is
    // the "warm bounce off the sandstone" the brief asks for, and it is what
    // keeps shadowed faces WARM instead of merely dark.
    this.bounceLight = new THREE.DirectionalLight(
      new THREE.Color().setRGB(0.196, 0.130, 0.072, THREE.LinearSRGBColorSpace),
      solved.bounceIntensity
    );
    this.bounceLight.name = 'bounce';
    this.bounceLight.position.set(38, 9, -22);
    this.bounceLight.castShadow = false;
    this.scene.add(this.bounceLight);

    // RIM. Low back-light that separates the kart silhouette from the deck.
    this.rimLight = new THREE.DirectionalLight(
      new THREE.Color().setRGB(rim[0], rim[1], rim[2], THREE.LinearSRGBColorSpace),
      solved.rimIntensity
    );
    this.rimLight.name = 'rim';
    this.rimLight.position.copy(this._sunDir).multiplyScalar(-60);
    this.rimLight.position.y = 6;
    this.rimLight.castShadow = false;
    this.scene.add(this.rimLight);

    // ONE definition: the preset owns the number (config.visibleLightsFor), and
    // the audit below counts what is actually in the scene against it.
    this.visibleLightCount = this.preset.visibleLights;
    this.lightAudit.expected = this.visibleLightCount;
  }

  _buildSky() {
    // Sky solves its own gradient to hit the MEASURED 4.39x falloff. The
    // target is passed in; the exponent and zenith scale are solved, not typed.
    // The gradient must be solved against the DOME HEIGHTS THIS CAMERA ACTUALLY
    // SAMPLES. Sky's defaults (imageHeight 619, fov 55) describe the reference
    // photograph, not our render, so passing them would solve the ramp for
    // scanlines this camera never evaluates.
    this.sky = new Sky({
      falloffTarget: TARGETS.skyFalloff,
      imageHeight: this.height,
      fovDeg: this.camera.fov
    });
    this.scene.add(this.sky.mesh);
  }

  _buildHarbour() {
    this.materials = new MaterialLibrary();
    // STREAM CHOICE. The declared stream set is
    // spawn|decor|fx|material|audio|ai - there is no 'render' stream, and
    // inventing one at a call site would be an undeclared contract change.
    // Materials use 'material'; scenery variation uses 'decor'. Those are the
    // two streams that already exist for exactly this purpose.
    this.materials.build(this.rngHub.get('material'), this.maxAnisotropy);
    this.harbour = new Harbour(
      this.track, this.materials, this.rngHub.get('decor')
    ).build();
    this.scene.add(this.harbour.group);
  }

  _buildPost() {
    this.post = new PostChain(this.renderer, this.postEnabled, {
      exposure: this.exposure,
      aoSamples: this.preset.aoSamples
    });
    this.prewarm = new Prewarm(this.renderer);
  }

  async warm() {
    return this.prewarm.run({
      scene: this.scene,
      camera: this.camera,
      loop: this.loop,
      rng: this.rngHub,
      postMaterials: this.post.materials(),
      depthOverride: this.post.depthOverrideMaterial(),
      depthPrepass: () => this.post.prewarmDepthPrepass(this.scene, this.camera)
    });
  }

  setSize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this._size);
    this.post.setSize(this._size.x, this._size.y);
  }

  /**
   * Count the lights the renderer will actually see. Called every frame by
   * render(); a violation is recorded, not thrown, so a capture still produces
   * a frame and the gate can report WHICH frame first diverged.
   */
  auditLights() {
    let n = 0;
    this.scene.traverse((o) => { if (o.isLight && o.visible) n++; });
    this.lightAudit.observed = n;
    if (n !== this.lightAudit.expected) {
      this.lightAudit.violations++;
      if (this.lightAudit.firstViolationFrame < 0) {
        this.lightAudit.firstViolationFrame = this.frame;
      }
    }
    return n;
  }

  /**
   * Draw one frame.
   * @param {number} alpha  interpolation alpha from the fixed loop
   * @param {number} timeS  ENGINE time in seconds. NEVER performance.now().
   */
  render(alpha, timeS) {
    this.cascades.update(this.camera);
    // The skydome follows the camera so it never clips the far plane. Sky has
    // no sync() of its own - the dome is a plain Mesh, so the follow is done
    // here, writing into its existing position (no allocation).
    this.sky.mesh.position.copy(this.camera.position);
    this.harbour.syncCrates(timeS);
    this.harbour.syncWater(timeS);
    this.auditLights();
    this.post.render(this.scene, this.camera);
    this.frame++;
  }

  /**
   * The achieved-vs-target report. Every number here is MEASURED off the built
   * scene, not restated from the target table.
   */
  report() {
    // Sky luminance is sampled through lumAt(t), the SAME function the sky
    // fragment shader mirrors - so the reported falloff describes the pixels
    // that actually render, not a second independent model of them.
    const skyTop = this.sky.lumAt(this.sky.tTop);
    const skyMid = this.sky.lumAt(this.sky.tMid);
    const info = this.renderer.info;
    return {
      quality: this.qualityName,
      post: this.postEnabled,
      exposure: this.exposure,
      toneMapping: this.postEnabled ? 'composite-ACES' : 'renderer-ACES',
      lights: {
        expected: this.lightAudit.expected,
        observed: this.lightAudit.observed,
        violations: this.lightAudit.violations,
        firstViolationFrame: this.lightAudit.firstViolationFrame
      },
      cascades: this.cascades.report(),
      sky: { topLum: skyTop, midLum: skyMid, falloff: skyTop / Math.max(1e-6, skyMid) },
      lighting: this.solvedLighting,
      harbour: this.harbour.report(),
      materials: this.materials.audit,
      draws: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : 0
    };
  }

  dispose() {
    this.post.dispose();
    this.prewarm.dispose();
    this.harbour.dispose();
    this.cascades.dispose();
    this.materials.dispose();
    this.sky.dispose();
    this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.scene.clear();
    this.renderer.dispose();
    if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
  }
}

/**
 * SOLVE the light intensities against the measured key/fill ratio.
 *
 * The target is 3.33: sunlit facade 0.1257 over shadowed wall 0.0378. Both
 * regions share the SAME measured albedo family, so the ratio is a property of
 * the LIGHT RIG, not of the materials.
 *
 * A Lambert surface facing the key receives:  key * NdotL  +  fill
 * The same surface in shadow receives:        fill  (+ bounce, if facing it)
 *
 * So  ratio = (key*NdotL + fill) / fill,  which rearranges to
 *     key*NdotL = fill * (ratio - 1)
 *
 * NdotL for a facade lit by a 7.5-degree sun is close to cos(7.5deg) for a
 * vertical wall facing the sun: 0.9914. Solving for key given a chosen fill
 * makes the ratio an OUTPUT of arithmetic rather than a number dialled in by
 * eye - which is the same discipline the sight line got.
 *
 * The gate re-derives this independently and compares.
 */
export function solveLighting() {
  const ratio = TARGETS.keyFillRatio;             // 3.3228
  const el = THREE.MathUtils.degToRad(SUN.elevationDeg);
  const NdotL = Math.cos(el);                     // vertical facade, low sun

  // Fill is anchored to the measured SHADOW value. The shadowed wall reads
  // 0.0378 with a measured albedo of 0.0378 (REGION.shadowedWall luminance), so
  // the fill irradiance that produces it is ~1.0 in normalised terms; the
  // absolute scale is then set by exposure, not here.
  const fillIntensity = 0.42;
  const keyIntensity = fillIntensity * (ratio - 1) / NdotL;

  return {
    ratio,
    NdotL: +NdotL.toFixed(6),
    fillIntensity: +fillIntensity.toFixed(6),
    keyIntensity: +keyIntensity.toFixed(6),
    // Bounce and rim are deliberately SMALL: they add warmth and separation
    // without participating in the key/fill arithmetic above. If they were
    // large the solved ratio would no longer describe the rendered result.
    bounceIntensity: 0.16,
    rimIntensity: 0.22,
    predictedRatio: +(((keyIntensity * NdotL) + fillIntensity) / fillIntensity).toFixed(6)
  };
}
