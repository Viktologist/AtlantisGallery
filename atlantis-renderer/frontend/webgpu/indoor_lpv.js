                                                                            
                                                                              
import {GPU,G,ShaderModule,UniformBlock,StorageBuffer,ComputeKernel,readBuffer} from '../../vendor/tidewater/src/engine/webgpu.js';
import {SceneLighting} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {lpvTerrainQueryKey} from './terrain_ray_query.js';

                                                                                 
                                                                              
                                                                              
                                          
export function validateLPV(d) {
 return d;
}
                                                                          
                                                                              
                                                                  
export function lpvBinaryViews(facesBytes,masksBytes){
 return {faces:new Float32Array(facesBytes),masks:new Uint32Array(masksBytes)};
}
const COMMON=          `
fn lpvIndex(p:vec3i)->u32{return u32(p.x)+lpvP.shape.x*(u32(p.y)+lpvP.shape.y*u32(p.z));}
fn lpvCell(i:u32)->vec3i{return vec3i(vec3u(i%lpvP.shape.x,(i/lpvP.shape.x)%lpvP.shape.y,i/(lpvP.shape.x*lpvP.shape.y)));}
fn lpvInside(p:vec3i)->bool{return all(p>=vec3i(0))&&all(p<vec3i(lpvP.shape.xyz));}
fn lpvDirection(k:u32)->vec3i {var d=vec3i(0);d[k%3u]=select(-1,1,k<3u);return d;}
fn lpvBasis(d:vec3f)->vec4f{return vec4f(.282094792,.488602512*d);}
fn lpvEvaluate(i:u32,d:vec3f)->vec3f {let b=lpvBasis(d);return max(vec3f(0),vec3f(dot(lpvRead[i*3u],b),dot(lpvRead[i*3u+1u],b),dot(lpvRead[i*3u+2u],b)));}
fn lpvIrradiance(i:u32,n:vec3f)->vec3f {let b=lpvBasis(n)*vec4f(1,vec3f(2.0/3.0));return max(vec3f(0),vec3f(dot(lpvRead[i*3u],b),dot(lpvRead[i*3u+1u],b),dot(lpvRead[i*3u+2u],b)));}
fn lpvPositive(c:vec4f)->vec4f {let a=max(0.0,c.x);return vec4f(a,c.yzw*min(1.0,a/(1.73205081*max(1e-8,length(c.yzw)))));}
`;

export class IndoorLPV {
 static async load(viewer,reference,base,{fetcher=fetch,signal}={}) {
  const get=async(ref,parent)=>{if(!ref||typeof ref.file!=='string'||!ref.file)throw Error('LPV input needs a file');const url=new URL(ref.file,parent);if(!['http:','https:','blob:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid LPV URL');const response=await fetcher(url,{signal,credentials:'include'});if(!response.ok)throw Error('LPV input HTTP '+response.status);const bytes=await response.arrayBuffer();return {bytes,url:url.href};};
  const manifest=await get(reference,base),d=validateLPV(JSON.parse(new TextDecoder().decode(manifest.bytes)));
  const [faces,masks]=await Promise.all([get(d.faces,manifest.url),get(d.masks,manifest.url)]);
  viewer.staticOcclusion?.ensureTerrain();
  const {faces:faceData,masks:maskData}=lpvBinaryViews(faces.bytes,masks.bytes);
  const volume=new IndoorLPV(viewer,d,faceData,maskData);
  try{await GPU.pipelinesReady();if(volume.kernels.some(k=>k.handle.failed))throw Error('LPV compute compilation failed');return volume;}catch(e){volume.dispose();throw e;}
 }
 constructor(viewer,d,faces,masks) {
  this.viewer=viewer;this.document=d;this.iteration=0;this.generation=0;this.disposed=false;
  this.faces=new StorageBuffer({label:'LPV exact shell links',count:d.cells*6,data:faces});
  this.masks=new StorageBuffer({label:'LPV thin wall barriers',type:'u32',count:d.cells,data:masks});
  this.a=new StorageBuffer({label:'LPV SH4 RGB A',count:d.cells*3,data:new Float32Array(d.cells*12)});
  this.b=new StorageBuffer({label:'LPV SH4 RGB B',count:d.cells*3,data:new Float32Array(d.cells*12)});
  this.sources=new StorageBuffer({label:'LPV sunlit surface injection',count:d.cells*6});
  this.params=new UniformBlock('APSIndoorLPV',{shape:['vec4u',[...d.shape,0]],count:['u32',d.cells],origin:['vec3f',d.origin],spacing:['f32',d.spacing],sun:['vec3f',[0,1,0]],pad:['f32',0],sunlight:['vec3f',[0,0,0]],enabled:['u32',1],sky:['vec3f',[0,0,0]],regions:['u32',d.regions.length],low:['vec4f[64]',Array.from({length:64},(_,i)=>[...(d.regions[i]?.min??[0,0,0]),0])],high:['vec4f[64]',Array.from({length:64},(_,i)=>[...(d.regions[i]?.max??[0,0,0]),0])]});
  const bindings={lpvP:{uniform:this.params},lpvFaces:{storage:this.faces,access:'read'},lpvMasks:{storage:this.masks,access:'read'}};
  const terrain=viewer.staticOcclusion?.module;
  this.inject=new ComputeKernel({label:'Indoor LPV geometric surface sun injection',modules:terrain?[terrain]:[],defines:terrain?{LPV_TERRAIN:1}:{},bindings:{...bindings,lpvSources:{storage:this.sources,access:'read_write'},lpvRead:{storage:this.a,access:'read'}},workgroupSize:[64,1,1],code:COMMON+          `
fn lpvSunVisibility(point:vec3f)->f32 {
 #if LPV_TERRAIN
 if(apsTerrainOccluded(point,lpvP.sun,10000.0)){return 0.0;}
 #endif
 let p=(point-lpvP.origin)/lpvP.spacing;var cell=vec3i(floor(p+.5));let d=lpvP.sun;
 var step=vec3i(1);var next=vec3f(1e20);var delta=vec3f(1e20);
 for(var a=0u;a<3u;a++){if(abs(d[a])>1e-7){step[a]=select(-1,1,d[a]>0.0);delta[a]=1.0/abs(d[a]);next[a]=(f32(cell[a])+.5*f32(step[a])-p[a])/d[a];}}
 for(var n=0u;n<512u;n++){
  if(!lpvInside(cell)){return 1.0;}let i=lpvIndex(cell);if((lpvMasks[i]&64u)!=0u){return 0.0;}
  var axis=0u;if(next.y<next.x){axis=1u;}if(next.z<next[axis]){axis=2u;}
  let face=axis+select(3u,0u,step[axis]>0);if((lpvMasks[i]&(1u<<face))!=0u){return 0.0;}
  cell[axis]+=step[axis];next[axis]+=delta[axis];
 }return 0.0;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=lpvP.count){return;}let p=lpvP.origin+vec3f(lpvCell(i))*lpvP.spacing;
 for(var f=0u;f<6u;f++){var light=vec3f(0);let face=lpvFaces[i*6u+f];if(face.w>0.0&&(lpvMasks[i]&64u)==0u){let d=vec3f(lpvDirection(f));let normal=-d;let mu=max(0.0,dot(normal,lpvP.sun));if(mu>0.0){let q=p+d*max(0.0,face.w-.025);light=face.rgb*lpvP.sunlight*(mu/3.141592654)*lpvSunVisibility(q);}}lpvSources[i*6u+f]=vec4f(light,0);}
}`});
  this.steps=[[this.a,this.b],[this.b,this.a]].map(([read,write])=>new ComputeKernel({label:'Indoor LPV occluded SH4 propagation',bindings:{...bindings,lpvRead:{storage:read,access:'read'},lpvWrite:{storage:write,access:'read_write'},lpvSources:{storage:this.sources,access:'read'}},workgroupSize:[64,1,1],code:COMMON+          `
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=lpvP.count){return;}var r=vec4f(0);var g=vec4f(0);var b=vec4f(0);
 if((lpvMasks[i]&64u)==0u){let cell=lpvCell(i);
 for(var f=0u;f<6u;f++){let d=lpvDirection(f);let q=cell+d;let basis=lpvBasis(vec3f(d))*(12.566370614/6.0);let face=lpvFaces[i*6u+f];var L=vec3f(0);
  if(face.w>0.0){L=face.rgb*lpvIrradiance(i,-vec3f(d))+lpvSources[i*6u+f].rgb;}
  else if(!lpvInside(q)){L=lpvP.sky*select(.18,1.0,d.y>=0);}
  else if((lpvMasks[lpvIndex(q)]&64u)==0u){L=lpvEvaluate(lpvIndex(q),vec3f(d));}
  r+=L.r*basis;g+=L.g*basis;b+=L.b*basis;
 }}lpvWrite[i*3u]=lpvPositive(r);lpvWrite[i*3u+1u]=lpvPositive(g);lpvWrite[i*3u+2u]=lpvPositive(b);
}` }));
  this.kernels=[this.inject,...this.steps];
  this.module=new ShaderModule({name:'apsIndoorLightPropagationVolume',bindings:{...bindings,lpvRead:{storage:()=>this.current??this.a,access:'read'}},code:COMMON+          `
fn apsIndoorDiffuse(P:vec3f,N:vec3f,fallback:vec3f)->vec3f {
 if(lpvP.enabled==0u){return fallback;}let p=P+N*.045;var region=-1;
 for(var r=0u;r<lpvP.regions;r++){if(all(p>=lpvP.low[r].xyz)&&all(p<=lpvP.high[r].xyz)){region=i32(r);break;}}
 if(region<0){return fallback;}let low=lpvP.low[region].xyz;let high=lpvP.high[region].xyz;
 let coordinate=(p-lpvP.origin)/lpvP.spacing;let base=vec3i(floor(coordinate));let blend=fract(coordinate);var irradiance=vec3f(0);var total=0.0;
 for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){let delta=vec3i(x,y,z);let q=base+delta;if(!lpvInside(q)){continue;}let point=lpvP.origin+vec3f(q)*lpvP.spacing;
 if(any(point<low)||any(point>high)){continue;}let i=lpvIndex(q);if((lpvMasks[i]&64u)!=0u){continue;}let factors=mix(vec3f(1)-blend,blend,vec3f(delta));let w=factors.x*factors.y*factors.z;
 irradiance+=lpvIrradiance(i,N)*w;total+=w;
 }}}
 // Never restore the unoccluded outdoor sky merely because a boundary tap
 // was rejected. The nearest valid in-room cell is used at thin-wall edges.
 if(total<1e-6){let q=vec3i(round((clamp(p,low+lpvP.spacing*.55,high-lpvP.spacing*.55)-lpvP.origin)/lpvP.spacing));if(lpvInside(q)&&(lpvMasks[lpvIndex(q)]&64u)==0u){return lpvIrradiance(lpvIndex(q),N)*frame.envIntensity;}return vec3f(0);}
 return irradiance/total*frame.envIntensity;
}`});
 }
 publish(){this.previous=SceneLighting.hooks.indoorGI??null;SceneLighting.set('indoorGI',this.module);this.viewer.indoorLPV=this;this.viewer.components.add(this);return this;}
 update(){if(this.disposed)return;const v=x=>[x.x??x.r,x.y??x.g,x.z??x.b];const sun=v(G.sunDir.value),color=v(G.sunColor.value),sky=v(G.skyIrradiance.value);const terrain=this.viewer.staticOcclusion;terrain?.ensureTerrain();const key=lpvTerrainQueryKey(terrain,this.viewer.terrainIntervention,sun,color,sky);
  if(key!==this.key){this.key=key;this.iteration=0;this.generation++;this.params.set('sun',sun);this.params.set('sunlight',color);this.params.set('sky',sky);this.inject.dispatch(Math.ceil(this.document.cells/64));}
  for(let k=0;k<this.document.iterations_per_frame&&this.iteration<this.document.iterations;k++,this.iteration++){this.steps[this.iteration%2].dispatch(Math.ceil(this.document.cells/64));this.current=this.iteration%2===0?this.b:this.a;}
 }
 metadata(){return {method:'LPV-inspired dynamic positive SH4 RGB neighbour transport',regions:this.document.regions.length,cells:this.document.cells,spacing_m:this.document.spacing,iteration:this.iteration,target_iterations:this.document.iterations,generations:this.generation,injection:'compiled shell link/solid-cell DDA plus independent live terrain rays; no building mesh rays',wall_occlusion:'exact triangle intersection links + solid centres',terrain_query:this.viewer.staticOcclusion?.metadata(),interpolation:'within the receiving room only; no through-wall taps',limitations:this.document.limitations};}
 async audit(){
  GPU.submit();await GPU.queue.onSubmittedWorkDone();const values=new Float32Array(await readBuffer(this.current??this.a,this.a.byteLength));
  const d=this.document,rooms=d.regions.map(r=>({id:r.id,samples:0,min:Infinity,max:0,sum:0}));let finite=true,negativeL0=0,max=0;
  for(let i=0;i<d.cells;i++){const p=[i%d.shape[0],Math.floor(i/d.shape[0])%d.shape[1],Math.floor(i/(d.shape[0]*d.shape[1]))].map((x,k)=>d.origin[k]+x*d.spacing);let mean=0;
   for(let c=0;c<3;c++){const k=i*12+c*4;negativeL0+=values[k]<-1e-7?1:0;mean+=values[k]*.282094792/3;for(let j=0;j<4;j++){finite&&=Number.isFinite(values[k+j]);max=Math.max(max,Math.abs(values[k+j]));}}
   for(let r=0;r<rooms.length;r++){const box=d.regions[r];if(p.every((x,k)=>x>box.min[k]+.22&&x<box.max[k]-.22)){const q=rooms[r];q.samples++;q.min=Math.min(q.min,mean);q.max=Math.max(q.max,mean);q.sum+=mean;}}
  }
  return {...this.metadata(),finite,negative_l0:negativeL0,max_abs_coefficient:max,rooms:rooms.map(({sum,...r})=>({...r,min:r.samples?r.min:0,mean:r.samples?sum/r.samples:0})),water:[...(this.viewer.boundedWaters??[])].map(w=>w.metadata())};
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.viewer.components.delete(this);if(this.viewer.indoorLPV===this)this.viewer.indoorLPV=null;if(SceneLighting.hooks.indoorGI===this.module)SceneLighting.set('indoorGI',this.previous??null);const release=()=>{for(const b of [this.faces,this.masks,this.a,this.b,this.sources])b.destroy();this.params.buffer?.destroy();};GPU.queue?.onSubmittedWorkDone().then(release,release);}
}
