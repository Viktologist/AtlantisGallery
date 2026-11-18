                                                                            
                                                                            
export const LOCAL_SHADOW_FILTER=          `
struct APSShadowProjection { uv:vec2f, depth:f32, layer:i32 }
fn apsShadowProject(i:u32,delta:vec3f)->APSShadowProjection {
 let a=abs(delta);var face=0u;
 if(a.x>=a.y&&a.x>=a.z){face=select(1u,0u,delta.x>=0.0);}
 else if(a.y>=a.z){face=select(3u,2u,delta.y>=0.0);}else{face=select(5u,4u,delta.z>=0.0);}
 let layer=u32(apsLocalShadow.info[i].x)+select(0u,face,apsLocalShadow.info[i].y>.5);
 let clip=apsLocalShadow.matrices[layer]*vec4f(apsLocal.positionRange[i].xyz+delta,1);
 let q=clip.xyz/max(clip.w,1e-8);
 return APSShadowProjection(q.xy*vec2f(.5,-.5)+.5,q.z,i32(layer));
}
fn apsShadowDisk(k:u32,count:f32,angle:f32)->vec2f {
 let phi=f32(k)*2.39996323+angle;return sqrt((f32(k)+.5)/count)*vec2f(cos(phi),sin(phi));
}
fn apsSoftLocalVisibility(i:u32,P:vec3f,N:vec3f)->f32 {
 let settings=apsLocalShadow.softness[i];let origin=apsLocal.positionRange[i].xyz;
 let delta=P-origin;let distance=length(delta);if(distance<settings.y){return 1.0;}
 let D=delta/distance;let helper=select(vec3f(0,1,0),vec3f(1,0,0),abs(D.y)>.9);
 let T=normalize(cross(D,helper));let B=cross(D,T);
 let rotation=fract(sin(dot(floor(P*128.0),vec3f(12.9898,78.233,37.719)))*43758.5453)*6.2831853;
 let search=min(.18,settings.x/max(distance,settings.y));var blockers=0.0;var blockerSum=0.0;
 let dimensions=vec2i(textureDimensions(apsLocalDepth));
 for(var k=0u;k<12u;k++){
  let disk=apsShadowDisk(k,12.0,rotation)*search;
  let ray=normalize(D+T*disk.x+B*disk.y);let q=apsShadowProject(i,ray*distance);
  let pixel=clamp(vec2i(q.uv*vec2f(dimensions)),vec2i(0),dimensions-vec2i(1));
  let depth=textureLoad(apsLocalDepth,pixel,q.layer,0);
  if(depth<q.depth-apsLocalShadow.info[i].z&&depth<.999999){
   let viewDistance=settings.y*settings.z/max(settings.z-depth*(settings.z-settings.y),1e-6);
   let radial=viewDistance/max(max(abs(ray.x),abs(ray.y)),abs(ray.z));blockerSum+=radial;blockers+=1.0;
  }
 }
 if(blockers==0.0){return 1.0;}
 let blocker=blockerSum/blockers;
 let spread=clamp(settings.x*max(0.0,distance-blocker)/max(blocker*distance,1e-5),.75/f32(dimensions.x),.18);
 var visibility=0.0;
 for(var k=0u;k<24u;k++){
  let disk=apsShadowDisk(k,24.0,rotation)*spread;let ray=normalize(D+T*disk.x+B*disk.y);
  // Receiver-plane correction prevents a grazing surface shadowing itself.
  let denominator=dot(ray,N);var receiverDistance=distance;
  if(abs(denominator)>.1){receiverDistance=clamp(dot(delta,N)/denominator,distance*.5,distance*2.0);}
  let q=apsShadowProject(i,ray*receiverDistance);
  visibility+=textureSampleCompareLevel(apsLocalDepth,smpShadow,q.uv,q.layer,q.depth-apsLocalShadow.info[i].z);
 }
 return visibility/24.0;
}
`;
