// Blender-authored articulated asset adapter. Physics dimensions remain authoritative.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { W, L, TYRE_W_FRONT, TYRE_W_REAR, TYRE_R_FRONT, TYRE_R_REAR } from '../sim/kartsize.js';

export async function loadCoachwork(res) {
  const gltf = await new GLTFLoader().loadAsync(new URL('../../assets/kart-coachwork-v3.glb', import.meta.url).href);
  gltf.scene.updateMatrixWorld(true);
  const bins = {coachwork: [], wheel_fl: [], wheel_fr: [], wheel_rl: [], wheel_rr: []};
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const originalGeo = new Set(), originalMat = new Set();
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    originalGeo.add(o.geometry); originalMat.add(o.material);
    const key = Object.keys(bins).find(k => o.name.startsWith(k));
    if (!key) throw Error('Unknown coachwork part: ' + o.name);
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const mat = o.material.clone();
    const n = mat.name.toLowerCase();
    const paint = /paint|body|teal/.test(n);
    mat.metalness = /steel|metal|chrome|rim/.test(n) ? 1 : 0;
    mat.roughness = /rubber|grip/.test(n) ? 0.88 : paint ? 0.32 : 0.5;
    bins[key].push({geo, mat, paint});
  });
  for (const key of Object.keys(bins)) {
    const parts = bins[key];
    if (!parts.length) throw Error('Missing articulated part: ' + key);
    const b = new THREE.Box3();
    for (const p of parts) { p.geo.computeBoundingBox(); b.union(p.geo.boundingBox); }
    const c = b.getCenter(new THREE.Vector3()), d = b.getSize(new THREE.Vector3());
    for (const p of parts) {
      if (key === 'coachwork') {
        p.geo.translate(-mid.x, -box.min.y, -mid.z);
        p.geo.scale(W/size.x, 1.05, L/size.z);
        p.geo.translate(0, 0.065, 0);
      } else {
        const front = key === 'wheel_fl' || key === 'wheel_fr';
        const r = front ? TYRE_R_FRONT : TYRE_R_REAR;
        p.geo.translate(-c.x, -c.y, -c.z);
        p.geo.scale((front ? TYRE_W_FRONT : TYRE_W_REAR)/d.x, 2*r/d.y, 2*r/d.z);
      }
      p.geo.computeBoundingBox(); p.geo.computeBoundingSphere();
    }
  }
  for (const g of originalGeo) g.dispose();
  for (const m of originalMat) m.dispose();
  res.coachwork = bins;
  res.coachworkMats = res.liveryMats.map(lm => {
    const out = new Map();
    for (const parts of Object.values(bins)) for (const p of parts) {
      const m = p.mat.clone();
      if (p.paint) m.color.copy(lm.body.color);
      out.set(p, m);
    }
    return out;
  });
}

export function attachCoachwork(kart) {
  const bins = kart.res.coachwork;
  if (!bins) return;
  // Retain the seated driver, flag, sockets and ground contact shadows.
  for (const o of [...kart.body.children]) {
    if (/^(chassis_|sidepod_|roll_hoop$)/.test(o.name)) kart.body.remove(o);
  }
  kart.sockets.exhaust.clear();
  const shell = new THREE.Group(); shell.name = 'authored_coachwork';
  kart.body.add(shell);
  const mats = kart.res.coachworkMats[kart.liveryIndex];
  for (const [key, parts] of Object.entries(bins)) {
    const parent = key === 'coachwork' ? shell : kart.sockets[key];
    if (key !== 'coachwork') parent.clear();
    for (const p of parts) {
      const mesh = new THREE.Mesh(p.geo, mats.get(p));
      mesh.name = key + '_authored'; mesh.castShadow = true; mesh.receiveShadow = true;
      parent.add(mesh);
    }
  }
  kart.authored = true;
}

export function disposeCoachwork(res) {
  if (!res.coachwork) return;
  for (const parts of Object.values(res.coachwork)) for (const p of parts) { p.geo.dispose(); p.mat.dispose(); }
  for (const set of res.coachworkMats) for (const m of set.values()) m.dispose();
  res.coachwork = null; res.coachworkMats = null;
}
