import {ShaderModule,UniformBlock,commonModule,GPU,FrameUniforms,RenderTarget,FullscreenPass,generateMipmaps} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {WaterMaterial} from '../../vendor/tidewater/src/ocean/WaterMaterial.js';
import {RefractionPass as NativeRefractionPass} from '../../vendor/tidewater/src/ocean/RefractionPass.js';
import {SceneLighting} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';

import {surfaceModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {OCEAN_OPTICAL_HELPERS,oceanOpticalOutput} from './ocean_optical_shader.js';
import {OCEAN_REFLECTION_TRACE_WGSL} from './ocean_reflection.js';
import {normalGuardModule} from './normal_guard.js';

                                                                             
                                                                                
export const OCEAN_RECEIVER_COLUMN_WGSL=`
// Same displaced surface and animated dry/film coverage as the water draw.
// Evaluated at the receiver fragment, never on a terrain vertex or mask texel.
fn oceanReceiverFragmentContact(P:vec3f,footprint:f32)->f32 {
 if(shoreP.enabled==0u||shoreP.wetness==0u){return 0.0;}
 var q=P.xz;
 for(var i=0;i<5;i++){let d=oceanCompositeDisplacement(q,footprint).xyz;q=P.xz-d.xz;}
 let waterY=frame.seaLevel+oceanCompositeDisplacement(q,footprint).y;
 let gap=waterY-P.y;
 let front=oceanDryShoreFront(P.xz);
 let coverage=oceanAnimatedShoreCoverage(P.xz,footprint,max(0.003,fwidth(front.x)));
 return oceanReceiverContactWeight(gap,max(0.00015,0.5*fwidth(gap)),coverage);
}
fn oceanReceiverContactWeight(gap:f32,width:f32,coverage:f32)->f32 {
 return smoothstep(-width,width,gap-0.00015)*coverage;
}
fn oceanReceiverWaterColumn(P:vec3f)->vec2f {
 if(shoreP.enabled==0u){return vec2f(0);}
 var depth=max(0.0,frame.seaLevel-P.y);var surfaceY=frame.seaLevel;
 if(oceanBedKnown(P.xz)){
  let support=oceanPageSupport(P.xz).x;
  if(support>1e-6){
   let bed=oceanBed(P.xz);let meanDepth=frame.seaLevel-bed;
   let blend=1.0-smoothstep(max(0.12,shoreP.hs*0.18),max(0.9,shoreP.hs*1.1),meanDepth);
   surfaceY=max(frame.seaLevel+oceanPageProfile(P.xz).y*blend,bed+0.0003);
   depth=max(0.0,surfaceY-P.y);
  }
 }
 let coverage=smoothstep(0.0003,0.006,depth)*oceanAnimatedShoreCoverage(P.xz,0.06,0.003);
 return vec2f(depth,coverage);
}
// The animated thin sheet uses the same physical clear-water interface.
fn oceanReceiverOpticalColumn(P:vec3f)->vec2f {
 let water=oceanReceiverWaterColumn(P);
 return water;
}
`;

export const OCEAN_RECEIVER_SHADOW_WGSL=`
fn oceanShoreShadowRelease(distance:f32,fadeDistance:f32,beach:f32,film:f32,foam:f32,contact:f32)->f32 {
 var seaward=0.0;if(fadeDistance>0.0){seaward=1.0-smoothstep(0.0,fadeDistance,distance);}
 return mix(seaward,max(film,foam),beach)*contact;
}
fn oceanShoreShadowVisibility(P:vec3f,visibility:f32)->f32 {
 if(shoreP.enabled==0u||!oceanBedKnown(P.xz)){return visibility;}
 let bed=oceanBed(P.xz);let contact=1.0-smoothstep(0.05,0.2,abs(P.y-bed));
 if(contact<=0.0){return visibility;}
 let e=0.25;let dx=vec2f(e,0);let dz=vec2f(0,e);
 let gradient=vec2f(oceanBed(P.xz+dx)-oceanBed(P.xz-dx),oceanBed(P.xz+dz)-oceanBed(P.xz-dz))/(2.0*e);
 // Local metric distance approximation: adjustable seaward transition from no shadow
 // at the actual mean-bed waterline to the usual submerged shadow policy.
 let distance=max(0.0,frame.seaLevel-bed)/max(0.015,length(gradient));
 let beach=oceanBeachFoamBlend(P.xz);
 let film=oceanReceiverWaterColumn(P).y;
 let foam=smoothstep(0.002,0.03,shoreSimSample(P.xz).x);
 let release=oceanShoreShadowRelease(distance,oceanReceiverP.shadowFadeDistance,beach,film,foam,contact);
 return mix(visibility,1.0,release);
}
`;

                                                                              
export class OceanPhysicalMaterial extends WaterMaterial {
  _build(){
    super._build();
    if(this.waterSurface.terrain){this.depthBias=2;this.depthBiasSlopeScale=0.5;}
    this.params.ssr.value=Number(!!this.reflection);
  }
  _shadeWGSL(options){
    const spec=SceneLighting.hooks.envSpecular,diff=SceneLighting.hooks.envDiffuse;
    if(!spec||!diff||!this.refraction?.module)throw Error('Ocean requires preintegrated IBL and the owned receiver capture');
    this.modules.push(spec,diff,surfaceModule,this.refraction.module,
      new ShaderModule({name:'apsAcceptedOceanOptics',deps:[commonModule,normalGuardModule],code:OCEAN_OPTICAL_HELPERS}));
    return oceanOpticalOutput(options,this.cameraWaterHeightNode?String(this.cameraWaterHeightNode):'frame.seaLevel');
  }
}

                                                                                
                                                                              
export class RefractionPass extends NativeRefractionPass {
  constructor(options){
    super(options);this.target.texture.destroy();this.target.depthTexture.destroy();
    this.target=options.sceneRenderer.opaqueCopy;this.texture=this.target.texture;this.depthTexture=this.target.depthTexture;
    this.calls=0;this.guard={sx:1,sy:1,cx:0,cy:0};
    this.mapping=new UniformBlock('OceanRefractionSource',{
      inverseViewProjection:['mat4x4f',new Matrix4()],viewProjection:['mat4x4f',new Matrix4()],inverseProjection:['mat4x4f',new Matrix4()],
      bedSpacing:['f32',options.bedSpacing??1.25],receiverCell:['vec2f',[1,1]],receiverIterations:['u32',5],
    });
    this.module=new ShaderModule({name:'oceanRefractionSource',deps:[commonModule],uniforms:this.mapping,uniformName:'oceanRefr',code:`
fn oceanRefractionUV(ndc:vec2f)->vec2f {return vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5);}
fn oceanRefractionInside(uv:vec2f)->bool {return all(uv>=vec2f(0.0))&&all(uv<vec2f(1.0));}
fn oceanRefractionWorld(uv:vec2f,depth:f32)->vec3f {
 let h=oceanRefr.inverseViewProjection*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,depth,1.0);return h.xyz/h.w;
}`});
  }
  render(){
    const fields=FrameUniforms.fields;
    this.mapping.set('inverseViewProjection',fields.invViewProj.value.clone());
    this.mapping.set('viewProjection',fields.viewProj.value.clone());this.mapping.set('inverseProjection',fields.invProj.value.clone());this.calls++;
  }
  metadata(){return {calls:this.calls,geometry_passes:0,guard:{...this.guard},resolution:[this.target.width,this.target.height],source:'current main opaque colour/depth copy, borrowed from SceneRenderer',depth_reconstruction:'matched current main inverse view-projection',intersection:'metric native bed 64 exponential steps + 8 bisections; 4 matched colour/depth taps; Snell air/object ray',receiver_validation:'strict bent receivers; straight contact bounded by four encoded-depth ULPs plus eight float32 world ULPs; displaced wave and animated film occupancy retained',optical_distance:'shared validated undistorted receiver distance for refracted, fallback and medium transport; coincident contact retains its short path; 180m only when unavailable',optical_scattering:'one common water transport after normalized receiver-colour blending; current Snell direction for every confidence value',invalid_receiver:'valid colour support normalized, never black opacity; zero receiver colour only when both unavailable; spatial wet coverage applied once',out_of_source_rays:'rejected; bent hit distance qualifies colour only, never selects attenuation thickness',limitations:'one visible depth layer and main viewport; hidden/off-screen receivers cannot be recovered'};}
  dispose(){this.block.buffer?.destroy();this.mapping.buffer?.destroy();}
}

                                                                              
                                                                                 
const sharedReflectionSources=new WeakMap();
export class OceanScreenSpaceReflection {
  constructor(viewer,seaLevel) {
    this.viewer=viewer;this.sea=seaLevel;this.calls=0;this.disposed=false;
    const existing=sharedReflectionSources.get(viewer);
    if(existing){this.shared=existing;existing.references++;Object.assign(this,{target:existing.target,mapping:existing.mapping,module:existing.module,coverage:existing.coverage});return;}
    this.target=new RenderTarget(1,1,{colors:['rgba16float'],mips:true,label:'ocean SSR opaque radiance'});
    this.mapping=new UniformBlock('OceanSSRSource',{viewProjection:['mat4x4f',new Matrix4()],inverseViewProjection:['mat4x4f',new Matrix4()],view:['mat4x4f',new Matrix4()],inverseProjection:['mat4x4f',new Matrix4()],near:['f32',.1],maxDistance:['f32',16000]});
    this.module=new ShaderModule({name:'oceanScreenSpaceReflection',deps:[commonModule],uniforms:this.mapping,uniformName:'oceanSSRP',bindings:{oceanSSRColor:{texture:this.target.texture},oceanSSRDepthTexture:{texture:()=>viewer.sceneRenderer.opaqueCopy.depthTexture}},code:OCEAN_REFLECTION_TRACE_WGSL});
    this.coverage=new FullscreenPass({label:'ocean SSR main opaque coverage',bindings:{ssrSourceColor:{texture:()=>viewer.sceneRenderer.opaqueCopy.texture},ssrSourceDepth:{texture:()=>viewer.sceneRenderer.opaqueCopy.depthTexture}},code:`
fn fragment(in:FSIn)->vec4f {
 let px=vec2i(in.pos.xy);let depth=textureLoad(ssrSourceDepth,px,0);
 if(depth<=0.0){return vec4f(0);}
 return vec4f(textureLoad(ssrSourceColor,px,0).rgb,1.0);
}`});
    this.shared={target:this.target,mapping:this.mapping,module:this.module,coverage:this.coverage,references:1,frame:-1,source:null,viewProjection:null,preparations:0};sharedReflectionSources.set(viewer,this.shared);
  }
  render(){
    if(this.disposed)return;
    const fields=FrameUniforms.fields,source=this.viewer.sceneRenderer.opaqueCopy;
    const shared=this.shared,vp=fields.viewProj.value.elements;this.calls++;
    if(shared.frame===GPU.frame&&shared.source===source&&shared.width===source.width&&shared.height===source.height&&shared.viewProjection?.every((v,i)=>v===vp[i]))return;
    this.target.setSize(source.width,source.height);
    this.mapping.set('viewProjection',fields.viewProj.value.clone());this.mapping.set('inverseViewProjection',fields.invViewProj.value.clone());
    this.mapping.set('view',fields.view.value.clone());this.mapping.set('inverseProjection',fields.invProj.value.clone());this.mapping.set('near',this.viewer.camera.near??.1);
    this.coverage.render({colorViews:[this.target.texture],clear:[0,0,0,0]});
    generateMipmaps(this.target.texture);shared.preparations++;shared.frame=GPU.frame;shared.source=source;shared.width=source.width;shared.height=source.height;shared.viewProjection=Array.from(vp);
  }
  metadata(){return {method:'screen-space reflection',calls:this.calls,shared_source_preparations:this.shared.preparations,shared_source_users:this.shared.references,geometry_passes:0,auxiliary_cameras:0,resolution:[this.target.width,this.target.height],source:'current main opaque colour/depth, coverage/mips shared by ocean and pools once per frame',sampling:'perspective-correct reflected ray, up to 96 steps and 6 refinements',filter:'depth-qualified premultiplied HDR coverage mips',miss:'existing preintegrated environment',limitations:'only main-camera visible opaque receivers; screen edges and missing/hidden receivers fade to environment'};}
  dispose(){if(this.disposed)return;this.disposed=true;if(--this.shared.references===0){this.mapping.buffer?.destroy();for(const t of this.target.textures)t.destroy();sharedReflectionSources.delete(this.viewer);}this.coverage=null;}
}

export function oceanReceiverModule(surface,shore,params=new UniformBlock('OceanReceiverOptions',{shadowFadeDistance:['f32',2],depthDisplayMax:['f32',1]})) {
  return new ShaderModule({name:'oceanPhysicalReceiver',deps:[shore.pageModule,surface.displacementModule],uniforms:params,uniformName:'oceanReceiverP',code:`
${OCEAN_RECEIVER_COLUMN_WGSL}
${OCEAN_RECEIVER_SHADOW_WGSL}
fn oceanSunTransmission(cosine:f32)->f32 {
 let c=clamp(cosine,0.0,1.0);let eta=1.333;
 let t=sqrt(max(0.0,1.0-(1.0-c*c)/(eta*eta)));let rs=(c-eta*t)/max(1e-6,c+eta*t);let rp=(eta*c-t)/max(1e-6,eta*c+t);
 return 1.0-0.5*(rs*rs+rp*rp);
}
fn oceanAmbientModulation(P:vec3f)->vec3f {let water=oceanReceiverOpticalColumn(P);return mix(vec3f(1.0),exp(-(frame.waterAbsorption+frame.waterScattering)*water.x/0.8),water.y);}
`});
}
