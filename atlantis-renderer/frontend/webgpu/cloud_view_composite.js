import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {volumeShadowModule} from './volume_transport.js';
import {VIEW_TRANSPORT_WGSL} from './cloud_transport.js';

export function createCloudViewComposite(view){
 return new ShaderModule({name:'apsDepthClippedCloudView',deps:[view.field.transportModule,volumeShadowModule],bindings:{
  apsView:{uniform:view.params},apsViewScatter:{texture:view.output},apsViewTransmittance:{texture:view.outputT},
  apsViewAir:{texture:view.outputAir},apsViewGuide:{texture:view.guide}},code:VIEW_TRANSPORT_WGSL+          `
var<private> apsCloudQueryUV:vec2f;
fn apsSampleViewTransport(uv:vec2f,D:vec3f,distance:f32,sky:bool)->APSViewTransport {
 let size=vec2i(textureDimensions(apsViewScatter));let p=uv*vec2f(size)-.5;let base=vec2i(floor(p));let f=fract(p);
 var S=vec3f(0);var T=vec3f(0);var A=vec3f(0);var cloudT=0.0;var total=0.0;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let q=clamp(base+vec2i(x,y),vec2i(0),size-1);let end=textureLoad(apsViewGuide,q,0).x;
  let compatible=(sky&&end==0.0)||(!sky&&end>0.0&&abs(end-distance)<=max(.25,distance*.02));
  if(compatible){
   let w=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
   let s=textureLoad(apsViewScatter,q,0);S+=s.rgb*w;cloudT+=s.a*w;
   T+=textureLoad(apsViewTransmittance,q,0).rgb*w;A+=textureLoad(apsViewAir,q,0).rgb*w;total+=w;
  }
 }}
 if(total>1e-6){return APSViewTransport(S/total,T/total,A/total,distance,cloudT/total);}
 // Thin geometry / newly exposed sky must not borrow the opposite side of
 // an edge. Fall back to the exact current full-resolution ray and endpoint.
 return apsTraceViewTransport(apsEnvironmentPoint(frame.cameraPos),apsEnvironmentDirection(D),.5,apsView.steps,distance,sky,apsView.air>.5);
}
fn apsCameraSunRadiance(D:vec3f)->vec3f {
 let mu=dot(apsEnvironmentDirection(D),cloudParams.sun);let edge=cos(.004675);let width=max(fwidth(mu),1e-7);
 return cloudParams.solar/(PI*pow(sin(.004675),2.0))*smoothstep(edge-width,edge+width,mu)*apsView.disk;
}
`});
}
