import {GPU,Texture,UniformBlock,ShaderModule,ComputeKernel,commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {OCEAN_RECEIVER_COLUMN_WGSL} from './ocean_optics.js';

                                                                          
                                                                                   
export const CAUSTIC_FOCUS_WGSL=`
fn oceanCausticDisplacement(q:vec2f,footprint:f32)->vec3f {
 return oceanCompositeDisplacementMask(q,max(causticP.minimumStep,footprint),causticP.cascadeMask).xyz;
}
fn oceanCausticNormal(q:vec2f,footprint:f32)->vec3f {
 // Exact FFT derivatives, including shore weights and the bed constraint.
 // All four layers + original step follows the original normal sampling.
 let fp=max(causticP.minimumStep,footprint);let t=oceanCompositeTangentsMask(q,fp,causticP.cascadeMask);
 let bed=oceanBed(q);let water=oceanReceiverOpticalColumn(vec3f(q.x,bed,q.y));
 let film=oceanPageSupport(q).x*(1.0-smoothstep(0.03,0.35,water.x));
 var tx=t[0];var tz=t[1];
 if(film>1e-6){
  // The clear sheet still has resolved FFT optical detail above mean sea.
  // Restore only the attenuation loss; no water displacement is changed.
  for(var c=0;c<4;c++){
   if((causticP.cascadeMask&(1u<<u32(c)))==0u){continue;}
   let uv=oceanUv(q,c);let lod=oceanLod(fp,c);
   let d=textureSampleLevel(oceanDerivatives,smpLinearRepeat,uv,c,lod);let crossD=textureSampleLevel(oceanCross,smpLinearRepeat,uv,c,lod).x;
   let gain=film*(1.0-waterSurfaceCascadeAttenuation(c,frame.seaLevel-bed));
   tx+=vec3f(ocean.choppiness*d.z,d.x,ocean.choppiness*crossD)*gain;
   tz+=vec3f(ocean.choppiness*crossD,d.y,ocean.choppiness*d.w)*gain;
  }
 }
 return normalize(cross(tz,tx));
}
fn oceanRefractedPoint(q:vec2f,y:f32,footprint:f32)->vec2f {
 let n=oceanCausticNormal(q,footprint);let ray=refract(-normalize(frame.sunDir),n,1.0/1.333);
 if(abs(ray.y)<.02){return q;}let wave=oceanCausticDisplacement(q,footprint);
 return q+wave.xz+ray.xz*(y-frame.seaLevel-wave.y)/ray.y;
}
fn oceanCausticFocus(world:vec3f,footprint:f32)->f32 {
 let water=oceanReceiverOpticalColumn(world);let depth=water.x;if(water.y<=1e-6||depth>=22.0||frame.sunDir.y<=.001){return 1.0;}
 // Retain the accepted 1 m approximation in established water. In the thin
 // sheet the receiver plane approaches the actual bed as thickness vanishes.
 let opticalDepth=mix(depth,1.0,smoothstep(0.03,0.35,depth));let surfaceY=world.y+depth;
 let planeY=surfaceY-opticalDepth;let flat=refract(-normalize(frame.sunDir),vec3f(0,1,0),1.0/1.333);
 if(flat.y>=-.001){return 1.0;}var q=world.xz+flat.xz/flat.y*opticalDepth;
 let minimumStep=causticP.minimumStep;let sampleFootprint=max(minimumStep,footprint*1.5);
 let e=max(minimumStep,footprint);
 // One call site and a uniform loop bound prevent driver unrolling from
 // duplicating the complete shore/FFT optical graph. The seven evaluations
 // remain the original three inverse updates plus four Jacobian probes.
 var hits:array<vec2f,4>;
 for(var i=0u;i<causticP.traceEvaluations;i++){
  var probe=q;
  if(i>=3u){let j=i-3u;let sign=select(1.0,-1.0,(j&1u)!=0u);probe+=select(vec2f(e*sign,0),vec2f(0,e*sign),j>=2u);}
  let hit=oceanRefractedPoint(probe,planeY,sampleFootprint);
  if(i<3u){q+=world.xz-hit;}else{hits[i-3u]=hit;}
 }
 let dx=hits[0]-hits[1];let dz=hits[2]-hits[3];
 let jac=abs(dx.x*dz.y-dx.y*dz.x)/(4.0*e*e);let focus=clamp(1.0/max(.16,jac),.12,5.0);
 return mix(focus,1.0,smoothstep(12.0,22.0,depth));
}`;

export class OceanCaustics {
 constructor(ocean){
  this.ocean=ocean;this.steps=0;this.scale=1;this.mips=[];
  this.texture=new Texture({label:'screen receiver caustic irradiance and depth support',format:'rgba32float',mips:true,usage:['sample','storage']});
  this.fallback=new Texture({label:'coarse whole native-bed caustic fallback',width:512,height:512,format:'rgba32float',mips:true,usage:['sample','storage']});
  this.params=new UniformBlock('ScreenCausticParams',{inverse:['mat4x4f',new Matrix4()],viewProjection:['mat4x4f',new Matrix4()],view:['mat4x4f',new Matrix4()],ready:['u32',0],shadowAttenuation:['f32',ocean.config.causticShadowAttenuation],cascadeMask:['u32',ocean.config.causticCascadeMask],minimumStep:['f32',ocean.config.causticMinimumStep],traceEvaluations:['u32',7],receiverSamples:['u32',4]});
  this.domain=new ShaderModule({name:'screenCausticDomain',deps:[commonModule],uniforms:this.params,uniformName:'causticP',code:`
fn oceanCausticWorld(uv:vec2f,d:f32)->vec3f {let p=causticP.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,d,1);return p.xyz/p.w;}
fn oceanCausticUV(P:vec3f)->vec3f {let c=causticP.viewProjection*vec4f(P,1);return vec3f(c.x/c.w*.5+.5,.5-c.y/c.w*.5,c.w);}
fn oceanCausticScreenFootprint(P:vec3f,dx:vec3f,dy:vec3f)->vec2f {let uv=oceanCausticUV(P).xy;return max(abs(oceanCausticUV(P+dx).xy-uv),abs(oceanCausticUV(P+dy).xy-uv));}
`});
  this.trace=new ShaderModule({name:'screenCausticPhotonTrace',deps:[ocean.surface.displacementModule,this.domain],code:OCEAN_RECEIVER_COLUMN_WGSL+CAUSTIC_FOCUS_WGSL});
  const write=texture=>({storageTexture:texture,access:'write',view:{baseMipLevel:0,mipLevelCount:1}});
  this.kernel=new ComputeKernel({label:'Screen opaque receiver four-subpixel irradiance',modules:[this.trace],bindings:{receiverDepth:{texture:()=>ocean.viewer.sceneRenderer.opaqueCopy.depthTexture},focusOut:write(this.texture)},workgroupSize:[8,8,1],code:`
fn receiverStep(pixel:vec2i,axis:vec2i,P:vec3f,d:f32)->vec3f {
 let size=vec2i(textureDimensions(receiverDepth));let a=pixel+axis;let b=pixel-axis;
 let da=textureLoad(receiverDepth,clamp(a,vec2i(0),size-1),0);let db=textureLoad(receiverDepth,clamp(b,vec2i(0),size-1),0);
 let va=all(a>=vec2i(0))&&all(a<size)&&da>0.0;let vb=all(b>=vec2i(0))&&all(b<size)&&db>0.0;
 let pa=oceanCausticWorld((vec2f(a)+.5)/vec2f(size),max(1e-20,da))-P;
 let pb=P-oceanCausticWorld((vec2f(b)+.5)/vec2f(size),max(1e-20,db));
 if(va&&vb){return select(pb,pa,dot(pa,pa)<dot(pb,pb));}if(va){return pa;}if(vb){return pb;}
 return oceanCausticWorld((vec2f(pixel+axis)+.5)/vec2f(size),d)-P;
}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(receiverDepth);if(any(id.xy>=size)){return;}let pixel=vec2i(id.xy);let d=textureLoad(receiverDepth,pixel,0);
 var result=vec4f(0);if(d>0.0){let P=oceanCausticWorld((vec2f(pixel)+.5)/vec2f(size),d);let water=oceanReceiverOpticalColumn(P);
 if(water.y>1e-6&&water.x<22.0&&frame.sunDir.y>.001){let dx=receiverStep(pixel,vec2i(1,0),P,d);let dy=receiverStep(pixel,vec2i(0,1),P,d);
 let footprint=max(.0001,.5*max(length(dx.xz),length(dy.xz)));var focus=0.0;
 for(var i=0u;i<causticP.receiverSamples;i++){let offset=vec2f(select(-.25,.25,i%2u==1u),select(-.25,.25,i>=2u));focus+=oceanCausticFocus(P+dx*offset.x+dy*offset.y,footprint)*.25;}
 result=vec4f(focus,-(causticP.view*vec4f(P,1)).z,.5*max(length(dx),length(dy)),1);}}
 textureStore(focusOut,id.xy,result);
}`});
  this.fallbackKernel=new ComputeKernel({label:'Whole native-bed coarse optical fallback',modules:[this.trace],bindings:{focusOut:write(this.fallback)},workgroupSize:[8,8,1],code:`
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=vec2u(512))){return;}
 let q=shoreP.domain.xy+(vec2f(id.xy)+.5)/512.0*shoreP.domain.zw;let bed=oceanBed(q);let P=vec3f(q.x,bed,q.y);let water=oceanReceiverOpticalColumn(P);var result=vec4f(0);
 if(oceanBedKnown(q)&&water.y>1e-6&&water.x<22.0){result=vec4f(oceanCausticFocus(P,.5*max(shoreP.domain.z,shoreP.domain.w)/512.0),0,0,1);}textureStore(focusOut,id.xy,result);
}`});
  this.module=new ShaderModule({name:'oceanScreenCausticReceiver',deps:[ocean.receiverModule,this.domain],bindings:{oceanCausticReceiver:{texture:this.texture,sampleType:'unfilterable-float'},oceanCausticFallback:{texture:this.fallback,sampleType:'unfilterable-float'}},code:`
fn oceanCausticBilinear(tex:texture_2d<f32>,uv:vec2f,mip:i32)->vec4f {
 let size=vec2i(textureDimensions(tex,mip));let q=uv*vec2f(size)-.5;let a=vec2i(floor(q));let f=fract(q);var result=vec4f(0);
 for(var i=0;i<4;i++){let offset=vec2i(i%2,i/2);let w=mix(1.0-f,f,vec2f(offset));result+=textureLoad(tex,clamp(a+offset,vec2i(0),size-1),mip)*w.x*w.y;}return result;
}
fn oceanFallbackCaustics(P:vec3f,footprint:f32)->f32 {
 let uv=(P.xz-shoreP.domain.xy)/shoreP.domain.zw;if(any(uv<vec2f(0))||any(uv>vec2f(1))){return 1.0;}
 let lod=clamp(log2(max(1.0,2.0*footprint*512.0/min(shoreP.domain.z,shoreP.domain.w))),0.0,9.0);
 let c=mix(oceanCausticBilinear(oceanCausticFallback,uv,i32(floor(lod))),oceanCausticBilinear(oceanCausticFallback,uv,i32(min(9.0,floor(lod)+1.0))),fract(lod));return select(1.0,c.x/max(.00001,c.w),c.w>.00001);
}
fn oceanCausticFactorCached(P:vec3f,N:vec3f,footprint:f32,screenFootprint:vec2f,water:vec2f)->f32 {
 if(shoreP.caustics==0u||causticP.ready==0u||frame.sunDir.y<=.001||water.y<=1e-6||water.x>=22.0){return 1.0;}
 let projected=oceanCausticUV(P);let fallback=oceanFallbackCaustics(P,footprint);
 if(projected.z<=0.0||any(projected.xy<vec2f(0))||any(projected.xy>vec2f(1))){return fallback;}
 let size=vec2f(textureDimensions(oceanCausticReceiver));let maxMip=floor(log2(max(size.x,size.y)));
 let lod=clamp(log2(max(1.0,max(screenFootprint.x*size.x,screenFootprint.y*size.y)))+.5,0.0,maxMip);
 let viewDepth=-(causticP.view*vec4f(P,1)).z;var focus=0.0;var coverage=0.0;
 for(var level=0;level<2;level++){let mip=i32(min(maxMip,floor(lod)+f32(level)));let dim=vec2i(textureDimensions(oceanCausticReceiver,mip));let q=projected.xy*vec2f(dim)-.5;let a=vec2i(floor(q));let f=fract(q);
 for(var i=0;i<4;i++){let offset=vec2i(i%2,i/2);let c=textureLoad(oceanCausticReceiver,clamp(a+offset,vec2i(0),dim-1),mip);if(c.w<=.00001){continue;}
 let tolerance=max(.002,4.0*max(footprint,c.z/c.w*exp2(f32(mip))));let confidence=1.0-smoothstep(tolerance,tolerance*2.0,abs(viewDepth-c.y/c.w));let w=mix(1.0-f,f,vec2f(offset));
 let weight=w.x*w.y*select(1.0-fract(lod),fract(lod),level==1)*confidence;focus+=c.x*weight;coverage+=c.w*weight;}}
 if(coverage>.999){return focus/coverage;}return select(fallback,mix(fallback,focus/max(.00001,coverage),clamp(coverage,0.0,1.0)),coverage>.00001);
}
fn oceanReceiverDirectModulation(P:vec3f,N:vec3f,footprint:f32,screenFootprint:vec2f)->vec3f {
 let water=oceanReceiverOpticalColumn(P);if(water.y<=1e-6){return vec3f(1.0);}let T=refract(-normalize(frame.sunDir),vec3f(0,1,0),1.0/1.333);let path=water.x/max(.08,-T.y);
 let submerged=exp(-(frame.waterAbsorption+frame.waterScattering)*path)*oceanSunTransmission(frame.sunDir.y)*oceanCausticFactorCached(P,N,footprint,screenFootprint,water);
 return mix(vec3f(1.0),submerged,water.y);
}
fn oceanCausticShadowVisibility(P:vec3f,visibility:f32)->f32 {
 let water=oceanReceiverOpticalColumn(P);let depth=water.x;
 var adjusted=visibility;
 // Requested visual option: the same focused irradiance survives terrain
 // shadow at a fraction of sunlight. Zero restores complete occlusion.
 if(shoreP.enabled>0u&&shoreP.caustics>0u&&causticP.ready>0u&&frame.sunDir.y>.001&&water.y>1e-6&&depth<22.0){
  let weight=water.y*(1.0-smoothstep(12.0,22.0,depth));
  adjusted=mix(visibility,max(visibility,causticP.shadowAttenuation),weight);
 }
 return oceanShoreShadowVisibility(P,adjusted);
}`});
 }
 downsample(texture){
  let chain=this.mips.find(c=>c.texture===texture);if(!chain){chain={texture,kernels:[]};this.mips.push(chain);}
  for(let l=1;l<texture.mipLevelCount;l++){
   let k=chain.kernels[l-1];if(!k){k=new ComputeKernel({label:'Caustic premultiplied irradiance mip '+l,bindings:{src:{texture,sampleType:'unfilterable-float',view:{baseMipLevel:l-1,mipLevelCount:1}},dst:{storageTexture:texture,access:'write',view:{baseMipLevel:l,mipLevelCount:1}}},workgroupSize:[8,8,1],code:`
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){let size=textureDimensions(dst);if(any(id.xy>=size)){return;}let sourceSize=vec2i(textureDimensions(src));
 // Area footprint handles odd/non-power-of-two screen extents too.
 let lo=vec2f(id.xy)/vec2f(size)*vec2f(sourceSize);let hi=vec2f(id.xy+1u)/vec2f(size)*vec2f(sourceSize);var value=vec4f(0);var weight=0.0;
 for(var y=i32(floor(lo.y));y<i32(ceil(hi.y));y++){for(var x=i32(floor(lo.x));x<i32(ceil(hi.x));x++){let p=vec2i(x,y);let w=max(vec2f(0),min(hi,vec2f(p+1))-max(lo,vec2f(p)));let area=w.x*w.y;value+=textureLoad(src,clamp(p,vec2i(0),sourceSize-1),0)*area;weight+=area;}}textureStore(dst,id.xy,value/max(1e-6,weight));
}`});chain.kernels[l-1]=k;}k.dispatch([Math.ceil(Math.max(1,texture.width>>l)/8),Math.ceil(Math.max(1,texture.height>>l)/8)]);
  }
 }
 update(){
  const o=this.ocean,v=o.viewer;this.params.set('ready',0);if(!o.enabled||!o.shore.params.get('caustics'))return;
  const snapshot=v.opaqueSnapshot,w=v.sceneRenderer.width,h=v.sceneRenderer.height;
  this.densityScale=1;this.texture.resize(w,h);
  const valid=snapshot&&snapshot.width===w&&snapshot.height===h&&snapshot.frame===v.frame-1;
  if(valid){
                                                                               
                                                                         
   this.params.set('inverse',snapshot.inverse);this.params.set('viewProjection',snapshot.viewProjection);this.params.set('view',snapshot.view);
   this.kernel.dispatch([Math.ceil(w/8),Math.ceil(h/8)]);this.downsample(this.texture);this.sourceFrame=snapshot.frame;
  }
  const key=JSON.stringify([o.time,Array.from(frameSun(v)),o.shore.steps,this.params.get('cascadeMask'),this.params.get('minimumStep')]);if(key!==this.fallbackKey){this.fallbackKey=key;this.fallbackKernel.dispatch([64,64]);this.downsample(this.fallback);}
  this.params.set('ready',valid?1:0);this.steps++;
 }
 metadata(){return {method:'reprojected prior main opaque depth and current-wave refracted-ray Jacobian',geometry_passes:0,source_frame:this.sourceFrame??null,source_age_frames:this.sourceFrame==null?null:this.ocean.viewer.frame-this.sourceFrame,resolution:[this.texture.width,this.texture.height],central_screen_density_scale:this.densityScale??1,frustum_scale:this.scale,spatial_detail_tiers:0,subpixel_samples:4,wave_sampling:{cascade_mask:this.params.get('cascadeMask'),included_cascades:[512,128,32,8].filter((_,i)=>(this.params.get('cascadeMask')&(1<<i))!==0),minimum_curvature_half_step_m:this.params.get('minimumStep'),normal_sampling:'selected-band FFT derivatives; resolved optical attenuation restored in shallow water'},fft_resolution_independent:true,cadence:'current-wave compute using previous complete opaque depth with matched saved camera; invalid source disabled for one frame',virtual_receiver_depth_m:1,thin_sheet_receiver:'land sheet is foam-only; shallow submerged receiver uses actual depth below 3cm, blended to 1m over 3--35cm',receiver_coverage:'current dry-front and column fade, multiplied by submerged-side beach blend',receiver_lod:'continuous depth-validated premultiplied irradiance mips with half-level bias',shadow_attenuation:this.params.fields.shadowAttenuation.value,shore_shadow_fade_distance_m:this.ocean.receiverParams?.get('shadowFadeDistance')??2,shadow_policy:'adjustable local metric shore transition to no shadow; active land film/foam releases shadow at bed contact; offshore keeps configured caustic sunlight floor',history:'one prior depth frame; irradiance recomputed with current waves, no temporal colour accumulation',updates:this.steps,fallback:'whole native bed at FFT-size resolution for newly exposed or off-screen receivers',approximation:'one-frame receiver geometry lag; cached shore column without residual FFT height or XZ inversion; local depth/bed-gradient shore distance; bounded 1/J focus and established-water 1m plane, not exact photon tracing'};}
 dispose(){this.texture.destroy();this.fallback.destroy();this.params.buffer?.destroy();}
}
function frameSun(viewer){return viewer.lighting.weather.sunDirection??[0,1,0];}
