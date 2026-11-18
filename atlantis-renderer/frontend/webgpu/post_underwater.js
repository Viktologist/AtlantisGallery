import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {volumeShadowModule} from './volume_transport.js';

                                                                               
                                                                             
export const UNDERWATER_WGSL=          `
fn apsCameraUnderwater()->bool {return uw.enabled>.5 && frame.cameraPos.y<oceanCameraWaterHeight();}
fn apsWaterSurface(xz:vec2f)->vec4f {
 var q=xz;
 for(var i=0;i<5;i++){q=xz-oceanCompositeDisplacement(q,.25).xz;}
 let d=oceanCompositeDisplacement(q,.25);let n=oceanSurfaceNormal(q,.25);
 return vec4f(n,frame.seaLevel+d.y);
}
fn apsWaterHeight(xz:vec2f)->f32 {
 var q=xz;
 for(var i=0;i<5;i++){q=xz-oceanCompositeDisplacement(q,.25).xz;}
 return frame.seaLevel+oceanCompositeDisplacement(q,.25).y;
}
fn apsWaterCrossing(origin:vec3f,D:vec3f,distance:f32,wet:bool)->f32 {
 var a=0.0;
 for(var j=1;j<=32;j++){
  let f=f32(j)/32.0;let b=f*f*distance;let P=origin+D*b;
  if((P.y<apsWaterHeight(P.xz))!=wet){
   var lo=a;var hi=b;
   for(var k=0;k<12;k++){
    let mid=(lo+hi)*.5;let M=origin+D*mid;
    if((M.y<apsWaterHeight(M.xz))==wet){lo=mid;}else{hi=mid;}
   }
   return (lo+hi)*.5;
  }
  a=b;
 }
 return distance;
}
fn apsWaterEntryTransmission(cosI:f32)->f32 {
 let c=clamp(cosI,0.0,1.0);let eta=1.333;
 let ct=sqrt(max(0.0,1.0-(1.0-c*c)/(eta*eta)));
 let rs=(c-eta*ct)/max(1e-8,c+eta*ct);
 let rp=(eta*c-ct)/max(1e-8,eta*c+ct);
 return 1.0-.5*(rs*rs+rp*rp);
}
fn apsUnderwaterTransport(base:vec4f,origin:vec3f,direction:vec3f,distance:f32)->vec4f {
 if(distance<=0.0){return base;}
 let ds=distance/8.0;let extinction=max(frame.waterAbsorption+frame.waterScattering,vec3f(.000001));
 let sun=normalize(frame.sunDir);let refracted=refract(-sun,vec3f(0,1,0),1.0/1.333);
 let cosine=dot(refracted,-direction);let g=.75;
 let phase=(1.0-g*g)/(4.0*PI*pow(max(.001,1.0+g*g-2.0*g*cosine),1.5));
 var T=vec3f(1);var L=vec3f(0);let segmentT=exp(-extinction*ds);let integral=(1.0-segmentT)/extinction;
 for(var i=0;i<8;i++){
  let P=origin+direction*((f32(i)+.5)*ds);
  var solarPath=max(0.0,apsWaterHeight(P.xz)-P.y)/max(.08,-refracted.y);
  var entry=P-refracted*solarPath;
  // Refine the interface point against the actual displaced wave field.
  for(var k=0;k<5;k++){
   solarPath=max(0.0,apsWaterHeight(entry.xz)-P.y)/max(.08,-refracted.y);entry=P-refracted*solarPath;
  }
  let surfaceAtEntry=apsWaterSurface(entry.xz);let cosI=max(0.0,dot(sun,surfaceAtEntry.xyz));
  let entryT=select(0.0,apsWaterEntryTransmission(cosI),cosI>0.0 && sun.y>0.0);
  let solar=frame.sunColor*entryT*apsCloudSunVisibility(entry)*apsVolumeSunVisibility(entry)*exp(-extinction*solarPath);
  let sky=frame.skyIrradiance*exp(-extinction*max(0.0,apsWaterHeight(P.xz)-P.y)/.8);
  L+=T*frame.waterScattering*(solar*phase+sky*.25)*integral;T*=segmentT;
 }
 return vec4f(clamp(base.rgb*T+L,vec3f(0),vec3f(60000)),base.a);
}
fn apsMixedTransport(base:vec4f,origin:vec3f,D:vec3f,distance:f32,sky:bool)->vec4f {
 if(uw.enabled<.5){return apsAirTransport(base,origin,D,distance,sky);}
 let wet=apsCameraUnderwater();let crossing=apsWaterCrossing(origin,D,distance,wet);
 let boundary=origin+D*crossing;
 // Compose far segment first, then near segment: radiance flows toward eye.
 if(wet){
  let air=apsAirTransport(base,boundary,D,max(0.0,distance-crossing),sky);
  return apsUnderwaterTransport(air,origin,D,crossing);
 }
 let water=apsUnderwaterTransport(base,boundary,D,max(0.0,distance-crossing));
 return apsAirTransport(water,origin,D,crossing,sky);
}
`;
export function createUnderwaterTransport(ocean,cloudModule){
 const params=new UniformBlock('APSUnderwaterTransport',{enabled:['f32',1]});
 const module=new ShaderModule({name:'apsUnderwaterTransport',deps:[ocean.cameraModule,ocean.surface.displacementModule,cloudModule,volumeShadowModule],uniforms:params,uniformName:'uw',code:UNDERWATER_WGSL});
 return {module,params,dispose(){params.buffer?.destroy();}};
}
