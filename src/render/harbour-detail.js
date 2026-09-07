import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Render-only facade kit: all ornaments stay inside the existing roof envelope.
// Two merged material slots, no new lights, no runtime allocations or RNG use.
export function buildHarbourDetail(harbour) {
  const stone = [], timber = [];
  let count = 0;
  for (const b of harbour.track.buildings) {
    const add = (slot, w, h, d, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);g.rotateY(b.yaw);g.translate(b.x, 0, b.z);
      slot.push(g);count++;
    };
    for (const side of [-1, 1]) {
      const face = side * (b.depth / 2 + 0.10);
      add(stone,b.w+0.28,0.22,0.32,0,b.h-0.12,face);
      add(stone,b.w+0.18,0.32,0.24,0,0.20,face);
      for (let floor=0;floor<Math.max(1,b.floors);floor++) {
        const y = (floor+0.53)*b.h/Math.max(1,b.floors);
        const wh = Math.min(1.5,b.h/Math.max(1,b.floors)*0.44);
        for(let j=0;j<b.arches;j++) {
          const x=((j+0.5)/b.arches*2-1)*b.w*0.34;
          const ww=Math.min(1.15,b.w/b.arches*0.43);
          add(timber,ww,wh,0.12,x,y,face);
          add(stone,ww+0.23,0.13,0.32,x,y-wh/2,face+side*0.08);
          add(stone,0.075,wh,0.16,x,y,face+side*0.08);
          for(const sign of [-1,1]) add(timber,0.17,wh+0.15,0.24,x+sign*(ww/2+0.15),y,face);
        }
      }
      // Striped shop awnings break up the waterfront silhouette at ground level.
      if (b.balcony) {
        const span=b.w*0.50;
        for(let stripe=0;stripe<6;stripe++) {
          add(stripe%2?stone:timber,span/6,0.12,0.74,(stripe-2.5)*span/6,2.25,face+side*0.24);
        }
      }
    }
  }
  for(const [name,parts,base,tint] of [
    ['facade-stone-trim',stone,'stone',0xe4d9b9],
    ['facade-teal-shutters',timber,'boardwalk',0x638b83]
  ]) {
    if(!parts.length)continue;
    const geometry=harbour._own(mergeGeometries(parts));
    for(const g of parts)g.dispose();
    const material=harbour._own(harbour.mats.get(base).clone());
    material.vertexColors=false;material.color.setHex(tint);material.name=name;
    harbour._track(geometry,name,material,false,true);
  }
  harbour.stats.facadeDetailParts=count;
}

// Deterministic model-space weathering: keeps source material hue/texture and
// authors gentle crevice/waterline tone rather than flattening every material.
export function weatherLandmarkGeometry(geometry) {
  const pos=geometry.getAttribute('position'),normal=geometry.getAttribute('normal');
  geometry.computeBoundingBox();
  const box=geometry.boundingBox, height=Math.max(0.001,box.max.y-box.min.y);
  let color=geometry.getAttribute('color');
  if(!color){color=new THREE.BufferAttribute(new Float32Array(pos.count*3).fill(1),3);geometry.setAttribute('color',color);}
  for(let i=0;i<pos.count;i++) {
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    const foot=Math.exp(-((y-box.min.y)/height)*9);
    const grain=0.5+0.5*Math.sin(x*8.3+z*5.7+y*13.1);
    const under=normal?Math.max(0,-normal.getY(i)):0;
    const tone=1-0.17*foot-0.055*grain-0.08*under;
    color.setXYZ(i,color.getX(i)*tone,color.getY(i)*tone,color.getZ(i)*tone);
  }
  color.needsUpdate=true;
}

// Imported PBR art uses full-range base colours, unlike the reference-calibrated
// procedural palette. Adapt outgoing radiance, not albedo, to this exposure.
// Apply fog in linear space before the shared output transform on BOTH paths.
export function adaptHarbourModelMaterial(material) {
  if(material.userData.harbourRadianceAdapted)return;
  material.userData.harbourRadianceAdapted=true;
  material.onBeforeCompile=shader=>{
    const fog=THREE.ShaderChunk.fog_fragment.replace('fogColor, fogFactor','vec3(0.042, 0.056, 0.050), fogFactor');
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <opaque_fragment>','outgoingLight *= 0.24;\n#include <opaque_fragment>')
      .replace('#include <fog_fragment>','')
      .replace('#include <tonemapping_fragment>',fog+'\n#include <tonemapping_fragment>');
  };
  material.customProgramCacheKey=()=> 'harbour-import-radiance-v1';
  material.needsUpdate=true;
}
