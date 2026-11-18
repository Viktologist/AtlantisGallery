import {VIEW_TRANSPORT_WGSL} from './cloud_transport.js';

export const CLOUD_VIEW_TRACE_WGSL=VIEW_TRANSPORT_WGSL+          `
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(lab.size))){return;}
 let uv=(vec2f(id.xy)+.5)/lab.size;let D=apsEnvironmentDirection(viewRay(uv));
 // Nearest reversed-Z depth protects thin foreground. Full-resolution edge
 // pixels with no matching half-resolution guide use an exact ray fallback.
 let size=vec2i(textureDimensions(sceneDepth));let p=vec2i(floor(uv*vec2f(size)-.5));var z=0.0;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){z=max(z,textureLoad(sceneDepth,clamp(p+vec2i(x,y),vec2i(0),size-1),0));}}
 let sky=isSky(z);var end=0.0;if(!sky){end=length(worldFromDepth(uv,z)-frame.cameraPos);}
 let jitter=fract(52.9829189*fract(dot(vec2f(id.xy),vec2f(.06711056,.00583715)))+f32(lab.frame%32u)*.61803398875);
 let sample=apsTraceViewTransport(lab.origin,D,jitter,lab.steps,end,sky,lab.air>.5);
 textureStore(raw,id.xy,vec4f(sample.L,sample.cloudT));textureStore(rawT,id.xy,vec4f(sample.T,1));
 textureStore(rawAir,id.xy,vec4f(sample.air,1));textureStore(depth,id.xy,vec4f(sample.depth));textureStore(guide,id.xy,vec4f(end));
}`;

export const CLOUD_VIEW_RESOLVE_WGSL=          `
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(lab.size))){return;}let px=vec2i(id.xy);let uv=(vec2f(id.xy)+.5)/lab.size;
 let color=textureLoad(raw,px,0);let T=textureLoad(rawT,px,0);let air=textureLoad(rawAir,px,0);
 let distance=textureLoad(depth,px,0).x;let end=textureLoad(guide,px,0).x;
 let worldEye=apsEnvironmentWorldPoint(lab.origin);let D=viewRay(uv);let point=worldEye+D*distance;
 let previous=lab.previous*vec4f(point,1);let historyUV=vec2f(previous.x,-previous.y)/max(previous.w,.001)*.5+.5;
 var result=color;var resultT=T;var resultAir=air;
 if(lab.valid>.5&&previous.w>0.0&&all(historyUV>vec2f(0))&&all(historyUV<vec2f(1))){
  let hp=clamp(vec2i(historyUV*lab.size),vec2i(0),vec2i(lab.size)-1);
  let priorDepth=textureLoad(historyDepth,hp,0).x;let priorEnd=textureLoad(historyGuide,hp,0).x;
  let expectedDepth=length(point-lab.previousEye);let expectedEnd=length(worldEye+D*end-lab.previousEye);
  let matchingEnd=(end==0.0&&priorEnd==0.0)||(end>0.0&&priorEnd>0.0&&abs(priorEnd-expectedEnd)<max(1.0,expectedEnd*.02));
  let old=textureLoad(history,hp,0);let oldT=textureLoad(historyT,hp,0);let oldAir=textureLoad(historyAir,hp,0);
  if(matchingEnd&&abs(priorDepth-expectedDepth)<max(10.0,expectedDepth*.04)&&abs(old.a-color.a)<.22){
   var lo=color;var hi=color;var loT=T;var hiT=T;var loAir=air;var hiAir=air;
   for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let q=clamp(px+vec2i(x,y),vec2i(0),vec2i(lab.size)-1);let qEnd=textureLoad(guide,q,0).x;
    if((end==0.0&&qEnd==0.0)||(end>0.0&&qEnd>0.0&&abs(qEnd-end)<max(.5,end*.02))){
     let v=textureLoad(raw,q,0);let t=textureLoad(rawT,q,0);let a=textureLoad(rawAir,q,0);
     lo=min(lo,v);hi=max(hi,v);loT=min(loT,t);hiT=max(hiT,t);loAir=min(loAir,a);hiAir=max(hiAir,a);
    }
   }}
   result=mix(color,clamp(old,lo,hi),.90);resultT=mix(T,clamp(oldT,loT,hiT),.90);resultAir=mix(air,clamp(oldAir,loAir,hiAir),.90);
  }
 }
 textureStore(resolved,id.xy,result);textureStore(resolvedT,id.xy,clamp(resultT,vec4f(0),vec4f(1)));
 textureStore(resolvedAir,id.xy,vec4f(min(max(resultAir.rgb,vec3f(0)),max(result.rgb,vec3f(0))),1));
}`;
