import {ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {loadMesh} from './mesh_adapter.js';
import {concatenateVegetation} from './vegetation_geometry.js';
import {createVegetationMaterial} from './vegetation_material.js';

export const GRASS_IMPOSTOR_PATCH_SCHEMAS=Object.freeze(['plantfactory-grass-impostor/v1','atlantis-plants-grass-impostor/v1']);
                                                                                
                                                                              
                                             
export const GRASS_IMPOSTOR_PATCH_LIMITS=Object.freeze({area_min_m2:.15,area_max_m2:4,instances:112,core_tufts:64,satellite_tufts:48,proxy_triangles:6,rendered_triangles:672,stored_triangles:12,max_footprint_area_m2:16});

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const integer=value=>Number.isInteger(value);

function matrixFromNode(node,label){
 if(node.matrix!==undefined){
  if(!Array.isArray(node.matrix)||node.matrix.length!==16||!node.matrix.every(finite))throw Error('Invalid grass impostor node matrix at '+label);
  return node.matrix.slice();
 }
 const t=node.translation??[0,0,0],r=node.rotation??[0,0,0,1],s=node.scale??[1,1,1];
 if(![t,r,s].every(value=>Array.isArray(value)&&value.every(finite))||t.length!==3||r.length!==4||s.length!==3)throw Error('Invalid grass impostor node TRS at '+label);
 const [x,y,z,w]=r,xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;
 return [(1-2*(yy+zz))*s[0],2*(xy+wz)*s[0],2*(xz-wy)*s[0],0,2*(xy-wz)*s[1],(1-2*(xx+zz))*s[1],2*(yz+wx)*s[1],0,2*(xz+wy)*s[2],2*(yz-wx)*s[2],(1-2*(xx+yy))*s[2],0,t[0],t[1],t[2],1];
}
function multiplyMatrix(a,b){
 const out=new Array(16).fill(0);
 for(let column=0;column<4;column++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)out[column*4+row]+=a[k*4+row]*b[column*4+k];
 return out;
}
function transformPoint(m,p){
 return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
}
function rigidMatrix(m,label){
 const lengths=[0,1,2].map(column=>Math.hypot(m[column*4],m[column*4+1],m[column*4+2]));
 const dot=(a,b)=>m[a*4]*m[b*4]+m[a*4+1]*m[b*4+1]+m[a*4+2]*m[b*4+2];
 const determinant=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
 if(!m.every(finite)||lengths.some(length=>Math.abs(length-1)>1e-6)||Math.abs(dot(0,1))>1e-6||Math.abs(dot(0,2))>1e-6||Math.abs(dot(1,2))>1e-6||determinant<=0)throw Error('Grass impostor proxy instance must be a proper rigid transform at '+label);
}
function documentShape(document){
 const nodes=document.nodes??[],meshes=document.meshes??[],accessors=document.accessors??[],materials=document.materials??[];
 if(!Array.isArray(nodes)||!Array.isArray(meshes)||!Array.isArray(accessors)||!Array.isArray(materials))throw Error('Native grass patch proxy has invalid glTF arrays');
 if(meshes.length<1||meshes.length>2)throw Error('Native grass patch proxy must store one or two six-triangle proxy meshes');
 const trianglesByMesh=[];
 for(let index=0;index<meshes.length;index++){
  const mesh=meshes[index],primitives=mesh?.primitives;
  if(!Array.isArray(primitives)||primitives.length!==3)throw Error('Native grass patch proxy mesh must keep three plane primitives');
  let triangles=0;
  for(const primitive of primitives){
   if((primitive?.mode??4)!==4||!integer(primitive.indices))throw Error('Native grass patch proxy must keep indexed triangle-list planes');
   const indices=accessors[primitive.indices];
   if(!indices||indices.type!=='SCALAR'||!integer(indices.count)||indices.count<6||indices.count%3)throw Error('Native grass patch proxy has invalid plane indices');
   const planeTriangles=indices.count/3;
   if(planeTriangles!==2)throw Error('Native grass patch proxy plane is not two triangles');
   const material=materials[primitive.material];
   if(!material||material.alphaMode!=='MASK'||material.doubleSided!==true)throw Error('Native grass patch proxy must keep double-sided MASK planes');
   const position=accessors[primitive.attributes?.POSITION];
   if(!position||position.type!=='VEC3'||!Array.isArray(position.min)||!Array.isArray(position.max)||position.min.length!==3||position.max.length!==3||!position.min.every(finite)||!position.max.every(finite))throw Error('Native grass patch proxy lacks finite position bounds');
   triangles+=planeTriangles;
  }
  if(triangles!==GRASS_IMPOSTOR_PATCH_LIMITS.proxy_triangles)throw Error('Native grass patch proxy mesh is not six triangles');
  trianglesByMesh.push(triangles);
 }
 const storedTriangles=trianglesByMesh.reduce((sum,value)=>sum+value,0);
 const parents=new Map();
 nodes.forEach((node,index)=>{for(const child of node?.children??[])if(parents.has(child))throw Error('Native grass patch proxy has a multiply-parented node');else parents.set(child,index);});
 const scene=document.scenes?.[document.scene??0];
 if(document.scenes&&!scene)throw Error('Native grass patch proxy has no selected scene');
 const roots=scene?.nodes??nodes.map((_,index)=>index).filter(index=>!parents.has(index));
 const visited=new Set();let meshNodes=0;const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
 const visit=(index,parent)=>{
  if(!integer(index)||!nodes[index])throw Error('Native grass patch proxy has an invalid scene node');
  if(visited.has(index))throw Error('Native grass patch proxy has a repeated/cyclic scene node');visited.add(index);
  const node=nodes[index],world=multiplyMatrix(parent,matrixFromNode(node,'node '+index));
  if(node.mesh!==undefined){
   if(!integer(node.mesh)||!trianglesByMesh[node.mesh])throw Error('Native grass patch proxy node lost its native mesh');
   rigidMatrix(world,'node '+index);meshNodes++;
   for(const primitive of meshes[node.mesh].primitives){
    const position=accessors[primitive.attributes.POSITION],minimum=position.min,maximum=position.max;
    for(const x of [minimum[0],maximum[0]])for(const y of [minimum[1],maximum[1]])for(const z of [minimum[2],maximum[2]]){
     const point=transformPoint(world,[x,y,z]);
     for(let axis=0;axis<3;axis++){low[axis]=Math.min(low[axis],point[axis]);high[axis]=Math.max(high[axis],point[axis]);}
    }
   }
  }
  for(const child of node.children??[])visit(child,world);
 };
 for(const root of roots)visit(root,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
 if(!meshNodes||!low.every(finite)||!high.every(finite))throw Error('Native grass patch proxy has no finite mesh occurrences');
 return {meshNodes,storedTriangles,bounds:{min:low,max:high},renderedTriangles:meshNodes*GRASS_IMPOSTOR_PATCH_LIMITS.proxy_triangles};
}
function foliageOptics(document){
 const top=document.extras?.plantfactory_impostor?.foliage_optics;
 if(isObject(top))return {evidence:'plantfactory_impostor',optics:top};
 const definitions=document.materials??[];
 const principled=definitions.map(material=>material?.extras?.principled).filter(isObject);
 if(principled.length!==definitions.length||!principled.length||!principled.every(value=>finite(value.diffuseTransmission)&&value.diffuseTransmission>0))return null;
 const signatures=new Set(principled.map(value=>JSON.stringify([value.diffuseTransmission,value.transmissionThickness??null,value.transmissionColor??null])));
 if(signatures.size!==1)return null;
 const {diffuseTransmission,transmissionThickness,transmissionColor}=principled[0],source={diffuseTransmission,transmissionThickness,transmissionColor};
 for(const key of Object.keys(source))if(source[key]===undefined)delete source[key];
 return {evidence:'material-principled',optics:{source:'material-principled',source_materials:definitions.length,principled:source}};
}
                                                                            
                                                                               
                                                                          
function readbackSummary(rows){
 if(!Array.isArray(rows)||!rows.length)return null;
 const nodes=new Map();
 for(const row of rows){
  if(!row||!integer(row.nodeIndex)||!integer(row.primitiveIndex))continue;
  const mesh=row.mesh;if(!mesh?.geometry)continue;
  const occurrences=Number.isInteger(mesh.isInstancedMesh?mesh.count:1)&&(mesh.isInstancedMesh?mesh.count:1)>=1?(mesh.isInstancedMesh?mesh.count:1):1;
  const count=mesh.geometry.index?.count??mesh.geometry.attributes?.position?.count??0;
  const triangles=Number.isFinite(count)?Math.floor(count/3):0;
  let node=nodes.get(row.nodeIndex);
  if(!node)nodes.set(row.nodeIndex,node={occurrences,triangles:0,primitives:new Set()});
  if(node.primitives.has(row.primitiveIndex))continue;
  node.primitives.add(row.primitiveIndex);node.triangles+=triangles;
 }
 let instances=0,triangles=0;
 for(const node of nodes.values()){instances+=node.occurrences;triangles+=node.triangles*node.occurrences;}
 return {instances,triangles,nodes:nodes.size};
}

                                                                                
                                                                             
                                                                                
                                                
export function validateGrassImpostorShape(document,{sourceNativeSha256=null,readback=null}={}){
 if(!isObject(document))throw Error('Invalid grass impostor document');
 const extras=isObject(document.extras)?document.extras:{},schema=extras.schema??null;
 const request=isObject(extras.request)?extras.request:{},meta=isObject(extras.impostor)?extras.impostor:{};
 const declaredPatch=!!(schema===null?(isObject(extras.impostor)||request.impostor===true):(GRASS_IMPOSTOR_PATCH_SCHEMAS.includes(schema)||isObject(extras.impostor)||request.impostor===true||/grass-impostor/i.test(schema)));
 let native=null;try{native=documentShape(document);}catch{}
 const stats=readbackSummary(readback);
 const patch=declaredPatch||(stats?.instances??0)>1||(stats?.nodes??0)>1||(native?.meshNodes??0)>1||(Array.isArray(readback)&&readback.length>1);
 const warnings=[];
 if(!patch)return {kind:'single-tuft',patch:false,schema,limit_triangles:null,readback:stats,warnings};
 const instances=stats?.instances??native?.meshNodes??(Number.isInteger(meta.instances)&&meta.instances>0?meta.instances:1);
 const triangles=stats?.triangles??(Number.isInteger(meta.rendered_triangles)?meta.rendered_triangles:instances*GRASS_IMPOSTOR_PATCH_LIMITS.proxy_triangles);
 const stored=native?.storedTriangles??(Number.isInteger(meta.stored_triangles)?meta.stored_triangles:null);
 const bounds=native?.bounds??null;
 const footprint=bounds?Math.abs((bounds.max[0]-bounds.min[0])*(bounds.max[2]-bounds.min[2])):null;
 const binding=isObject(meta.binding)?meta.binding:{};
 const original=typeof binding.original_patch_sha256==='string'?binding.original_patch_sha256:(typeof sourceNativeSha256==='string'?sourceNativeSha256:null);
 const maxFootprint=GRASS_IMPOSTOR_PATCH_LIMITS.max_footprint_area_m2;
 if(Number.isInteger(meta.instances)&&meta.instances!==instances)warnings.push(`Declared ${meta.instances} instances; actual ${instances}`);
 if(Number.isInteger(meta.rendered_triangles)&&meta.rendered_triangles!==triangles)warnings.push(`Declared ${meta.rendered_triangles} triangles; actual ${triangles}`);
 if(Number.isInteger(meta.stored_triangles)&&stored!==null&&meta.stored_triangles!==stored)warnings.push(`Declared ${meta.stored_triangles} stored triangles; actual ${stored}`);
 if(footprint!==null&&footprint>maxFootprint)warnings.push(`Footprint ${footprint} m2 exceeds the former ${maxFootprint} m2 budget`);
 const foliage=foliageOptics(document);
 return {kind:'patch',patch:true,schema,instances,
  core_tufts:Number.isInteger(meta.core_tufts)?meta.core_tufts:null,
  satellite_tufts:Number.isInteger(meta.satellite_tufts)?meta.satellite_tufts:null,
  proxy_triangles:GRASS_IMPOSTOR_PATCH_LIMITS.proxy_triangles,triangles,stored_triangles:stored,
  area_m2:finite(request.area_m2)?request.area_m2:null,bounds,footprint_area_m2:footprint,max_footprint_area_m2:maxFootprint,
  original_patch_sha256:original,foliage_optics:foliage?.optics??null,normal_frame_evidence:foliage?.evidence??null,
  readback:stats,warnings};
}

                                                                               
                                                                              
                                                                                
                                                                               
                                                                
export function impostorLocalMaterial(material){
 if(!material?.modules?.length||typeof material.allDefines!=='function'||typeof material.output!=='string')throw Error('Invalid grass impostor material');
 if(material.userData?.normalFrame==='impostor-local')return material;
 const output=material.output.replace('apsShadePrincipled(apsMeshMaterial,s,in.P,in.V,in.pixel,apsMeshTangent)','apsShadeImpostorDetail(apsMeshMaterial,s,in.P,in.pixel)');
 if(output===material.output)throw Error('Native grass impostor material cannot adopt the light-facing frame');
 const view=Object.create(material);
 Object.defineProperty(view,'output',{value:output,enumerable:true});
 view.userData={...material.userData,normalFrame:'impostor-local'};
 view.allDefines=()=>({...material.allDefines(),APS_IMPOSTOR_LOCAL:1});
 return view;
}

export function impostorDisplayScale(width,height,minimum=8){
 if(![width,height,minimum].every(Number.isFinite)||width<=0||height<=0||minimum<=0)throw Error('Invalid impostor screen size');
 return [Math.max(1,minimum/width),Math.max(1,minimum/height)];
}

                                                                           
                                                                              
export function impostorPixelClamp(bounds,minimum=8){
 const literal=a=>'vec3f('+a.map(x=>Number.isInteger(x)?x+'.0':String(x)).join(',')+')';
 const lo=bounds.min.toArray(),hi=bounds.max.toArray();
 return new ShaderModule({name:'aps-grass-impostor-pixel-floor',code:          `
fn apsImpostorPosition(m:mat4x4f,position:vec3f)->vec3f{
 let original=(m*vec4f(position,1.)).xyz;
 let low=${literal(lo)};let high=${literal(hi)};
 var a=vec2f(1e30);var b=vec2f(-1e30);
 for(var i=0u;i<8u;i++){
  let p=vec3f(select(low.x,high.x,(i&1u)!=0u),select(low.y,high.y,(i&2u)!=0u),select(low.z,high.z,(i&4u)!=0u));
  let c=frame.viewProj*m*vec4f(p,1.);if(c.w<=1e-6){return original;}
  a=min(a,c.xy/c.w);b=max(b,c.xy/c.w);
 }
 let size=max((b-a)*frame.resolution*.5,vec2f(1e-6));
 let scale=max(vec2f(1),vec2f(${minimum.toFixed(1)})/size);if(all(scale==vec2f(1))){return original;}
 let center=(a+b)*.5;var clip=frame.viewProj*vec4f(original,1.);
 clip=vec4f((center+(clip.xy/clip.w-center)*scale)*clip.w,clip.zw);
 let h=frame.invViewProj*clip;return h.xyz/h.w;
}
`});
}

export async function loadGrassImpostor(viewer,source,reference,signal,{load=loadMesh}={}){
 if(!reference)return null;
 const declaredSha=typeof reference.sha256==='string'?reference.sha256:null;
 const declaredSource=typeof reference.source_sha256==='string'?reference.source_sha256:null;
 const sourceSha=typeof source?.native?.sha256==='string'?source.native.sha256:null;
 const asset=await load(viewer,reference.url??reference.file,signal),parts=[],partMaterials=[];
 let geometry=null,committed=false;
 try{
  asset.root.visible=false;asset.root.removeFromParent();viewer.meshRenderer.nativeCasterBounds?.delete(asset.root);
  const rows=asset.native.readback;if(!Array.isArray(rows)||!rows.length)throw Error('Empty grass impostor');
  const shape=validateGrassImpostorShape(asset.native.json,{sourceNativeSha256:sourceSha,readback:rows});
  for(const row of rows){
   if(row.mesh.parent)row.mesh.updateWorldMatrix(true,false);
   if(shape.patch){
                                                                             
                                                                                 
    const occurrences=row.mesh.isInstancedMesh?row.mesh.count:1,local=new Matrix4();
    for(let index=0;index<occurrences;index++){
     let world=row.mesh.matrixWorld;
     if(row.mesh.isInstancedMesh){row.mesh.getMatrixAt(index,local);world=world.clone().multiply(local);}
     parts.push(row.mesh.geometry.clone().applyMatrix4(world));partMaterials.push(row.mesh.material);
    }
   }else{
    parts.push(row.mesh.geometry.clone().applyMatrix4(row.mesh.matrixWorld));partMaterials.push(row.mesh.material);
   }
  }
  const packed=concatenateVegetation(parts,{facesets:true});geometry=packed.geometry;
  let materials=partMaterials;
  if(shape.patch){
   const unique=[],lookup=new Map(),facesets=geometry.attributes.apsFaceset?.array;
   if(!facesets)throw Error('Native grass patch impostor lost its faceset identity');
   parts.forEach((part,index)=>{
    const source=partMaterials[index];if(!lookup.has(source)){lookup.set(source,unique.length);unique.push(source);}
    const range=packed.ranges[index],base=range.baseVertex;
    facesets.fill(lookup.get(source),base,base+part.attributes.position.count);
   });
   geometry.attributes.apsFaceset.needsUpdate=true;
   materials=unique.map(material=>shape.foliage_optics&&material.userData?.normalFrame!=='impostor-local'?impostorLocalMaterial(material):material);
  }
  const packedMaterial=createVegetationMaterial(materials),material=packedMaterial;asset.prepareGPU();
  const normalFrame=shape.patch?(shape.foliage_optics?'impostor-local':(rows[0].mesh.material?.userData?.normalFrame??'surface')):rows[0].mesh.material?.userData?.normalFrame;
  let disposed=false;
  const actualSha=typeof asset.native?.sha256==='string'?asset.native.sha256:declaredSha;
  const result={asset,geometry,material,bounds:geometry.boundingBox.clone(),range:{indexCount:geometry.index.count,firstIndex:0,baseVertex:0},
   metadata:()=>({representation:shape.patch?(asset.native.json.extras?.impostor?.representation??'native core/satellite three-plane tuft proxies'):'native PlantFactory three-plane billboard',schema:shape.schema??null,patch:shape.patch,sha256:actualSha,source_sha256:sourceSha??declaredSource,original_patch_sha256:shape.original_patch_sha256??null,triangles:geometry.index.count/3,stored_triangles:shape.stored_triangles??geometry.index.count/3,instances:shape.patch?shape.instances:1,core_tufts:shape.core_tufts??null,satellite_tufts:shape.satellite_tufts??null,area_m2:shape.area_m2??null,footprint_area_m2:shape.footprint_area_m2??null,minimum_display_pixels:[8,8],source_geometry_preserved:true,normal_frame:normalFrame,warnings:shape.warnings??[],foliage_optics:shape.patch?(shape.foliage_optics??null):(asset.native.json.extras?.plantfactory_impostor?.foliage_optics??null)}),
   dispose(){if(disposed)return;disposed=true;material.dispose();material.uniformBlock?.buffer?.destroy();geometry.dispose();asset.dispose();}};
  committed=true;return result;
 }catch(error){if(!committed)geometry?.dispose();asset.dispose();throw error;}finally{for(const part of parts)part.dispose();}
}
