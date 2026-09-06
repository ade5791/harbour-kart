// Shader prewarm - the single highest-value performance system in the build.
//
// Owner: render. Runs ONCE, behind the loading screen, before the first real
// frame. Lazy compilation mid-play is the number one cause of "my Three.js game
// freezes": it presents as a multi-second stall, not as low fps.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT, each previously paid for:
//
// 1. COMPILE AGAINST THE SAME BOUND-TARGET *KIND* THE REAL FRAME WILL USE.
//    Three folds outputColorSpace AND toneMapping into the program cache key
//    and reads BOTH off the CURRENTLY BOUND target. Verified in r0.180 source:
//
//      6942  let toneMapping = NoToneMapping;
//      6944  if ( material.toneMapped ) {
//      6946    if ( currentRenderTarget === null || ...isXRRenderTarget ) {
//      6948      toneMapping = renderer.toneMapping;
//      6979  outputColorSpace: ( currentRenderTarget === null )
//              ? renderer.outputColorSpace
//              : ( ...isXRRenderTarget ? ...texture.colorSpace
//                                      : LinearSRGBColorSpace ),
//
//    So there are exactly TWO key spaces:
//      bound null (canvas)  -> renderer.outputColorSpace + renderer.toneMapping
//      bound a plain RT     -> LinearSRGBColorSpace      + NoToneMapping
//
//    Note the second row is HARDCODED: the `colorSpace` you pass when
//    constructing a scratch RT is NOT read for a non-XR target. Authoring a
//    scratch RT that "matches the canvas" is impossible.
//
//    CONSEQUENCE, and this is the defect the S2 gate caught: warming ONLY
//    against a scratch RT while the real frame renders direct-to-canvas
//    (post disabled) compiles the wrong variant. Every lit material then
//    recompiles on the first real frame - exactly the stall prewarm exists to
//    prevent. Measured: compiledDuringPrewarm=3, compiledDuringPlay=2.
//
//    This build renders BOTH ways (post off in the baseline gate, optional at
//    high), so prewarm warms BOTH key spaces. See docs/s2/PROGRAM_KEY_FINDING.md.
//
// 2. compileAsync ONLY REACHES THE FORWARD LIT PASS of what is currently in the
//    scene graph. It does not compile:
//      - depth / distance variants used by shadow map rendering
//      - any full-screen post material (they are not in the scene graph)
//      - materials on objects not yet spawned
//    Those need EXPLICIT hooks. This module renders one shadow-map update
//    against the scratch target to force the depth variants, and compiles post
//    materials by name.
//
// 3. PREWARM MUST BE SIMULATION-TRANSPARENT.
//    Snapshot and restore the engine clock, every RNG stream, and the
//    fixed-step accumulator. Otherwise every downstream capture drifts by the
//    prewarm duration and the pixel gate reports phantom regressions that are
//    really just a different sim time. No real frames are drawn.

import * as THREE from 'three';

export class Prewarm {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = null;
    this.report = {
      programsBefore: 0,
      programsAfterCompile: 0,
      programsAfterShadow: 0,
      programsAfterPost: 0,
      programsAfterCanvasSpace: 0,
      programsTotal: 0,
      compiledDuringPrewarm: 0,
      compiledInRtKeySpace: 0,
      compiledInCanvasKeySpace: 0,
      ms: 0,
      simTransparent: false,
      drift: null
    };
  }

  _programCount() {
    // renderer.info.programs is the live program cache. Its length IS the
    // compiled-permutation count; this is the number the gate reports.
    const p = this.renderer.info.programs;
    return p ? p.length : 0;
  }

  /**
   * @param {object} o
   *   scene, camera            the real scene graph and camera
   *   loop                     FixedLoop (snapshot/restore)
   *   rng                      RngHub  (snapshot/restore)
   *   postMaterials            array of full-screen materials not in the graph
   *   extraScenes              [{scene, camera}] variants to also compile
   */
  async run(o) {
    const t0 = Date.now();
    const renderer = this.renderer;

    // ---- 1. snapshot everything the prewarm could disturb ------------------
    const loopSnap = o.loop ? o.loop.snapshot() : null;
    const rngSnap = o.rng ? o.rng.snapshot() : null;
    const infoBefore = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      frame: renderer.info.render.frame
    };
    const prevTarget = renderer.getRenderTarget();
    const prevShadowEnabled = renderer.shadowMap.enabled;
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;

    this.report.programsBefore = this._programCount();

    // ---- 2. KEY SPACE A: bound to a scratch render target -----------------
    // This warms the LinearSRGB + NoToneMapping variants: the post-enabled
    // scene pass, and every depth/shadow variant (shadow maps always render
    // into a target, so they only ever exist in this key space).
    //
    // `colorSpace` is deliberately NOT passed: line 6979 hardcodes
    // LinearSRGBColorSpace for any non-XR target, so the option is inert and
    // passing it would imply a control that does not exist.
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0
    });
    renderer.setRenderTarget(this.target);

    // ---- 3. forward lit pass ---------------------------------------------
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(o.scene, o.camera);
    } else {
      renderer.compile(o.scene, o.camera);
    }
    if (o.extraScenes) {
      for (let i = 0; i < o.extraScenes.length; i++) {
        const e = o.extraScenes[i];
        if (typeof renderer.compileAsync === 'function') {
          await renderer.compileAsync(e.scene, e.camera);
        } else {
          renderer.compile(e.scene, e.camera);
        }
      }
    }
    this.report.programsAfterCompile = this._programCount();

    // ---- 4. depth / shadow variants --------------------------------------
    // compileAsync does not touch these. Forcing ONE shadow map update against
    // the scratch target compiles the depth and distance material variants for
    // every casting material in the graph. This is a render, but it is a render
    // into a 4x4 scratch target, not a real frame - nothing is presented.
    // FRUSTUM CULLING MUST BE OFF WHILE WARMING SHADOWS.
    //
    // Measured by the S8 profiler. The shadow pass only draws casters that fall
    // inside a cascade frustum AT THE PREWARM CAMERA POSE (the start line), so
    // any caster elsewhere on the 1236 m circuit was never drawn and never
    // compiled. Its depth variant then compiled mid-race the moment it entered a
    // cascade. The residual key differed from a warmed one in exactly two
    // fields - `uv` vs `false` and 1 vs 3 - i.e. an INSTANCED caster with no UV
    // attribute, not a quality step-down (this build has no step-down path).
    //
    // Disabling culling for the two warm renders draws every caster once,
    // compiling the full set. Restored immediately afterwards, so the shipped
    // render path keeps its culling.
    const culled = [];
    o.scene.traverse((n) => {
      if ((n.isMesh || n.isInstancedMesh || n.isPoints) && n.frustumCulled) {
        culled.push(n); n.frustumCulled = false;
      }
    });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.needsUpdate = true;
    renderer.render(o.scene, o.camera);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(o.scene, o.camera);
    for (let i = 0; i < culled.length; i++) culled[i].frustumCulled = true;
    this.report.programsAfterShadow = this._programCount();

    // ---- 4b. DEPTH PREPASS OVERRIDE --------------------------------------
    // Found by the S8 profiler. The post chain runs a depth prepass by setting
    // `scene.overrideMaterial = depthMaterial`. An override material compiles a
    // SEPARATE program for every geometry layout it is drawn with, and none of
    // those keys are reachable from compileAsync (step 3), from the shadow pass
    // (step 4, which uses the renderer's own internal depth material) or from
    // the post quads (step 5). They were therefore compiling lazily on the first
    // frames of real play - 4 residual `depth,...` programs, measured.
    //
    // Warmed the way it is USED: as a scene override, against the real graph,
    // into the scratch target. Rendered twice so the second pass proves the
    // programs are cached rather than merely created.
    // Warmed through the REAL prepass (same override material AND same bound
    // depthTarget). A first attempt warmed it into the generic scratch target
    // instead and left the residual key `3201,3,144384` still compiling during
    // play, because the program cache key folds in the bound target - warming
    // into a different buffer is a cache miss against the pass that really runs.
    if (o.depthPrepass) o.depthPrepass();
    this.report.programsAfterDepthOverride = this._programCount();

    // ---- 5. full-screen post materials -----------------------------------
    // Not in the scene graph, so nothing above can have reached them. Compile
    // each against a unit quad in a throwaway scene.
    if (o.postMaterials && o.postMaterials.length) {
      const quad = new THREE.PlaneGeometry(2, 2);
      const s = new THREE.Scene();
      const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const meshes = [];
      for (let i = 0; i < o.postMaterials.length; i++) {
        const m = new THREE.Mesh(quad, o.postMaterials[i]);
        m.frustumCulled = false;
        s.add(m);
        meshes.push(m);
      }
      if (typeof renderer.compileAsync === 'function') {
        await renderer.compileAsync(s, c);
      } else {
        renderer.compile(s, c);
      }
      renderer.render(s, c);
      for (let i = 0; i < meshes.length; i++) s.remove(meshes[i]);
      quad.dispose();
    }
    this.report.programsAfterPost = this._programCount();
    this.report.compiledInRtKeySpace =
      this.report.programsAfterPost - this.report.programsBefore;

    // ---- 5b. KEY SPACE B: bound to null (the canvas) ----------------------
    // THE DEFECT THE S2 GATE CAUGHT. With post disabled the real frame renders
    // direct to the canvas, where the program key uses renderer.outputColorSpace
    // (SRGB) and renderer.toneMapping (ACESFilmic) instead of the hardcoded
    // Linear/NoToneMapping of a bound target. Those are DIFFERENT cache keys, so
    // everything compiled above is a cache miss on the first real frame and
    // every lit material recompiles mid-play.
    //
    // Warming this space is a compile plus one scratch render. It is still
    // behind the loading curtain, and the canvas is cleared afterwards, so no
    // real frame is presented. The clock, RNG and accumulator are restored in
    // step 6 exactly as before, so this stays simulation-transparent.
    renderer.setRenderTarget(null);
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(o.scene, o.camera);
    } else {
      renderer.compile(o.scene, o.camera);
    }
    renderer.render(o.scene, o.camera);
    if (o.extraScenes) {
      for (let i = 0; i < o.extraScenes.length; i++) {
        const e = o.extraScenes[i];
        renderer.render(e.scene, e.camera);
      }
    }
    // Clear the canvas so the warm render is never mistaken for a real frame.
    renderer.clear();

    this.report.programsAfterCanvasSpace = this._programCount();
    this.report.compiledInCanvasKeySpace =
      this.report.programsAfterCanvasSpace - this.report.programsAfterPost;
    this.report.programsTotal = this.report.programsAfterCanvasSpace;
    this.report.compiledDuringPrewarm =
      this.report.programsAfterCanvasSpace - this.report.programsBefore;

    // ---- 6. restore EVERYTHING -------------------------------------------
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.enabled = prevShadowEnabled;
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    this.target.dispose();
    this.target = null;

    if (o.loop && loopSnap) o.loop.restore(loopSnap);
    if (o.rng && rngSnap) o.rng.restore(rngSnap);

    // Reset the render counters so the first real frame's stats are not
    // polluted by the scratch renders above.
    renderer.info.reset();
    renderer.info.render.frame = infoBefore.frame;

    // ---- 7. PROVE transparency rather than asserting it -------------------
    // Compare the restored state against the snapshot. If prewarm moved the
    // clock, the RNG or the accumulator, this reports a non-zero drift and the
    // gate fails. An unchecked "it should be transparent" is not evidence.
    let drift = null;
    if (o.loop && loopSnap) {
      const now = o.loop.snapshot();
      drift = {
        accumulator: now.accumulator - loopSnap.accumulator,
        time: now.time - loopSnap.time,
        steps: now.steps - loopSnap.steps,
        frames: now.frames - loopSnap.frames
      };
    }
    let rngDrift = 0;
    if (o.rng && rngSnap) {
      const now = o.rng.snapshot();
      for (const k of Object.keys(rngSnap)) {
        const a = rngSnap[k], b = now[k];
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) rngDrift++;
      }
    }
    this.report.drift = { loop: drift, rngWords: rngDrift };
    this.report.simTransparent =
      rngDrift === 0 &&
      (!drift || (drift.accumulator === 0 && drift.time === 0 &&
                  drift.steps === 0 && drift.frames === 0));

    this.report.ms = Date.now() - t0;
    return this.report;
  }

  dispose() {
    if (this.target) { this.target.dispose(); this.target = null; }
  }
}
