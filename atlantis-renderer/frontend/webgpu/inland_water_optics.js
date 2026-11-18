import {GPU,ShaderModule,UniformBlock,Texture,FrameUniforms,RenderTarget,FullscreenPass,generateMipmaps,commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {OCEAN_REFLECTION_TRACE_WGSL} from './ocean_reflection.js';
import {INLAND_MAX_BODIES,INLAND_BODY_ROWS,INLAND_WATER_DEFAULTS,validateInlandWaterConfig,packBodies,bodyDiagnostics,planeHeight,bodyContains} from './inland_water_math.js';
import {composeWaterHook} from './water_consumers.js';
import {unlinkWaterHook} from './water_hook_chain.js';

                                                                               
                                                                    
export const INLAND_REFLECTION_TRACE_WGSL=OCEAN_REFLECTION_TRACE_WGSL
  .replaceAll('oceanSSRP','inlandSSR')
  .replaceAll('oceanSSRColor','inlandSSRColor')
  .replaceAll('oceanSSRDepthTexture','inlandSSRDepthTexture')
  .replaceAll('oceanReflectionWorldSample','inlandReflectionWorldSample');

export const INLAND_CORE_WGSL=          `
struct APSInlandBody {
 plane:vec4f, bounds:vec4f, sample:vec4f, flow:vec4f, wave:vec4f, absorb:vec4f, scatter:vec4f, flags:vec4f, aux:vec4f,
};
struct APSInlandHit { body:APSInlandBody, index:i32, planeY:f32, depth:f32, };
// Water bodies are authored in the DEM frame; the renderer and lights use
// world space. Keep positions, directions and normals distinct under shear.
fn apsInlandNativePosition(p:vec3f)->vec3f{return (inlandB.nativeFromWorld*vec4f(p,1.0)).xyz;}
fn apsInlandNativeDirection(v:vec3f)->vec3f{return (inlandB.nativeFromWorld*vec4f(v,0.0)).xyz;}
fn apsInlandWorldDirection(v:vec3f)->vec3f{return (inlandB.worldFromNative*vec4f(v,0.0)).xyz;}
fn apsInlandWorldNormal(n:vec3f)->vec3f{return normalize((transpose(inlandB.nativeFromWorld)*vec4f(n,0.0)).xyz);}
// Native vertical speed changes with scale. Compare incidence using the
// transformed vertical plane normal so a scaled body keeps the same threshold.
fn apsInlandNativeVerticalScale()->f32{return length((transpose(inlandB.nativeFromWorld)*vec4f(0.0,1.0,0.0,0.0)).xyz);}
fn apsInlandRow(i:u32,j:u32)->vec4f {return inlandB.body[i*${INLAND_BODY_ROWS}u+j];}
fn apsInlandBodyAt(i:u32)->APSInlandBody {
 var b:APSInlandBody;b.plane=apsInlandRow(i,0u);b.bounds=apsInlandRow(i,1u);b.sample=apsInlandRow(i,2u);b.flow=apsInlandRow(i,3u);
 b.wave=apsInlandRow(i,4u);b.absorb=apsInlandRow(i,5u);b.scatter=apsInlandRow(i,6u);b.flags=apsInlandRow(i,7u);b.aux=apsInlandRow(i,8u);return b;
}
fn apsInlandPlaneY(b:APSInlandBody,xz:vec2f)->f32 {
 let n=b.plane.xyz;if(abs(n.y)<0.01){return b.plane.w;}
 return (b.plane.w-n.x*xz.x-n.z*xz.y)/n.y;
}
// Bounding-box + local water plane classification is the user-accepted domain.
// The receiver tests additionally require the actual local water depth, so land
// above the local plane inside a concave/curved AABB is rejected.
fn apsInlandContains(b:APSInlandBody,xz:vec2f,margin:f32)->bool {
 let r=b.bounds;let m=max(0.0,margin);
 return xz.x>=r.x-m&&xz.x<=r.z+m&&xz.y>=r.y-m&&xz.y<=r.w+m;
}
// Body plane normal plus the current wave gradient. This is the single normal
// definition shared by the water draw, Snell refraction and caustic ray mapping.
fn apsInlandSurfaceNormal(b:APSInlandBody,s:vec4f)->vec3f {
 let n=normalize(b.plane.xyz);
 return normalize(vec3f(n.x-n.y*s.y,n.y,n.z-n.y*s.z));
}
fn apsInlandShoreFade(b:APSInlandBody,depth:f32)->f32 {
 let w=b.aux.x;if(w<=0.0){return 1.0;}
 return smoothstep(0.0,w,max(0.0,depth));
}
fn apsInlandSinc(x:f32)->f32 {let a=abs(x);if(a<=1e-4){return 1.0;}return sin(a)/a;}
// Two directional sinusoids with analytic derivatives and analytic box-filter
// attenuation. The previous lateral phase-warp derivative was omitted and its
// footprint could not be filtered; this form removes that unresolved term.
fn apsInlandRiverRipple(q:vec2f,b:APSInlandBody,foot:f32)->vec4f {
 let dir=b.flow.xy;let perp=vec2f(-dir.y,dir.x);
 let k=6.28318530718/max(0.05,b.wave.x);let k2=k*1.7;let speed=b.flow.z;let amp=b.flow.w;
 let fp=max(0.01,foot);let a0=apsInlandSinc(0.5*k*fp);let a2=apsInlandSinc(0.5*k2*fp);
 let phase=dot(q,dir)*k-frame.time*(speed*k);
 let phase2=dot(q,perp)*k2+frame.time*(speed*k*0.43+0.6);
 let h=amp*(a0*sin(phase)+0.35*a2*sin(phase2));
 let dhdx=amp*(a0*cos(phase)*k*dir.x+0.35*a2*cos(phase2)*k2*perp.x);
 let dhdz=amp*(a0*cos(phase)*k*dir.y+0.35*a2*cos(phase2)*k2*perp.y);
 return vec4f(h,dhdx,dhdz,0.0);
}
fn apsInlandBodySampleFade(b:APSInlandBody,q:vec2f,foot:f32,fade:f32)->vec4f {
 let f=clamp(fade,0.0,1.0);
 if(b.flags.y<0.5){
  // Explicit saved lakes have no FFT atlas layer; retain their flat plane.
  if(b.sample.w<0.0){return vec4f(0.0);}
  let uv=(q-b.sample.xy)/max(0.01,b.sample.z)+vec2f(0.5/128.0);
  let lod=clamp(log2(max(1.0,foot*128.0/max(0.01,b.sample.z))),0.0,7.0);
  let s=textureSampleLevel(inlandLakeAtlas,smpLinearRepeat,uv,i32(b.sample.w),lod);
  return vec4f(s.x*f,s.y*f,s.z*f,0.0);
 }
 let r=apsInlandRiverRipple(q,b,foot);
 return vec4f(r.x*f,r.y*f,r.z*f,0.0);
}
fn apsInlandBodySample(b:APSInlandBody,q:vec2f,foot:f32)->vec4f {
 return apsInlandBodySampleFade(b,q,foot,1.0);
}
fn apsInlandFindBody(P:vec3f,margin:f32)->APSInlandHit {
 var out:APSInlandHit;out.index=-1;out.planeY=0.0;out.depth=-1e9;
 let nativeP=apsInlandNativePosition(P);
 var best=-1e9;
 for(var i=0u;i<inlandB.count;i++){
  let b=apsInlandBodyAt(i);if(b.flags.x<0.5||!apsInlandContains(b,nativeP.xz,margin)){continue;}
  let y=apsInlandPlaneY(b,nativeP.xz);let d=y-nativeP.y;
  if(d<-0.6){continue;}
  if(d>best){best=d;out.index=i32(i);out.body=b;out.planeY=y;out.depth=d;}
 }
 return out;
}
// Publication predicate for direct/ambient water hooks. It is true only for a
// receiver below the local inland water plane inside the accepted AABB; the
// ocean hook otherwise keeps its original coefficients. Caustics/shadow
// visibility stay receiver-side and camera-independent.
fn apsInlandReceiverActive(P:vec3f)->bool {
 let hit=apsInlandFindBody(P,0.25);
 return hit.index>=0&&hit.body.flags.x>=0.5&&hit.depth>0.0;
}
fn apsInlandFresnel(cosI:f32,eta:f32)->f32 {
 let c=clamp(cosI,0.0,1.0);let e=max(1.0001,eta);let sin2=(1.0-c*c)/(e*e);
 if(sin2>=1.0){return 1.0;}
 let ct=sqrt(max(0.0,1.0-sin2));
 let rs=(c-e*ct)/max(1e-6,c+e*ct);let rp=(e*c-ct)/max(1e-6,e*c+ct);
 return clamp(0.5*(rs*rs+rp*rp),0.0,1.0);
}
fn apsInlandSunTransmission(cosI:f32,eta:f32)->f32 {return 1.0-apsInlandFresnel(cosI,eta);}
fn apsInlandPhase(cosT:f32,g:f32)->f32 {
 let g2=g*g;return (1.0-g2)/(4.0*PI*pow(max(1e-4,1.0+g2-2.0*g*cosT),1.5));
}
// Signed ray/offset-plane intersection. The offset is the receiver plane's depth
// below the local water plane, so s.x + offset is always positive for a lower
// receiver. The old max(0, planeY-surfaceY) collapsed this to zero.
fn apsInlandRefractedXZ(b:APSInlandBody,q:vec2f,offset:f32,foot:f32,fade:f32)->vec2f {
 let s=apsInlandBodySampleFade(b,q,foot,fade);
 let n=apsInlandWorldNormal(apsInlandSurfaceNormal(b,s));
 let ray=apsInlandNativeDirection(refract(-normalize(frame.sunDir),n,1.0/max(1.0001,b.absorb.w)));
 if(ray.y>=-0.06*apsInlandNativeVerticalScale()){return q;}
 let drop=s.x+max(0.0,offset);
 if(drop<=0.0){return q;}
 return q+ray.xz/(-ray.y)*drop;
}
// Actual receiver ray map. x/y are the solved surface-entry shift (non-trivial
// for a real caustic), z is the finite-difference Jacobian, w is the bounded
// focus used by the shading path. Debug mode 5 exposes this on the GPU.
fn apsInlandRayMap(b:APSInlandBody,P:vec3f,depth:f32,foot:f32,fade:f32)->vec4f {
 let ior=max(1.0001,b.absorb.w);
 let nativeP=apsInlandNativePosition(P);
 let flat=apsInlandNativeDirection(refract(-normalize(frame.sunDir),apsInlandWorldNormal(b.plane.xyz),1.0/ior));
 if(flat.y>=-0.02*apsInlandNativeVerticalScale()){return vec4f(0.0,0.0,1.0,1.0);}
 let optical=mix(depth,clamp(b.scatter.w,0.2,2.0),smoothstep(0.03,0.35,depth));
 var q=nativeP.xz+flat.xz/(-flat.y)*optical;
 let sampleFoot=max(0.02,foot*1.5);
 for(var i=0;i<2;i++){q+=nativeP.xz-apsInlandRefractedXZ(b,q,optical,sampleFoot,fade);}
 let e=max(0.05,foot*1.5);
 let dx=apsInlandRefractedXZ(b,q+vec2f(e,0),optical,sampleFoot,fade)-apsInlandRefractedXZ(b,q-vec2f(e,0),optical,sampleFoot,fade);
 let dz=apsInlandRefractedXZ(b,q+vec2f(0,e),optical,sampleFoot,fade)-apsInlandRefractedXZ(b,q-vec2f(0,e),optical,sampleFoot,fade);
 let jac=abs(dx.x*dz.y-dx.y*dz.x)/(4.0*e*e);
 var focus=clamp(1.0/max(0.18,jac),0.15,4.0);
 focus=1.0+(focus-1.0)*clamp(b.wave.y,0.0,4.0);
 focus=clamp(mix(focus,1.0,smoothstep(0.7,1.0,depth/max(0.01,b.wave.w))),0.05,5.0);
 return vec4f(q-nativeP.xz,jac,focus);
}
// Accepted shallow receiver-plane caustic mapping. Actual water depth controls
// validity, shore fade and attenuation; the 1m plane is only the approximation.
fn apsInlandCausticAt(P:vec3f,b:APSInlandBody,depth:f32,foot:f32)->f32 {
 if(b.flags.z<0.5||b.wave.y<=0.0||depth<0.02||depth>b.wave.w||dot(frame.sunDir,apsInlandWorldNormal(b.plane.xyz))<=0.005){return 1.0;}
 let fade=apsInlandShoreFade(b,depth);
 let map=apsInlandRayMap(b,P,depth,foot,fade);
 return map.w;
}
// Fresnel for the water-to-air side. The air-to-water helper above clamps eta
// >= 1 and therefore could never represent total internal reflection.
fn apsInlandFresnelWaterToAir(cosI:f32,ior:f32)->f32 {
 let c=clamp(cosI,0.0,1.0);let e=max(1.0001,ior);let sin2=(1.0-c*c)*e*e;
 if(sin2>=1.0){return 1.0;}
 let ct=sqrt(max(0.0,1.0-sin2));
 let rs=(e*c-ct)/max(1e-6,e*c+ct);let rp=(c-e*ct)/max(1e-6,c+e*ct);
 return clamp(0.5*(rs*rs+rp*rp),0.0,1.0);
}
fn apsInlandTIRWaterToAir(cosI:f32,ior:f32)->bool {
 let c=clamp(cosI,0.0,1.0);let e=max(1.0001,ior);
 return (1.0-c*c)*e*e>=1.0;
}
fn apsInlandCameraUnder(b:APSInlandBody)->bool {
 let C=apsInlandNativePosition(frame.cameraPos);
 return apsInlandContains(b,C.xz,0.0)&&C.y<apsInlandPlaneY(b,C.xz)-0.02;
}
fn apsInlandPlaneT(b:APSInlandBody,C:vec3f,P:vec3f)->f32 {
 let c=apsInlandNativePosition(C);let p=apsInlandNativePosition(P);
 let f0=apsInlandPlaneY(b,c.xz)-c.y;let f1=apsInlandPlaneY(b,p.xz)-p.y;
 let d=f0-f1;if(abs(d)<1e-5){return 1e9;}
 return f0/d;
}
// View extinction for a submerged receiver: whole camera-to-point segment when
// the camera is already underwater, otherwise only the entry-to-point part.
// Above-water receivers are handled at the water interface, not here.
fn apsInlandViewAttenuationBody(P:vec3f,b:APSInlandBody)->vec3f {
 // The late water surface owns entry-to-receiver transport for an air camera.
 // Opaque receivers only own this view segment when the camera starts in water.
 if(!apsInlandCameraUnder(b)){return vec3f(1.0);}
 let C=frame.cameraPos;let len=length(P-C);
 if(len<1e-4){return vec3f(1.0);}
 var wetLength=len;
 let p=apsInlandNativePosition(P);
 if(p.y>apsInlandPlaneY(b,p.xz)){
  wetLength=len*clamp(apsInlandPlaneT(b,C,P),0.0,1.0);
 }
 return exp(-(b.absorb.xyz+b.scatter.xyz)*wetLength);
}
fn apsInlandViewAttenuation(P:vec3f)->vec3f {
 let hit=apsInlandFindBody(P,0.1);
 if(hit.index<0||hit.depth<0.0){return vec3f(1.0);}
 return apsInlandViewAttenuationBody(P,hit.body);
}
fn apsInlandDirectModulation(P:vec3f,N:vec3f)->vec3f {
 let hit=apsInlandFindBody(P,0.25);
 // Caustics-off must not bypass the baseline Beer/Fresnel direct attenuation;
 // only the focus term becomes one inside apsInlandCausticAt.
 if(hit.index<0||hit.body.flags.x<0.5){return vec3f(1.0);}
 let b=hit.body;let depth=hit.depth;
 if(depth<0.02||depth>b.wave.w){return vec3f(1.0);}
 let ior=max(1.0001,b.absorb.w);
 let nativeP=apsInlandNativePosition(P);
 let foot=max(0.01,max(length(dpdx(nativeP.xz)),length(dpdy(nativeP.xz))));
 // Use the same body-plane + wave normal and shore fade as the surface/caustic.
 let s=apsInlandBodySampleFade(b,nativeP.xz,foot,apsInlandShoreFade(b,depth));
 let worldN=apsInlandWorldNormal(apsInlandSurfaceNormal(b,s));
 let T=apsInlandNativeDirection(refract(-normalize(frame.sunDir),worldN,1.0/ior));
 if(T.y>=-0.02*apsInlandNativeVerticalScale()){return vec3f(1.0);}
 let path=depth/max(0.08*apsInlandNativeVerticalScale(),-T.y);
 let ext=b.absorb.xyz+b.scatter.xyz;
 let attenuation=exp(-ext*path);
 let entry=apsInlandSunTransmission(max(0.0,dot(normalize(frame.sunDir),worldN)),ior);
 let caustic=apsInlandCausticAt(P,b,depth,foot);
 let radiance=mix(vec3f(1.0),attenuation*entry*caustic,smoothstep(0.0,0.06,depth));
 return radiance*apsInlandViewAttenuation(P);
}
fn apsInlandAmbientModulation(P:vec3f,N:vec3f)->vec3f {
 let hit=apsInlandFindBody(P,0.25);
 if(hit.index<0||hit.body.flags.x<0.5){return vec3f(1.0);}
 let depth=hit.depth;if(depth<=0.0){return vec3f(1.0);}
 let ext=hit.body.absorb.xyz+hit.body.scatter.xyz;
 let ambient=mix(vec3f(1.0),exp(-ext*(depth/0.8)),smoothstep(0.0,0.05,depth));
 return ambient*apsInlandViewAttenuation(P);
}
fn apsInlandWetness(P:vec3f)->f32 {
 var result=0.0;
 let p=apsInlandNativePosition(P);
 for(var i=0u;i<inlandB.count;i++){
  let b=apsInlandBodyAt(i);
  if(b.flags.x<0.5||b.flags.w<0.5||!apsInlandContains(b,p.xz,0.3)){continue;}
  let gap=apsInlandPlaneY(b,p.xz)-p.y;
  if(gap<-0.35||gap>0.2){continue;}
  let variation=perlin2(p.xz*2.7+vec2f(b.sample.x*0.013,b.sample.y*0.017));
  let width=max(0.015,b.wave.z*(0.65+0.55*variation));
  let contact=1.0-smoothstep(width*0.3,width,abs(gap));
  let landward=1.0-smoothstep(0.04,0.22,max(gap,0.0));
  result=max(result,contact*landward);
 }
 return clamp(result,0.0,1.0);
}
`;

export const INLAND_WATER_WGSL=          `
struct APSInlandRay { color:vec3f, path:f32, coverage:f32, depth:f32, refracted:f32, offscreen:f32, valid:f32, };
fn apsInlandWorldFromDepth(uv:vec2f,d:f32)->vec3f {
 let h=frame.invViewProj*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,d,1.0);return h.xyz/h.w;
}
fn apsInlandProject(P:vec3f)->vec3f {
 let c=frame.viewProj*vec4f(P,1.0);return vec3f(c.x/max(c.w,1e-8)*0.5+0.5,0.5-c.y/max(c.w,1e-8)*0.5,c.w);
}
fn apsInlandDepthAt(pixel:vec2i,size:vec2i)->f32 {
 if(any(pixel<vec2i(0))||any(pixel>=size)){return 0.0;}
 return textureLoad(inlandRefrDepth,pixel,0).x;
}
fn apsInlandNoRay()->APSInlandRay {
 return APSInlandRay(hookEnvDiffuse(vec3f(0,1,0)),0.0,0.0,-1.0,0.0,0.0,0.0);
}
fn apsInlandStraightRay(P:vec3f,uv:vec2f,b:APSInlandBody)->APSInlandRay {
 let size=vec2i(textureDimensions(inlandRefrDepth));
 let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);
 let d=textureLoad(inlandRefrDepth,pixel,0).x;
 if(d<=0.0){return apsInlandNoRay();}
 let world=apsInlandWorldFromDepth(uv,d);let back=normalize(P-frame.cameraPos);
 if(dot(world-P,back)<=0.0005){return apsInlandNoRay();}
 let native=apsInlandNativePosition(world);let plane=apsInlandPlaneY(b,native.xz);let depth=plane-native.y;
 // A sky/above-water or foreground opaque sample is not an underwater
 // receiver. Reject it here so geometric water coverage can stay one and the
 // interface still draws when there is no receiver behind it (underwater sky).
 if(depth<=0.01){return apsInlandNoRay();}
 return APSInlandRay(textureLoad(inlandRefrColor,pixel,0).rgb,length(world-P),1.0,depth,0.0,0.0,1.0);
}
// Snell-bent receiver gather. Dry/foreground peaks, cross-body hits and empty
// samples are rejected; the straight opacity sample is the explicit fallback.
fn apsInlandRefraction(P:vec3f,N:vec3f,V:vec3f,b:APSInlandBody,straight:APSInlandRay,uv:vec2f)->APSInlandRay {
 if(straight.valid<0.5||straight.depth<=0.01||inlandRefr.strength<=0.0){return straight;}
 let ior=max(1.0001,b.absorb.w);
 let bend=normalize(mix(apsInlandWorldNormal(b.plane.xyz),N,clamp(inlandRefr.strength,0.0,1.0)));
 let dir=refract(-V,bend,1.0/ior);
 let nativeDir=apsInlandNativeDirection(dir);
 if(dot(dir,dir)<1e-8||nativeDir.y>=-0.02*apsInlandNativeVerticalScale()){return straight;}
 let t=straight.depth/max(-nativeDir.y,0.08*apsInlandNativeVerticalScale());
 let hit=P+dir*t;let projected=apsInlandProject(hit);
 if(projected.z<=0.0||any(projected.xy<vec2f(0))||any(projected.xy>vec2f(1))){
  var off=straight;off.offscreen=1.0;return off;
 }
 let size=vec2i(textureDimensions(inlandRefrDepth));
 let pixel=clamp(vec2i(projected.xy*vec2f(size)),vec2i(0),size-1);
 let d=textureLoad(inlandRefrDepth,pixel,0).x;
 if(d<=0.0){var off2=straight;off2.offscreen=1.0;return off2;}
 let world=apsInlandWorldFromDepth(projected.xy,d);let back=normalize(P-frame.cameraPos);
 if(dot(world-P,back)<=0.0005){return straight;}
 let native=apsInlandNativePosition(world);let plane=apsInlandPlaneY(b,native.xz);
 if(native.y>=plane-0.006||!apsInlandContains(b,native.xz,0.15)){return straight;}
 return APSInlandRay(textureLoad(inlandRefrColor,pixel,0).rgb,length(world-P),1.0,plane-native.y,1.0,0.0,1.0);
}
fn apsInlandReflection(P:vec3f,N:vec3f,V:vec3f,rough:f32,foot:f32)->vec3f {
 let R=reflect(-V,N);var env=hookEnvSpecular(R,rough);
 if(inlandSSR.enabled>0u){
  let screen=inlandReflectionWorldSample(P,R,rough,foot);
  env=mix(env,screen.rgb,screen.a);
 }
 return env;
}
fn apsInlandSmith(c:f32,alpha:f32)->f32 {return 1.0/max(c+sqrt(alpha*alpha*(1.0-c*c)+c*c),1e-6);}
fn apsInlandSunSpecular(N:vec3f,L:vec3f,V:vec3f,rough:f32,eta:f32)->vec3f {
 let nl=dot(N,L);let nv=dot(N,V);if(nl<=0.0||nv<=0.0){return vec3f(0.0);}
 let H=normalize(L+V);let nh=max(0.0,dot(N,H));let lh=max(0.0,dot(L,H));
 let alpha=max(0.004,rough*rough);let a2=alpha*alpha;
 let denom=(1.0-nh*nh)/a2+nh*nh;let D=1.0/(PI*a2*denom*denom);
 return vec3f(D*apsInlandSmith(nl,alpha)*apsInlandSmith(nv,alpha)*apsInlandFresnel(lh,eta)*nl);
}
fn apsInlandWaterTransport(P:vec3f,N:vec3f,V:vec3f,b:APSInlandBody,ray:APSInlandRay,sunLight:vec3f)->vec3f {
 let ior=max(1.0001,b.absorb.w);let up=apsInlandWorldNormal(b.plane.xyz);
 let dir=refract(-V,normalize(mix(up,N,clamp(inlandRefr.strength,0.0,1.0))),1.0/ior);
 let path=clamp(ray.path,0.0,inlandRefr.maxPath);
 let ext=b.absorb.xyz+b.scatter.xyz;
 let trans=exp(-ext*path);
 let L=normalize(frame.sunDir);let Ls=refract(-L,up,1.0/ior);
 let muS=max(dot(Ls,up),0.1);let muV=max(dot(V,up),0.12);
 let phase=0.7*apsInlandPhase(dot(dir,Ls),0.86)+0.3/(4.0*PI);
 let sky=hookEnvDiffuse(up);
 let sunIn=sunLight*apsInlandSunTransmission(max(0.0,dot(L,up)),ior)*(b.scatter.xyz*phase);
 let kSun=ext*(1.0+muV/muS);let kAmb=ext*(1.0+muV/0.75);
 let inSun=sunIn*(1.0-exp(-kSun*path))/max(kSun,vec3f(1e-5));
 let inAmb=sky*b.scatter.xyz*0.25*(1.0-exp(-kAmb*path))/max(kAmb,vec3f(1e-5));
 return ray.color*trans+inSun+inAmb;
}
fn apsInlandCoverage(P:vec3f,b:APSInlandBody,straight:APSInlandRay)->f32 {
 if(b.flags.x<0.5||!apsInlandContains(b,apsInlandNativePosition(P).xz,0.2)){return 0.0;}
 if(straight.valid<0.5){return 1.0;}
 return smoothstep(-0.012,0.035,straight.depth);
}
// One canonical normal, not the mesh normal plus the wave (which double-counted
// the lake material's own lakeN). Explicit saved lakes with no FFT layer retain
// their native mesh normal; lakes/rivers use body plane + wave + shared fade.
fn apsInlandWaterNormal(P:vec3f,baseN:vec3f,foot:f32,index:u32,fade:f32)->vec3f {
 let b=apsInlandBodyAt(index);let N=normalize(baseN);
 if(b.flags.y<0.5&&b.sample.w<0.0){return N;}
 let s=apsInlandBodySampleFade(b,apsInlandNativePosition(P).xz,foot,fade);
 return apsInlandWorldNormal(apsInlandSurfaceNormal(b,s));
}
fn apsInlandWaterSample(P:vec3f,foot:f32)->vec4f {
 let b=apsInlandBodyAt(apsInlandIndex());
 return apsInlandBodySample(b,apsInlandNativePosition(P).xz,foot);
}
`;

                                                                              
                                                                             
export const INLAND_WATER_OUTPUT=          `
let inlandP=in.P;
let inlandFoot=max(0.0005,max(length(dpdx(inlandP)),length(dpdy(inlandP))));
let inlandNativeP=apsInlandNativePosition(inlandP);
let inlandNativeFoot=max(0.0005,max(length(dpdx(inlandNativeP.xz)),length(dpdy(inlandNativeP.xz))));
let inlandIndex=apsInlandIndex();
let inlandBody=apsInlandBodyAt(inlandIndex);
let inlandCamUnder=apsInlandCameraUnder(inlandBody);
let inlandUV=in.pixel*frame.invResolution;
let inlandStraight=apsInlandStraightRay(inlandP,inlandUV,inlandBody);
let inlandCover=apsInlandCoverage(inlandP,inlandBody,inlandStraight);
if(inlandCover<=0.0){discard;}
let inlandBaseN=normalize(apsMeshMaterial.normal);
// The shared fade uses the actual receiver-column depth where available. This
// is the same smoothstep(0,lakeParams.fade,depth) the lake surface applies to
// its vertex displacement and normal, so caustics cannot carry full-amplitude
// waves into the shore while the visible surface is calm.
let inlandFade=select(1.0,apsInlandShoreFade(inlandBody,max(0.0,inlandStraight.depth)),inlandStraight.valid>0.5&&inlandStraight.depth>0.0);
let inlandN=apsInlandWaterNormal(inlandP,inlandBaseN,inlandNativeFoot,inlandIndex,inlandFade);
let inlandIor=max(1.0001,inlandBody.absorb.w);
let inlandRough=clamp(apsMeshMaterial.roughness,0.02,1.0);
var inlandRay=apsInlandNoRay();
var inlandRadiance=vec3f(0.0);
if(inlandRefr.enabled==0u){
 inlandRadiance=apsShadePrincipled(apsMeshMaterial,s,inlandP,in.V,in.pixel,apsMeshTangent);
}else if(inlandCamUnder){
 // Camera already in the water: the visible interface is viewed from below.
 // Use the water-to-air Fresnel/TIR branch and the whole camera-to-surface
 // underwater segment. No "must enter through a surface" assumption is made.
 let inlandI=normalize(inlandP-frame.cameraPos);
 let inlandCos=abs(dot(inlandN,inlandI));
 let inlandTIR=apsInlandTIRWaterToAir(inlandCos,inlandIor);
 let inlandF=apsInlandFresnelWaterToAir(inlandCos,inlandIor);
 let inlandView=apsInlandViewAttenuationBody(inlandP,inlandBody);
 let inlandScreen=inlandReflectionWorldSample(inlandP,reflect(inlandI,inlandN),inlandRough,inlandFoot);
 let inlandEnv=hookEnvDiffuse(vec3f(0,1,0))*0.08+inlandBody.scatter.xyz*2.0;
 let inlandRefl=mix(inlandEnv,inlandScreen.rgb,inlandScreen.a);
 let inlandPixel=clamp(vec2i(in.pixel),vec2i(0),vec2i(textureDimensions(inlandRefrColor))-1);
 let inlandD=textureLoad(inlandRefrDepth,inlandPixel,0).x;
 var inlandWorld=inlandP;
 if(inlandD>0.0){inlandWorld=apsInlandWorldFromDepth(inlandUV,inlandD);}
 let inlandWorldNative=apsInlandNativePosition(inlandWorld);
 let inlandAbove=inlandD<=0.0||inlandWorldNative.y>apsInlandPlaneY(inlandBody,inlandWorldNative.xz)+0.01;
 let inlandExitFallback=select(hookEnvDiffuse(vec3f(0,1,0)),textureLoad(inlandRefrColor,inlandPixel,0).rgb,inlandAbove);
 let inlandExitDirection=refract(inlandI,-inlandN,inlandIor);
 var inlandExitSample=vec4f(0.0);
 if(!inlandTIR&&length(inlandExitDirection)>0.001){
  inlandExitSample=inlandReflectionWorldSample(inlandP,inlandExitDirection,inlandRough,inlandFoot);
 }
 let inlandThrough=mix(inlandExitFallback,inlandExitSample.rgb,inlandExitSample.a);
 let inlandUnder=select(mix(inlandRefl,inlandThrough,1.0-inlandF),inlandRefl,inlandTIR);
 inlandRadiance=inlandUnder*inlandView;
}else{
 let inlandF=apsInlandFresnel(max(dot(inlandN,in.V),0.0),inlandIor);
 let inlandReflected=apsInlandReflection(inlandP,inlandN,in.V,inlandRough,inlandFoot);
 let inlandSun=apsSunRadianceWithShadowNormal(inlandP,inlandN,inlandN,in.pixel);
 let inlandSunSpec=apsInlandSunSpecular(inlandN,normalize(frame.sunDir),in.V,inlandRough,inlandIor)*inlandSun*inlandF;
 inlandRay=apsInlandRefraction(inlandP,inlandN,in.V,inlandBody,inlandStraight,inlandUV);
 let inlandTransmitted=apsInlandWaterTransport(inlandP,inlandN,in.V,inlandBody,inlandRay,inlandSun);
 let inlandDry=textureLoad(inlandRefrColor,clamp(vec2i(in.pixel),vec2i(0),vec2i(textureDimensions(inlandRefrColor))-1),0).rgb;
 let inlandDeep=inlandReflected*inlandF+inlandSunSpec+inlandTransmitted*(1.0-inlandF);
 inlandRadiance=select(inlandDeep,mix(inlandDry,inlandDeep,smoothstep(0.0,0.045,inlandStraight.depth)),inlandStraight.valid>0.5);
}
if(inlandRefr.mode==1u){inlandRadiance=vec3f(apsInlandWetness(inlandP));}
else if(inlandRefr.mode==2u){inlandRadiance=vec3f(apsInlandCausticAt(inlandP,inlandBody,max(0.0,inlandStraight.depth),inlandNativeFoot));}
else if(inlandRefr.mode==3u){inlandRadiance=vec3f(inlandCover);}
else if(inlandRefr.mode==4u){inlandRadiance=vec3f(inlandRay.refracted,inlandRay.offscreen,inlandRay.valid);}
else if(inlandRefr.mode==5u){
 // GPU ray-map diagnostic: x/y = solved entry shift, z = Jacobian, w = focus.
 let inlandMap=apsInlandRayMap(inlandBody,inlandP,max(0.0,inlandStraight.depth),inlandNativeFoot,apsInlandShoreFade(inlandBody,max(0.0,inlandStraight.depth)));
 inlandRadiance=vec3f(clamp(length(inlandMap.xy)*2.0,0.0,1.0),clamp(inlandMap.z*0.5,0.0,1.0),clamp(inlandMap.w*0.25,0.0,1.0));
}
else if(inlandRefr.mode==6u){inlandRadiance=apsInlandViewAttenuationBody(inlandP,inlandBody);}
r.color=vec4f(inlandRadiance,1.0);
let inlandBelow=select(0.0,1.0,inlandCamUnder);
r.mask=vec4f(inlandBelow*inlandCover,inlandCover,1.0,inlandCover);
`;

                                                                               
                                                                                
export const INLAND_RECEIVER_WGSL=          `
struct OceanReceiverMaterial{baseColor:vec3f,roughness:f32,clearcoat:f32,clearcoatGloss:f32};
fn terrainReceiverWetness(xz:vec2f)->f32{return 0.0;}
fn terrainReceiverFoam(P:vec3f,footprint:f32)->vec2f{return vec2f(0.0);}
fn terrainReceiverSandColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return color;}
fn terrainReceiverShadeColor(P:vec3f,footprint:f32,color:vec3f)->vec3f {
 let hit=apsInlandFindBody(P,0.25);
 if(hit.index<0||hit.depth<=0.0){return color;}
 let ext=hit.body.absorb.xyz+hit.body.scatter.xyz;
 return color*exp(-ext*min(8.0,hit.depth)*0.22);
}
fn terrainReceiverShallowDepthColor(P:vec3f)->vec3f {
 let hit=apsInlandFindBody(P,0.25);
 if(hit.index<0){return vec3f(0.12);}
 return vec3f(clamp(hit.depth/8.0,0.0,1.0),select(0.0,1.0,hit.body.flags.y>0.5),0.15);
}
fn oceanApplyReceiverMaterial(P:vec3f,footprint:f32,color:vec3f,rough:f32,coat:f32,gloss:f32)->OceanReceiverMaterial {
 let wet=apsInlandWetness(P);
 let darken=mix(1.0,0.82,wet);
 return OceanReceiverMaterial(color*darken,mix(rough,max(0.06,rough*0.45),wet),max(coat,wet*0.35),mix(gloss,max(gloss,0.65),wet));
}
`;

function shader(name, code, extra = {}) { return new ShaderModule({name, code, ...extra}); }
const RECEIVER_ENTRY = ['terrainReceiverWetness','terrainReceiverFoam','terrainReceiverSandColor','terrainReceiverShadeColor','terrainReceiverShallowDepthColor'];
function renameReceiverModule(module, prefix, renameStruct) {
  let code = module.code;
  for (const name of RECEIVER_ENTRY) code = code.replace(new RegExp(`\\b${name}\\b`, 'g'), prefix + name[0].toUpperCase() + name.slice(1));
  code = code.replace(/\boceanApplyReceiverMaterial\b/g, prefix + 'ApplyReceiverMaterial');
  if (renameStruct) code = code.replace(/\bOceanReceiverMaterial\b/g, prefix + 'ReceiverMaterial');
  return new ShaderModule({name: `${module.name}-${prefix.toLowerCase()}-composite`, deps: module.deps, bindings: module.bindings, code});
}

export class InlandWaterOptics {
  constructor(viewer, native, options = {}) {
    if (!viewer?.sceneRenderer?.opaqueCopy) throw new Error('Inland optics requires the native opaque colour/depth copy');
    if (!native?.shape || !Number.isFinite(native.spacing?.[0])) throw new Error('Inland optics requires native terrain registration');
    this.viewer = viewer; this.native = native;
    this.config = validateInlandWaterConfig(options);
    this.configOverrides = new Set(Object.keys(options));
    this.bodies = []; this.allocatedLayers = new Set(); this.enabled = true; this.caustics = !!this.config.caustics;
    this.wetness = !!this.config.wetness; this.reflections = !!this.config.reflections; this.steps = 0;
    this.released = false; this.dirtyRows = true; this.atlasDirty = false; this.sourceFrame = null;
    this.indexUniforms = [];
    this.atlas = new Texture({label: 'inland lake FFT atlas', width: 128, height: 128, depth: INLAND_MAX_BODIES,
      dimension: '2d-array', format: 'rgba16float', mips: true, usage: ['sample', 'storage', 'render', 'copyDst', 'copySrc']});
    this.bodyUniform = new UniformBlock('APSInlandBodies', {count: ['u32', 0], body: [`vec4f[${INLAND_MAX_BODIES * INLAND_BODY_ROWS}]`, new Array(INLAND_MAX_BODIES * INLAND_BODY_ROWS * 4).fill(0)], worldFromNative:['mat4x4f',new Matrix4()], nativeFromWorld:['mat4x4f',new Matrix4()]}, {label: 'inland body rows'});
    this.refractionUniform = new UniformBlock('APSInlandRefraction', {enabled: ['u32', 1], strength: ['f32', this.config.refraction], maxPath: ['f32', this.config.max_refraction_path_m], mode: ['u32', 0]});
    this.ssrUniform = new UniformBlock('APSInlandSSR', {viewProjection: ['mat4x4f', new Matrix4()], inverseViewProjection: ['mat4x4f', new Matrix4()], view: ['mat4x4f', new Matrix4()], inverseProjection: ['mat4x4f', new Matrix4()], near: ['f32', 0.1], maxDistance: ['f32', this.config.max_reflection_distance_m], enabled: ['u32', 0]});
    this.core = shader('aps-inland-water-core', INLAND_CORE_WGSL, {
      deps: [commonModule],
      bindings: {inlandLakeAtlas: {texture: this.atlas}},
      uniforms: this.bodyUniform, uniformName: 'inlandB',
    });
    this.receiverModule = shader('aps-inland-water-receiver', this.config.wet_darkening === INLAND_WATER_DEFAULTS.wet_darkening ? INLAND_RECEIVER_WGSL : INLAND_RECEIVER_WGSL.replace('mix(1.0,0.82,wet)', 'mix(1.0,' + (1-this.config.wet_darkening).toFixed(8) + ',wet)'), {deps: [this.core]});
    this.directModulationModule = shader('aps-inland-water-direct', 'fn hookDirectModulation(P:vec3f,N:vec3f)->vec3f{return apsInlandDirectModulation(P,N);}', {deps: [this.core]});
    this.ambientModulationModule = shader('aps-inland-water-ambient', 'fn hookAmbientModulation(P:vec3f,N:vec3f)->vec3f{return apsInlandAmbientModulation(P,N);}', {deps: [this.core]});
    this.receiverSurfaceModule = this.receiverModule;
    this.terrainWetnessModule = this.receiverModule;
    this.ssr = new InlandScreenSpaceReflection(viewer, this.config);
    this.waterModule = shader('aps-inland-water-optics', INLAND_WATER_WGSL + INLAND_REFLECTION_TRACE_WGSL, {
      deps: [this.core],
      bindings: {
        inlandRefrColor: {texture: () => viewer.sceneRenderer.opaqueCopy.texture},
        inlandRefrDepth: {texture: () => viewer.sceneRenderer.opaqueCopy.depthTexture, sampleType: 'unfilterable-float'},
        inlandSSRColor: {texture: () => this.ssr.target.texture},
                                                                             
                                                                             
                                                                              
                                                                                  
        inlandSSRDepthTexture: {texture: () => viewer.sceneRenderer.opaqueCopy.depthTexture},
        inlandSSR: {uniform: this.ssrUniform},
      },
      uniforms: this.refractionUniform, uniformName: 'inlandRefr',
    });
    this.hook = null; this.previousBeforeWater = null;
    this._oceanReceiver = null; this._compositeReceiver = null;
    this._receiverComposites = new WeakMap();
    this._compositeOceanSource = null; this._compositeOceanBinding = null;
  }
                                                                               
                                                                              
                                                                         
                                                                            
  composeReceiver(oceanModule) {
    if (!oceanModule) return this.receiverModule;
    const cached = this._receiverComposites.get(oceanModule);
    if (cached) return cached;
    const ocean = renameReceiverModule(oceanModule, 'apsOcean', false);
    const inland = renameReceiverModule(this.receiverModule, 'apsInland', true);
    const code =           `
fn terrainReceiverWetness(xz:vec2f)->f32{return max(apsOceanTerrainReceiverWetness(xz),apsInlandTerrainReceiverWetness(xz));}
fn terrainReceiverFoam(P:vec3f,footprint:f32)->vec2f{return apsOceanTerrainReceiverFoam(P,footprint);}
fn terrainReceiverSandColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return apsInlandTerrainReceiverSandColor(P,footprint,apsOceanTerrainReceiverSandColor(P,footprint,color));}
fn terrainReceiverShadeColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return apsInlandTerrainReceiverShadeColor(P,footprint,apsOceanTerrainReceiverShadeColor(P,footprint,color));}
fn terrainReceiverShallowDepthColor(P:vec3f)->vec3f{let o=apsOceanTerrainReceiverShallowDepthColor(P);let i=apsInlandTerrainReceiverShallowDepthColor(P);return select(i,o,o.x>0.0&&o.x<0.11);}
fn oceanApplyReceiverMaterial(P:vec3f,footprint:f32,color:vec3f,rough:f32,coat:f32,gloss:f32)->OceanReceiverMaterial{
 let o=apsOceanApplyReceiverMaterial(P,footprint,color,rough,coat,gloss);
 let i=apsInlandApplyReceiverMaterial(P,footprint,o.baseColor,o.roughness,o.clearcoat,o.clearcoatGloss);
 return OceanReceiverMaterial(i.baseColor,i.roughness,i.clearcoat,i.clearcoatGloss);
}`;
    this._oceanReceiver = oceanModule;
    this._compositeReceiver = new ShaderModule({name: 'aps-inland-ocean-receiver', deps: [ocean, inland], code});
    this._receiverComposites.set(oceanModule, this._compositeReceiver);
    return this._compositeReceiver;
  }
                                                                               
                                                                               
                                                                              
                                                                    
                                                            
  composeWithOcean(ocean) {
    if (!ocean) return this;
    if (this._compositeOceanSource === ocean && this._compositeOceanBinding) return this._compositeOceanBinding;
    const receiver = ocean.receiverSurfaceModule ?? ocean.terrainWetnessModule;
    const wetness = ocean.terrainWetnessModule ?? ocean.receiverSurfaceModule;
    this._compositeOceanBinding = Object.assign(Object.create(ocean), {
      ocean,
      inland: this,
      receiverSurfaceModule: this.composeReceiver(receiver),
      terrainWetnessModule: this.composeReceiver(wetness),
      directModulationModule: composeWaterHook(ocean.directModulationModule, this.directModulationModule, 'hookDirectModulation', 'aps-ocean-inland-direct', 'apsInlandReceiverActive'),
      ambientModulationModule: composeWaterHook(ocean.ambientModulationModule, this.ambientModulationModule, 'hookAmbientModulation', 'aps-ocean-inland-ambient', 'apsInlandReceiverActive'),
    });
    this._compositeOceanSource = ocean;
    return this._compositeOceanBinding;
  }
  releaseOceanComposition() { this._compositeOceanSource = null; this._compositeOceanBinding = null; this._receiverComposites = new WeakMap(); }
  allocateLakeLayer() {
    for (let i = 0; i < INLAND_MAX_BODIES; i++) if (!this.allocatedLayers.has(i)) { this.allocatedLayers.add(i); return i; }
    throw new Error(`Inland lake atlas capacity exceeded (${INLAND_MAX_BODIES} bodies)`);
  }
  addBody(body) {
    if (this.released) throw new Error('Inland optics disposed');
    if (this.bodies.length >= INLAND_MAX_BODIES) throw new Error(`Inland water body capacity exceeded (${INLAND_MAX_BODIES})`);
    if (body.sample.layer >= 0) {
      if (this.bodies.some(b => b.sample.layer === body.sample.layer)) throw new Error('Duplicate inland atlas layer');
      this.allocatedLayers.add(body.sample.layer);
    }
                                                                               
                                                                             
    const overrides=this.configOverrides, config=this.config, optical={...body.optics}, wave={...body.wave}, flow={...body.flow};
    for(const key of ['ior','caustics','wetness','caustic_plane_m'])if(overrides.has(key))optical[key]=config[key];
    for(const key of ['absorption','scatter']){
      const setting=body.kind==='river'?'river_'+key:key;
      if(overrides.has(setting))optical[key]=[...config[setting]];
    }
    if(overrides.has('caustic_strength'))wave.caustic_strength*=config.caustic_strength;
    if(overrides.has('wet_width_m'))wave.wet_width=config.wet_width_m;
    const depthSetting=body.kind==='river'?'river_caustic_max_depth_m':'caustic_max_depth_m';
    if(overrides.has(depthSetting))wave.max_depth=config[depthSetting];
    if(body.kind==='river'){
      if(overrides.has('river_wave_amplitude_m'))wave.amplitude=config.river_wave_amplitude_m;
      if(overrides.has('river_wave_wavelength_m'))wave.wavelength=config.river_wave_wavelength_m;
      if(!flow.explicit_speed&&overrides.has('river_flow_speed_m_s'))flow.speed=config.river_flow_speed_m_s;
    }
    body=Object.freeze({...body,optics:Object.freeze(optical),wave:Object.freeze(wave),flow:Object.freeze(flow)});
    this.bodies.push(body); this.dirtyRows = true; return this.bodies.length - 1;
  }
  indexModule(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.bodies.length) throw new Error('Invalid inland water body index');
    const cached = this.indexUniforms.find(row => row.index === index);
    if (cached) return cached.module;
                                                                               
                                                                              
    const module = shader('aps-inland-water-index-' + index, `fn apsInlandIndex()->u32{return ${index}u;}`);
    this.indexUniforms.push({index, module});
    return module;
  }
  attachMaterial(material, index, {kind = 'lake'} = {}) {
    if (!material?.modules) throw new Error('Inland optics requires a native mesh material');
    if (material.userData?.inland_water) throw new Error('Material already carries inland optics');
    material.modules.push(this.waterModule, this.indexModule(index));
    material.output = INLAND_WATER_OUTPUT;
                                                                            
                                                                            
    material.depthWrite = true; material.blending = 'none';
    material.userData = {...material.userData, inland_water: {kind, body_index: index, water_kind: kind}};
    material.needsUpdate = true;
    return material;
  }
  install() {
    if (this.hook) return this;
    const sr = this.viewer.sceneRenderer;
    this.previousBeforeWater = sr.onBeforeWater ?? null;
    this.hook = () => { this.previousBeforeWater?.(); if (!this.released) this.updateViewUniforms(); if (this.enabled && this.reflections) this.ssr.render(); };
    this.hook.apsInlandOwner = this; this.hook.base = this.previousBeforeWater;
    sr.onBeforeWater = this.hook;
    return this;
  }
  markAtlasDirty() { this.atlasDirty = true; }
  rebuildRows() {
    const packed = packBodies(this.bodies, {optics: this.enabled, caustics: this.caustics, wetness: this.wetness});
    this.bodyUniform.set('count', packed.count); this.bodyUniform.set('body', packed.rows); this.dirtyRows = false;
    this.refractionUniform.set('enabled', this.enabled ? 1 : 0);
    this.ssrUniform.set('enabled', this.enabled && this.reflections ? 1 : 0);
  }
  setOpticsEnabled(value) { this.enabled = !!value; this.dirtyRows = true; this.refractionUniform.set('enabled', this.enabled ? 1 : 0); this.ssrUniform.set('enabled', this.enabled && this.reflections ? 1 : 0); }
  setCausticsEnabled(value) { this.caustics = !!value; this.dirtyRows = true; }
  setWetnessEnabled(value) { this.wetness = !!value; this.dirtyRows = true; }
  setReflectionsEnabled(value) { this.reflections = !!value; this.ssrUniform.set('enabled', this.enabled && this.reflections ? 1 : 0); }
  setDebugMode(mode = 0) { if (!Number.isInteger(mode) || mode < 0 || mode > 6) throw new Error('Unsupported inland optics debug mode'); this.refractionUniform.set('mode', mode); }
  setRefractionStrength(value) { if (!Number.isFinite(value) || value < 0 || value > 4) throw new Error('Invalid inland refraction strength'); this.refractionUniform.set('strength', value); }
  setCoordinateFrame(frame) {
    if(!frame?.worldFromNative||!frame?.nativeFromWorld)throw new Error('Inland water coordinate frame missing');
    this.bodyUniform.set('worldFromNative',frame.worldFromNative);
    this.bodyUniform.set('nativeFromWorld',frame.nativeFromWorld);
  }
  update(time = this.viewer.time ?? 0) {
    if (this.released) return;
    if (!Number.isFinite(time) || time < 0) throw new Error('Inland optics needs finite scene time');
    if (this.dirtyRows) this.rebuildRows();
    if (this.atlasDirty) { generateMipmaps(this.atlas); this.atlasDirty = false; }
    this.updateViewUniforms();
    this.steps++;
  }
  updateViewUniforms() {
    const f = FrameUniforms.fields;
    this.ssrUniform.set('viewProjection', new Matrix4().fromArray(f.viewProj.value.elements ?? f.viewProj.value));
    this.ssrUniform.set('inverseViewProjection', new Matrix4().fromArray(f.invViewProj.value.elements ?? f.invViewProj.value));
    this.ssrUniform.set('view', new Matrix4().fromArray(f.view.value.elements ?? f.view.value));
    this.ssrUniform.set('inverseProjection', new Matrix4().fromArray(f.invProj.value.elements ?? f.invProj.value));
    this.ssrUniform.set('near', this.viewer.camera.near ?? 0.1);
    this.ssrUniform.set('maxDistance', this.config.max_reflection_distance_m);
  }
  selected(x, z) {
    let best = null, bestDepth = -Infinity;
    for (const b of this.bodies) {
      if (!bodyContains(b, x, z, 0.3)) continue;
      const depth = planeHeight(b.plane, x, z);
      if (depth > bestDepth) { best = b; bestDepth = depth; }
    }
    return best;
  }
  metadata() {
    return {method: 'shared inland body-plane + fade wave normal; signed Snell/Beer refraction; receiver-ray-map caustics; underwater camera view segment and water-to-air TIR',
      enabled: this.enabled, caustics: this.caustics, wetness: this.wetness, reflections: this.reflections,
      config: {absorption: this.config.absorption, scatter: this.config.scatter, ior: this.config.ior, refraction: this.config.refraction,
        max_refraction_path_m: this.config.max_refraction_path_m, caustic_plane_m: this.config.caustic_plane_m,
        caustic_max_depth_m: this.config.caustic_max_depth_m, wet_width_m: this.config.wet_width_m},
      atlas: {width: this.atlas.width, height: this.atlas.height, layers: INLAND_MAX_BODIES, format: this.atlas.format, mips: true},
      bodies: bodyDiagnostics(this.bodies), body_count: this.bodies.length, updates: this.steps,
      opacity: 'alpha-free late pass; receiver colour blended by current water-column contact',
      domain: {method: 'AABB + local water plane (user-accepted; no shoreline mask or mesh-domain texture)', wet_band: 'narrow near-plane contact only', above_plane_rejection: 'receiver depth <= 0 is rejected for refraction/caustics'},
      refraction: {method: 'Snell air/water ray against reconstructed opaque depth using the same body-plane + wave normal', foreground_rejection: 'receiver must be behind the water fragment', dry_rejection: 'receiver above local water plane', cross_body_rejection: 'AABB/local-plane body selection (user-accepted)', offscreen: 'straight same-pixel opaque sample', attenuation: 'actual bent or straight receiver path, capped'},
      caustics: {method: 'signed receiver-ray-map Jacobian around the accepted shallow 1m plane', actual_depth_validity: true, actual_ray_distance: 's.x + positive receiver offset; never max(0, planeY-surfaceY)', attenuation: 'Beer extinction over the actual sun-to-receiver path', anti_flash: 'bounded 0.05..5 focus and depth fade', body_source: 'same FFT atlas layer / flow ripple and frame time', camera_independent: true, gpu_debug: 'mode 2 focus, mode 5 entry shift/Jacobian/focus'},
      wetness: {method: 'per-fragment local waterline contact band with per-body noise width', foam: 'none', uniform_white_ring: false},
      underwater_camera: {classification: 'camera inside body AABB and below the local plane', submerged_target: 'whole camera-to-point underwater segment', above_water_target: 'camera-to-exit intersection; water-to-air Fresnel and TIR at exit', whole_segment_requires_entry: false, caustics: 'receiver sun path remains camera-independent'},
      ssr: this.ssr.metadata(), limitations: ['single visible opaque layer', 'AABB/local-plane body domain rather than exact shoreline polygon (user-accepted)', 'no hydrodynamic solve', 'underwater surface transmission is an approximate single-interface model']};
  }
  dispose() {
    if (this.released) return;
    this.released = true;
    this.releaseOceanComposition();
    unlinkWaterHook(this.viewer?.sceneRenderer, this.hook, this.previousBeforeWater);
    this.hook = null;
    this.ssr.dispose();
    this.atlas.destroy();
    this.bodyUniform.buffer?.destroy(); this.refractionUniform.buffer?.destroy(); this.ssrUniform.buffer?.destroy();
    for (const row of this.indexUniforms) row.block?.buffer?.destroy();
    this.indexUniforms.length = 0; this.bodies.length = 0;
  }
}

class InlandScreenSpaceReflection {
  constructor(viewer, config) {
    this.viewer = viewer; this.config = config; this.calls = 0;
    this.target = new RenderTarget(1, 1, {colors: ['rgba16float'], mips: true, label: 'inland SSR opaque radiance'});
    this.coverage = new FullscreenPass({label: 'inland SSR main opaque coverage', bindings: {ssrSourceColor: {texture: () => viewer.sceneRenderer.opaqueCopy.texture}, ssrSourceDepth: {texture: () => viewer.sceneRenderer.opaqueCopy.depthTexture}}, code: `
fn fragment(in:FSIn)->vec4f {
 let px=vec2i(in.pos.xy);let depth=textureLoad(ssrSourceDepth,px,0);
 if(depth<=0.0){return vec4f(0);}
 return vec4f(textureLoad(ssrSourceColor,px,0).rgb,1.0);
}`});
  }
  render() {
    if (!this.config.reflections) return;
    const source = this.viewer.sceneRenderer.opaqueCopy;
    this.target.setSize(source.width, source.height);
    this.coverage.render({colorViews: [this.target.texture], clear: [0, 0, 0, 0]});
    generateMipmaps(this.target.texture); this.calls++;
  }
  metadata() { return {method: 'screen-space trace of the current main opaque colour/depth', calls: this.calls, auxiliary_cameras: 0, resolution: [this.target.width, this.target.height], miss: 'preintegrated environment', limitations: 'main-camera-visible receivers only'}; }
  dispose() { for (const t of this.target.textures) t.destroy(); this.target.depthTexture?.destroy(); this.coverage = null; }
}

export function createInlandWaterOptics(viewer, native, options = {}) { return new InlandWaterOptics(viewer, native, options); }








