                                                                                  
import {MeshoptEncoder} from '../../vendor/meshoptimizer/meshopt_encoder.js';
import {MeshoptSimplifier} from '../../vendor/meshoptimizer/meshopt_simplifier.js';
import {inspectGLB,readMeshAccessor,floatAttribute} from '../webgpu/mesh_gltf.js';

export const MESHOPT_VERSION='1.3';
const BIN=0x004e4942,JSON_CHUNK=0x4e4f534a;
const TYPES={1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4'};
const CTYPE=new Map([[Int8Array,5120],[Uint8Array,5121],[Int16Array,5122],[Uint16Array,5123],[Uint32Array,5125],[Float32Array,5126]]);
const cloneStreams=a=>Object.fromEntries(Object.entries(a).map(([k,v])=>[k,{...v,array:v.array.slice()}]));
function assert(ok,message){if(!ok)throw Error(message);}
function bounds(p){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<p.length;i++){
 const c=i%3;min[c]=Math.min(min[c],p[i]);max[c]=Math.max(max[c],p[i]);}return {min,max,scale:Math.max(...max.map((v,i)=>v-min[i]))};}
function remapStreams(attributes,remap,count){return Object.fromEntries(Object.entries(attributes).map(([key,a])=>{
 const array=new a.array.constructor(count*a.itemSize);for(let i=0;i<remap.length;i++)if(remap[i]!==0xffffffff)
  array.set(a.array.subarray(i*a.itemSize,(i+1)*a.itemSize),remap[i]*a.itemSize);
 return [key,{...a,array}];}));}

                                                                                  
                                                                               
                                                             
export function weldPrimitive(attributes,indices){
 const streams=Object.values(attributes),count=attributes.POSITION.array.length/3;
 const bytes=streams.map(a=>new Uint8Array(a.array.buffer,a.array.byteOffset,a.array.byteLength));
 const widths=streams.map(a=>a.itemSize*a.array.BYTES_PER_ELEMENT);
 const map=new Map(),remap=new Uint32Array(count).fill(0xffffffff),out=new Uint32Array(indices.length);let next=0;
 for(let k=0;k<indices.length;k++){const i=indices[k];assert(i<count,'Index outside vertex buffer');
  if(remap[i]===0xffffffff){let key='';for(let s=0;s<streams.length;s++)for(let j=0;j<widths[s];j++)key+=String.fromCharCode(bytes[s][i*widths[s]+j]);
   let v=map.get(key);if(v===undefined){v=next++;map.set(key,v);}remap[i]=v;}
  out[k]=remap[i];}
 return {attributes:remapStreams(attributes,remap,next),indices:out};
}
function triangleArea(p,a,b,c){const x=[0,1,2].map(k=>p[b*3+k]-p[a*3+k]),y=[0,1,2].map(k=>p[c*3+k]-p[a*3+k]);
 return Math.hypot(x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0])*.5;}
export function surfaceArea(p,indices){let sum=0;for(let i=0;i<indices.length;i+=3)sum+=triangleArea(p,indices[i],indices[i+1],indices[i+2]);return sum;}
function componentGroups(p,indices){
 const remap=MeshoptSimplifier.generatePositionRemap(p,3),parent=Uint32Array.from({length:remap.length},(_,i)=>i);
 const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
 for(let i=0;i<indices.length;i+=3){const a=root(remap[indices[i]]);for(let k=1;k<3;k++){const b=root(remap[indices[i+k]]);if(a!==b)parent[b]=a;}}
 const groups=new Map();for(let i=0;i<indices.length;i+=3){const r=root(remap[indices[i]]);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(indices[i],indices[i+1],indices[i+2]);}
 return {remap,root,groups};
}

                                                                         
                                                                             
                                                                             
                                                                           
export function compensateLeafArea(positions,sourceIndices,lodIndices,{maxOffset=Infinity}={}){
 assert(maxOffset>=0&&!Number.isNaN(maxOffset),'Nonnegative leaf offset cap required');
 const p=positions.slice(),{remap,root,groups}=componentGroups(positions,sourceIndices),low=new Map();
 for(let i=0;i<lodIndices.length;i+=3){const r=root(remap[lodIndices[i]]);if(!low.has(r))low.set(r,[]);low.get(r).push(lodIndices[i],lodIndices[i+1],lodIndices[i+2]);}
 const output=[],rows=[];let maximumOffset=0,restored=0;
 for(const [r,old] of groups){let indices=low.get(r)??[],oldArea=surfaceArea(positions,old),newArea=surfaceArea(positions,indices);
  if(!indices.length||newArea<oldArea*.25){const raw=newArea;indices=old;restored++;rows.push({before:oldArea,raw,after:oldArea,restored:true});for(const i of indices)output.push(i);continue;}
  const vertices=new Set(indices),edges=new Map(),normal=new Map();let perimeter=0;
  for(let i=0;i<indices.length;i+=3)for(let e=0;e<3;e++){
   const a=remap[indices[i+e]],b=remap[indices[i+(e+1)%3]],key=a+':'+b;edges.set(key,(edges.get(key)??0)+1);}
  if(newArea<oldArea)for(let i=0;i<indices.length;i+=3)for(let e=0;e<3;e++){
   const a=remap[indices[i+e]],b=remap[indices[i+(e+1)%3]],c=remap[indices[i+(e+2)%3]];
   if(edges.has(b+':'+a)||edges.get(a+':'+b)!==1)continue;
   const ev=[0,1,2].map(k=>positions[b*3+k]-positions[a*3+k]),el=Math.hypot(...ev);
   const cv=[0,1,2].map(k=>positions[a*3+k]-positions[c*3+k]);
   const cp=cv.reduce((s,v,k)=>s+v*ev[k],0)/(el*el||1),nv=cv.map((v,k)=>v-ev[k]*cp),nl=Math.hypot(...nv);
   if(!nl||!el)continue;for(const v of [a,b]){const n=normal.get(v)??[0,0,0,0];for(let k=0;k<3;k++)n[k]+=nv[k]*el/nl;n[3]+=el;normal.set(v,n);}perimeter+=el;
  }
  const used=Array.from(vertices),local=[];for(const v of used)local.push(...positions.subarray(v*3,v*3+3));
  const cap=Math.min(maxOffset,bounds(local).scale*.15),distance=perimeter?(oldArea-newArea)/perimeter:0;
  const offsets=new Map();let offset=0;
  for(const [v,n] of normal){const q=n.slice(0,3).map(x=>x/n[3]),nn=q.reduce((s,x)=>s+x*x,0),d=q.map(x=>x*distance/Math.max(.15,nn));
   const length=Math.hypot(...d),factor=Math.min(1,cap/(length||1));offsets.set(v,d.map(x=>x*factor));offset=Math.max(offset,length*factor);}
  const apply=f=>{for(const v of vertices){const d=offsets.get(remap[v]);for(let k=0;k<3;k++)p[v*3+k]=positions[v*3+k]+(d?.[k]??0)*f;}};
  apply(1);let after=surfaceArea(p,indices),factor=1;
                                                                              
                                                                             
  if(after>oldArea*1.001){let lo=0,hi=1;for(let step=0;step<12;step++){const mid=(lo+hi)*.5;apply(mid);if(surfaceArea(p,indices)>oldArea)hi=mid;else lo=mid;}factor=lo;apply(factor);after=surfaceArea(p,indices);}
                                                                              
                                                                             
  if(after<oldArea*.85){for(const v of vertices)for(let k=0;k<3;k++)p[v*3+k]=positions[v*3+k];for(const i of old)output.push(i);restored++;rows.push({before:oldArea,raw:newArea,after:oldArea,restored:true});continue;}
  maximumOffset=Math.max(maximumOffset,offset*factor);rows.push({before:oldArea,raw:newArea,after,restored:false});
  for(const i of indices)output.push(i);
 }
 const sum=k=>rows.reduce((s,r)=>s+r[k],0);
 return {positions:p,indices:new Uint32Array(output),report:{components:rows.length,restored_components:restored,
  source_area_m2:sum('before'),simplified_area_m2:sum('raw'),compensated_area_m2:sum('after'),max_offset_m:maximumOffset,
  coverage:'geometric area approximation; alpha silhouette and light transmission require visual review'}};
}

function attributeMetric(attributes,indices){
                                                                               
                                                                                 
                                                                              
 if(!attributes.NORMAL){const p=attributes.POSITION.array,n=new Float32Array(p.length);for(let i=0;i<indices.length;i+=3){const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
  const x=[0,1,2].map(k=>p[b+k]-p[a+k]),y=[0,1,2].map(k=>p[c+k]-p[a+k]),v=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
  for(const vertex of [a,b,c])for(let k=0;k<3;k++)n[vertex+k]+=v[k];}
  for(let i=0;i<n.length;i+=3){const length=Math.hypot(n[i],n[i+1],n[i+2])||1;for(let k=0;k<3;k++)n[i+k]/=length;}
  attributes={...attributes,NORMAL:{array:n,itemSize:3}};
 }
 const names=Object.keys(attributes).filter(k=>k!=='POSITION'),count=attributes.POSITION.array.length/3;
 const widths=names.map(k=>attributes[k].itemSize),stride=widths.reduce((a,b)=>a+b,0);
 assert(stride<=32,'Meshoptimizer supports at most 32 error attributes');
 const out=new Float32Array(count*stride),weights=[];let offset=0;
 for(const key of names){const a=attributes[key],values=floatAttribute(a),weight=key==='NORMAL'?.5:key.startsWith('TEXCOORD')?1:.5;
  for(let i=0;i<count;i++)for(let c=0;c<a.itemSize;c++)out[i*stride+offset+c]=values[i*a.itemSize+c];
  for(let c=0;c<a.itemSize;c++)weights.push(weight);offset+=a.itemSize;}
 return {out,stride,weights};
}

function simplifyComponents(base,metric,ratio,errorMeters,foliage){
 const p=base.attributes.POSITION.array,{groups}=componentGroups(p,base.indices),output=[];let error=0,calls=0;
 for(const old of groups.values()){
  const vertices=[...new Set(old)],map=new Map(vertices.map((v,i)=>[v,i])),positions=new Float32Array(vertices.length*3),attributes=new Float32Array(vertices.length*Math.max(1,metric.stride));
  vertices.forEach((v,i)=>{positions.set(p.subarray(v*3,v*3+3),i*3);attributes.set(metric.out.subarray(v*metric.stride,(v+1)*metric.stride),i*metric.stride);});
  const indices=Uint32Array.from(old,v=>map.get(v)),locks=new Uint8Array(vertices.length);
                                                                              
                                                                               
  let a=0;for(let i=1;i<vertices.length;i++)if(positions[i*3]<positions[a*3])a=i;
  const distance=(i,j)=>[0,1,2].reduce((s,k)=>s+(positions[i*3+k]-positions[j*3+k])**2,0);
  let b=a;for(let i=0;i<vertices.length;i++)if(distance(i,a)>distance(b,a))b=i;
  let c=a,best=0;for(let i=0;i<vertices.length;i++){const area=triangleArea(positions,a,b,i);if(area>best){best=area;c=i;}}
  for(let i=0;i<vertices.length;i++)if([a,b,c].some(v=>distance(i,v)===0))locks[i]=1;
  const target=Math.max(3,Math.floor(indices.length*ratio/3)*3);
  const bnd=bounds(positions),extents=bnd.max.map((v,i)=>v-bnd.min[i]).filter(v=>v>0);
  const limit=foliage?errorMeters:Math.min(errorMeters,Math.min(...extents)*.25);
  let reduced=indices;if(indices.length>target&&best){let e;[reduced,e]=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,attributes,metric.stride||1,metric.stride?metric.weights:[0],locks,target,limit,foliage?['ErrorAbsolute','PreserveFolds','RegularizeLight']:['ErrorAbsolute','RegularizeLight']);error=Math.max(error,e);calls++;}
  if(!reduced.length)reduced=indices;for(const i of reduced)output.push(vertices[i]);
 }
 return {indices:new Uint32Array(output),error,calls};
}
export async function optimizePrimitive(attributes,sourceIndices,{foliage=false,ratios=[1,.5,.2],errors=[.01,.03]}={}){
 await Promise.all([MeshoptEncoder.ready,MeshoptSimplifier.ready]);
 assert(MeshoptEncoder.supported&&MeshoptSimplifier.supported,'WebAssembly meshoptimizer is unavailable');
 assert(ratios.length===3&&ratios[0]===1&&ratios[1]>ratios[2]&&ratios[2]>0&&ratios[1]<1,'Require ratios 1 > LOD1 > LOD2 > 0');
 assert(errors.length===2&&errors.every(e=>Number.isFinite(e)&&e>0)&&errors[1]>=errors[0],'Invalid LOD error limits');
 assert(attributes.POSITION?.itemSize===3,'VEC3 POSITION required');
 const count=attributes.POSITION.array.length/3;
 assert(attributes.POSITION.array instanceof Float32Array,'POSITION must be float32 (no lossy requantization)');
 for(const [key,a] of Object.entries(attributes)){assert(a.array.length/a.itemSize===count&&[1,2,3,4].includes(a.itemSize),'Mismatched vertex stream '+key);
  assert(a.array.every(Number.isFinite),'Nonfinite vertex attribute '+key);}
 assert(sourceIndices.length>0&&sourceIndices.length%3===0&&sourceIndices.every(i=>Number.isInteger(i)&&i>=0&&i<count),'Valid nonempty triangle list required');
 const base=weldPrimitive(attributes,sourceIndices),positions=base.attributes.POSITION.array,metric=attributeMetric(base.attributes,base.indices);
 const scale=MeshoptSimplifier.getScale(positions,3),levels=[];
 for(let level=0;level<3;level++){
  let streams=cloneStreams(base.attributes),indices=base.indices.slice(),error=0,area=null,calls=0;
  if(level){const result=simplifyComponents(base,metric,ratios[level],errors[level-1]*scale,foliage);indices=result.indices;error=scale?result.error/scale:0;calls=result.calls;
   if(!indices.length)indices=base.indices.slice();
   if(foliage){const compensated=compensateLeafArea(positions,base.indices,indices,{maxOffset:errors[level-1]*scale});
    streams.POSITION.array=compensated.positions;indices=compensated.indices;area=compensated.report;}
  }
                                                                            
  const monotonicFallback=level>0&&indices.length>levels[level-1].indices.length;
  if(monotonicFallback){const previous=levels[level-1];streams=cloneStreams(previous.attributes);indices=previous.indices.slice();error=previous.report.simplification_error_m/(scale||1);area=previous.report.area;}
  const [remap,vertices]=MeshoptEncoder.reorderMesh(indices,true,false);streams=remapStreams(streams,remap,vertices);
  levels.push({attributes:streams,indices,report:{level,part:foliage?'foliage':'wood',source_triangles:sourceIndices.length/3,
   triangles:indices.length/3,vertices,ratio:indices.length/sourceIndices.length,target_ratio:ratios[level],target_met:indices.length<=base.indices.length*ratios[level]+3,
   simplification_error_m:error*scale,conservative_error_m:error*scale+(area?.max_offset_m??0),area,
   simplifier:level?'simplifyWithAttributes':null,simplifier_calls:calls,monotonic_fallback:monotonicFallback,derived_normal_error_metric:!base.attributes.NORMAL,
   vertex_bytes:Object.values(streams).reduce((s,a)=>s+a.array.byteLength,0),index_bytes:vertices<=65535?indices.length*2:indices.byteLength}});
 }
 return levels;
}

function isFoliage(material,index,options){
 if(options.foliageMaterials)return options.foliageMaterials.includes(index);
 const part=material?.extras?.aps_vegetation_part;if(part)return part==='foliage';
 return material?.alphaMode==='MASK'&&material.doubleSided||material?.extras?.principled?.diffuseTransmission>0||
  /leaf|leaves|foliage|frond|grass|petal|needle|叶|花瓣/i.test(material?.name??'');
}
function appendAccessor(json,chunks,attribute,target,metadata={}){
 const array=attribute.array,componentType=CTYPE.get(array.constructor);assert(componentType&&TYPES[attribute.itemSize],'Unsupported attribute encoding');
 const bv=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:0,byteLength:array.byteLength,target});
 chunks.set(bv,new Uint8Array(array.buffer,array.byteOffset,array.byteLength));
 const a={bufferView:bv,componentType,count:array.length/attribute.itemSize,type:TYPES[attribute.itemSize]};if(attribute.normalized)a.normalized=true;
 for(const key of ['name','extras'])if(metadata[key]!==undefined)a[key]=structuredClone(metadata[key]);
 if(target===34962&&attribute.itemSize===3&&attribute.isPosition){const b=bounds(array);a.min=b.min;a.max=b.max;}
 json.accessors.push(a);return json.accessors.length-1;
}
function compactAndPack(json,chunks){
 const refs=[];for(const mesh of json.meshes)for(const primitive of mesh.primitives){for(const key of Object.keys(primitive.attributes))refs.push([primitive.attributes,key]);if(primitive.indices!==undefined)refs.push([primitive,'indices']);}
 for(const node of json.nodes??[]){const a=node.extensions?.EXT_mesh_gpu_instancing?.attributes;for(const k of Object.keys(a??{}))refs.push([a,k]);}
 const used=[...new Set(refs.map(([o,k])=>o[k]))].sort((a,b)=>a-b),map=new Map(used.map((x,i)=>[x,i]));
 json.accessors=used.map(i=>json.accessors[i]);for(const [o,k] of refs)o[k]=map.get(o[k]);
                                                                              
                                                                         
 const viewRefs=[];function scan(value){if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){
  if(k==='bufferView'&&Number.isInteger(v))viewRefs.push([value,k]);else if(k!=='bufferViews')scan(v);}}
 scan(json);const views=[...new Set(viewRefs.map(([o,k])=>o[k]))].sort((a,b)=>a-b),vmap=new Map(views.map((x,i)=>[x,i]));
 const data=[];let length=0;for(const i of views){length=(length+3)&~3;const bytes=chunks.get(i);assert(bytes,'Missing buffer view payload');
  const view={...json.bufferViews[i],buffer:0,byteOffset:length};data.push({view,bytes});length+=bytes.length;}
 for(const [o,k] of viewRefs)o[k]=vmap.get(o[k]);json.bufferViews=data.map(x=>x.view);json.buffers=[{byteLength:length}];
 const encoded=new TextEncoder().encode(JSON.stringify(json)),jl=(encoded.length+3)&~3,bl=(length+3)&~3;
 const buffer=new ArrayBuffer(28+jl+bl),dv=new DataView(buffer);dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);dv.setUint32(8,buffer.byteLength,true);
 dv.setUint32(12,jl,true);dv.setUint32(16,JSON_CHUNK,true);new Uint8Array(buffer,20,jl).fill(32);new Uint8Array(buffer,20,encoded.length).set(encoded);
 dv.setUint32(20+jl,bl,true);dv.setUint32(24+jl,BIN,true);for(const {view,bytes} of data)new Uint8Array(buffer,28+jl+view.byteOffset,bytes.length).set(bytes);
 return buffer;
}
export async function optimizeVegetationGLB(buffer,options={}){
 const {json:source,chunks:sourceChunks}=inspectGLB(buffer),json=structuredClone(source),bin=sourceChunks.find(c=>c.type===BIN)?.bytes;
 assert(bin,'Embedded geometry BIN required');assert(!source.animations?.length&&!source.skins?.length&&!source.nodes?.some(n=>n.skin!==undefined),'Static vegetation only; animation/skin data must use a separate optimizer');
 assert((source.buffers??[]).length===1&&!source.buffers[0].uri,'Self-contained GLB required');
 assert(Number.isInteger(source.buffers[0].byteLength)&&source.buffers[0].byteLength<=bin.length,'Invalid embedded buffer size');
 assert((source.images??[]).every(i=>i.uri===undefined||/^data:/.test(i.uri)),'External images require embedding before writing a derivative');
 assert(sourceChunks.every(c=>[BIN,JSON_CHUNK].includes(c.type)),'Unknown GLB chunk cannot be relocated safely');
 for(const bv of source.bufferViews??[]){assert(bv.buffer===0&&!bv.extensions,'Compressed/extended buffer views require prior decoding');
  assert(Number.isInteger(bv.byteOffset??0)&&(bv.byteOffset??0)>=0&&Number.isInteger(bv.byteLength)&&bv.byteLength>=0&&(bv.byteOffset??0)+bv.byteLength<=source.buffers[0].byteLength,'Invalid buffer view bounds');}
                                                                                
                                                                         
 for(const node of source.nodes??[])assert(Object.keys(node.extensions??{}).every(k=>['EXT_mesh_gpu_instancing','KHR_lights_punctual'].includes(k)),'Unsupported node extension in offline optimizer');
 assert(Object.keys(source.extensions??{}).every(k=>k==='KHR_lights_punctual'),'Unsupported root extension in offline optimizer');
 for(const accessor of source.accessors??[])assert(!accessor.extensions,'Unsupported accessor extension in offline optimizer');
 for(const mesh of source.meshes??[])for(const p of mesh.primitives??[])assert(!p.targets?.length&&!p.extensions,'Static uncompressed primitives required, including unselected meshes');
 const thresholds=options.thresholds??[200,55];assert(thresholds.length===2&&thresholds.every(Number.isFinite)&&thresholds[0]>thresholds[1]&&thresholds[1]>0,'Invalid LOD pixel thresholds');
 if(options.foliageMaterials)assert(options.foliageMaterials.every(i=>Number.isInteger(i)&&i>=0&&source.materials?.[i]),'Select existing foliage materials');
 const chunks=new Map((source.bufferViews??[]).map((bv,i)=>[i,bin.subarray(bv.byteOffset??0,(bv.byteOffset??0)+bv.byteLength)]));
 const selected=options.meshes??[...new Set((source.nodes??[]).filter(n=>n.mesh!==undefined).map(n=>n.mesh))];
 assert(selected.length&&new Set(selected).size===selected.length&&selected.every(i=>Number.isInteger(i)&&source.meshes?.[i]),'Select unique existing source meshes');
 const report={schema:'aps-vegetation-meshopt/1',meshoptimizer:MESHOPT_VERSION,meshes:[],source_bytes:buffer.byteLength,
  policy:'lossless LOD0 cache/fetch optimization; component/thickness-aware wood; anchored leaf sheets with bounded border dilation',
  material_texture_instance_data_preserved:true,wind_attributes_preserved:true,production_wind_implementation:false};
 const cache=new Map(),read=i=>{if(!cache.has(i))cache.set(i,readMeshAccessor(source,bin,i));return cache.get(i);};
 for(const index of selected){const src=source.meshes[index];assert(!src.extras?.aps_vegetation_lods,'Source already has vegetation LODs; select the original prototype');
  const lodMeshes=Array.from({length:3},(_,level)=>({...structuredClone(src),name:(src.name??'vegetation')+' LOD'+level,primitives:[]}));
  for(const lod of lodMeshes){lod.extras={...lod.extras};delete lod.extras.aps_vegetation_lods;}
  const row={mesh:index,name:src.name,primitives:[]};
  for(let pi=0;pi<src.primitives.length;pi++){const primitive=src.primitives[pi],material=source.materials?.[primitive.material];
   assert((primitive.mode??4)===4&&!primitive.targets?.length&&!primitive.extensions,'Require static uncompressed triangle primitives');
   assert(material?.alphaMode!=='BLEND','Alpha BLEND is incompatible with the vegetation LOD runtime');
   const attributes=Object.fromEntries(Object.entries(primitive.attributes).map(([k,i])=>[k,read(i)]));
   const indexAccessor=primitive.indices!==undefined?read(primitive.indices):null;
   assert(!indexAccessor||indexAccessor.itemSize===1&&!indexAccessor.normalized&&[Uint8Array,Uint16Array,Uint32Array].some(A=>indexAccessor.array instanceof A),'Unsigned scalar index accessor required');
   const indices=indexAccessor?new Uint32Array(indexAccessor.array):Uint32Array.from({length:attributes.POSITION.array.length/3},(_,i)=>i);
   const levels=await optimizePrimitive(attributes,indices,{...options,foliage:isFoliage(material,primitive.material,options)});
   for(let level=0;level<3;level++){const data=levels[level],p={...structuredClone(primitive),attributes:{}};
    for(const [key,a] of Object.entries(data.attributes))p.attributes[key]=appendAccessor(json,chunks,{...a,isPosition:key==='POSITION'},34962,source.accessors[primitive.attributes[key]]);
    const typed=data.report.vertices<=65535?new Uint16Array(data.indices):data.indices;
    p.indices=appendAccessor(json,chunks,{array:typed,itemSize:1},34963,source.accessors[primitive.indices]);lodMeshes[level].primitives.push(p);}
   row.primitives.push({primitive:pi,material:primitive.material,levels:levels.map(l=>l.report)});
  }
  const lodIds=[index,json.meshes.length,json.meshes.length+1];lodMeshes[0].extras={...lodMeshes[0].extras,aps_vegetation_lods:lodIds,
   aps_vegetation_lod_pixels:options.thresholds??src.extras?.aps_vegetation_lod_pixels??[200,55],aps_meshopt:{version:MESHOPT_VERSION,source_mesh:index,area_compensation:'bounded leaf borders'}};
  json.meshes[index]=lodMeshes[0];json.meshes.push(lodMeshes[1],lodMeshes[2]);report.meshes.push(row);
 }
 const output=compactAndPack(json,chunks);report.output_bytes=output.byteLength;
 report.triangles=[0,1,2].map(level=>report.meshes.reduce((sum,m)=>sum+m.primitives.reduce((s,p)=>s+p.levels[level].triangles,0),0));
 return {buffer:output,report};
}
