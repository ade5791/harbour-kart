// Render-owned Sketchfab dressing. Static, deterministic, outside the full course.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CLEAR_RADIUS } from '../sim/track.js';
import { weatherLandmarkGeometry, adaptHarbourModelMaterial } from './harbour-detail.js';

export class HarbourLandmarks {
  constructor(track) {
    this.track=track; this.group=new THREE.Group(); this.group.name='harbour-landmarks';
    this.owned=new Set(); this.items=[]; this.disposed=false; this.status='loading';
  }
  collect(model) {
    model.traverse(o=>{if(!o.isMesh)return;this.owned.add(o.geometry);
      for(const m of (Array.isArray(o.material)?o.material:[o.material])) {
        this.owned.add(m);for(const v of Object.values(m))if(v?.isTexture)this.owned.add(v);
      }
    });
  }
  // The lighthouse source has 255 tiny meshes. Bake solid material colours into
  // vertices and merge them into one draw, preserving the authored silhouette.
  mergeLighthouse(model) {
    model.updateMatrixWorld(true);const geos=[];
    model.traverse(o=>{if(!o.isMesh)return;
      if(Array.isArray(o.material)||o.material.map)throw Error('Unexpected lighthouse material');
      const g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      for(const k of Object.keys(g.attributes))if(k!=='position'&&k!=='normal')g.deleteAttribute(k);
      if(!g.attributes.normal)g.computeVertexNormals();
      const c=o.material.color||new THREE.Color(1,1,1),a=new Float32Array(g.attributes.position.count*3);
      for(let i=0;i<a.length;i+=3){a[i]=c.r;a[i+1]=c.g;a[i+2]=c.b;}
      g.setAttribute('color',new THREE.BufferAttribute(a,3));g.clearGroups();geos.push(g);
    });
    const geo=mergeGeometries(geos,false);for(const g of geos)g.dispose();
    if(!geo)throw Error('Lighthouse merge failed');
    weatherLandmarkGeometry(geo);
    const mat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.85,metalness:0,name:'lighthouse-baked-colours'});
    this.owned.add(geo);this.owned.add(mat);return new THREE.Mesh(geo,mat);
  }
  normalize(model,height) {
    const pivot=new THREE.Group();pivot.add(model);pivot.updateMatrixWorld(true);
    let b=new THREE.Box3().setFromObject(pivot);const size=b.getSize(new THREE.Vector3());
    if(!Number.isFinite(size.y)||size.y<=0)throw Error('Invalid landmark bounds');
    pivot.scale.setScalar(height/size.y);pivot.updateMatrixWorld(true);
    b=new THREE.Box3().setFromObject(pivot);const c=b.getCenter(new THREE.Vector3());
    model.position.x-=c.x/pivot.scale.x;model.position.z-=c.z/pivot.scale.x;model.position.y-=b.min.y/pivot.scale.x;
    pivot.updateMatrixWorld(true);b=new THREE.Box3().setFromObject(pivot);
    return {pivot,radius:Math.hypot(b.max.x,b.max.z)+.3,size:b.getSize(new THREE.Vector3()).toArray()};
  }
  place(template,kind,station,height,baseY) {
    const {pivot,radius,size}=this.normalize(template,height),p={x:0,z:0,heading:0},q={x:0,z:0,heading:0};
    let placement=null;
    for(const offshore of [18,26,38,54,72]) {
      this.track.offsetPoint(station,-offshore,p);let min=Infinity;
      for(let s=0;s<this.track.course.length;s+=1){this.track.offsetPoint(s,0,q);min=Math.min(min,Math.hypot(p.x-q.x,p.z-q.z));}
      if(min-radius<=CLEAR_RADIUS+5)continue;
      if(this.track.buildings.some(b=>Math.hypot(p.x-b.x,p.z-b.z)<radius+Math.hypot(b.w,b.d||b.w)+3))continue;
      if(this.items.some(b=>Math.hypot(p.x-b.x,p.z-b.z)<radius+b.radius+3))continue;
      placement={kind,station,x:p.x,z:p.z,heading:p.heading,clearance:min-radius,radius,size,offshore};break;
    }
    if(!placement)throw Error('No safe placement for '+kind+' at '+station);
    const root=new THREE.Group();root.name=kind+'-'+station;root.position.set(placement.x,baseY,placement.z);root.rotation.y=placement.heading;root.add(pivot);
    // Lighthouse sits on a stepped stone footing instead of emerging from water.
    // It remains within its already tested bounding radius and clearance.
    if(kind==='lighthouse') {
      const mat=new THREE.MeshStandardMaterial({color:0x807c6a,roughness:0.94});
      this.owned.add(mat);
      for(let i=0;i<3;i++) {
        const r=radius*(0.94-i*0.12);
        const g=new THREE.CylinderGeometry(r,r+0.08,0.28,12);
        this.owned.add(g);const plinth=new THREE.Mesh(g,mat);
        plinth.position.y=0.15+i*0.25;root.add(plinth);
      }
      pivot.position.y=0.72;
    }
    root.traverse(o=>{if(o.isMesh){o.castShadow=kind==='lighthouse';o.receiveShadow=true;
      for(const m of (Array.isArray(o.material)?o.material:[o.material]))adaptHarbourModelMaterial(m);
    }});
    root.userData={...placement,source:'Sketchfab'};this.group.add(root);this.items.push(placement);
  }
  async load() {
    for(const [file,kind] of [['harbour-lighthouse.glb','lighthouse'],['harbour-buoy.glb','navigation-buoy']]) {
      if(this.disposed)return;
      const {scene}=await new GLTFLoader().loadAsync(new URL('../../assets/'+file,import.meta.url).href);
      this.collect(scene);if(this.disposed){this.dispose();return;}
      if(kind==='lighthouse')this.place(this.mergeLighthouse(scene),kind,100,22,-.8);
      else {
        const seen=new Set();
        scene.traverse(o=>{if(!o.isMesh)return;
          if(!seen.has(o.geometry)){weatherLandmarkGeometry(o.geometry);seen.add(o.geometry);}
          for(const m of (Array.isArray(o.material)?o.material:[o.material])) {
            m.vertexColors=true;
            if(m.isMeshStandardMaterial)m.roughness=Math.max(0.58,m.roughness);
          }
        });
        for(const station of [70,230,420,610,800,990])this.place(scene.clone(true),kind,station,3.2,-1.15);
      }
    }
    this.status='ready';
  }
  dispose() {
    this.disposed=true;for(const r of this.owned)r.dispose();this.owned.clear();
    this.group.removeFromParent();this.group.clear();this.items.length=0;
  }
}
