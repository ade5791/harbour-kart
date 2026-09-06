// Post-processing chain: depth prepass -> AO -> TAA -> bloom -> tonemap.
//
// Owner: render. S5.
//
// THE NO-POST BASELINE GATE IS THE POINT OF THIS FILE.
// Post is a THIN, OPTIONAL polish layer. Every element of the frame that
// carries meaning - material separation, form, depth, kerb readability, hazard
// contrast - is authored in the lighting and material system and survives with
// this chain disabled. If the harbour only reads with bloom on, the authored
// system is missing and the fix is upstream, never here.
//
// ORDER, AND WHY TONEMAP IS LAST
// ------------------------------
//   1. depth prepass   -> a linear-depth target the AO and TAA both read
//   2. AO              -> horizon-style occlusion from that depth
//   3. scene           -> HDR linear, NO tonemapping in the material pass
//   4. TAA             -> resolved in LINEAR HDR
//   5. bloom           -> bright-pass in LINEAR HDR
//   6. tonemap+comp    -> ACES, then sRGB encode. LAST.
//
// Tonemapping last is not a style preference. If the scene pass tonemaps, the
// bloom bright-pass runs on already-compressed values: everything above the
// knee has been squashed toward 1.0, so the threshold can no longer separate a
// genuine specular hit from a merely bright surface, and the bloom smears
// across the whole sunlit side. Blooming in linear HDR and tonemapping the sum
// is the only ordering where the threshold means what it says.
//
// This has a direct consequence for the NO-POST path: with post off there is no
// composite pass to tonemap in, so the RENDERER's own tonemapping must be on
// instead. RenderSystem sets renderer.toneMapping from the post flag for
// exactly this reason, and both paths therefore produce a tonemapped frame.
// Getting this wrong yields a no-post baseline that is a blown-out linear
// buffer and a gate that fails for a reason that has nothing to do with the
// authored scene.
//
// TAA AT 28.6 M/S
// ---------------
// The brief's caution is real: a chase camera at V_TOP produces large
// reprojection error and naive TAA smears the kart and the kerbs into paste.
// Two defences, both in the resolve shader:
//   - NEIGHBOURHOOD CLAMPING. The history sample is clamped to the min/max of
//     the current frame's 3x3 neighbourhood, so history that disagrees with
//     what is actually on screen now cannot survive. This is what rejects the
//     moving karts, whose pixels reproject wrongly because the reprojection is
//     camera-only.
//   - VELOCITY-SCALED HISTORY WEIGHT. History weight falls as reprojection
//     distance grows, so fast camera motion leans on the current frame.
// The result is a stabiliser for the static harbour, not a motion blur.
//
// The chain is hand-written rather than pulled from EffectComposer: composer
// passes allocate per frame and add targets we would then have to audit.
// Nothing here allocates after init.

import * as THREE from 'three';

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const RAW_PREFIX = 'precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n';

// ---- AO from linear depth --------------------------------------------------
// A horizon/occlusion estimator: compare each sample's depth against a ring of
// neighbours and darken where the neighbourhood sits closer to camera. Cheap,
// no normal buffer required, and it degrades gracefully at distance.
//
// NOTE ON WHAT AO IS FOR HERE. The materials already carry a baked AO channel
// in their ORM map, which is what makes crevices read WITH POST OFF. This pass
// adds CONTACT darkening between separate objects - a kart against the deck, a
// crate against a plank - which a per-material map structurally cannot do.
const AO_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uDepth;
uniform vec2  uTexel;
uniform float uRadius;
uniform float uStrength;
uniform float uNear;
uniform float uFar;
uniform int   uSamples;

float linearDepth(vec2 uv) {
  return texture2D(uDepth, uv).r;
}

void main() {
  float d = linearDepth(vUv);
  if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }

  // Radius shrinks with distance so the effect is world-scaled, not screen-scaled.
  float r = uRadius / max(0.05, d * uFar);
  float occ = 0.0;
  float total = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uSamples) break;
    float a = float(i) * 2.399963;          // golden-angle spiral
    float rad = r * (0.35 + 0.65 * float(i) / 16.0);
    vec2 off = vec2(cos(a), sin(a)) * rad * uTexel * 64.0;
    float ds = linearDepth(vUv + off);
    float diff = (d - ds) * uFar;
    // Only NEARER neighbours occlude, and only within a plausible range - a
    // wall 40 m in front of the sky must not darken the sky.
    float w = step(0.02, diff) * (1.0 - smoothstep(0.0, 1.4, diff));
    occ += w;
    total += 1.0;
  }
  float ao = 1.0 - uStrength * (occ / max(total, 1.0));
  gl_FragColor = vec4(clamp(ao, 0.0, 1.0));
}
`;

// ---- TAA resolve -----------------------------------------------------------
const TAA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uDepth;
uniform vec2  uTexel;
uniform mat4  uReproject;      // prevViewProj * inverse(curViewProj)
uniform float uFeedback;       // base history weight
uniform float uValid;          // 0 on the first frame: no history exists yet

void main() {
  vec3 cur = texture2D(uCurrent, vUv).rgb;

  // Reproject this pixel into the previous frame using its depth. This is
  // CAMERA-ONLY motion: moving karts reproject wrongly on purpose, and the
  // neighbourhood clamp below is what catches them.
  float d = texture2D(uDepth, vUv).r;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 prev = uReproject * ndc;
  vec2 prevUv = (prev.xy / max(abs(prev.w), 1e-6)) * 0.5 + 0.5;

  float offscreen = any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))
    ? 0.0 : 1.0;

  vec3 hist = texture2D(uHistory, prevUv).rgb;

  // NEIGHBOURHOOD CLAMP. History that disagrees with the current 3x3 min/max
  // cannot survive - this is the anti-smear defence at 28.6 m/s.
  vec3 lo = cur, hi = cur;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = texture2D(uCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb;
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  hist = clamp(hist, lo, hi);

  // VELOCITY-SCALED WEIGHT: the further this pixel travelled, the less the
  // history is trusted.
  float vel = length((prevUv - vUv) / max(uTexel, vec2(1e-6)));
  float w = uFeedback * exp(-vel * 0.06) * offscreen * uValid;

  gl_FragColor = vec4(mix(cur, hist, clamp(w, 0.0, 0.97)), 1.0);
}
`;

// ---- bloom bright-pass, in LINEAR HDR --------------------------------------
const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 off = vec2(float(x), float(y)) * uTexel * 1.5;
      vec3 c = texture2D(uScene, vUv + off).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float s = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
      s = s * s;
      float w = exp(-float(x * x + y * y) * 0.35);
      acc += c * s * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0);
}
`;

// ---- composite: AO, bloom, THEN tonemap + sRGB. LAST. ----------------------
const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform float uBloomGain;
uniform float uVignette;
uniform float uExposure;
uniform float uAOMix;

// ACES, TRANSCRIBED FROM THREE'S OWN ACESFilmicToneMapping.
//
// DEFECT FOUND AND FIXED IN S6 (hard rule 8). This function previously carried
// the comment "the exact ACES approximation three uses, so the post path and
// the no-post path are the same transform and the two baseline frames are
// comparable" - and the CLAIM WAS FALSE. It was the Narkowicz curve:
//   (x*(2.51x+0.03)) / (x*(2.43x+0.59)+0.14)
// while three's ACESFilmicToneMapping (verified against the vendored
// node_modules/three/.../tonemapping_pars_fragment.glsl.js) does:
//   color *= toneMappingExposure / 0.6;   <-- a 1.6667x SCALE that was MISSING
//   color = ACESInputMat * color;          <-- full AP1 matrices, also missing
//   color = RRTAndODTFit(color);
//   color = ACESOutputMat * color;
//
// The no-post path tonemaps via the RENDERER (three's real ACES); the post path
// tonemapped here (Narkowicz, no /0.6). So the two "comparable baseline frames"
// rode DIFFERENT CURVES AT DIFFERENT EFFECTIVE EXPOSURES. tools/_s6_tonediverge.mjs
// measured the divergence at the exposure the game actually runs (2.76478) and
// it is worst exactly where this scene lives - the dark end:
//   sceneLinear 0.002 -> noPost/post 0.5389
//   sceneLinear 0.010 -> 0.8079
//   sceneLinear 0.100 -> 0.9265
//   sceneLinear 1.000 -> 0.9888
// The frame's median is 0.0296, so essentially the whole image sat in the
// region of maximum disagreement. That is what N3-nobloom was reporting as a
// 3.96x "readability manufactured by post" split on the kerb, and it was NOT
// bloom: tools/_s6_splitattrib.mjs neutralised each composite term in turn and
// found bloom contributes EXACTLY 0.0000 to the split, while the control row
// (AO+bloom+vignette all off) still measured 3.5794 - i.e. the difference is
// upstream of every term the composite mixes.
//
// Fixed by making this function what its comment always claimed: three's ACES,
// including the /0.6 and both matrices. The N3-nobloom THRESHOLD WAS NOT MOVED.
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOutputMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602)
  );
  color /= 0.6;                 // three folds this into toneMappingExposure
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
             step(0.0031308, c));
}

void main() {
  vec3 scene = texture2D(uScene, vUv).rgb;
  float ao = mix(1.0, texture2D(uAO, vUv).r, uAOMix);
  scene *= ao;

  vec3 bloom = texture2D(uBloom, vUv).rgb;
  vec3 col = scene + bloom * uBloomGain;

  vec2 d = vUv - 0.5;
  float v = 1.0 - uVignette * dot(d, d) * 2.0;
  col *= clamp(v, 0.0, 1.0);

  // TONEMAP LAST, then encode.
  gl_FragColor = vec4(srgbEncode(aces(col * uExposure)), 1.0);
}
`;

export class PostChain {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {boolean} enabled  false = the NO-POST BASELINE. Nothing allocates a
   *                           target or a material when disabled, so "post off"
   *                           is genuinely off, not a pass-through still paying
   *                           the cost.
   * @param {object} opts { exposure, aoSamples }
   */
  constructor(renderer, enabled, opts) {
    const o = opts || {};
    this.renderer = renderer;
    this.enabled = !!enabled;
    // Test seam only - see _present(). null = present to the canvas, as shipped.
    this.captureTarget = null;
    this.exposure = o.exposure !== undefined ? o.exposure : 0.62;
    this.aoSamples = o.aoSamples !== undefined ? o.aoSamples : 16;
    this.frame = 0;

    this.sceneTarget = null;
    this.depthTarget = null;
    this.aoTarget = null;
    this.taaTargets = null;
    this.bloomTarget = null;
    this._mats = [];

    // Preallocated matrices for the TAA reprojection. Nothing allocates in
    // render().
    this._prevViewProj = new THREE.Matrix4();
    this._curViewProj = new THREE.Matrix4();
    this._reproject = new THREE.Matrix4();
    this._invCur = new THREE.Matrix4();
    this._size = new THREE.Vector2();

    if (this.enabled) this._build();
  }

  _build() {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x | 0), h = Math.max(2, size.y | 0);
    const bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);

    const hdr = {
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,   // LINEAR HDR: tonemap happens last
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter
    };

    // MSAA ON THE SCENE PASS - and the resolution of the S6 N3-nobloom split.
    //
    // `antialias: true` on the WebGLRenderer only ever antialiases the DEFAULT
    // FRAMEBUFFER. The post path does not draw the scene there - it draws into
    // this target - so with samples:0 the post path rendered the scene with NO
    // antialiasing at all while the no-post path (which does draw to the
    // canvas) got MSAA. The two "comparable baseline frames" therefore differed
    // in geometric coverage, not in colour.
    //
    // MEASURED, at the kerb (9.02 px wide on screen at 45.64 m, sampled with a
    // 5x5 window, so the window straddles the edge and coverage dominates it):
    //   samples 0 -> kerb fg 0.008310, ratio 24.119, split vs no-post 4.1929  FAIL
    //   samples 4 -> kerb fg 0.037908, ratio  5.069, split vs no-post 1.1349  PASS
    // The no-post fg is 0.033401, so samples:4 brings the post path back into
    // agreement with it. Nothing about the CONTENT changed and the N3-nobloom
    // THRESHOLD WAS NOT MOVED - the 3x bound stands exactly as written.
    //
    // Why every earlier attribution run missed it: AO, bloom, vignette and TAA
    // feedback are all COMPOSITE terms, and the earlier "MSAA control" flipped
    // the renderer's `antialias` flag, which the post path never reads. All
    // five probes were varying things downstream of, or irrelevant to, the
    // scene rasterisation. Per-stone sampling was what exposed it: ALL SIX kerb
    // stones darkened ~3-4x in fg while their backgrounds matched within 4% at
    // the SAME pixel - a coverage signature, not a tone-curve or blur signature.
    // Scoped to THIS target: `hdr` is reused by the TAA targets below, which
    // are resolve destinations and must stay single-sampled.
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, { ...hdr, samples: 4 });

    // Depth prepass target. Depth is written as a packed linear value in the
    // red channel by a dedicated depth material, so the AO and TAA passes read
    // ONE agreed depth encoding instead of each unpacking gl_FragCoord.z
    // differently - which is how two passes end up disagreeing about where a
    // surface is.
    this.depthTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter
    });
    this.depthMaterial = new THREE.MeshDepthMaterial();
    this.depthMaterial.depthPacking = THREE.BasicDepthPacking;

    this.aoTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false, stencilBuffer: false
    });

    // Two ping-pong TAA targets.
    this.taaTargets = [
      new THREE.WebGLRenderTarget(w, h, hdr),
      new THREE.WebGLRenderTarget(w, h, hdr)
    ];
    this.taaIndex = 0;

    this.bloomTarget = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false, stencilBuffer: false
    });

    const mk = (frag, uniforms) => {
      const m = new THREE.RawShaderMaterial({
        vertexShader: RAW_PREFIX + FS_VERT,
        fragmentShader: frag,
        depthTest: false, depthWrite: false,
        uniforms
      });
      this._mats.push(m);
      return m;
    };

    this.aoMat = mk(AO_FRAG, {
      uDepth:    { value: this.depthTarget.texture },
      uTexel:    { value: new THREE.Vector2(1 / w, 1 / h) },
      uRadius:   { value: 0.85 },
      uStrength: { value: 0.55 },
      uNear:     { value: 0.1 },
      uFar:      { value: 400 },
      uSamples:  { value: this.aoSamples }
    });
    this.taaMat = mk(TAA_FRAG, {
      uCurrent:   { value: this.sceneTarget.texture },
      uHistory:   { value: this.taaTargets[1].texture },
      uDepth:     { value: this.depthTarget.texture },
      uTexel:     { value: new THREE.Vector2(1 / w, 1 / h) },
      uReproject: { value: new THREE.Matrix4() },
      uFeedback:  { value: 0.82 },
      uValid:     { value: 0 }
    });
    this.brightMat = mk(BRIGHT_FRAG, {
      uScene:     { value: this.taaTargets[0].texture },
      uTexel:     { value: new THREE.Vector2(1 / bw, 1 / bh) },
      uThreshold: { value: 1.15 },   // in LINEAR HDR: only genuine highlights
      uKnee:      { value: 0.35 }
    });
    this.compositeMat = mk(COMPOSITE_FRAG, {
      uScene:     { value: this.taaTargets[0].texture },
      uBloom:     { value: this.bloomTarget.texture },
      uAO:        { value: this.aoTarget.texture },
      uBloomGain: { value: 0.26 },   // low: polish, never a contrast source
      uVignette:  { value: 0.20 },
      uExposure:  { value: this.exposure },
      uAOMix:     { value: 0.85 }
    });

    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(this.quadGeo, this.aoMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Materials the prewarm must compile explicitly - they are NOT in the graph. */
  materials() { return this.enabled ? this._mats.slice() : []; }

  /**
   * The depth-prepass override material.
   *
   * MISSING PREWARM HOOK, found by the S8 profiler. `materials()` returns only
   * the full-screen quad materials. The depth prepass instead assigns
   * `this.depthMaterial` to `scene.overrideMaterial`, which makes the renderer
   * compile ONE PROGRAM PER GEOMETRY LAYOUT it is applied to (skinning,
   * instancing, vertex-colour and morph permutations are separate keys). None of
   * those were reachable from compileAsync or from the shadow pass, so they
   * compiled lazily during play: the profiler measured 4 residual `depth,...`
   * programs on the first frames of every run.
   *
   * Returned separately from `materials()` because it must be prewarmed as a
   * SCENE OVERRIDE against the real scene graph - compiling it on a quad would
   * produce a different, useless key.
   */
  depthOverrideMaterial() { return this.enabled ? this.depthMaterial : null; }

  /**
   * Prewarm the depth prepass THROUGH THE EXACT PATH IT RUNS IN.
   *
   * Warming the override material against a generic scratch target was not
   * enough: the residual key measured `3201,3,144384` while the scratch pass
   * produced `3200,*,139264`. The program cache key folds in properties of the
   * BOUND RENDER TARGET, so a prepass warmed into some other buffer is a cache
   * MISS against the prepass that actually runs into `this.depthTarget`.
   *
   * This method therefore performs the real prepass verbatim - same override
   * material, same target, same clear - so the key it compiles is the key the
   * first real frame will look up. It renders no visible frame: depthTarget is
   * an offscreen buffer and the caller restores the previous binding.
   */
  prewarmDepthPrepass(scene, camera) {
    if (!this.enabled) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    // Same reason as the shadow warm: a mesh outside the prewarm-pose frustum is
    // never drawn and so never compiled. Unculled for the warm, restored after.
    const culled = [];
    scene.traverse((n) => {
      if ((n.isMesh || n.isInstancedMesh || n.isPoints) && n.frustumCulled) {
        culled.push(n); n.frustumCulled = false;
      }
    });
    scene.overrideMaterial = this.depthMaterial;
    r.setRenderTarget(this.depthTarget);
    r.clear();
    r.render(scene, camera);
    r.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    for (let i = 0; i < culled.length; i++) culled[i].frustumCulled = true;
    r.setRenderTarget(prevTarget);
  }

  setSize(w, h) {
    if (!this.enabled) return;
    const W = Math.max(2, w | 0), H = Math.max(2, h | 0);
    this.sceneTarget.setSize(W, H);
    this.depthTarget.setSize(W, H);
    this.aoTarget.setSize(W, H);
    this.taaTargets[0].setSize(W, H);
    this.taaTargets[1].setSize(W, H);
    const bw = Math.max(2, W >> 2), bh = Math.max(2, H >> 2);
    this.bloomTarget.setSize(bw, bh);
    this.aoMat.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.taaMat.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.brightMat.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    // Resizing invalidates the history: it was rasterised at another size.
    this.taaMat.uniforms.uValid.value = 0;
  }

  /**
   * DETERMINISTIC CAPTURE HOOK.
   *
   * The final present of BOTH paths (post on and post off) targets `null`, the
   * default framebuffer - whose contents are UNDEFINED once the compositor has
   * consumed them. Reading it back therefore races the compositor, which made
   * the S6 integration gate non-deterministic: two runs over byte-identical
   * inputs scored 21/30 and 28/30, with every no-post-derived number collapsing
   * to exactly 0.00000 in the bad run.
   *
   * `captureTarget` substitutes an owned render target for that final `null`.
   * A target we allocate is never handed to the compositor, so its contents are
   * stable and a readback is reproducible. It defaults to null, so the shipped
   * render path is byte-identical to before - this is a test seam, not a
   * behaviour change.
   */
  _present() { return this.captureTarget || null; }

  _blit(mat, target) {
    this.quad.material = mat;
    // A blit whose destination is the canvas is the FINAL PRESENT, and that is
    // the one a capture must be able to redirect. Intermediate blits (bloom,
    // AO, TAA history) target their own buffers and are left untouched.
    this.renderer.setRenderTarget(target === null ? this._present() : target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Render one frame. With post disabled this is a single direct render to the
   * canvas - the exact path the no-post baseline captures.
   */
  render(scene, camera) {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(this._present());
      r.render(scene, camera);
      return;
    }

    // 1. DEPTH PREPASS.
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMaterial;
    r.setRenderTarget(this.depthTarget);
    r.clear();
    r.render(scene, camera);
    scene.overrideMaterial = prevOverride;

    // 2. AO from that depth.
    this._blit(this.aoMat, this.aoTarget);

    // 3. SCENE, in linear HDR. No tonemapping in this pass.
    r.setRenderTarget(this.sceneTarget);
    r.render(scene, camera);

    // 4. TAA resolve, in linear HDR.
    this._curViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._invCur.copy(this._curViewProj).invert();
    this._reproject.multiplyMatrices(this._prevViewProj, this._invCur);
    this.taaMat.uniforms.uReproject.value.copy(this._reproject);
    const src = this.taaIndex, dst = 1 - this.taaIndex;
    this.taaMat.uniforms.uCurrent.value = this.sceneTarget.texture;
    this.taaMat.uniforms.uHistory.value = this.taaTargets[src].texture;
    this._blit(this.taaMat, this.taaTargets[dst]);
    this.taaIndex = dst;
    this.taaMat.uniforms.uValid.value = 1;
    this._prevViewProj.copy(this._curViewProj);

    const resolved = this.taaTargets[dst].texture;

    // 5. BLOOM, in linear HDR, so the threshold means what it says.
    this.brightMat.uniforms.uScene.value = resolved;
    this._blit(this.brightMat, this.bloomTarget);

    // 6. COMPOSITE: AO, bloom, THEN tonemap + sRGB encode. LAST.
    this.compositeMat.uniforms.uScene.value = resolved;
    this._blit(this.compositeMat, null);
    this.frame++;
  }

  /** Reset TAA history. Called before a capture so a frame is reproducible. */
  resetHistory() {
    if (this.enabled) this.taaMat.uniforms.uValid.value = 0;
  }

  dispose() {
    if (!this.enabled) return;
    this.sceneTarget.dispose();
    this.depthTarget.dispose();
    this.aoTarget.dispose();
    this.taaTargets[0].dispose();
    this.taaTargets[1].dispose();
    this.bloomTarget.dispose();
    this.depthMaterial.dispose();
    for (const m of this._mats) m.dispose();
    this._mats.length = 0;
    this.quadGeo.dispose();
    this.quadScene = null;
  }
}
