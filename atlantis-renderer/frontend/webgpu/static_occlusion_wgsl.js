                                                                              
                                                                             
                                                                          
export const STATIC_OCCLUSION_WGSL=          `
fn apsStaticOccluded(lo:vec3f,hi:vec3f,depth:texture_2d<f32>,vp:mat4x4f,screen:vec2f)->bool {
  if(any(textureDimensions(depth,0)<=vec2u(1u))){return false;}
  var pmin=vec2f(1e20);var pmax=vec2f(-1e20);var nearest=0.0;
  for(var k=0u;k<8u;k++){
    let p=vec3f(select(lo.x,hi.x,(k&1u)!=0u),select(lo.y,hi.y,(k&2u)!=0u),select(lo.z,hi.z,(k&4u)!=0u));
    let c=vp*vec4f(p,1.0);
    if(c.w<=0.00001||c.z<0.0||c.z>=c.w){return false;}
    let n=c.xyz/c.w;let px=(n.xy*vec2f(0.5,-0.5)+vec2f(0.5))*screen;
    pmin=min(pmin,px);pmax=max(pmax,px);nearest=max(nearest,n.z);
  }
  pmin=clamp(floor(pmin)-vec2f(1.0),vec2f(0.0),screen-vec2f(0.001));
  pmax=clamp(ceil(pmax)+vec2f(1.0),vec2f(0.0),screen-vec2f(0.001));
  let level=min(i32(textureNumLevels(depth))-1,i32(ceil(log2(max(1.0,max(pmax.x-pmin.x,pmax.y-pmin.y))))));
  let scale=exp2(f32(level));let limit=vec2i(textureDimensions(depth,level))-vec2i(1);
  let a=clamp(vec2i(floor(pmin/scale)),vec2i(0),limit);let b=clamp(vec2i(floor(pmax/scale)),vec2i(0),limit);
  let z=min(min(textureLoad(depth,a,level).r,textureLoad(depth,vec2i(b.x,a.y),level).r),min(textureLoad(depth,vec2i(a.x,b.y),level).r,textureLoad(depth,b,level).r));
  return nearest<z-max(0.000002,nearest*0.00001);
}
`;
