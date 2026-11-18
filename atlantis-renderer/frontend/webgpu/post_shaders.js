import {AIR_TRANSPORT_WGSL} from './volume_transport.js';
                                                              
export const BOUNDED_RADIANCE_WGSL=          `
fn apsBoundedRadiance(c:vec3f)->vec3f {
 return select(vec3f(0),min(c,vec3f(60000)),c>=vec3f(0));
}
fn apsGlareHighlight(c:vec3f,threshold:f32,exposure:f32,cap:f32)->vec3f {
 let bounded=apsBoundedRadiance(c);let brightness=luminance(bounded)*exposure;
 let excess=max(0.0,brightness-threshold);
 // Bright partially occluded solar pixels must not amplify the coarse blur
 // lattice. Bound glare energy only, retaining original HDR scene/disk light.
 let highlight=excess/(1.0+excess/cap);
 return bounded*highlight/max(brightness,1e-6);
}
`;
export const AERIAL_WGSL =           `
${AIR_TRANSPORT_WGSL}

struct APSAirOutput {@location(0) color:vec4f,@location(1) scattering:vec4f};
fn fragment(in: FSIn) -> vec4f {
  apsCloudQueryUV=in.uv;
  let px = vec2i(in.pos.xy);
  let base = textureLoad(postScene,px,0);
  let depth = textureLoad(postDepth,px,0);
  if (post.aerial < .5 && apsView.enabled < .5) {return base;}
  let sky=isSky(depth);let D=viewRay(in.uv);
  let distance=select(length(worldFromDepth(in.uv,depth)-frame.cameraPos),frame.far,sky);
  return apsAirTransport(base,frame.cameraPos,D,distance,sky);
}
@fragment fn fs(in:FSIn)->APSAirOutput {
 apsAtmosphereInScattering=vec3f(0);
 let color=fragment(in);
 let fogOpacity=apsHeightFogOpacity(in.uv,textureLoad(postDepth,vec2i(in.pos.xy),0));
  var fogSource=apsFogAmbientSource();
  if(post.fogVolumetric>.5 && fogOpacity>0.){fogSource+=apsFogVolumeSource(in.uv,textureLoad(postDepth,vec2i(in.pos.xy),0));}
  fogSource*=post.fogColor;
 return APSAirOutput(vec4f(mix(color.rgb,fogSource,fogOpacity),color.a),vec4f(apsBoundedRadiance(apsAtmosphereInScattering)*(1.-fogOpacity),1));
}
`;

export const EXPOSURE_WGSL =           `
var<workgroup> meter: array<vec2f,128>;
fn apsMeter(uv:vec2f)->vec2f {
 let c=textureSampleLevel(meterSource,smpLinearClamp,uv,0.0).rgb;
 if(!all(c>=vec3f(0)) || !all(c<=vec3f(65504))){return vec2f(0);}
 let lum=dot(c,vec3f(.2126,.7152,.0722));
 if(!(lum>=1e-5 && lum<=1e3)){return vec2f(0);}
 let p=(uv-.5)*2.0;let weight=.05+exp(-2.0*dot(p,p));
 return vec2f(log2(clamp(lum,1e-4,1e2))*weight,weight);
}
@compute @workgroup_size(128) fn main(@builtin(local_invocation_index) li: u32) {
 var sum=vec2f(0);
 for(var i=li; i<4096u; i+=128u) {
  let uv=(vec2f(f32(i%64u),f32(i/64u))+.5)/64.0;let d=.25/64.0;
  sum+=apsMeter(uv+vec2f(-d,-d))+apsMeter(uv+vec2f(d,-d))+apsMeter(uv+vec2f(-d,d))+apsMeter(uv+vec2f(d,d));
 }
 meter[li]=sum;workgroupBarrier();
 for(var s=64u;s>0u;s>>=1u){if(li<s){meter[li]+=meter[li+s];}workgroupBarrier();}
 if(li==0u){
  var ev=exposureState[0].x;var logL=exposureState[0].z;
  if(exposureState[1].x!=post.evRevision){
   ev=select(post.manualEV,ev+exposureState[1].y-post.compensation,post.autoExposure>.5 && exposureState[1].z>.5 && exposureState[1].x>=post.evResetRevision);
  }
  var valid=0.0;
  if(post.autoExposure>.5){
   ev=clamp(ev,post.minEV,post.maxEV);
   if(meter[0].y>0.0 && abs(meter[0].x)<3.4e38){
    logL=meter[0].x/meter[0].y;
    let targetEV=clamp(logL+log2(post.radianceScale)+3.0-post.compensation,post.minEV,post.maxEV);
    let rate=select(post.adaptationDown,post.adaptationUp,targetEV>ev);
    ev=clamp(mix(ev,targetEV,1.0-exp(-rate*max(frame.dt,0.0))),post.minEV,post.maxEV);valid=1.0;
   }
  }else{ev=post.manualEV;}
  let value=exp2(log2(post.radianceScale)-log2(1.2)-ev);
  exposureState[0]=vec4f(ev,value,logL,valid);
  exposureState[1]=vec4f(post.evRevision,post.compensation,post.autoExposure,0);
 }
}
`;

export const HIGHLIGHT_WGSL =           `
fn fragment(in: FSIn) -> vec4f {
  let texel=1.0/vec2f(textureDimensions(bloomSource));
  var sum=vec3f(0);
  for(var y=0; y<2; y++) {for(var x=0; x<2; x++) {
    let c=apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv+(vec2f(f32(x),f32(y))-.5)*texel,0.0).rgb);
    sum+=apsGlareHighlight(c,post.bloomThreshold,exposureState[0].y,post.bloomMaxBrightness);
  }}
  return vec4f(sum*.25,1);
}
`;
export const DOWNSAMPLE_WGSL =           `
fn fragment(in: FSIn) -> vec4f {
  let texel=1.0/vec2f(textureDimensions(bloomSource));var sum=vec3f(0);
  for(var y=0; y<2; y++) {for(var x=0; x<2; x++) {
    sum+=apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv+(vec2f(f32(x),f32(y))-.5)*texel,0.0).rgb);
  }}return vec4f(sum*.25,1);
}
`;
export function blurWGSL(horizontal) {return           `
fn fragment(in: FSIn) -> vec4f {
  let axis=vec2f(${horizontal?'1.0,0.0':'0.0,1.0'})/vec2f(textureDimensions(bloomSource));
  var c=apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv,0.0).rgb)*.2270270270;
  c+=(apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv+axis*1.3846153846,0.0).rgb)+apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv-axis*1.3846153846,0.0).rgb))*.3162162162;
  c+=(apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv+axis*3.2307692308,0.0).rgb)+apsBoundedRadiance(textureSampleLevel(bloomSource,smpLinearClamp,in.uv-axis*3.2307692308,0.0).rgb))*.0702702703;
  return vec4f(c,1);
}`;}

export const DOF_WGSL =           `
fn apsCoC(d: f32) -> f32 {
  let f=post.focalLength*.001;let sensor=post.sensorWidth*.001;
  return min(12.0,f*f/(post.aperture*max(post.focusDistance-f,1e-6))*abs(1.0-post.focusDistance/d)*frame.resolution.x/sensor);
}
fn fragment(in: FSIn) -> vec4f {
  let depth=textureLoad(postDepth,vec2i(in.pos.xy),0);
  let z=select(max(1e-6,viewDepth(depth)),frame.far,isSky(depth));
  let center=textureSampleLevel(dofSource,smpLinearClamp,in.uv,0.0);let diameter=apsCoC(z);let radius=diameter*.5;
  if(post.dof<.5 || diameter<=.5) {return center;}
  var color=apsBoundedRadiance(center.rgb);var total=1.0;
  for(var i=0;i<32;i++) {
    let t=f32(i)+.5;let angle=t*2.399963229728653;
    let offset=vec2f(cos(angle),sin(angle))*sqrt(t/32.0)*radius;
    let uv=clamp(in.uv+offset*frame.invResolution,vec2f(0),vec2f(1));
    let p=vec2i(min(uv*frame.resolution,frame.resolution-1.0));
    let sd=textureLoad(postDepth,p,0);let sz=select(max(1e-6,viewDepth(sd)),frame.far,isSky(sd));
    // A sharp foreground never gathers distant background into its silhouette.
    let w=select(1.0,clamp(apsCoC(sz)/max(diameter,.5),0.0,1.0),sz>z);
    color+=apsBoundedRadiance(textureSampleLevel(dofSource,smpLinearClamp,uv,0.0).rgb)*w;total+=w;
  }
  return vec4f(color/total,center.a);
}
`;

export const COMPOSE_WGSL =           `
fn apsGlareReconstruct(tex:texture_2d<f32>,uv:vec2f)->vec3f {
 let size=vec2f(textureDimensions(tex));let q=uv*size-.5;let p=floor(q);let f=fract(q);let f2=f*f;let f3=f2*f;
 let w0=(1.0-3.0*f+3.0*f2-f3)/6.0;let w1=(4.0-6.0*f2+3.0*f3)/6.0;
 let w2=(1.0+3.0*f+3.0*f2-3.0*f3)/6.0;let w3=f3/6.0;
 let a=w0+w1;let b=w2+w3;let u0=(p-1.0+w1/a+.5)/size;let u1=(p+1.0+w3/b+.5)/size;
 let c0=mix(textureSampleLevel(tex,smpLinearClamp,vec2f(u0.x,u0.y),0.0).rgb,textureSampleLevel(tex,smpLinearClamp,vec2f(u1.x,u0.y),0.0).rgb,b.x);
 let c1=mix(textureSampleLevel(tex,smpLinearClamp,vec2f(u0.x,u1.y),0.0).rgb,textureSampleLevel(tex,smpLinearClamp,vec2f(u1.x,u1.y),0.0).rgb,b.x);
 return apsBoundedRadiance(mix(c0,c1,b.y));
}
fn apsACES(color: vec3f) -> vec3f {
  // ACES fitted in linear sRGB, including the input/output matrices used by the old camera.
  let input=mat3x3f(vec3f(.59719,.07600,.02840),vec3f(.35458,.90834,.13383),vec3f(.04823,.01566,.83777));
  let output=mat3x3f(vec3f(1.60475,-.10208,-.00327),vec3f(-.53108,1.10813,-.07276),vec3f(-.07367,-.00605,1.07602));
  let v=input*(color/.6);
  let a=v*(v+.0245786)-.000090537;let b=v*(.983729*v+.4329510)+.238081;
  return sat3(output*(a/b));
}
fn apsSRGB(c: vec3f) -> vec3f {
  return select(1.055*pow(max(c,vec3f(0)),vec3f(1.0/2.4))-.055,c*12.92,c<=vec3f(.0031308));
}
fn fragment(in: FSIn) -> vec4f {
  let source=textureSampleLevel(composeSource,smpLinearClamp,in.uv,0.0);
  if(post.rawDiagnostic>.5){return source;}
  var hdr=apsBoundedRadiance(source.rgb);
  if(post.shaftBloomEnabled>.5){hdr+=apsBoundedRadiance(textureSampleLevel(shaftBloom,smpLinearClamp,in.uv,0.0).rgb)*post.shaftBloomTint*post.shaftBloomScale*post.shafts*post.sunFade;}
  if(post.bloom>0.0 || post.glow>0.0) {
    let b0=apsGlareReconstruct(bloom0,in.uv);
    let b1=apsGlareReconstruct(bloom1,in.uv);
    let b2=apsGlareReconstruct(bloom2,in.uv);
    let b3=apsGlareReconstruct(bloom3,in.uv);
    let b4=apsGlareReconstruct(bloom4,in.uv);
    hdr+=post.bloom*(b0*.35+b1*.25+b2*.18+b3*.13+b4*.09);
    hdr+=post.glow*(b0*.02+b1*.08+b2*.18+b3*.30+b4*.42);
  }
  let lens=(in.uv-.5)*vec2f(post.sensorWidth,post.sensorWidth*frame.resolution.y/frame.resolution.x)/post.focalLength;
  let vignette=mix(1.0,1.0/pow(1.0+dot(lens,lens),2.0),post.vignette);
  var exposed=hdr*exposureState[0].y*vignette;
  if(post.grain>0.0){exposed+=(fract(sin(dot(floor(in.pos.xy),vec2f(12.9898,78.233))+post.time*37.719)*43758.5453)-.5)*post.grain*.08*sqrt(max(exposed,vec3f(.001)));}
  // One exposure, one tone map, one output transfer. No depth attachment is used by post.
  let mapped=apsACES(clamp(exposed,vec3f(0),vec3f(60000)));
  return vec4f(apsOutput(mapped),source.a);
}
`;
