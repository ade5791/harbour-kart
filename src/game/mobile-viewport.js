// Game-surface gesture ownership. Does not affect the separate Credits page.
// Pointer Events still own gameplay; these non-passive listeners only suppress
// browser scrolling/pinch gestures (not propagation or single-tap activation).
export function lockGameViewport(root) {
  const bindings = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    bindings.push([target, type, fn, options]);
  };
  const cancel = e => { if (e.cancelable) e.preventDefault(); };
  const opts = { passive: false };
  on(root, 'touchmove', cancel, opts);
  on(root, 'touchstart', e => { if (e.touches.length > 1) cancel(e); }, opts);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) on(root, type, cancel, opts);
  on(root, 'dblclick', cancel, opts);
  on(root, 'contextmenu', e => {
    if (e.target.closest('button, .hk-touch, canvas')) cancel(e);
  }, opts);
  // Browser chrome expanding/collapsing must resize, never reset the race.
  const viewport = window.visualViewport;
  const fit = () => {
    if (viewport && Math.abs(viewport.scale - 1) < 0.01) {
      root.style.width = viewport.width + 'px';
      root.style.height = viewport.height + 'px';
    } else {
      root.style.removeProperty('width');
      root.style.removeProperty('height');
    }
    window.dispatchEvent(new Event('resize'));
  };
  if (viewport) on(viewport, 'resize', fit);
  on(window, 'orientationchange', fit);
  fit();
  return () => {
    for (const [target, type, fn, options] of bindings) target.removeEventListener(type, fn, options);
    bindings.length = 0;
    root.style.removeProperty('width');
    root.style.removeProperty('height');
  };
}
