import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {shadowModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {clipmapShadowCode} from './shadow_clipmap.js';
shadowModule.code=clipmapShadowCode(shadowModule.code);

                                                                                
export const volumeShadowModule=new ShaderModule({name:'apsVolumeSolarVisibility',deps:[shadowModule],code:`
fn apsVolumeSunCoverage(P:vec3f)->vec2f {
 if(shadowParams.enabled<.5){return vec2f(0);}
 for(var i=0;i<i32(shadowParams.count);i++){
  if(apsShadowClipEdge(P,i)>=0.0){return vec2f(sunShadowHard(P),1.0);}
 }
 return vec2f(0);
}
fn apsVolumeSunVisibility(P:vec3f)->f32 {let s=apsVolumeSunCoverage(P);return select(1.0,s.x,s.y>.5);}
`});

export const AIR_TRANSPORT_WGSL=          `
var<private> apsAtmosphereInScattering:vec3f=vec3f(0);
fn apsAirTransport(base:vec4f,origin:vec3f,D:vec3f,distance:f32,sky:bool)->vec4f {
 if(apsView.enabled>.5){
  var sample:APSViewTransport;
  if(length(origin-frame.cameraPos)<.001){sample=apsSampleViewTransport(apsCloudQueryUV,D,distance,sky);}
  else{sample=apsTraceViewTransport(apsEnvironmentPoint(origin),apsEnvironmentDirection(D),.5,apsView.steps,distance,sky,apsView.air>.5);}
  apsAtmosphereInScattering+=sample.air*select(1.0,frame.envIntensity,sky);
  let background=select(base.rgb,apsCameraSunRadiance(D),sky);
  // The camera replacement must retain the environment multiplier already used
  // by skyViewRadiance and surface IBL. Exposure remains one global post value.
  let scattering=sample.L*select(1.0,frame.envIntensity,sky);
  return vec4f(clamp(scattering+sample.T*background,vec3f(0),vec3f(60000)),base.a);
 }
 let span=select(distance,min(distance,8000.0),sky);
 if(span<=0.0){return base;}
 let mu=dot(D,apsEnvironmentWorldDirection(atmosphereParams.sunDir));
 let phaseRay=3.0/(16.0*PI)*(1.0+mu*mu);
 let g=atmosphereParams.mieG;
 let phaseMie=(1.0-g*g)/(4.0*PI*pow(max(1.0+g*g-2.0*g*mu,.001),1.5));
 var T=vec3f(1);var L=vec3f(0);var correction=vec3f(0);
 // Eight bounded segments, concentrated near the camera. No secondary march
 // towards the light: atmosphere LUT, cloud optical field and CSM are lookups.
 for(var i=0;i<8;i++){
  let a=f32(i)/8.0;let b=f32(i+1)/8.0;let nearT=a*a*span;let farT=b*b*span;let ds=farT-nearT;
  let P=origin+D*((nearT+farT)*.5);let h=max(.001,(P.y-cloudParams.ground)*.001);
  let medium=atmosphereMedium(h);let r=ATMO_RG+h;
  var solarT=atmosphereSampleTransmittance(r,atmosphereParams.sunDir.y);
  if(atmosphereRaySphereNearest(vec3f(0,r,0),atmosphereParams.sunDir,ATMO_RG)>0.0){solarT=vec3f(0);}
  let solar=atmosphereParams.sunIlluminance*solarT;
  let cloudVisibility=apsCloudSunVisibility(P);let geometryVisibility=apsVolumeSunVisibility(P);let visibility=cloudVisibility*geometryVisibility;
  let aerial=select(0.0,1.0,post.aerial>.5);
  let atmosphericExt=medium.extinction*.001*aerial;
  let ext=atmosphericExt;let segmentT=exp(-ext*ds);
  let airScattering=(medium.rayScat*phaseRay+medium.mieScat*phaseMie)*.001;
  let airDirect=airScattering*solar;
  let multi=atmosphereSampleMultiScat(r,atmosphereParams.sunDir.y)*medium.scattering*.001*atmosphereParams.sunIlluminance;
  let integral=(vec3f(1)-segmentT)/max(ext,vec3f(1e-8));
  L+=T*(airDirect*visibility+multi)*aerial*integral;
  // The cached sky already contains atmosphere and cloud scattering. Change
  // only its lower-atmosphere direct contribution. Shafts compose separately.
  let airT=exp(-atmosphericExt*ds);let airIntegral=(1.0-airT)/max(atmosphericExt,vec3f(1e-8));
  correction+=T*aerial*airDirect*cloudVisibility*(geometryVisibility-1.0)*airIntegral;
  T*=segmentT;
 }
 if(sky){
  let color=clamp(base.rgb+correction,vec3f(0),vec3f(60000));
  // Isolate existing local scattering, without inventing an extra haze medium.
  apsAtmosphereInScattering+=min(color,max(L,vec3f(0)));
  return vec4f(color,base.a);
 }
 apsAtmosphereInScattering+=max(L,vec3f(0));
 return vec4f(clamp(base.rgb*T+L,vec3f(0),vec3f(60000)),base.a);
}
`;
