import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {FullscreenPass} from '../../vendor/tidewater/src/engine/render/FullscreenPass.js';
import {HEIGHT_FOG_WGSL} from './height_fog.js';
import {volumeShadowModule} from './volume_transport.js';
import {releaseAfterSubmit} from './lighting_native.js';

export const FOG_VOLUME_WGSL=          `
// Inverse of the integrated exponential profile, including the constant-density
// region below base height. This distributes work over scattering, not empty air.
fn apsFogDistanceForIntegral(y:f32,dy:f32,mass:f32,limit:f32)->f32 {
 let k=post.fogHeightFalloff;
 if(k<1e-8){return min(mass,limit);}
 let rho=exp(-max(0.,y)*k);
 if(abs(dy)<1e-6){return min(mass/max(rho,1e-30),limit);}
 if(y<=0.){
  if(dy<=0.){return min(mass,limit);}
  let crossing=-y/dy;
  if(mass<=crossing){return min(mass,limit);}
  return min(crossing-log(max(1.-(mass-crossing)*k*dy,1e-30))/(k*dy),limit);
 }
 if(dy<0.){
  let above=(1.-rho)/(-k*dy);
  if(mass>=above){return min(-y/dy+mass-above,limit);}
 }
 let x=-mass*k*dy/max(rho,1e-30);
 // log(1+x) loses the entire distance for small optical changes in f32.
 let logarithm=select(log(max(1.+x,1e-30)),x-x*x*.5,abs(x)<.001);
 return clamp(-logarithm/(k*dy),0.,limit);
}
fn apsFogRayDistance(uv:vec2f,depth:f32)->f32 {
 if(isSky(depth)){return post.fogMaxDistance;}
 return min(length(worldFromDepth(uv,depth)-frame.cameraPos),post.fogMaxDistance);
}
fn apsFogSunSource(uv:vec2f,depth:f32)->vec3f {
 if(post.fog<.5 || post.fogVolumetric<.5 || post.fogDensity<=0. || post.fogSunIntensity<=0. || max(max(frame.sunColor.r,frame.sunColor.g),frame.sunColor.b)<=0.){return vec3f(0);}
 let D=viewRay(uv);let distance=apsFogRayDistance(uv,depth);
 let start=min(post.fogStart,distance);let span=distance-start;
 let y=frame.cameraPos.y+D.y*start-post.fogBaseHeight;
 let tau=post.fogDensity*apsFogIntegral(y,D.y,span);
 if(tau<1e-6){return vec3f(0);}
 let opacity=1.-exp(-min(tau,80.));let g=post.fogAnisotropy;
 let phase=(1.-g*g)/(4.*PI*pow(max(1.+g*g-2.*g*dot(D,normalize(frame.sunDir)),.001),1.5));
 let jitter=interleavedGradientNoise(floor(uv*frame.resolution));
 var visibility=0.;
 for(var i=0u;i<post.fogSteps;i++){
  // Equal contribution strata: integral(T * extinction * ds) = 1-exp(-tau).
  let u=(f32(i)+jitter)/f32(post.fogSteps);
  let optical=-log(max(1.-u*opacity,1e-30));
  let t=apsFogDistanceForIntegral(y,D.y,optical/post.fogDensity,span);
  let P=frame.cameraPos+D*(start+t);
  var shadow=1.;if(post.fogShadows>.5){shadow=apsVolumeSunVisibility(P);}
  visibility+=shadow*apsCloudSunVisibility(P);
 }
 return min(vec3f(60000),frame.sunColor*(post.fogSunIntensity*phase*visibility/f32(post.fogSteps)));
}`;

export const FOG_RECONSTRUCT_WGSL=          `
fn apsFogVolumeSource(uv:vec2f,depth:f32)->vec3f {
 if(post.fogVolumetric<.5 || post.fog<.5 || post.fogDensity<=0. || post.fogSunIntensity<=0.){return vec3f(0);}
 let size=vec2i(textureDimensions(fogVolume));let full=vec2i(textureDimensions(fogDepth));
 let at=uv*vec2f(size)-.5;let base=vec2i(floor(at));let f=fract(at);
 let distance=apsFogRayDistance(uv,depth);var sum=vec3f(0);var weights=0.;
 for(var i=0;i<4;i++){
  let offset=vec2i(i%2,i/2);let p=clamp(base+offset,vec2i(0),size-1);
  let anchor=clamp(vec2i((vec2f(p)+.5)/vec2f(size)*vec2f(full)),vec2i(0),full-1);
  let sampleUV=(vec2f(anchor)+.5)/vec2f(full);let sampleDepth=textureLoad(fogDepth,anchor,0);
  if(isSky(sampleDepth)!=isSky(depth)){continue;}
  let delta=abs(apsFogRayDistance(sampleUV,sampleDepth)-distance);
  let tolerance=max(.1,distance*.01);
  if(delta>tolerance*3.){continue;}
  let bilinear=select(1.-f.x,f.x,offset.x==1)*select(1.-f.y,f.y,offset.y==1);
  let weight=bilinear*exp(-delta/tolerance);
  sum+=textureLoad(fogVolume,p,0).rgb*weight;weights+=weight;
 }
 // At disocclusions/thin silhouettes don't import distant fog onto foreground.
 if(weights<1e-5){return apsFogSunSource(uv,depth);}
 return sum/weights;
}`;

export class VolumetricFog {
 constructor(scene,postModule,lighting){
  this.scene=scene;this.frames=0;this.active=false;
  this.texture=new Texture({label:'APS half-resolution volumetric fog solar source',width:1,height:1,format:'rgba16float',usage:['sample','render','copySrc']});
  this.resolved=new Texture({label:'APS depth-resolved volumetric fog solar source',width:1,height:1,format:'rgba16float',usage:['sample','render','copySrc']});
  this.traceModule=new ShaderModule({name:'apsHeightFogTransport',deps:[postModule,volumeShadowModule,lighting.cloudField.module],code:HEIGHT_FOG_WGSL+FOG_VOLUME_WGSL});
  const depth={texture:()=>scene.sceneRT.depthTexture};
                                                                            
                                                                               
  this.resolvePass=new FullscreenPass({label:'APS depth-aware volumetric fog reconstruction',modules:[this.traceModule],bindings:{fogVolume:{texture:this.texture},fogDepth:depth},code:FOG_RECONSTRUCT_WGSL+`
fn fragment(in:FSIn)->vec4f{return vec4f(apsFogVolumeSource(in.uv,textureLoad(fogDepth,vec2i(in.pos.xy),0)),1);}`});
  this.compositeModule=new ShaderModule({name:'apsHeightFogComposite',deps:[postModule,lighting.cloudField.daylight.module],bindings:{fogResolved:{texture:this.resolved}},code:HEIGHT_FOG_WGSL+`
// Same current clear-air hemispherical illumination as the cloud transport.
// Fog color is scattering albedo, never an unlit emissive background.
fn apsFogAmbientSource()->vec3f {return apsCloudIncidentDaylight()*post.fogAmbientIntensity;}
fn apsFogVolumeSource(uv:vec2f,depth:f32)->vec3f {
 if(post.fogSunIntensity<=0. || post.fogVolumetric<.5 || post.fog<.5 || post.fogDensity<=0.){return vec3f(0);}
 let size=vec2i(textureDimensions(fogResolved));
 return textureLoad(fogResolved,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0).rgb;
}`});
  this.pass=new FullscreenPass({label:'APS shadowed volumetric height fog',modules:[this.traceModule],bindings:{fogDepth:depth},code:`
fn fragment(in:FSIn)->vec4f {
 let size=vec2i(textureDimensions(fogDepth));let p=clamp(vec2i(in.uv*vec2f(size)),vec2i(0),size-1);
 let uv=(vec2f(p)+.5)/vec2f(size);
 return vec4f(apsFogSunSource(uv,textureLoad(fogDepth,p,0)),1);
}`});
 }
 render(options){
  this.active=options.fog&&options.fogVolumetric&&options.fogDensity>0&&options.fogSunIntensity>0;
  if(!this.active)return;
  const w=Math.max(1,Math.ceil(this.scene.width/2)),h=Math.max(1,Math.ceil(this.scene.height/2));
  if(this.texture.width!==w||this.texture.height!==h)this.texture.resize(w,h);
  if(this.resolved.width!==this.scene.width||this.resolved.height!==this.scene.height)this.resolved.resize(this.scene.width,this.scene.height);
  this.pass.render({colorViews:[this.texture]});this.resolvePass.render({colorViews:[this.resolved]});this.frames++;
 }
 metadata(){return {active:this.active,frames:this.frames,resolution:[this.texture.width,this.texture.height],method:'single solar scattering; analytic optical-depth importance sampling',geometry_shadows:'existing world-space solar clipmaps',cloud_shadows:'existing optical-depth field',reconstruction:'depth-aware bilinear; exact ray fallback at disocclusions',extra_shadow_draws:0,temporal_history:false,limitations:['screen-space half-resolution integration can alias thin volumetric shadows during motion','shadow-map coverage/resolution limits remain','local lights and multiple scattering are not included','height fog remains composited after cloud/air transport, not a jointly integrated medium']};}
 dispose(){releaseAfterSubmit(()=>{this.texture.destroy();this.resolved.destroy();});}
}
