import {GRASS_DENSITY_WGSL} from './grass_density.js';
import {LIGHT_CULL_WGSL} from './light_cull_wgsl.js';
const VEGETATION_CULL_BASE=          `
${GRASS_DENSITY_WGSL}
struct View { vp:mat4x4f, screen:vec4f, flags:vec4u, clip:vec4f, control:vec4u, gcEyeEnd:vec4f, gcRange:vec4f, blocks:vec4u, policy:vec4f, densityEye:vec4f, densityPolicy:vec4f }
// Native intervention registration. The root is taken from the true instance
// matrix column, never from the conservative world-bounds center.
struct Intervention { originSpacing:vec4f, shapeEnabled:vec4f }
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var<storage,read> bounds:array<vec4f>;
@group(0) @binding(2) var<storage,read> indexCounts:array<u32>;
@group(0) @binding(3) var<storage,read_write> args:array<atomic<u32>>;
@group(0) @binding(4) var<storage,read_write> visible:array<u32>;
@group(0) @binding(5) var<storage,read_write> state:array<u32>;
@group(0) @binding(6) var<storage,read_write> stats:array<atomic<u32>>;
@group(0) @binding(7) var pyramid:texture_2d<f32>;
/* APS_LIGHT_CULL_INSERT */
// GPU population (blocks.w bit 1) reuses this non-raster grass binding for
// exact world IDs; ordinary vegetation retains its raster visibility buffer.
@group(0) @binding(8) var<storage,read> rasterVisible:array<u32>;
@group(0) @binding(9) var<storage,read> blocks:array<u32>;
@group(0) @binding(10) var<uniform> intervention:Intervention;
@group(0) @binding(11) var interventionMask:texture_2d<f32>;
@group(0) @binding(12) var<storage,read> rootMatrices:array<mat4x4f>;
fn apsInterventionBlocked(xz:vec2f)->bool{
 if(intervention.shapeEnabled.z<.5){return false;}
 let reg=intervention.originSpacing;let shape=intervention.shapeEnabled.xy;
 let g=(xz-reg.xy)/reg.zw;
 if(any(g<vec2f(0.))||any(g>shape-vec2f(1.))){return false;}
 let dims=vec2i(textureDimensions(interventionMask));
 let scale=(vec2f(dims)-vec2f(1.))/max(shape-vec2f(1.),vec2f(1.));
 let t=g*scale;let q=clamp(vec2i(floor(t)),vec2i(0),max(dims-vec2i(2),vec2i(0)));let f=clamp(t-vec2f(q),vec2f(0),vec2f(1));
 let a=textureLoad(interventionMask,q,0).r;let b=textureLoad(interventionMask,vec2i(min(q.x+1,dims.x-1),q.y),0).r;
 let c=textureLoad(interventionMask,vec2i(q.x,min(q.y+1,dims.y-1)),0).r;let d=textureLoad(interventionMask,vec2i(min(q.x+1,dims.x-1),min(q.y+1,dims.y-1)),0).r;
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y)>.5;
}
@compute @workgroup_size(64) fn reset(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i<15u){var v=0u;let lod=i/5u;let lane=i%5u;if(lane==0u){v=indexCounts[lod*3u];}if(lane==2u){v=indexCounts[lod*3u+1u];}if(lane==3u){v=indexCounts[lod*3u+2u];}atomicStore(&args[i],v);}
 if(i<7u){var rejected=0u;if(i==6u&&view.gcRange.z>.5&&view.gcRange.w==0.){rejected=view.control.x;}atomicStore(&stats[i],rejected);}
 if(i==7u){atomicStore(&stats[7],0u);}if(i==8u||i==9u){atomicStore(&stats[i],1u);}
 if(i>=10u&&i<=13u){atomicStore(&stats[i],0u);}
}
// Queue layout: counters [0..6], dispatchWorkgroupsIndirect [7..9],
// reject counters [10..13], then surviving block IDs from slot 14. No CPU
// readback or per-instance dispatch for rejects.
@compute @workgroup_size(64) fn selectBlocks(@builtin(global_invocation_id) gid:vec3u){
 let id=gid.x;if(id>=view.blocks.x){return;}let at=id*72u;
 let center=vec3f(bitcast<f32>(blocks[at]),bitcast<f32>(blocks[at+1u]),bitcast<f32>(blocks[at+2u]));
 let extent=vec3f(bitcast<f32>(blocks[at+4u]),bitcast<f32>(blocks[at+5u]),bitcast<f32>(blocks[at+6u]));
 let count=blocks[at+3u];
 if(blocks[at+7u]==0xffffffffu){atomicAdd(&stats[6],count);return;} // GPU population: empty world tile
 if(view.gcRange.z>.5&&view.gcRange.w<0.){
  let delta=max(abs(center.xz-view.gcEyeEnd.xz)-extent.xz,vec2f(0));
  let dy=max(max(view.gcRange.x-view.gcEyeEnd.y,view.gcEyeEnd.y-view.gcRange.y),0.);
  if(length(vec3f(delta.x,dy,delta.y))>=view.gcEyeEnd.w){atomicAdd(&stats[6],count);return;}
 }
 if(view.flags.x!=0u){
  var outside=array<bool,7>(true,true,true,true,true,true,true);
  for(var k=0u;k<8u;k++){
   let s=vec3f(select(-1.,1.,(k&1u)!=0u),select(-1.,1.,(k&2u)!=0u),select(-1.,1.,(k&4u)!=0u));
   let p=center+extent*s;let c=view.vp*vec4f(p,1.);
   outside[0]=outside[0]&&c.x < -c.w;outside[1]=outside[1]&&c.x>c.w;
   outside[2]=outside[2]&&c.y < -c.w;outside[3]=outside[3]&&c.y>c.w;
   outside[4]=outside[4]&&c.z<0.;outside[5]=outside[5]&&c.z>c.w;
   outside[6]=outside[6]&&dot(view.clip,vec4f(p,1.))<0.;
  }
  for(var k=0u;k<7u;k++){if(outside[k]){atomicAdd(&stats[0],count);return;}}
 }
 let slot=atomicAdd(&stats[7],1u);atomicStore(&stats[14u+slot],id);
}
@compute @workgroup_size(64) fn selectInstances(@builtin(global_invocation_id) gid:vec3u,@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 var id=gid.x;let n=view.control.x;
 if(view.blocks.y!=0u){let at=atomicLoad(&stats[14u+group.x])*72u;if(lane>=blocks[at+3u]){return;}id=blocks[at+8u+lane];}
 if(id>=n){return;}
 if(bounds[id*2u].w<0.){atomicAdd(&stats[6],1u);return;} // GPU population: unplanted slot
 let center=bounds[id*2u].xyz;let extent=bounds[id*2u+1u].xyz;
 if(all(extent<=vec3f(0))){atomicAdd(&stats[0],1u);return;} // unused runtime population slot
 // Rejection only: matrix/ID/LOD stay untouched. rootMatrices is the same
 // native instance matrix consumed by the draw path.
 if(apsInterventionBlocked(rootMatrices[id][3].xz)){atomicAdd(&stats[12],1u);return;}
 if(view.gcRange.z>.5){
  if(view.gcRange.w==0.){return;} // reset already counted a completely excluded asset
  let delta=max(abs(center.xz-view.gcEyeEnd.xz)-extent.xz,vec2f(0));
  let dy=max(max(view.gcRange.x-view.gcEyeEnd.y,view.gcEyeEnd.y-view.gcRange.y),0.);
  let gone=view.gcRange.w<0.&&length(vec3f(delta.x,dy,delta.y))>=view.gcEyeEnd.w;
  if(gone){atomicAdd(&stats[6],1u);return;}
 }
 var allOutside=array<bool,7>(true,true,true,true,true,true,true);
 var near=false;var lo=vec3f(1e30);var hi=vec3f(-1e30);
 for(var k=0u;k<8u;k++){
  let sign=vec3f(select(-1.0,1.0,(k&1u)!=0u),select(-1.0,1.0,(k&2u)!=0u),select(-1.0,1.0,(k&4u)!=0u));
  let p=center+extent*sign;let c=view.vp*vec4f(p,1.0);
  allOutside[0]=allOutside[0]&&(c.x < -c.w);allOutside[1]=allOutside[1]&&(c.x>c.w);
  allOutside[2]=allOutside[2]&&(c.y < -c.w);allOutside[3]=allOutside[3]&&(c.y>c.w);
  allOutside[4]=allOutside[4]&&(c.z<0.0);allOutside[5]=allOutside[5]&&(c.z>c.w);
  allOutside[6]=allOutside[6]&&(dot(view.clip,vec4f(p,1.0))<0.0);
  near=near||c.w<=1e-6||c.z<0.0||c.z>c.w;
  let q=c.xyz/max(c.w,1e-6);let pixel=vec3f((q.x*.5+.5)*view.screen.x,(.5-q.y*.5)*view.screen.y,q.z);
  lo=min(lo,pixel);hi=max(hi,pixel);
 }
 if(view.flags.x!=0u){for(var k=0u;k<7u;k++){if(allOutside[k]){atomicAdd(&stats[0],1u);return;}}}
 var pixels=max(hi.x-lo.x,hi.y-lo.y);if(near){pixels=1e30;atomicAdd(&stats[5],1u);}
 let area=select(max(hi.x-lo.x,0.)*max(hi.y-lo.y,0.),1e30,near);
 if(area<view.policy.z){atomicAdd(&stats[10],1u);return;}
 var densityKey=id+1u;if((view.blocks.w&2u)!=0u){densityKey=rasterVisible[id];}
 if(!apsGrassDensityKeep(densityKey,center,view.densityEye,view.densityPolicy)){atomicAdd(&stats[11],1u);return;}
 var thresholds=view.screen.zw;
 if((view.blocks.w&1u)!=0u){pixels=area;thresholds=view.policy.xy*view.screen.x*view.screen.y;}
 var lod=0u;
 if(view.flags.w!=0u){
  lod=select(select(2u,1u,pixels>=thresholds.y),0u,pixels>=thresholds.x);
  // In the GPU population, binding 8 supplies stable world IDs. A toroidal
  // slot keeps its history only while it still represents the same plant.
  if((view.blocks.w&2u)!=0u){let key=rasterVisible[id];if(state[n+id]!=key){state[id]=3u;state[n+id]=key;}}
  let old=state[id];
  if(old<3u&&old!=lod){
   if(lod>old&&pixels>select(thresholds.x,thresholds.y,old==1u)*.8){lod=old;}
   if(lod<old&&pixels<select(thresholds.x,thresholds.y,lod==1u)*1.2){lod=old;}
  }
 }
 lod=max(lod,view.blocks.z);
 // Grass main/reflection views use the actual LOD2 mesh above the 32x32 area
 // boundary. Solar shadow views keep their separate, unchanged budget.
 if((view.blocks.w&4u)!=0u){lod=2u;}
 let mask=view.control.y;
 if((mask&(1u<<lod))==0u){
  var found=false;for(var k=lod;k<3u;k++){if(!found&&(mask&(1u<<k))!=0u){lod=k;found=true;}}
  if(!found){for(var k=2i;k>=0i;k--){if(!found&&(mask&(1u<<u32(k)))!=0u){lod=u32(k);found=true;}}}
 }
 state[id]=lod;
 if(view.flags.y==2u&&rasterVisible[id]==0u){atomicAdd(&stats[1],1u);return;}
 // Fine->coarse reuse coverage: an instance whose complete projected AABB lies
 // inside this level's valid reuse rectangle was already seeded from the finer
 // depth image, so it needs no vegetation draw at this level. Cross-boundary
 // instances are never rejected here; their fragments are masked instead.
 // stats[13] is reuse_rejected and stays separate from occlusion (stats[1]).
 if(apsLightReuseReject(center,extent)){atomicAdd(&stats[13],1u);return;}
 // Forward-Z static-light complete-bbox occlusion. This branch is disabled
 // (lightCull.flags bit0 clear) for main/reflection views, whose existing
 // reversed-Z Hi-Z branch below is unchanged.
 if(apsLightCullEnabled()&&apsLightCullReject(center,extent)){atomicAdd(&stats[1],1u);return;}
 if(view.flags.y==1u&&view.flags.z!=0u&&!near&&all(hi.xy>=vec2f(0))&&all(lo.xy<view.screen.xy)){
  // Only rasterized coverage matters. A box intersecting a viewport edge is
  // still occludable over its visible rectangle; its off-screen portion does
  // not require depth samples. Keep the nearest depth of the WHOLE bound.
  let visibleLo=clamp(lo.xy,vec2f(0),view.screen.xy-vec2f(0.001));
  let visibleHi=clamp(hi.xy,vec2f(0),view.screen.xy-vec2f(0.001));
  let visiblePixels=max(visibleHi.x-visibleLo.x,visibleHi.y-visibleLo.y);
  // A padded power-of-two pyramid. This mip covers the rectangle with at most
  // two cells per axis. The farthest depth of ALL covered cells is required.
  let mip=min(i32(textureNumLevels(pyramid))-1,i32(ceil(log2(max(1.0,visiblePixels)))));
  let scale=exp2(f32(mip));let dims=vec2i(textureDimensions(pyramid,mip));
  let a=clamp(vec2i(floor(visibleLo/scale)),vec2i(0),dims-vec2i(1));
  let b=clamp(vec2i(floor(visibleHi/scale)),vec2i(0),dims-vec2i(1));
  let taps=vec4f(textureLoad(pyramid,a,mip).r,textureLoad(pyramid,vec2i(b.x,a.y),mip).r,textureLoad(pyramid,vec2i(a.x,b.y),mip).r,textureLoad(pyramid,b,mip).r);
  let reversed=view.flags.z!=0u;let far=select(max(max(taps.x,taps.y),max(taps.z,taps.w)),min(min(taps.x,taps.y),min(taps.z,taps.w)),reversed);
  let cameraNear=max(bitcast<f32>(view.control.z),1e-6);
  let metres=max(bitcast<f32>(view.control.w),0.0);
  let nearest=max(abs(far),abs(hi.z));
  // Perspective reversed-Z includes -near/(far-near) for a finite far plane.
  // The world-space norm of the projection's depth row recovers this offset.
  let offset=length(vec3f(view.vp[0][2],view.vp[1][2],view.vp[2][2]));
  let linearDepth=nearest+offset;
  // World-space tolerance plus eight float32 relative ULPs. This stays
  // conservative for very near bounds without accepting 35m gaps at 400m.
  let bias=linearDepth*linearDepth*metres/(cameraNear*(1.0+offset))+linearDepth*9.536743e-7;
  if(select(lo.z>far+bias,hi.z<far-bias,reversed)){atomicAdd(&stats[1],1u);return;}
 }
 let at=atomicAdd(&args[lod*5u+1u],1u);visible[lod*n+at]=id;atomicAdd(&stats[2u+lod],1u);
}`;

                                                                               
                                                                             
                                                                 
export const VEGETATION_CULL_WGSL=VEGETATION_CULL_BASE.replace('/* APS_LIGHT_CULL_INSERT */',
  () => `${LIGHT_CULL_WGSL}
fn apsLightCullEnabled()->bool{return (lightCull.flags&1u)!=0u;}`);

                                                                        
                                                                           
                                                                             
                                                                    
export const VEGETATION_CULL_WGSL_9STORAGE=VEGETATION_CULL_BASE.replace('/* APS_LIGHT_CULL_INSERT */',
  () => `
// Nine-storage compatibility path: no ReceiverDemand binding.
fn apsLightCullEnabled()->bool{return false;}
fn apsLightCullReject(center:vec3f,extent:vec3f)->bool{return false;}
fn apsLightReuseReject(center:vec3f,extent:vec3f)->bool{return false;}`);

export const VEGETATION_CULL_STORAGE_BINDINGS=9;
export const VEGETATION_CULL_STORAGE_BINDINGS_WITH_LIGHT_CULL=10;

                                                                                
                                                                               
                                                                             
                                                          
                                                                        
export const VEGETATION_DISPATCH_COPY=          `
@group(0) @binding(0) var<storage,read> stats:array<u32>;
@group(0) @binding(1) var<storage,read_write> dispatch:array<u32>;
@compute @workgroup_size(1) fn copyDispatch(){
 dispatch[0]=stats[7];dispatch[1]=stats[8];dispatch[2]=stats[9];
}`;

export const VEGETATION_HIZ_COPY=          `
@group(0) @binding(0) var source:texture_depth_2d;
@group(0) @binding(1) var dest:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){
 let p=vec2i(gid.xy);if(any(p>=vec2i(textureDimensions(dest)))){return;}
 var d=0.0;if(all(p<vec2i(textureDimensions(source)))){d=textureLoad(source,p,0);}
 textureStore(dest,p,vec4f(d));
}`;
export const VEGETATION_HIZ_REDUCE=          `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var dest:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){
 let p=vec2i(gid.xy);if(any(p>=vec2i(textureDimensions(dest)))){return;}
 let s=p*2;let limit=vec2i(textureDimensions(source))-vec2i(1);let d=min(min(textureLoad(source,min(s,limit),0).r,textureLoad(source,min(s+vec2i(1,0),limit),0).r),min(textureLoad(source,min(s+vec2i(0,1),limit),0).r,textureLoad(source,min(s+vec2i(1,1),limit),0).r));
 textureStore(dest,p,vec4f(d));
}`;
