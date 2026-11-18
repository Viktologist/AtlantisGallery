                                                                      
                                                                               
export const OCEAN_REFLECTION_TRACE_WGSL=          `
fn oceanSSRProject(P:vec3f)->vec3f {
 let h=oceanSSRP.viewProjection*vec4f(P,1);
 return vec3f(h.x/max(h.w,1e-8)*.5+.5,.5-h.y/max(h.w,1e-8)*.5,h.w);
}
fn oceanSSRInside(uv:vec2f)->bool {return all(uv>=vec2f(0))&&all(uv<vec2f(1));}
fn oceanSSRDepth(uv:vec2f)->f32 {
 if(!oceanSSRInside(uv)){return 0.0;}
 let size=vec2i(textureDimensions(oceanSSRDepthTexture));
 return textureLoad(oceanSSRDepthTexture,min(vec2i(uv*vec2f(size)),size-1),0);
}
fn oceanSSRViewDepth(uv:vec2f,d:f32)->f32 {
 let h=oceanSSRP.inverseProjection*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,d,1);
 return -h.z/h.w;
}
fn oceanSSRWorld(uv:vec2f,d:f32)->vec3f {
 let h=oceanSSRP.inverseViewProjection*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,d,1);
 return h.xyz/h.w;
}
fn oceanSSRPixelWorld(viewDepth:f32)->f32 {
 let size=vec2f(textureDimensions(oceanSSRDepthTexture));
 return 2.0*viewDepth*max(abs(oceanSSRP.inverseProjection[0][0])/size.x,abs(oceanSSRP.inverseProjection[1][1])/size.y);
}
fn oceanSSRRayDistance(u:f32,k0:f32,k1:f32,distance:f32)->f32 {
 return u*k1*distance/max(1e-8,mix(k0,k1,u));
}
fn oceanSSRRaySample(start:vec3f,R:vec3f,uv:vec2f,rough:f32,footprint:f32,limit:f32)->vec4f {
 let depth=oceanSSRDepth(uv);if(depth<=0.0){return vec4f(0);}
 let hit=oceanSSRWorld(uv,depth);let distance=dot(hit-start,R);
 if(distance<=max(.02,footprint*.5)||distance>limit){return vec4f(0);}
 let pixelWorld=max(1e-5,oceanSSRPixelWorld(oceanSSRViewDepth(uv,depth)));
 let tolerance=max(.02,max(footprint*1.5,pixelWorld*2.0));
 let error=length(hit-(start+R*distance));let confidence=1.0-smoothstep(tolerance,tolerance*3.0,error);
 let size=vec2f(textureDimensions(oceanSSRDepthTexture));
 let edge=min(min(uv.x,1.0-uv.x)*size.x,min(uv.y,1.0-uv.y)*size.y);
 let coverage=confidence*smoothstep(0.0,8.0,edge);
 // Filter the HDR/coverage image over a roughness cone, then unpremultiply.
 // Box mips approximate this cone; the sky still uses its existing GGX IBL.
 let cone=max(footprint,2.0*rough*rough*distance);
 let lod=clamp(log2(max(1.0,cone/pixelWorld)),0.0,f32(textureNumLevels(oceanSSRColor)-1u));
 let colour=textureSampleLevel(oceanSSRColor,smpLinearClamp,uv,lod);
 return vec4f(colour.rgb/max(1e-5,colour.a),clamp(coverage*colour.a,0.0,1.0));
}
fn oceanReflectionWorldSample(P:vec3f,direction:vec3f,rough:f32,footprint:f32)->vec4f {
 let R=normalize(direction);let start=P+R*0.0005;
 let startView=(oceanSSRP.view*vec4f(start,1)).xyz;
 let rayView=(oceanSSRP.view*vec4f(R,0)).xyz;
 if(startView.z>=-oceanSSRP.near){return vec4f(0);}
 var limit=oceanSSRP.maxDistance;
 if(rayView.z>1e-6){limit=min(limit,(-oceanSSRP.near-startView.z)/rayView.z*.999);}
 if(limit<=0.0){return vec4f(0);}
 let a=oceanSSRProject(start);let b=oceanSSRProject(start+R*limit);
 if(a.z<=0.0||b.z<=0.0||!oceanSSRInside(a.xy)){return vec4f(0);}
 let delta=b.xy-a.xy;let size=vec2f(textureDimensions(oceanSSRDepthTexture));
 var end=1.0;
 for(var axis=0;axis<2;axis++){
  if(delta[axis]>1e-8){end=min(end,(.999999-a[axis])/delta[axis]);}
  else if(delta[axis]<-1e-8){end=min(end,(.000001-a[axis])/delta[axis]);}
 }
 if(end<=0.0){return vec4f(0);}
 let span=max(abs(delta.x)*size.x,abs(delta.y)*size.y)*end;
 // Near-degenerate projected rays still require a world-space receiver match.
 if(span<.5){return oceanSSRRaySample(start,R,a.xy,rough,footprint,limit);}
 let steps=u32(clamp(ceil(span),1.0,96.0));let k0=1.0/a.z;let k1=1.0/b.z;
 var prior=0.0;var priorDelta=0.0;var priorValid=false;
 for(var i=0u;i<=steps;i++){
  let u=end*f32(i)/f32(steps);let uv=a.xy+delta*u;let d=oceanSSRDepth(uv);
  if(d>0.0){
   let distance=oceanSSRRayDistance(u,k0,k1,limit);let rayDepth=-(startView.z+rayView.z*distance);
   let receiverDepth=oceanSSRViewDepth(uv,d);let difference=rayDepth-receiverDepth;
   let tolerance=max(.02,max(footprint*1.5,oceanSSRPixelWorld(receiverDepth)*2.0));
   let crossing=priorValid&&priorDelta<=0.0&&difference>=0.0;
   if(crossing||abs(difference)<=tolerance){
    var hitU=u;
    if(crossing){
     var lo=prior;var hi=u;let loSign=priorDelta;
     for(var j=0;j<6;j++){
      let mid=(lo+hi)*.5;let midUV=a.xy+delta*mid;let z=oceanSSRDepth(midUV);
      if(z<=0.0){lo=mid;continue;}
      let t=oceanSSRRayDistance(mid,k0,k1,limit);
      let gap=-(startView.z+rayView.z*t)-oceanSSRViewDepth(midUV,z);
      if(loSign*gap<=0.0){hi=mid;}else{lo=mid;}
     }
     hitU=(lo+hi)*.5;
    }
    let sampled=oceanSSRRaySample(start,R,a.xy+delta*hitU,rough,footprint,limit);
    if(sampled.a>1e-5){return sampled;}
   }
   priorDelta=difference;priorValid=true;
  }else{priorValid=false;}
  prior=u;
 }
 return vec4f(0);
}
`;
