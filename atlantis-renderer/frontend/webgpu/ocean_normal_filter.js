                                                                            
                                                      
export const OCEAN_NORMAL_FILTER_WGSL=`
fn oceanFftOpticalTangentsGrad(p:vec2f,pixelDx:vec2f,pixelDy:vec2f)->mat2x3f {
 var dx=vec3f(0.0);var dz=vec3f(0.0);
 for(var c=0;c<4;c++){
  let uv=oceanUv(p,c);let period=ocean.sizes[c].x;
  // Keep the original two-pixel low-pass scale. The 8x sampler filters the
  // elongated footprint without applying its longest axis to both directions.
  let gx=2.0*pixelDx/period;let gy=2.0*pixelDy/period;
  let d=textureSampleGrad(oceanDerivatives,smpAnisoRepeat,uv,c,gx,gy);
  let crossD=textureSampleGrad(oceanCross,smpAnisoRepeat,uv,c,gx,gy).x;
  dx+=vec3f(ocean.choppiness*d.z,d.x,ocean.choppiness*crossD);
  dz+=vec3f(ocean.choppiness*crossD,d.y,ocean.choppiness*d.w);
 }
 return mat2x3f(vec3f(1.0,0.0,0.0)+dx,vec3f(0.0,0.0,1.0)+dz);
}
`;
