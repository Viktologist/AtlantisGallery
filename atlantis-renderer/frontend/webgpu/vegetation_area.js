export const SCREEN_AREA_LODS=Object.freeze([1/4,1/16,1/64]);
export const GRASS_MIN_PIXELS=32*32;
export const GRASS_SAMPLE_MIN_PIXELS=8*8;
export const GRASS_SAMPLE_STEP=2;
                                                                              
                                                                              
export const GRASS_NEAR_SAMPLE_STEP=2;
export function areaLOD(area,width,height){
 const fraction=area/(width*height);
 return fraction>=SCREEN_AREA_LODS[0]?0:fraction>=SCREEN_AREA_LODS[1]?1:2;
}
                                                                          
export const projectedAreaWGSL=          `
fn grassBoundsPixels(vp:mat4x4f,center:vec3f,extent:vec3f,size:vec2f)->f32{
 var lo=vec2f(1e30);var hi=vec2f(-1e30);
 for(var k=0u;k<8u;k++){
  let s=vec3f(select(-1.,1.,(k&1u)!=0u),select(-1.,1.,(k&2u)!=0u),select(-1.,1.,(k&4u)!=0u));
  let c=vp*vec4f(center+s*extent,1.);
  if(c.w<=1e-6||c.z<0.||c.z>c.w){return 1e30;}
  let p=c.xy/c.w*size*.5;lo=min(lo,p);hi=max(hi,p);
 }
 return max(hi.x-lo.x,0.)*max(hi.y-lo.y,0.);
}
`;
