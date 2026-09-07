// CPU equivalent of Three.js r180 ACES. Output is display-linear RGB.
export function displayRGB(rgb, exposure = 1) {
  const mul = (m, v) => m.map(r => r[0]*v[0]+r[1]*v[1]+r[2]*v[2]);
  let c = mul([[.59719,.35458,.04823],[.076,.90834,.01566],[.0284,.13383,.83777]], rgb.map(v=>v*exposure/.6));
  c = c.map(v=>(v*(v+.0245786)-.000090537)/(v*(.983729*v+.432951)+.238081));
  return mul([[1.60475,-.53108,-.07367],[-.10208,1.10813,-.00605],[-.00327,-.07276,1.07602]],c).map(v=>Math.min(1,Math.max(0,v)));
}
export const photometricLum = c => .2126*c[0]+.7152*c[1]+.0722*c[2];
export function radianceForDisplay(chroma, target, exposure) {
  let lo=0,hi=10000;
  for(let i=0;i<100;i++){const k=(lo+hi)/2;if(photometricLum(displayRGB(chroma.map(v=>v*k),exposure))<target)lo=k;else hi=k;}
  return chroma.map(v=>v*(lo+hi)/2);
}
export function unitLuminance(c) { const l=photometricLum(c);return c.map(v=>v/l); }
