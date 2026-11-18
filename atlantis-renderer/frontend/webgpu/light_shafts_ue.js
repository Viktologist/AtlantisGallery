                                                                 
                                                                            
export const SHAFT_MASK_WGSL=          `
fn fragment(in:FSIn)->vec4f {
 let size=vec2i(textureDimensions(postDepth));let first=vec2i(in.pos.xy)*2;var d=0.0;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){d=max(d,textureLoad(postDepth,min(first+vec2i(x,y),size-1),0));}}
 let visible=select(clamp(viewDepth(d)/post.occlusionDepthRange,0.0,1.0),1.0,isSky(d));
 return vec4f(vec3f(visible),1);
}`;
export const SHAFT_OCCLUSION_WGSL=          `
fn fragment(in:FSIn)->vec4f {
 let delta=(post.sunUV-in.uv)*post.shaftDensity;var visible=0.0;var weights=0.0;
 for(var i=0u;i<64u;i++){
  if(i>=post.shaftSamples){break;}
  let t=(f32(i)+.5)/f32(post.shaftSamples);let w=pow(post.shaftDecay,t*32.0);let uv=in.uv+delta*t;
  var sampleVisibility=1.0;
  if(all(uv>=vec2f(0))&&all(uv<=vec2f(1))){sampleVisibility=textureSampleLevel(shaftMask,smpLinearClamp,uv,0.0).r;}
  visible+=sampleVisibility*w;weights+=w;
 }
 visible=clamp(visible/max(weights,1e-6),0.0,1.0);
 return vec4f(vec3f(visible*visible*visible),1);
}`;
export const SHAFT_OCCLUSION_APPLY_WGSL=          `
fn fragment(in:FSIn)->vec4f {
 let px=vec2i(in.pos.xy);let source=textureLoad(aerialSource,px,0);let scatter=textureLoad(atmosphereScatter,px,0).rgb;
 let visibility=textureSampleLevel(shaftOcclusion,smpLinearClamp,in.uv,0.0).r;
 let mask=1.0+(visibility-1.0)*(1.0-post.occlusionMaskDarkness);
 let amount=clamp(post.shafts,0.0,1.0)*post.sunFade;
 return vec4f(apsBoundedRadiance(source.rgb-scatter*(1.0-mask)*amount),source.a);
}`;
export const SHAFT_BLOOM_EXTRACT_WGSL=          `
fn fragment(in:FSIn)->vec4f {
 let texel=1.0/vec2f(textureDimensions(shaftBloomScene));var color=vec3f(0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let uv=in.uv+(vec2f(f32(x),f32(y))-.5)*texel;
  let c=apsBoundedRadiance(textureSampleLevel(shaftBloomScene,smpLinearClamp,uv,0.0).rgb);
  let mu=dot(viewRay(uv),post.shaftDirection);
  let support=smoothstep(post.bloomConeCos,mix(post.bloomConeCos,1.0,.35),mu);
  color+=apsGlareHighlight(c,post.shaftBloomThreshold,exposureState[0].y,post.bloomMaxBrightness)*support;
 }}return vec4f(color*.25,1);
}`;
export function shaftBloomBlurWGSL(pass){return           `
fn fragment(in:FSIn)->vec4f {
 let delta=(post.sunUV-in.uv)*post.shaftDensity*${[.15,.45,.85][pass].toFixed(2)};
 var color=vec3f(0);var weights=0.0;
 for(var i=0u;i<64u;i++){
  if(i>=post.shaftSamples){break;}
  let t=f32(i)/max(1.0,f32(post.shaftSamples-1u));let w=pow(post.shaftDecay,t*32.0);let uv=in.uv+delta*t;
  if(all(uv>=vec2f(0))&&all(uv<=vec2f(1))){color+=apsBoundedRadiance(textureSampleLevel(shaftBloomInput,smpLinearClamp,uv,0.0).rgb)*w;}
  weights+=w;
 }return vec4f(color/max(weights,1e-6),1);
}`;}
