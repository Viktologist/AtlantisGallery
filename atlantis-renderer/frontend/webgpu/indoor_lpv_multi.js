                                                    
  
                                                                                
                                                                               
                                                                                
                                                                            
  
                                                                    
                                                                                
                                                                       
import {GPU,G,ShaderModule,UniformBlock,StorageBuffer,ComputeKernel,readBuffer} from '../../vendor/tidewater/src/engine/webgpu.js';
import {SceneLighting} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {lpvTerrainQueryKey} from './terrain_ray_query.js';
import {lpvBinaryViews} from './indoor_lpv.js';

const HEX64=/^[a-f0-9]{64}$/;
const BLOCK_STRIDE=12;                                           
const ROOM_STRIDE=2;                                            

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>typeof value==='string'&&HEX64.test(value);
const ref=value=>isObject(value)&&typeof value.file==='string'&&value.file.length>0;

                                                                             
                                                                        
                                                                           
                                                                          
export function validateRigid(value,label='localToWorld16columnmajor') {
 const m=value;
 const U=[[m[0],m[4],m[8]],[m[1],m[5],m[9]],[m[2],m[6],m[10]]],t=[m[12],m[13],m[14]];
 const det=U[0][0]*(U[1][1]*U[2][2]-U[1][2]*U[2][1])-U[0][1]*(U[1][0]*U[2][2]-U[1][2]*U[2][0])+U[0][2]*(U[1][0]*U[2][1]-U[1][1]*U[2][0]);
 const inv=[
  [(U[1][1]*U[2][2]-U[1][2]*U[2][1])/det,(U[0][2]*U[2][1]-U[0][1]*U[2][2])/det,(U[0][1]*U[1][2]-U[0][2]*U[1][1])/det],
  [(U[1][2]*U[2][0]-U[1][0]*U[2][2])/det,(U[0][0]*U[2][2]-U[0][2]*U[2][0])/det,(U[0][2]*U[1][0]-U[0][0]*U[1][2])/det],
  [(U[1][0]*U[2][1]-U[1][1]*U[2][0])/det,(U[0][1]*U[2][0]-U[0][0]*U[2][1])/det,(U[0][0]*U[1][1]-U[0][1]*U[1][0])/det],
 ];
 const inverse=[0,1,2].map(row=>[...inv[row],-(inv[row][0]*t[0]+inv[row][1]*t[1]+inv[row][2]*t[2])]);
 const forward=[[...U[0],t[0]],[...U[1],t[1]],[...U[2],t[2]]];
 return {matrix:Array.from(m),translation:t,inverse,forward,warnings:[]};
}

function transformPoint(rows,p) {
 return [rows[0][0]*p[0]+rows[0][1]*p[1]+rows[0][2]*p[2]+rows[0][3],
         rows[1][0]*p[0]+rows[1][1]*p[1]+rows[1][2]*p[2]+rows[1][3],
         rows[2][0]*p[0]+rows[2][1]*p[1]+rows[2][2]*p[2]+rows[2][3]];
}

                                                                          
                                                                               
                                                                              
                                                 
export function validateMulti(document) {
 return document;
}

function validateBlockVolume(document) {
 return document;
}

async function fetchExact(reference,parent,{fetcher,signal}) {
 if(!ref(reference))throw Error('LPV input needs a file');
 const url=new URL(reference.file,parent);
 if(!['http:','https:','blob:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid LPV URL');
 const response=await fetcher(url,{signal,credentials:'include'});
 if(!response.ok)throw Error('LPV input HTTP '+response.status);
 return {bytes:await response.arrayBuffer(),url:url.href};
}

const COMMON=          `
const LPV_BLOCK_STRIDE: u32 = 12u;
const LPV_ROOM_STRIDE: u32 = 2u;

fn lpvBlockBase(b:u32)->u32{return b*LPV_BLOCK_STRIDE;}
fn lpvBlockShape(base:u32)->vec3u{let v=lpvLayout[base+1u].xyz;return vec3u(u32(v.x),u32(v.y),u32(v.z));}
fn lpvBlockCellOffset(base:u32)->u32{return bitcast<u32>(lpvLayout[base+1u].w);}
fn lpvBlockCells(base:u32)->u32{return bitcast<u32>(lpvLayout[base+2u].x);}
fn lpvBlockRoomOffset(base:u32)->u32{return bitcast<u32>(lpvLayout[base+2u].y);}
fn lpvBlockRoomCount(base:u32)->u32{return bitcast<u32>(lpvLayout[base+2u].z);}
fn lpvBlockFlags(base:u32)->u32{return bitcast<u32>(lpvLayout[base+2u].w);}
fn lpvBlockForCell(i:u32)->u32{
 var lo=0u;var hi=lpvP.blockCount;
 if(hi==0u){return 0u;}
 while(lo+1u<hi){let mid=(lo+hi)/2u;let off=lpvBlockCellOffset(mid*LPV_BLOCK_STRIDE);if(off<=i){lo=mid;}else{hi=mid;}}
 return lo;
}
fn lpvCellLocal(li:u32,shape:vec3u)->vec3i{return vec3i(i32(li%shape.x),i32((li/shape.x)%shape.y),i32(li/(shape.x*shape.y)));}
fn lpvCellIndex(cell:vec3i,shape:vec3u)->u32{return u32(cell.x)+shape.x*(u32(cell.y)+shape.y*u32(cell.z));}
fn lpvInsideLocal(p:vec3i,shape:vec3u)->bool{return all(p>=vec3i(0))&&all(p<vec3i(i32(shape.x),i32(shape.y),i32(shape.z)));}
fn lpvDirection(k:u32)->vec3i{var d=vec3i(0);d[k%3u]=select(-1,1,k<3u);return d;}
fn lpvBasis(d:vec3f)->vec4f{return vec4f(.282094792,.488602512*d);}
fn lpvEvaluate(i:u32,d:vec3f)->vec3f{let b=lpvBasis(d);return max(vec3f(0),vec3f(dot(lpvRead[i*3u],b),dot(lpvRead[i*3u+1u],b),dot(lpvRead[i*3u+2u],b)));}
fn lpvIrradiance(i:u32,n:vec3f)->vec3f{let b=lpvBasis(n)*vec4f(1,vec3f(2.0/3.0));return max(vec3f(0),vec3f(dot(lpvRead[i*3u],b),dot(lpvRead[i*3u+1u],b),dot(lpvRead[i*3u+2u],b)));}
fn lpvPositive(c:vec4f)->vec4f{let a=max(0.0,c.x);return vec4f(a,c.yzw*min(1.0,a/(1.73205081*max(1e-8,length(c.yzw)))));}
fn lpvWorldToLocal(base:u32,p:vec3f)->vec3f{let r0=lpvLayout[base+3u];let r1=lpvLayout[base+4u];let r2=lpvLayout[base+5u];return vec3f(dot(r0.xyz,p)+r0.w,dot(r1.xyz,p)+r1.w,dot(r2.xyz,p)+r2.w);}
fn lpvLocalToWorld(base:u32,p:vec3f)->vec3f{let r0=lpvLayout[base+6u];let r1=lpvLayout[base+7u];let r2=lpvLayout[base+8u];return vec3f(dot(r0.xyz,p)+r0.w,dot(r1.xyz,p)+r1.w,dot(r2.xyz,p)+r2.w);}
fn lpvWorldDirToLocal(base:u32,d:vec3f)->vec3f{let r0=lpvLayout[base+3u];let r1=lpvLayout[base+4u];let r2=lpvLayout[base+5u];return vec3f(dot(r0.xyz,d),dot(r1.xyz,d),dot(r2.xyz,d));}
fn lpvLocalDirToWorld(base:u32,d:vec3f)->vec3f{let r0=lpvLayout[base+6u];let r1=lpvLayout[base+7u];let r2=lpvLayout[base+8u];return vec3f(dot(r0.xyz,d),dot(r1.xyz,d),dot(r2.xyz,d));}
fn lpvRoomMin(room:u32)->vec3f{return lpvLayout[lpvP.blockCount*LPV_BLOCK_STRIDE+room*LPV_ROOM_STRIDE].xyz;}
fn lpvRoomMax(room:u32)->vec3f{return lpvLayout[lpvP.blockCount*LPV_BLOCK_STRIDE+room*LPV_ROOM_STRIDE+1u].xyz;}
fn lpvRoomForPoint(base:u32,p:vec3f)->i32{let ro=lpvBlockRoomOffset(base);let rc=lpvBlockRoomCount(base);for(var r=0u;r<rc;r++){let room=ro+r;if(all(p>=lpvRoomMin(room))&&all(p<=lpvRoomMax(room))){return i32(r);}}return -1;}
`;

const INJECT=          `
fn lpvSunVisibilityLocal(base:u32,start:vec3i,sun:vec3f)->f32{
 let shape=lpvBlockShape(base);
 let offset=lpvBlockCellOffset(base);
 var cell=start;
 var step=vec3i(1);var next=vec3f(1e20);var delta=vec3f(1e20);
 let p=vec3f(start);
 for(var a=0u;a<3u;a++){
  if(abs(sun[a])>1e-7){
   step[a]=select(-1,1,sun[a]>0.0);
   delta[a]=1.0/abs(sun[a]);
   next[a]=(f32(cell[a])+.5*f32(step[a])-p[a])/sun[a];
  }
 }
 for(var n=0u;n<512u;n++){
  if(!lpvInsideLocal(cell,shape)){return 1.0;}
  let i=offset+lpvCellIndex(cell,shape);
  if((lpvMasks[i]&64u)!=0u){return 0.0;}
  var axis=0u;if(next.y<next.x){axis=1u;}if(next.z<next[axis]){axis=2u;}
  let face=axis+select(3u,0u,step[axis]>0);
  if((lpvMasks[i]&(1u<<face))!=0u){return 0.0;}
  cell[axis]+=step[axis];next[axis]+=delta[axis];
 }
 return 0.0;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=lpvP.count){return;}
 let b=lpvBlockForCell(i);let base=b*LPV_BLOCK_STRIDE;
 let shape=lpvBlockShape(base);let offset=lpvBlockCellOffset(base);
 let cell=lpvCellLocal(i-offset,shape);
 let origin=lpvLayout[base].xyz;let spacing=lpvLayout[base].w;
 let p=origin+vec3f(cell)*spacing;
 let sunLocal=normalize(lpvWorldDirToLocal(base,lpvP.sun));
 for(var f=0u;f<6u;f++){
  var light=vec3f(0);
  let face=lpvFaces[i*6u+f];
  if(face.w>0.0&&(lpvMasks[i]&64u)==0u){
   let d=vec3f(lpvDirection(f));
   let normal=-d;
   let mu=max(0.0,dot(normal,sunLocal));
   if(mu>0.0){
    let q=p+d*max(0.0,face.w-.025);
    var visible=lpvSunVisibilityLocal(base,cell,sunLocal);
    #if LPV_TERRAIN
    if(visible>0.0){
     let worldQ=lpvLocalToWorld(base,q);
     visible=select(1.0,0.0,apsTerrainOccluded(worldQ,lpvP.sun,10000.0));
    }
    #endif
    light=face.rgb*lpvP.sunlight*(mu/3.141592654)*visible;
   }
  }
  lpvSources[i*6u+f]=vec4f(light,0);
 }
}
`;

const STEP=          `
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=lpvP.count){return;}
 let b=lpvBlockForCell(i);let base=b*LPV_BLOCK_STRIDE;
 let shape=lpvBlockShape(base);let offset=lpvBlockCellOffset(base);
 let cell=lpvCellLocal(i-offset,shape);
 var r=vec4f(0);var g=vec4f(0);var bl=vec4f(0);
 if((lpvMasks[i]&64u)==0u){
  for(var f=0u;f<6u;f++){
   let d=lpvDirection(f);let q=cell+d;
   let basis=lpvBasis(vec3f(d))*(12.566370614/6.0);
   let face=lpvFaces[i*6u+f];var L=vec3f(0);
   if(face.w>0.0){L=face.rgb*lpvIrradiance(i,-vec3f(d))+lpvSources[i*6u+f].rgb;}
   else if(!lpvInsideLocal(q,shape)){let worldD=lpvLocalDirToWorld(base,vec3f(d));L=lpvP.sky*select(.18,1.0,worldD.y>=0);}
   else{let ni=offset+lpvCellIndex(q,shape);if((lpvMasks[ni]&64u)==0u){L=lpvEvaluate(ni,vec3f(d));}}
   r+=L.r*basis;g+=L.g*basis;bl+=L.b*basis;
  }
 }
 lpvWrite[i*3u]=lpvPositive(r);lpvWrite[i*3u+1u]=lpvPositive(g);lpvWrite[i*3u+2u]=lpvPositive(bl);
}
`;

const HOOK=          `
fn apsIndoorDiffuse(P:vec3f,N:vec3f,fallback:vec3f)->vec3f{
 if(lpvP.enabled==0u||lpvP.blockCount==0u){return fallback;}
 for(var b=0u;b<lpvP.blockCount;b++){
  let base=b*LPV_BLOCK_STRIDE;
  if((lpvBlockFlags(base)&1u)==0u){continue;}
  let wmin=lpvLayout[base+9u].xyz;let wmax=lpvLayout[base+10u].xyz;
  if(any(P<wmin)||any(P>wmax)){continue;}
  let localP=lpvWorldToLocal(base,P);
  let localN=normalize(lpvWorldDirToLocal(base,N));
  let tap=localP+localN*.045;
  let room=lpvRoomForPoint(base,tap);
  if(room<0){continue;}
  let roomIndex=lpvBlockRoomOffset(base)+u32(room);
  let low=lpvRoomMin(roomIndex);let high=lpvRoomMax(roomIndex);
  let origin=lpvLayout[base].xyz;let spacing=lpvLayout[base].w;
  let shape=lpvBlockShape(base);let offset=lpvBlockCellOffset(base);
  let coordinate=(tap-origin)/spacing;
  let baseCell=vec3i(floor(coordinate));
  let blend=fract(coordinate);
  var irradiance=vec3f(0);var total=0.0;
  for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
   let delta=vec3i(x,y,z);let q=baseCell+delta;
   if(!lpvInsideLocal(q,shape)){continue;}
   let point=origin+vec3f(q)*spacing;
   if(any(point<low)||any(point>high)){continue;}
   let i=offset+lpvCellIndex(q,shape);
   if((lpvMasks[i]&64u)!=0u){continue;}
   let factors=mix(vec3f(1)-blend,blend,vec3f(delta));
   let w=factors.x*factors.y*factors.z;
   irradiance+=lpvIrradiance(i,localN)*w;total+=w;
  }}}
  // Never restore unoccluded outdoor sky merely because a boundary tap was
  // rejected.  The nearest valid in-room cell is used at thin-wall edges.
  if(total<1e-6){
   let q=vec3i(round((clamp(tap,low,high)-origin)/spacing));
   if(lpvInsideLocal(q,shape)){
    let i=offset+lpvCellIndex(q,shape);
    let point=origin+vec3f(q)*spacing;
    if((lpvMasks[i]&64u)==0u&&all(point>=low)&&all(point<=high)){return lpvIrradiance(i,localN)*frame.envIntensity;}
   }
   return vec3f(0);
  }
  return irradiance/total*frame.envIntensity;
 }
 return fallback;
}
`;

export class IndoorLPVMulti {
 static async load(viewer,reference,base,{fetcher=fetch,signal}={}) {
  const manifest=await fetchExact(reference,base,{fetcher,signal});
  const document=validateMulti(JSON.parse(new TextDecoder().decode(manifest.bytes)));
  const candidates=(viewer.sceneDocumentCandidateAssets??[]).filter(a=>digest(a?.sha256));
  const bySha=new Map(candidates.map(a=>[a.sha256,a]));
  const loaded=await Promise.all(document.blocks.map(async (block,index)=>{
   const blockManifest=await fetchExact(block.manifest,manifest.url,{fetcher,signal});
   const volume=validateBlockVolume(JSON.parse(new TextDecoder().decode(blockManifest.bytes)),block,index);
   const [faces,masks]=await Promise.all([
    fetchExact(volume.faces,blockManifest.url,{fetcher,signal}),
    fetchExact(volume.masks,blockManifest.url,{fetcher,signal}),
   ]);
   const assembly=bySha.get(block.assembly_source?.sha256)??null;
   const prototype=bySha.get(block.source?.sha256)??null;
   const {faces:faceData,masks:maskData}=lpvBinaryViews(faces.bytes,masks.bytes);
   return {block,volume,faces:faceData,masks:maskData,assembly,prototype};
  }));
  const total=loaded.reduce((sum,item)=>sum+item.volume.cells,0);
  const totalRooms=loaded.reduce((sum,item)=>sum+item.volume.regions.length,0);
  document.cell_count=total;document.room_count=totalRooms;document.block_count=loaded.length;
  viewer.staticOcclusion?.ensureTerrain();
  let volume;
  try{
   volume=new IndoorLPVMulti(viewer,document,loaded);
   await GPU.pipelinesReady();
   if(volume.kernels.some(kernel=>kernel.handle.failed))throw Error('Multi-building LPV compute compilation failed');
   return volume;
  }catch(error){volume?.dispose();throw error;}
 }

 constructor(viewer,document,loaded) {
  this.viewer=viewer;this.document=document;this.iteration=0;this.generation=0;this.disposed=false;
  this.blocks=[];this.totalCells=loaded.reduce((sum,item)=>sum+item.volume.cells,0);
  this.totalRooms=loaded.reduce((sum,item)=>sum+item.volume.regions.length,0);
  this.iterations=document.iterations;this.iterationsPerFrame=document.iterations_per_frame;
  const faces=new Float32Array(this.totalCells*6*4);
  const masks=new Uint32Array(this.totalCells);
  const layout=new Float32Array((document.blocks.length*BLOCK_STRIDE+this.totalRooms*ROOM_STRIDE)*4);
  const layoutU32=new Uint32Array(layout.buffer);
  let cellOffset=0,roomOffset=0;
  this.warnings=[];
  for(let index=0;index<loaded.length;index++){
   const {block,volume,faces:blockFaces,masks:blockMasks,assembly,prototype}=loaded[index];
   const rigid=validateRigid(block.localToWorld16columnmajor,`LPV block ${block.id} localToWorld16columnmajor`);
   if(rigid.warnings?.length)this.warnings.push(...rigid.warnings);
   block.cell_offset=cellOffset;
   faces.set(blockFaces,cellOffset*24);masks.set(blockMasks,cellOffset);
   const base=index*BLOCK_STRIDE*4;
   layout[base+0]=volume.origin[0];layout[base+1]=volume.origin[1];layout[base+2]=volume.origin[2];layout[base+3]=volume.spacing;
   layout[base+4]=volume.shape[0];layout[base+5]=volume.shape[1];layout[base+6]=volume.shape[2];layoutU32[base+7]=cellOffset;
   layoutU32[base+8]=volume.cells;layoutU32[base+9]=roomOffset;layoutU32[base+10]=volume.regions.length;layoutU32[base+11]=1;
   for(let row=0;row<3;row++)layout.set(rigid.inverse[row],base+12+row*4);
   for(let row=0;row<3;row++)layout.set(rigid.forward[row],base+24+row*4);
   const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
   for(const x of [0,volume.shape[0]-1])for(const y of [0,volume.shape[1]-1])for(const z of [0,volume.shape[2]-1]){
    const world=transformPoint(rigid.forward,[volume.origin[0]+x*volume.spacing,volume.origin[1]+y*volume.spacing,volume.origin[2]+z*volume.spacing]);
    for(let k=0;k<3;k++){min[k]=Math.min(min[k],world[k]);max[k]=Math.max(max[k],world[k]);}
   }
   layout.set([...min,0],base+36);layout.set([...max,0],base+40);
   for(const room of volume.regions){
    const rb=(document.blocks.length*BLOCK_STRIDE+roomOffset*ROOM_STRIDE)*4;
    layout.set([room.min[0],room.min[1],room.min[2],index],rb);
    layout.set([room.max[0],room.max[1],room.max[2],0],rb+4);
    roomOffset++;
   }
   this.blocks.push({id:block.id,index,record:block,volume,rigid,assembly,prototype,cellOffset,worldMin:min,worldMax:max,rooms:volume.regions.length});
   cellOffset+=volume.cells;
  }
  this.faces=new StorageBuffer({label:'Multi-building LPV exact shell links',count:this.totalCells*6,data:faces});
  this.masks=new StorageBuffer({label:'Multi-building LPV thin wall barriers',type:'u32',count:this.totalCells,data:masks});
  this.a=new StorageBuffer({label:'Multi-building LPV SH4 RGB A',count:this.totalCells*3,data:new Float32Array(this.totalCells*12)});
  this.b=new StorageBuffer({label:'Multi-building LPV SH4 RGB B',count:this.totalCells*3,data:new Float32Array(this.totalCells*12)});
  this.sources=new StorageBuffer({label:'Multi-building LPV sunlit surface injection',count:this.totalCells*6});
  this.layout=new StorageBuffer({label:'Multi-building LPV packed block/room layout',count:layout.length/4,data:layout});
  this.params=new UniformBlock('APSIndoorLPVMulti',{
   enabled:['u32',document.enabled===false?0:1],
   blockCount:['u32',this.blocks.length],
   count:['u32',this.totalCells],
   iterations:['u32',this.iterations],
   sun:['vec3f',[0,1,0]],pad0:['f32',0],
   sunlight:['vec3f',[0,0,0]],pad1:['f32',0],
   sky:['vec3f',[0,0,0]],pad2:['f32',0],
  });
  const bindings={lpvP:{uniform:this.params},lpvFaces:{storage:this.faces,access:'read'},lpvMasks:{storage:this.masks,access:'read'},lpvLayout:{storage:this.layout,access:'read'}};
  const terrain=viewer.staticOcclusion?.module??null;
  this.inject=new ComputeKernel({label:'Multi-building LPV world-sun surface injection',modules:terrain?[terrain]:[],defines:terrain?{LPV_TERRAIN:1}:{},bindings:{...bindings,lpvSources:{storage:this.sources,access:'read_write'},lpvRead:{storage:this.a,access:'read'}},workgroupSize:[64,1,1],code:COMMON+INJECT});
  this.steps=[[this.a,this.b],[this.b,this.a]].map(([read,write])=>new ComputeKernel({label:'Multi-building LPV occluded SH4 propagation',bindings:{...bindings,lpvRead:{storage:read,access:'read'},lpvWrite:{storage:write,access:'read_write'},lpvSources:{storage:this.sources,access:'read'}},workgroupSize:[64,1,1],code:COMMON+STEP}));
  this.kernels=[this.inject,...this.steps];
  this.module=new ShaderModule({name:'apsIndoorLPVMulti',bindings:{lpvP:{uniform:this.params},lpvLayout:{storage:this.layout,access:'read'},lpvMasks:{storage:this.masks,access:'read'},lpvRead:{storage:()=>this.current??this.a,access:'read'}},code:COMMON+HOOK});
 }

 publish(){this.previous=SceneLighting.hooks.indoorGI===this.module?(this.previous??null):(SceneLighting.hooks.indoorGI??null);SceneLighting.set('indoorGI',this.module);this.viewer.indoorLPV=this;this.viewer.components.add(this);return this;}

 setEnabled(enabled){this.params.set('enabled',enabled?1:0);this.key=null;this.iteration=0;this.generation++;}

 update(){
  if(this.disposed)return;
  if(this.params.get('enabled')===0)return;
  const v=x=>[x.x??x.r,x.y??x.g,x.z??x.b];
  const sun=v(G.sunDir.value),color=v(G.sunColor.value),sky=v(G.skyIrradiance.value);
  const terrain=this.viewer.staticOcclusion;terrain?.ensureTerrain();
  const key=lpvTerrainQueryKey(terrain,this.viewer.terrainIntervention,sun,color,sky);
  if(key!==this.key){
   this.key=key;this.iteration=0;this.generation++;
   this.params.set('sun',sun);this.params.set('sunlight',color);this.params.set('sky',sky);
   this.inject.dispatch(Math.ceil(this.totalCells/64));
  }
  for(let k=0;k<this.iterationsPerFrame&&this.iteration<this.iterations;k++,this.iteration++){
   this.steps[this.iteration%2].dispatch(Math.ceil(this.totalCells/64));
   this.current=this.iteration%2===0?this.b:this.a;
  }
 }

 metadata(){
  return {
   method:'sparse multi-building LPV-inspired dynamic positive SH4 RGB neighbour transport',
   schema:this.document.schema,
   enabled:this.params.get('enabled')!==0,
   source_policy:this.document.source_policy??'assembly-exact',
   source_binding:'saved source/assembly digests are provenance; matching a loaded candidate asset is best-effort and never blocks transport',
   warnings:this.warnings,
   blocks:this.blocks.length,
   rooms:this.totalRooms,
   regions:this.totalRooms,
   spacing_m:[...new Set(this.blocks.map(block=>block.volume.spacing))].join('/'),
   cells:this.totalCells,
   block_cells:this.blocks.map(block=>({id:block.id,cells:block.volume.cells,rooms:block.rooms,origin:block.volume.origin,spacing:block.volume.spacing,cell_offset:block.cellOffset,source_sha256:block.record.source?.sha256??null,loaded_source_sha256:block.record.loaded_source_sha256??null,prototype_asset_verified:!!block.prototype,assembly_asset_id:block.assembly?.id??null})),
   iteration:this.iteration,
   target_iterations:this.iterations,
   iterations_per_frame:this.iterationsPerFrame,
   generations:this.generation,
   injection:'compiled local link/solid-cell DDA and independent live terrain rays; sky boundary per block; no cross-building mesh rays',
   terrain_query:this.viewer.staticOcclusion?.metadata(),
   wall_occlusion:'exact local triangle intersection links + solid centres; neighbour transport never crosses a block boundary',
   interpolation:'world->local affine inverse transform, room-only OBB taps, local normal for irradiance',
   limitations:this.document.limitations,
  };
 }

 async audit(){
  GPU.submit();await GPU.queue.onSubmittedWorkDone();
  const values=new Float32Array(await readBuffer(this.current??this.a,this.a.byteLength));
  const rooms=[];const blocks=[];
  for(const block of this.blocks){
   const stats={id:block.id,samples:0,min:Infinity,max:0,sum:0};
   for(const room of block.volume.regions)rooms.push({id:room.id,block:block.id,samples:0,min:Infinity,max:0,sum:0});
   blocks.push(stats);
  }
  let finite=true,negativeL0=0,max=0,roomCursor=0;
  for(const block of this.blocks){
   const {shape,origin,spacing,regions}=block.volume;
   for(let i=0;i<block.volume.cells;i++){
    const x=i%shape[0],y=Math.floor(i/shape[0])%shape[1],z=Math.floor(i/(shape[0]*shape[1]));
    const point=[origin[0]+x*spacing,origin[1]+y*spacing,origin[2]+z*spacing];
    let mean=0;const global=block.cellOffset+i;
    for(let c=0;c<3;c++){
     const k=global*12+c*4;
     negativeL0+=values[k]<-1e-7?1:0;mean+=values[k]*.282094792/3;
     for(let j=0;j<4;j++){finite&&=Number.isFinite(values[k+j]);max=Math.max(max,Math.abs(values[k+j]));}
    }
    for(let r=0;r<regions.length;r++){
     const box=regions[r];
     if(point.every((value,k)=>value>box.min[k]+.22&&value<box.max[k]-.22)){
      const q=rooms[roomCursor+r];q.samples++;q.min=Math.min(q.min,mean);q.max=Math.max(q.max,mean);q.sum+=mean;
     }
    }
    const stats=blocks[block.index];stats.samples++;stats.min=Math.min(stats.min,mean);stats.max=Math.max(stats.max,mean);stats.sum+=mean;
   }
   roomCursor+=regions.length;
  }
  return {...this.metadata(),finite,negative_l0:negativeL0,max_abs_coefficient:max,
   blocks:blocks.map(({sum,...block})=>({...block,min:block.samples?block.min:0,mean:block.samples?sum/block.samples:0})),
   rooms:rooms.map(({sum,...room})=>({...room,min:room.samples?room.min:0,mean:room.samples?sum/room.samples:0})),
   water:[...(this.viewer.boundedWaters??[])].map(water=>water.metadata())};
 }

 dispose(){
  if(this.disposed)return;this.disposed=true;
  this.viewer.components.delete(this);if(this.viewer.indoorLPV===this)this.viewer.indoorLPV=null;
  if(SceneLighting.hooks.indoorGI===this.module)SceneLighting.set('indoorGI',this.previous??null);
  const release=()=>{for(const buffer of [this.faces,this.masks,this.a,this.b,this.sources,this.layout])buffer?.destroy();this.params.buffer?.destroy();};
  GPU.queue?.onSubmittedWorkDone().then(release,release);
 }
}
