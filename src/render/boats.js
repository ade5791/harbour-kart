// Render-owned, deterministic harbour dressing; never a vehicle or collider.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CLEAR_RADIUS } from '../sim/track.js';
import { adaptHarbourModelMaterial } from './harbour-detail.js';

export const WATER_Y = -0.55;
export const BOAT_LENGTH = 9;

export class HarbourBoats {
  constructor(track) {
    this.track = track;
    this.group = new THREE.Group();
    this.group.name = 'harbour-boats';
    this.items = [];
    this.owned = new Set();
    this.disposed = false;
    this.status = 'loading';
  }

  async load() {
    const gltf = await new GLTFLoader().loadAsync(new URL('../../assets/harbour-fishing-boat.glb', import.meta.url).href);
    const model = gltf.scene;
    model.traverse(o => {
      if (!o.isMesh) return;
      this.owned.add(o.geometry);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        this.owned.add(m);
        adaptHarbourModelMaterial(m);
        for (const v of Object.values(m)) if (v && v.isTexture) this.owned.add(v);
      }
      o.castShadow = true;
      o.receiveShadow = true;
    });
    if (this.disposed) { this.dispose(); return; }
    model.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model);
    const rawSize = box.getSize(new THREE.Vector3());
    if (!Number.isFinite(rawSize.length()) || Math.min(rawSize.x,rawSize.y,rawSize.z) <= 0) {
      this.dispose(); throw Error('Fishing boat has invalid bounds');
    }
    // Convert longest horizontal axis to Z, preserving the authored vertical axis.
    const orient = new THREE.Group();
    orient.add(model);
    if (rawSize.x > rawSize.z) model.rotation.y += Math.PI / 2;
    orient.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(orient);
    const size = box.getSize(new THREE.Vector3());
    const scale = BOAT_LENGTH / size.z;
    orient.scale.setScalar(scale);
    orient.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(orient);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x / scale;
    model.position.z -= center.z / scale;
    model.position.y -= (box.min.y + 0.4) / scale;
    orient.updateMatrixWorld(true);
    this.dimensions = new THREE.Box3().setFromObject(orient).getSize(new THREE.Vector3()).toArray();
    // A bounding sphere covers all possible rocking orientations. Every placement
    // is checked against the WHOLE course, not merely its nearest nominal station.
    const bounds = new THREE.Box3().setFromObject(orient);
    const radius = Math.max(bounds.min.length(), bounds.max.length()) + 0.2;
    this.clearanceRadius = radius;
    const p = {x:0,z:0,heading:0}, q = {x:0,z:0,heading:0};
    for (const station of [36, 566, 918]) {
      let accepted = null;
      for (const offshore of [18, 26, 38, 54]) {
        this.track.offsetPoint(station, -offshore, p);
        let min = Infinity;
        for (let s = 0; s < this.track.course.length; s += 1) {
          this.track.offsetPoint(s, 0, q);
          min = Math.min(min, Math.hypot(p.x-q.x,p.z-q.z));
        }
        if (min - radius > CLEAR_RADIUS + 2) {
          accepted = {x:p.x,z:p.z,heading:p.heading,clearance:min-radius,station,offshore};
          break;
        }
      }
      if (!accepted) continue;
      const root = new THREE.Group();
      root.name = 'fishing-boat-' + station;
      root.position.set(accepted.x, WATER_Y, accepted.z);
      root.rotation.y = accepted.heading;
      root.add(orient.clone(true));
      root.userData = {...accepted, asset:'harbour-fishing-boat.glb', author:'SANKETPUSHKAR', license:'CC BY (as supplied with prepared asset)'};
      this.group.add(root);
      this.items.push({root, yaw:accepted.heading, phase:station * 0.017});
    }
    this.status = this.items.length ? 'ready' : 'no-safe-placement';
    this.sync(0, false);
  }

  // Absolute engine time, bounded motion, no RNG or per-frame allocation.
  sync(timeS, reducedMotion) {
    const t = reducedMotion ? 0 : timeS;
    for (let i=0; i<this.items.length; i++) {
      const b = this.items[i], p = b.phase;
      b.root.position.y = WATER_Y + (reducedMotion ? 0 : Math.sin(t * 0.85+p) * 0.055);
      b.root.rotation.set(reducedMotion ? 0 : Math.sin(t * 0.63+p) * 0.012,
        b.yaw, reducedMotion ? 0 : Math.sin(t * 0.85+p+0.6) * 0.022);
    }
  }

  dispose() {
    this.disposed = true;
    for (const resource of this.owned) resource.dispose();
    this.owned.clear();
    this.items.length = 0;
    this.group.removeFromParent();
    this.group.clear();
  }
}
