import {inspectGLB,readMeshAccessor} from './mesh_gltf.js';

export const PLANT_LOD_POLICY=Object.freeze({version:'plant-load-lod/1',meshoptimizer:'1.3',ratios:[1,.5,.2],errors:[.01,.03]});
export const plantLODKey=sha=>sha+':'+PLANT_LOD_POLICY.version;
export const digestPlantBytes=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const BIN=0x004e4942,JSON_CHUNK=0x4e4f534a;
const assert=(ok,message)=>{if(!ok)throw Error('Plant LOD: '+message);};
const primitiveTriangles=(j,p)=>(p.indices===undefined?j.accessors[p.attributes.POSITION].count:j.accessors[p.indices].count)/3;
export const plantMeshTriangles=(j,index)=>j.meshes[index].primitives.reduce((sum,p)=>sum+primitiveTriangles(j,p),0);
function activeMeshes(j){
 const used=new Set(),meshes=new Set(),visit=i=>{if(used.has(i))return;used.add(i);const n=j.nodes?.[i];assert(n,'invalid scene node');if(n.mesh!==undefined)meshes.add(n.mesh);for(const c of n.children??[])visit(c);};
 const scene=j.scenes?.[j.scene??0];if(scene)for(const i of scene.nodes??[])visit(i);else for(let i=0;i<(j.nodes?.length??0);i++)visit(i);
 return [...meshes];
}
export function declaredPlant(j){
 const e=j.extras??{};
 return !!(e.plant_community||e.planting||e.aps_loadtime_lod||['plantfactory-grass-patch/v1','atlantis-plants-grass-patch/v1'].includes(e.schema)||activeMeshes(j).some(i=>j.meshes?.[i]?.extras?.aps_vegetation_lods));
}
async function meshFingerprint(j,bin,index){
 const rows=[];
 for(const p of j.meshes[index].primitives){
  const a=[];for(const key of Object.keys(p.attributes).sort()){const v=readMeshAccessor(j,bin,p.attributes[key]);a.push([key,v.componentType,v.itemSize,v.normalized,await digestPlantBytes(new Uint8Array(v.array.buffer,v.array.byteOffset,v.array.byteLength))]);}
  const indices=p.indices===undefined?null:readMeshAccessor(j,bin,p.indices).array;
  rows.push([p.material,p.mode??4,a,indices?await digestPlantBytes(new Uint8Array(indices.buffer,indices.byteOffset,indices.byteLength)):null]);
 }
 return JSON.stringify(rows);
}
export async function inspectPlantLODs(buffer,{required=false}={}){
 const {json:j,chunks}=inspectGLB(buffer),plant=required||declaredPlant(j),meshes=activeMeshes(j),missing=[],authored=[];
 if(!plant)return {plant:false,missing,authored,meshes:[]};
 assert(meshes.length,'declared plant contains no active mesh');const bin=chunks.find(c=>c.type===BIN)?.bytes;assert(bin,'embedded geometry required');
 for(const index of meshes){
  const mesh=j.meshes?.[index];assert(mesh?.primitives?.length,'invalid active mesh');const ids=mesh.extras?.aps_vegetation_lods;
  let valid=Array.isArray(ids)&&ids.length===3&&ids[0]===index&&new Set(ids).size===3&&ids.every(i=>Number.isInteger(i)&&j.meshes[i]);
  let counts=valid?ids.map(i=>plantMeshTriangles(j,i)):null;
  valid=valid&&counts.every(n=>Number.isInteger(n)&&n>0)&&counts[1]<=counts[0]&&counts[2]<=counts[1];
  if(valid){for(const id of ids){const p=j.meshes[id].primitives;valid&&=p.length===mesh.primitives.length&&p.every((v,i)=>v.material===mesh.primitives[i].material&&Object.keys(v.attributes).sort().join()===Object.keys(mesh.primitives[i].attributes).sort().join());}}
                                                                                             
                                                                
  const built=mesh.extras?.aps_loadtime_lod?.version===PLANT_LOD_POLICY.version;
  if(valid&&!built&&counts[0]===counts[1]&&counts[1]===counts[2]){const hashes=await Promise.all(ids.map(i=>meshFingerprint(j,bin,i)));if(new Set(hashes).size===1)valid=false;}
  (valid?authored:missing).push({mesh:index,name:mesh.name??'mesh '+index,ids:valid?ids:null,triangles:counts??[plantMeshTriangles(j,index)]});
 }
 return {plant:true,meshes,missing,authored};
}
export function encodePlantGLB(json,bin){
 const text=new TextEncoder().encode(JSON.stringify(json)),jl=(text.length+3)&~3,bl=(bin.byteLength+3)&~3,out=new ArrayBuffer(28+jl+bl),v=new DataView(out);
 for(const [o,n]of [[0,0x46546c67],[4,2],[8,out.byteLength],[12,jl],[16,JSON_CHUNK],[20+jl,bl],[24+jl,BIN]])v.setUint32(o,n,true);
 new Uint8Array(out,20,jl).fill(32);new Uint8Array(out,20,text.length).set(text);new Uint8Array(out,28+jl,bin.byteLength).set(bin);return out;
}
export async function buildPlantLODs(buffer,{required=false,sourceSHA=null,onProgress=null}={}){
 const source=inspectGLB(buffer),sourceBin=source.chunks.find(c=>c.type===BIN)?.bytes,sourceSHA256=sourceSHA??await digestPlantBytes(buffer),plan=await inspectPlantLODs(buffer,{required});
 if(!plan.plant||!plan.missing.length)return {buffer,report:{schema:'aps-loadtime-plant-lod/1',version:PLANT_LOD_POLICY.version,key:plantLODKey(sourceSHA256),source_sha256:sourceSHA256,derived_sha256:sourceSHA256,status:plan.plant?'authored':'not-plant',meshes:plan.authored,generated_meshes:0}};
 onProgress?.('constructing');
 const {optimizeVegetationGLB}=await import('../src/vegetation_meshopt.js');
 const normalized=structuredClone(source.json);for(const row of plan.missing)delete normalized.meshes[row.mesh].extras?.aps_vegetation_lods;
 const normalizedBuffer=encodePlantGLB(normalized,sourceBin);
 const optimized=await optimizeVegetationGLB(normalizedBuffer,{meshes:plan.missing.map(r=>r.mesh),ratios:PLANT_LOD_POLICY.ratios,errors:PLANT_LOD_POLICY.errors});
 const derived=inspectGLB(optimized.buffer),derivedBin=derived.chunks.find(c=>c.type===BIN).bytes,json=structuredClone(source.json),pieces=[sourceBin];let length=sourceBin.byteLength;
 const appended=new Map();
 const copyAccessor=index=>{
  if(appended.has(index))return appended.get(index);
  const original=derived.json.accessors[index],a=readMeshAccessor(derived.json,derivedBin,index),bytes=new Uint8Array(a.array.buffer,a.array.byteOffset,a.array.byteLength),aligned=(length+3)&~3;
  if(aligned>length)pieces.push(new Uint8Array(aligned-length));const view=json.bufferViews.length;
  json.bufferViews.push({buffer:0,byteOffset:aligned,byteLength:bytes.byteLength,...(derived.json.bufferViews[original.bufferView]?.target?{target:derived.json.bufferViews[original.bufferView].target}:{})});pieces.push(bytes);length=aligned+bytes.byteLength;
  const accessor=structuredClone(original);delete accessor.byteOffset;delete accessor.sparse;accessor.bufferView=view;
  const id=json.accessors.length;json.accessors.push(accessor);appended.set(index,id);return id;
 };
 const result=[];
 for(const row of plan.missing){
  const index=row.mesh,ids=derived.json.meshes[index].extras.aps_vegetation_lods,newIDs=[index];
  for(const id of ids.slice(1)){const mesh=structuredClone(derived.json.meshes[id]);for(const p of mesh.primitives){for(const name of Object.keys(p.attributes))p.attributes[name]=copyAccessor(p.attributes[name]);p.indices=copyAccessor(p.indices);}newIDs.push(json.meshes.length);json.meshes.push(mesh);}
  const counts=newIDs.map(i=>plantMeshTriangles(json,i)),detail=optimized.report.meshes.find(m=>m.mesh===index);
  const record={mesh:index,name:row.name,ids:newIDs,triangles:counts,reduced:counts[2]<counts[0],ratios:counts.map(n=>n/counts[0]),parts:detail.primitives.map(p=>({material:p.material,levels:p.levels.map(l=>({triangles:l.triangles,target_met:l.target_met,area:l.area,simplifier_calls:l.simplifier_calls,monotonic_fallback:l.monotonic_fallback}))}))};
  json.meshes[index].extras={...json.meshes[index].extras,aps_vegetation_lods:newIDs,aps_vegetation_lod_pixels:source.json.meshes[index].extras?.aps_vegetation_lod_pixels??[200,55],aps_loadtime_lod:{version:PLANT_LOD_POLICY.version,source_sha256:sourceSHA256,triangles:counts,no_reduction:!record.reduced}};result.push(record);
 }
 json.extras={...json.extras,aps_loadtime_lod:{version:PLANT_LOD_POLICY.version,key:plantLODKey(sourceSHA256),source_sha256:sourceSHA256,policy:PLANT_LOD_POLICY}};
 if(json.extras.plant_community)json.extras.plant_community={...json.extras.plant_community,lod_policy:'original LOD0; load-time meshoptimizer component/thickness-aware real LOD1/LOD2'};
 json.buffers=[{...json.buffers[0],byteLength:length}];const bin=new Uint8Array(length);let at=0;for(const p of pieces){bin.set(p,at);at+=p.byteLength;}
 const output=encodePlantGLB(json,bin),checked=await inspectPlantLODs(output,{required:true});assert(!checked.missing.length,'generated LOD contract did not validate');
                                                                                                    
 const preserved=['nodes','scenes','materials','images','textures','samplers'].every(k=>JSON.stringify(json[k])===JSON.stringify(source.json[k]))&&plan.meshes.every(i=>JSON.stringify(json.meshes[i].primitives)===JSON.stringify(source.json.meshes[i].primitives));assert(preserved,'source material, node or LOD0 identity changed');
 return {buffer:output,report:{schema:'aps-loadtime-plant-lod/1',version:PLANT_LOD_POLICY.version,key:plantLODKey(sourceSHA256),source_sha256:sourceSHA256,derived_sha256:await digestPlantBytes(output),status:'built',generated_meshes:result.length,meshes:result,authored:plan.authored,original_bin_prefix_unchanged:true,original_bin_bytes:sourceBin.byteLength,lod0_primitives_unchanged:true,materials_nodes_images_unchanged:true,source_bytes:buffer.byteLength,derived_bytes:output.byteLength}};
}
