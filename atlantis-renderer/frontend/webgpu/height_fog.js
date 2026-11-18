                                                                                 
                                                                                 
export const HEIGHT_FOG_WGSL=          `
fn apsFogIntegral(y:f32,dy:f32,distance:f32)->f32 {
 let falloff=post.fogHeightFalloff;
 if(falloff<1e-8){return distance;}
 if(abs(dy)<1e-6){return distance*exp(-max(0.,y)*falloff);}
 let end=y+dy*distance;
 if(y<=0. && end<=0.){return distance;}
 if(y>=0. && end>=0.){
  let delta=abs(end-y)*falloff;
  let ratio=select((1.-exp(-delta))/max(delta,1e-8),1.-delta*.5,delta<.001);
  return distance*exp(-min(y,end)*falloff)*ratio;
 }
 let below=select(-end,-y,dy>0.)/abs(dy);
 let above=max(y,end);let delta=above*falloff;
 let ratio=select((1.-exp(-delta))/max(delta,1e-8),1.-delta*.5,delta<.001);
 return below+above/abs(dy)*ratio;
}
fn apsHeightFogOpacity(uv:vec2f,depth:f32)->f32 {
 if(post.fog<.5 || post.fogDensity<=0.){return 0.;}
 let D=viewRay(uv);
 let distance=select(min(length(worldFromDepth(uv,depth)-frame.cameraPos),post.fogMaxDistance),post.fogMaxDistance,isSky(depth));
 let start=min(post.fogStart,distance);
 let y=frame.cameraPos.y+D.y*start-post.fogBaseHeight;
 let opticalDepth=post.fogDensity*apsFogIntegral(y,D.y,distance-start);
 let opacity=min(post.fogMaxOpacity,1.-exp(-min(opticalDepth,80.)));
 return opacity;
}`;
