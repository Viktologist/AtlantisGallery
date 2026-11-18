                                                                                
                                                                                
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';

                                                                              
                                                                               
                                                                            
                                                       
function readInterventionNpy(buffer){
 const bytes=new Uint8Array(buffer),view=new DataView(buffer);
 if(bytes.length<10||bytes[0]!==147||String.fromCharCode(...bytes.slice(1,6))!=='NUMPY')throw Error('Expected NPY intervention field');
 const major=bytes[6],offset=major===1?10:12;
 if(![1,2,3].includes(major))throw Error('Unsupported NPY version');
 const length=major===1?view.getUint16(8,true):view.getUint32(8,true);
 if(offset+length>bytes.length)throw Error('NPY header exceeds field file');
 const header=new TextDecoder().decode(bytes.slice(offset,offset+length));
 const match=header.match(/['"]shape['"]\s*:\s*\((\d+),\s*(\d+)\s*,?\)/);
 if(!match||!header.match(/['"]descr['"]\s*:\s*['"]<f4['"]/)||!header.match(/['"]fortran_order['"]\s*:\s*False/))throw Error('Expected C-order little-endian float32 2D NPY');
 const shape=[Number(match[1]),Number(match[2])],start=offset+length,count=shape[0]*shape[1];
 if(buffer.byteLength-start!==count*4)throw Error('Intervention field byte count mismatch');
 const data=new Float32Array(count);
 if(start%4===0)data.set(new Float32Array(buffer,start));
 else{const view=new DataView(buffer,start);for(let i=0;i<count;i++)data[i]=view.getFloat32(i*4,true);}
 return {data,shape};
}

export const INTERVENTION_COMPOSE_WGSL=          `
struct State { enabled:u32, nx:u32, nz:u32, reserved:u32 }
@group(0) @binding(0) var<uniform> state:State;
@group(0) @binding(1) var baseHeight:texture_2d<f32>;
@group(0) @binding(2) var targetHeight:texture_2d<f32>;
@group(0) @binding(3) var blendMask:texture_2d<f32>;
@group(0) @binding(4) var activeHeight:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn compose(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=state.nx||id.y>=state.nz){return;}
 let q=vec2i(id.xy);let base=textureLoad(baseHeight,q,0).r;
 var value=base;
 if(state.enabled!=0u){let a=textureLoad(blendMask,q,0).r;
  // Exact restoration and bit-identical unmodified land, including a==0.
  if(a>0.){let desired=textureLoad(targetHeight,q,0).r;value=base+(desired-base)*a;}}
 textureStore(activeHeight,q,vec4f(value,0.,0.,0.));
}`;

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const ROLES=Object.freeze(['before','after','both']);
const FIELD_KEYS=Object.freeze(['target_height','blend_mask','plant_exclusion_mask']);

                                                                            
                                                                        
                                                                              
                                                                             
                                                                     
export const INTERVENTION_MASK_POLICY=Object.freeze({
 existing:'existing-old-root-mask',
 afterOnly:'new-vegetation-no-old-root-mask'
});
export function interventionMaskPolicy(role){
 if(!ROLES.includes(role))throw Error('Invalid intervention asset role');
 return role==='after'?INTERVENTION_MASK_POLICY.afterOnly:INTERVENTION_MASK_POLICY.existing;
}
const afterSources=new WeakMap();
export function interventionSourceForRole(source,role){
 const policy=interventionMaskPolicy(role);
 if(!source||policy!==INTERVENTION_MASK_POLICY.afterOnly)return source;
 if(source.maskPolicy===INTERVENTION_MASK_POLICY.afterOnly)return source;
 let value=afterSources.get(source);
 if(!value){
                                                                             
                                                                              
  value={maskPolicy:policy,
   get native(){return source.native??null;},
   get maskTexture(){return null;},
   get heightTexture(){return source.heightTexture??null;},
   get baseHeightTexture(){return source.baseHeightTexture??null;},
   get enabled(){return false;},
   get after(){return false;},
   get revision(){return source.revision??0;}};
  afterSources.set(source,value);
 }
 return value;
}
                                                                               
                                                                                 
                                                                          
                                                                      
export function validateInterventionManifest(manifest,native){
 return manifest;
}

                                                                              
                                                                         
                                                                              
                                                                              
export function normalizeInterventionFields(native,arrays={}){
 return {target_height:arrays?.target_height,blend_mask:arrays?.blend_mask,plant_exclusion_mask:arrays?.plant_exclusion_mask};
}

function measureInterventionFields(native,manifest,fields){
 const n=native.shape[0]*native.shape[1];let actual=0,modified=0;
 for(let i=0;i<n;i++){
  const a=fields.blend_mask[i];
  if(a>0){actual=Math.max(actual,Math.abs(fields.target_height[i]-native.data[i])*a);modified++;}
 }
 const declared=finite(manifest?.maximum_displacement_m)?manifest.maximum_displacement_m:null;
 const warnings=[];
 if(declared!==null&&actual>declared+1e-4)warnings.push(`Actual displacement ${actual} m exceeds declared bound ${declared} m; using the actual bound`);
 return {maximum_displacement_m:actual,declared_maximum_displacement_m:declared,modified_vertices:modified,warnings};
}

export function validateInterventionFields(native,manifest,arrays){
 return measureInterventionFields(native,manifest,normalizeInterventionFields(native,arrays));
}

export async function loadInterventionInputs(reference,base,native,{fetcher=fetch,signal}={}){
 if(!reference||typeof reference.file!=='string')throw Error('Scene intervention requires a manifest file');
 const url=new URL(reference.file,base);
 async function checked(file){const response=await fetcher(new URL(file,url),{credentials:'include',signal,cache:'no-store'});if(!response.ok)throw Error('Intervention HTTP '+response.status);return response.arrayBuffer();}
 const manifest=validateInterventionManifest(JSON.parse(new TextDecoder().decode(await checked(url.href))),native);
 for(const key of FIELD_KEYS)if(typeof manifest[key]?.file!=='string'||!manifest[key].file.trim())throw Error('Intervention needs file '+key);
 const entries=await Promise.all(FIELD_KEYS.map(async key=>[key,readInterventionNpy(await checked(manifest[key].file)).data]));
                                                                        
                                            
 const arrays=Object.fromEntries(entries);
 const audit=measureInterventionFields(native,manifest,arrays);
 return {manifest,arrays,audit,content_passthrough:true,url:url.href,sha256:typeof reference.sha256==='string'?reference.sha256:null};
}

export async function createTerrainIntervention(viewer,input){
 const terrain=viewer.heightfield;if(!terrain?.heightTexture)throw Error('Intervention requires live storage-capable DEM');
 const native=terrain.native,{manifest,arrays}=input;
 const audit=measureInterventionFields(native,manifest,arrays);
 const nx=native.shape[1],nz=native.shape[0],textures=[];
 const texture=(label,data)=>{const value=new Texture({label,width:nx,height:nz,format:'r32float',data});value.getGPU();textures.push(value);return value;};
 const baseHeightTexture=texture('immutable intervention original DEM',native.data);
 const targetTexture=texture('preloaded intervention target height',arrays.target_height);
 const mask=texture('preloaded intervention feather mask',arrays.blend_mask);
 const maskTexture=texture('preloaded intervention plant deactivation mask',arrays.plant_exclusion_mask);
 const uniform=GPU.device.createBuffer({label:'terrain intervention state',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
 const shader=GPU.device.createShaderModule({label:'terrain intervention composition',code:INTERVENTION_COMPOSE_WGSL});
 const messages=(await shader.getCompilationInfo()).messages.filter(m=>m.type==='error');if(messages.length)throw Error(messages.map(m=>m.message).join('\n'));
 const layout=GPU.device.createBindGroupLayout({entries:[
  {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
  ...[1,2,3].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}})),
  {binding:4,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'r32float'}}]});
 const pipeline=await GPU.device.createComputePipelineAsync({label:'terrain before-after composition',layout:GPU.device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:shader,entryPoint:'compose'}});
 const group=GPU.device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:uniform}},
  ...[baseHeightTexture,targetTexture,mask,terrain.heightTexture].map((value,i)=>({binding:i+1,resource:value.view()}))]});
 const assets=new Map(),systemRoles=new Map();let state='before',dispatches=0,disposed=false;
 terrain.setInterventionBounds?.(Math.max(manifest.maximum_displacement_m??0,audit.maximum_displacement_m));
                                                                               
                                                                            
                                                         
 function applySystem(system,role){
  if(!system)return;
  if(typeof system.setInterventionPolicy==='function'){system.setInterventionPolicy(role,api,terrain);return;}
  system.setIntervention?.(interventionSourceForRole(api,role),terrain);
 }
                                                                               
                                                                              
                                                                                
 const api={manifest,native,maskTexture,heightTexture:terrain.heightTexture,baseHeightTexture,manifestSha256:input.sha256??null,
  targetHeight:arrays.target_height,blendMask:arrays.blend_mask,
  origin:[...native.origin],spacing:[...native.spacing],shape:[...native.shape],enabled:false,revision:0,
  registerAsset(id,asset){
   const role=manifest.asset_states[id]??'both';assets.set(id,{asset,role});
   asset.root.visible=role==='both'||role===state;
   const system=asset.vegetation??null;
   if(system){systemRoles.set(system,role);applySystem(system,role);}
   return role;
  },
  unregisterAsset(id){
   const item=assets.get(id);if(!item)return false;
   if(item.asset.vegetation)systemRoles.delete(item.asset.vegetation);
   return assets.delete(id);
  },
  setState(next){
   if(disposed)throw Error('Terrain intervention disposed');
   if(!['before','after'].includes(next))throw Error('Intervention state must be before or after');
   const started=globalThis.performance?.now?.()??0,priorHold=viewer.shadowCacheHold;
                                                                           
                                                                               
                                                                           
   viewer.shadowCacheHold=true;
   try{
    state=next;api.enabled=next==='after';api.revision++;
    GPU.queue.writeBuffer(uniform,0,new Uint32Array([+api.enabled,nx,nz,0]));
    const encoder=GPU.device.createCommandEncoder({label:'atomic terrain state composition'}),pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(nx/8),Math.ceil(nz/8));pass.end();GPU.queue.submit([encoder.finish()]);dispatches++;
    for(const {asset,role}of assets.values())asset.root.visible=role==='both'||role===state;
    for(const system of viewer.meshRenderer.vegetationSystems)applySystem(system,systemRoles.get(system)??'both');
    viewer.shadows?.requestState?.(next);
                                                                             
                                                                                
                                                                           
    terrain.invalidateIntervention?.();viewer.invalidateVisibility();
    viewer.interventionToggle={state:next,revision:api.revision,handler_ms:(globalThis.performance?.now?.()??started)-started};
   }finally{viewer.shadowCacheHold=priorHold;}
   viewer.canvas?.dispatchEvent(new CustomEvent('interventionchange',{detail:{state,revision:api.revision}}));
   return api.metadata();
  },
  metadata(){return {schema:'aps-live-terrain-intervention/1',state,enabled:api.enabled,revision:api.revision,compose_dispatches:dispatches,
   base_height_sha256:native.sha256,manifest_sha256:input.sha256??null,shape:[...native.shape],fields_preloaded:true,
   render_reconstruction_unchanged:true,per_toggle_cpu_dem_composition:false,per_toggle_instance_reupload:false,
   source_byte_audit:audit,asset_states:[...assets].map(([id,{role,asset}])=>({id,state:role,visible:asset.root.visible,mask_policy:interventionMaskPolicy(role),vegetation_system:!!asset.vegetation})),
   system_policies:[...systemRoles].map(([system,role])=>({role,mask_policy:interventionMaskPolicy(role),enabled:system.intervention?.enabled??null,mask_attached:!!system.intervention?.maskTexture,height_attached:!!system.intervention?.heightTexture}))};},
  dispose(){if(disposed)return;const priorHold=viewer.shadowCacheHold;viewer.shadowCacheHold=true;try{if(api.enabled)api.setState('before');}finally{viewer.shadowCacheHold=priorHold;}disposed=true;viewer.shadows?.invalidateStateCache?.('intervention-disposed');for(const system of viewer.meshRenderer?.vegetationSystems??[])system.setIntervention?.(null);for(const t of textures)t.destroy();uniform.destroy();if(viewer.terrainIntervention===api)viewer.terrainIntervention=null;}
 };
 viewer.terrainIntervention=api;api.setState('before');return api;
}
