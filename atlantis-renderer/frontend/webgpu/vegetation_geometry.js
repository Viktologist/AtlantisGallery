import {BufferAttribute,BufferGeometry} from '../../vendor/tidewater/src/engine/index.js';

                                                                                  
                                                                           
export function concatenateVegetation(parts,{facesets=false}={}) {
  if(!parts.length)throw Error('Empty vegetation geometry');
  const names=Object.keys(parts[0].attributes).sort(),ranges=[];
  let vertices=0,indices=0;
  for(const g of parts){
    if(!g.index||g.groups.length||g.index.count%3)throw Error('Vegetation needs indexed triangle lists without groups');
    if(Object.keys(g.attributes).sort().join()!==names.join())throw Error('Vegetation vertex semantics differ');
    for(const name of names){const a=g.attributes[name],b=parts[0].attributes[name];if(a.isInterleavedBufferAttribute||a.itemSize!==b.itemSize||a.normalized!==b.normalized||a.array.constructor!==b.array.constructor||a.count!==g.attributes.position.count)throw Error('Vegetation attribute layout differs: '+name);}
    if(!g.index.array.every(i=>i>=0&&i<g.attributes.position.count))throw Error('Vegetation index out of bounds');
    ranges.push({indexCount:g.index.count,firstIndex:indices,baseVertex:vertices});
    vertices+=g.attributes.position.count;indices+=g.index.count;
  }
  const geometry=new BufferGeometry();
  for(const name of names){const a=parts[0].attributes[name],array=new a.array.constructor(vertices*a.itemSize);parts.forEach((g,i)=>array.set(g.attributes[name].array,ranges[i].baseVertex*a.itemSize));geometry.setAttribute(name,new BufferAttribute(array,a.itemSize,a.normalized));}
  const index=new Uint32Array(indices);
  parts.forEach((g,i)=>{const r=ranges[i];for(let j=0;j<r.indexCount;j++)index[r.firstIndex+j]=g.index.array[j]+(facesets?r.baseVertex:0);});
  geometry.setIndex(new BufferAttribute(index,1));
  if(facesets){const ids=new Uint32Array(vertices);parts.forEach((g,i)=>ids.fill(i,ranges[i].baseVertex,ranges[i].baseVertex+g.attributes.position.count));geometry.setAttribute('apsFaceset',new BufferAttribute(ids,1));}
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return {geometry,ranges,commands:new Uint32Array(ranges.flatMap(r=>[r.indexCount,r.firstIndex,r.baseVertex]))};
}

export function vegetationLODView(packed,level,count,bounds){
  const geometry=new BufferGeometry(),r=packed.ranges[level];
  for(const [name,a] of Object.entries(packed.geometry.attributes))geometry.setAttribute(name,a);
  geometry.setIndex(packed.geometry.index);geometry.setDrawRange(r.firstIndex,r.indexCount);
  geometry.boundingBox=bounds;geometry.boundingSphere=packed.geometry.boundingSphere;geometry.instanceCount=count;
  geometry.userData.apsVegetationBufferOwner=packed.geometry;
  return geometry;
}
