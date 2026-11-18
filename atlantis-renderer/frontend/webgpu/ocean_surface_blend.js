                                                                             
                                                                              
export const OCEAN_SURFACE_BLEND_WGSL =           `
fn oceanShoreBlendWeight(support:f32,depth:f32,hs:f32)->f32 {
 return clamp(support,0.0,1.0)*(1.0-smoothstep(max(0.12,hs*0.18),max(0.9,hs*1.1),depth));
}
fn oceanFftBlendWeight(shoreWeight:f32,column:f32)->f32 {
 let residual=0.35*smoothstep(0.02,0.35,column);
 return 1.0+shoreWeight*(residual-1.0);
}
fn oceanContactBlendWeight(shoreWeight:f32)->f32 {
 return smoothstep(0.0,0.001,shoreWeight);
}
fn oceanWeightSlope(lo:f32,hi:f32,x:f32)->f32 {
 let t=clamp((x-lo)/(hi-lo),0.0,1.0);
 return 6.0*t*(1.0-t)/(hi-lo);
}
// D = a*F + B, where B = w*S. Differentiate both fields AND both weights;
// mixing normalized normals loses the F*grad(a) and S*grad(w) terms.
fn oceanBlendTangent(axis:vec3f,fftTangent:vec3f,fft:vec3f,a:f32,da:f32,dB:vec3f)->vec3f {
 return axis+a*(fftTangent-axis)+fft*da+dB;
}
// Optical fine normals retain the FULL resolved FFT detail everywhere,
// independently of shore takeover, cache membership and thin-film weighting.
fn oceanFullFftDetailTangent(baseTangent:vec3f,fftPixel:vec3f,fftMacro:vec3f)->vec3f {
 return baseTangent+fftPixel-fftMacro;
}
// Foam optics requires an upward macro normal. A component guard is finite
// even for inverted crests; blending opposing unit normals can cross zero.
fn oceanFoamNormalGuard(n:vec3f)->vec3f {
 return normalize(vec3f(n.x,max(n.y,0.12),n.z));
}
`;
