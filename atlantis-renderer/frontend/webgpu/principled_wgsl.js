import {ShaderModule, surfaceModule, lightingModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {SceneLighting} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {principledDFGModule} from './mesh_dfg.js';
import {receiverShadowModule} from './receiver_shadow.js';
import {normalGuardModule} from './normal_guard.js';
export {principledDFGModule,principledDFGTexture} from './mesh_dfg.js';

                                                                                
                                                                                 
                                                                                
                                                                                  
export const PRINCIPLED_WGSL =           `
struct APSIncidentLight { direction: vec3f, radiance: vec3f, };
struct APSPrincipled {
  baseColor: vec3f, normal: vec3f, geometricNormal: vec3f, metallic: f32, roughness: f32,
  occlusion: f32, specular: f32, specularTint: f32, anisotropy: f32,
  subsurface: f32, sheen: f32, sheenTint: f32, clearcoat: f32,
  clearcoatGloss: f32, subsurfaceColor: vec3f, subsurfaceColorWeight: f32,
  emission: vec3f, clearcoatNormal: vec3f,
  diffuseTransmission: f32, transmissionThickness: f32, transmissionColor: vec3f,
};
fn apsSafeNormal(v: vec3f, fallback: vec3f) -> vec3f {
  return select(fallback, v * inverseSqrt(max(dot(v,v), 1e-20)), dot(v,v) > 1e-16);
}
fn apsTangent(N: vec3f, candidate: vec3f) -> vec3f {
  let axis = select(vec3f(0,1,0), vec3f(1,0,0), abs(N.y) > 0.98);
  return apsSafeNormal(candidate-N*dot(N,candidate), normalize(cross(axis,N)));
}
fn apsPrincipledDefaults(N: vec3f) -> APSPrincipled {
  var m: APSPrincipled;
  m.baseColor=vec3f(0.8); m.normal=N; m.geometricNormal=N; m.metallic=0; m.roughness=0.5;
  m.occlusion=1; m.specular=0.5; m.specularTint=0; m.anisotropy=0;
  m.subsurface=0; m.sheen=0; m.sheenTint=0.5; m.clearcoat=0; m.clearcoatGloss=1;
  m.subsurfaceColor=m.baseColor; m.subsurfaceColorWeight=0; m.emission=vec3f(0);
  m.clearcoatNormal=N;
  m.diffuseTransmission=0; m.transmissionThickness=1; m.transmissionColor=vec3f(1);
  return m;
}
fn apsSanitize(input: APSPrincipled, fallback: vec3f) -> APSPrincipled {
  var m=input;
  m.geometricNormal=apsSafeNormal(fallback,vec3f(0,1,0));
  m.baseColor=clamp(m.baseColor,vec3f(0),vec3f(1)); m.emission=max(m.emission,vec3f(0));
  m.subsurfaceColor=clamp(m.subsurfaceColor,vec3f(0),vec3f(1));
  m.normal=apsSafeNormal(m.normal,fallback); m.clearcoatNormal=apsSafeNormal(m.clearcoatNormal,m.normal);
  m.metallic=clamp(m.metallic,0,1); m.roughness=clamp(m.roughness,0,1);
  m.occlusion=clamp(m.occlusion,0,1); m.specular=clamp(m.specular,0,1);
  m.specularTint=clamp(m.specularTint,0,1); m.anisotropy=clamp(m.anisotropy,0,1);
  m.subsurface=clamp(m.subsurface,0,1); m.sheen=clamp(m.sheen,0,1);
  m.sheenTint=clamp(m.sheenTint,0,1); m.clearcoat=clamp(m.clearcoat,0,1);
  m.clearcoatGloss=clamp(m.clearcoatGloss,0,1); m.subsurfaceColorWeight=clamp(m.subsurfaceColorWeight,0,1);
  m.diffuseTransmission=clamp(m.diffuseTransmission,0,1);
  m.transmissionThickness=clamp(m.transmissionThickness,0,4);
  m.transmissionColor=clamp(m.transmissionColor,vec3f(0),vec3f(1));
  return m;
}
fn apsGuardPrincipled(input:APSPrincipled,L:vec3f,V:vec3f)->APSPrincipled {
 var m=input;
 m.normal=apsConsistentNormal(m.normal,m.geometricNormal,V,L);
 m.clearcoatNormal=apsConsistentNormal(m.clearcoatNormal,m.geometricNormal,V,L);
 return m;
}
fn apsFifth(cosine: f32) -> f32 { let t=clamp(1-cosine,0,1); return t*t*t*t*t; }
fn apsTint(color: vec3f) -> vec3f {
  let lum=dot(color,vec3f(0.3,0.6,0.1)); return select(vec3f(1),color/max(lum,1e-6),lum>1e-6);
}
fn apsVisibility(c: f32, x: f32, y: f32, a: vec2f) -> f32 {
  let t=a*vec2f(x,y); return 1/max(c+sqrt(dot(t,t)+c*c),1e-6);
}
fn apsClearcoat(m: APSPrincipled, L: vec3f, V: vec3f) -> vec3f {
  let N=m.clearcoatNormal; let nl=dot(N,L); let nv=dot(N,V);
  if(nl<=0 || nv<=0) { return vec3f(0); }
  let H=apsSafeNormal(L+V,N); let nh=max(dot(N,H),0);
  let a=mix(0.1,0.001,m.clearcoatGloss); let a2=a*a;
  let D=(a2-1)/(PI*log(a2)*(1-nh*nh+a2*nh*nh));
  let vis=1/max((nl+sqrt(0.0625+0.9375*nl*nl))*(nv+sqrt(0.0625+0.9375*nv*nv)),1e-6);
  return vec3f(0.25*m.clearcoat*D*vis*mix(0.04,1,apsFifth(max(dot(L,H),0)))*nl);
}
fn apsLeafTransmissionColor(m: APSPrincipled) -> vec3f {
  // Beer-Lambert-style optical-thickness scaling of an authored pigment prior.
  // Square root at thickness=1 follows the thin diffuse-color convention. A
  // supplied tint/map remains bounded and can darken veins or thicker leaves.
  return pow(max(m.baseColor,vec3f(1e-8)),vec3f(0.5*m.transmissionThickness))*m.transmissionColor;
}
fn apsLeafViewTransmission(m: APSPrincipled, V: vec3f) -> f32 {
  return 1.0-mix(0.08*m.specular,1.0,apsFifth(max(dot(m.normal,V),0)));
}
fn apsLeafTransmission(m: APSPrincipled, L: vec3f, V: vec3f) -> vec3f {
  if(m.diffuseTransmission<=0 || m.metallic>=1 || dot(m.normal,V)<=0) { return vec3f(0); }
  let nl=max(-dot(m.normal,L),0);
  return apsLeafTransmissionColor(m)*(m.diffuseTransmission*(1-m.metallic)*apsLeafViewTransmission(m,V)*nl/PI);
}
// Returns BRDF/BTDF times cosine once (coat has its independent shading normal).
fn apsDisneyDirect(input: APSPrincipled, L: vec3f, V: vec3f, tangent: vec3f) -> vec3f {
  let m=apsGuardPrincipled(input,L,V);
  let N=m.normal; let nl=dot(N,L); let nv=dot(N,V);
  var result=apsClearcoat(m,L,V)+apsLeafTransmission(m,L,V);
  if(nl<=0 || nv<=0) { return result; }
  let X=apsTangent(N,tangent); let Y=cross(N,X);
  let H=apsSafeNormal(L+V,N); let nh=max(dot(N,H),0); let lh=max(dot(L,H),0);
  let tint=apsTint(m.baseColor);
  let f0=mix(0.08*m.specular*mix(vec3f(1),tint,m.specularTint),m.baseColor,m.metallic);
  let fl=apsFifth(nl); let fv=apsFifth(nv); let fh=apsFifth(lh);
  let fd90=0.5+2*m.roughness*lh*lh;
  let diffuse=mix(1,fd90,fl)*mix(1,fd90,fv);
  let fss90=m.roughness*lh*lh;
  let ss=1.25*(mix(1,fss90,fl)*mix(1,fss90,fv)*(1/max(nl+nv,1e-6)-0.5)+0.5);
  let aspect=sqrt(1-0.9*m.anisotropy);
  let a=max(vec2f(0.001),m.roughness*m.roughness*vec2f(1/aspect,aspect));
  let ht=vec2f(dot(H,X),dot(H,Y))/a; let den=dot(ht,ht)+nh*nh;
  let D=1/(PI*a.x*a.y*den*den);
  let vis=apsVisibility(nl,dot(L,X),dot(L,Y),a)*apsVisibility(nv,dot(V,X),dot(V,Y),a);
  let spec=D*vis*mix(f0,vec3f(1),fh);
  let sheen=m.sheen*fh*mix(vec3f(1),tint,m.sheenTint);
  let ssColor=mix(m.baseColor,m.subsurfaceColor,m.subsurfaceColorWeight);
  result+=((mix(m.baseColor*diffuse,ssColor*ss,m.subsurface)*(1-m.diffuseTransmission)/PI+sheen)*(1-m.metallic)+spec)*nl;
  return result;
}
fn apsDiffuseDirect(input: APSPrincipled, L: vec3f, V: vec3f) -> vec3f {
  let m=apsGuardPrincipled(input,L,V);
  let nl=max(dot(m.normal,L),0); let nv=max(dot(m.normal,V),0);
  var t=dot(L,V)-nl*nv; if(t>0) { t/=max(max(nl,nv),1e-20); }
  let A=1/(PI+((3*PI-4)/6)*m.roughness);
  return m.baseColor*(nl*A*(1+m.roughness*t));
}
fn apsGlossyDirect(input: APSPrincipled, L: vec3f, V: vec3f) -> vec3f {
  let m=apsGuardPrincipled(input,L,V);
  let nl=dot(m.normal,L); let nv=dot(m.normal,V);
  if(nl<=0 || nv<=0) { return vec3f(0); }
  let H=apsSafeNormal(L+V,m.normal); let nh=max(dot(m.normal,H),0);
  let a=max(0.001,m.roughness*m.roughness); let a2=a*a; let d=1+(a2-1)*nh*nh;
  let vis=1/max((nl+sqrt(a2+(1-a2)*nl*nl))*(nv+sqrt(a2+(1-a2)*nv*nv)),1e-12);
  return m.baseColor*(a2/(PI*d*d)*vis*nl);
}
fn apsSrgbToLinear(c: vec3f) -> vec3f {
  return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));
}
`;

export const principledModule = new ShaderModule({name:'aps-disney-2012',deps:[surfaceModule,normalGuardModule],code:PRINCIPLED_WGSL});

                                                                               
                                                                           
                                                                               
export function createPrincipledLightingModule({dfgModule=null,localLightModule=null}={}) {
  const module=new ShaderModule({name:'aps-principled-lighting',deps:[principledModule,lightingModule,dfgModule,localLightModule,receiverShadowModule],code:          `
${localLightModule ? '' : `fn apsLocalLightCount() -> u32 { return 0u; }
fn apsLocalLight(index: u32, P: vec3f, N: vec3f, pixel: vec2f) -> APSIncidentLight {
  return APSIncidentLight(vec3f(0,1,0),vec3f(0));
}`}
${dfgModule ? '' : `fn apsPrincipledDFG(nv: f32, roughness: f32) -> vec4f {
  return vec4f(DFGApprox(nv,roughness),0.1*apsFifth(nv),1.0);
}`}
var<private> apsLightingPosition:vec3f;
fn apsDisneyEnvironment(input: APSPrincipled, V: vec3f, tangent: vec3f) -> vec3f {
  let m=apsGuardPrincipled(input,vec3f(0),V);
  let nv=dot(m.normal,V); if(nv<=1e-6) { return vec3f(0); }
  let base=clamp(m.baseColor,vec3f(0),vec3f(1)); let tint=apsTint(base);
  let f0=clamp(mix(0.08*m.specular*mix(vec3f(1),tint,m.specularTint),base,m.metallic),vec3f(0),vec3f(1));
  let dfg=apsPrincipledDFG(nv,m.roughness);
  let spec=clamp(f0*dfg.x+vec3f(dfg.y),vec3f(0),vec3f(1));
  var N=m.normal; let X=apsTangent(N,tangent); let Y=cross(N,X);
  let planeV=V-Y*dot(Y,V);
  N=apsSafeNormal(mix(N,apsSafeNormal(planeV,N),m.anisotropy*m.roughness),N);
  var result=hookEnvSpecular(reflect(-V,N),m.roughness)*spec;
  let diffuse=mix(base,clamp(m.subsurfaceColor,vec3f(0),vec3f(1)),m.subsurface*m.subsurfaceColorWeight);
  let sheen=clamp(m.sheen*dfg.z*mix(vec3f(1),tint,m.sheenTint),vec3f(0),vec3f(1));
  result+=apsIndoorDiffuse(apsLightingPosition,m.normal,hookEnvDiffuse(m.normal))*(1-m.metallic)*(vec3f(1)-spec)*(diffuse*(1-m.diffuseTransmission)*(vec3f(1)-sheen)+sheen);
  if(m.diffuseTransmission>0) {
    result+=hookEnvDiffuse(-m.normal)*(1-m.metallic)*apsLeafViewTransmission(m,V)*apsLeafTransmissionColor(m)*m.diffuseTransmission;
  }
  let coatR=sqrt(mix(0.1,0.001,m.clearcoatGloss));
  let coatNV=max(dot(m.clearcoatNormal,V),0); let coatDFG=apsPrincipledDFG(coatNV,coatR);
  let coat=select(0.0,0.25*m.clearcoat*clamp(0.04*coatDFG.x+coatDFG.y,0,1),coatNV>1e-6);
  return (result*(1-coat)+hookEnvSpecular(reflect(-V,m.clearcoatNormal),coatR)*coat)*m.occlusion;
}
// Call in uniform fragment control flow: modulation modules use these derivatives.
fn apsPrepareLighting(P: vec3f) { apsLightingPosition=P;lightDPdx=dpdx(P); lightDPdy=dpdy(P); }
fn apsSunRadianceWithShadowNormal(P: vec3f, N: vec3f, shadowN: vec3f, pixel: vec2f) -> vec3f {
  var light=frame.sunColor*hookDirectModulation(P,N);
#if MATERIAL_SUN_MODULATION
  light*=materialSunModulation(P,N);
#endif
#if RECEIVE_SHADOWS
  light*=apsReceiverSunShadow(P,sunShadow(hookShadowPosition(P,shadowN,pixel),shadowN,pixel));
#endif
  return light;
}
fn apsSunRadiance(P: vec3f, N: vec3f, pixel: vec2f) -> vec3f {
  return apsSunRadianceWithShadowNormal(P,N,N,pixel);
}
fn apsShadePrincipled(input: APSPrincipled, s: Surface, P: vec3f, V: vec3f, pixel: vec2f, tangent: vec3f) -> vec3f {
  let m=apsGuardPrincipled(input,frame.sunDir,V);
  // Query the illuminated side of a thin sheet. A camera-facing normal offset
  // on a backlit leaf would put the receiver behind its own depth-map surface.
  let sunN=select(m.normal,-m.normal,m.diffuseTransmission>0 && dot(m.normal,frame.sunDir)<0);
  let direct=apsDisneyDirect(m,frame.sunDir,V,tangent)*apsSunRadianceWithShadowNormal(P,m.normal,sunN,pixel);
  let env=apsDisneyEnvironment(m,V,tangent)+hookBounce(P,m.normal)*m.baseColor*(1-m.metallic)*m.occlusion;
  var local=vec3f(0);
  var localMask=apsMeshLocalLightMask(P);
  while(localMask!=0u){let i=firstTrailingBit(localMask);localMask=localMask & (localMask-1u);
    let light=apsMeshLocalLight(i,P,m.normal,pixel);
    if(all(light.radiance==vec3f(0))){continue;}
    local+=apsDisneyDirect(input,light.direction,V,tangent)*light.radiance;
  }
  return direct+env*hookAmbientModulation(P,m.normal)+local+m.emission;
}
`});
                                                                             
                                                                      
  const source=module.code;
  const baseDeps=module.deps;
  Object.defineProperty(module,'deps',{get(){return [...baseDeps,...(SceneLighting.hooks.indoorGI?[SceneLighting.hooks.indoorGI]:[])];}});
  Object.defineProperty(module,'code',{get(){
    const live=localLightModule??SceneLighting.hooks.localLights;
    const hasIncident=live&&/fn\s+apsLocalLight\(/.test(live.code);
    let code=source;
    if(!SceneLighting.hooks.indoorGI)code+='\nfn apsIndoorDiffuse(P:vec3f,N:vec3f,fallback:vec3f)->vec3f{return fallback;}';
    if(hasIncident&&!localLightModule)code=code.replace(/fn apsLocalLightCount\(\) -> u32 \{ return 0u; \}\s*fn apsLocalLight\([^]*?\n\}/,'');
    const args=localLightModule?'index,P,N,pixel':/fn\s+apsLocalLight\([^)]*\bN\s*:/.test(live?.code??'')?'index,P,N':'index,P';
    code+=/fn\s+apsLocalLightMask\(/.test(live?.code??'')?'\nfn apsMeshLocalLightMask(P:vec3f)->u32{return apsLocalLightMask(P);}':'\nfn apsMeshLocalLightMask(P:vec3f)->u32{let n=apsLocalLightCount();if(n>=32u){return 0xffffffffu;}return (1u<<n)-1u;}';
    code+=hasIncident?`\nfn apsMeshLocalLight(index:u32,P:vec3f,N:vec3f,pixel:vec2f)->APSIncidentLight{let light=apsLocalLight(${args});return APSIncidentLight(light.direction,light.radiance);}`:
      '\nfn apsMeshLocalLight(index:u32,P:vec3f,N:vec3f,pixel:vec2f)->APSIncidentLight{return APSIncidentLight(vec3f(0,1,0),vec3f(0));}';
    return code;
  }});
  return module;
}



export const principledLightingModule = createPrincipledLightingModule({dfgModule:principledDFGModule});

                                                                                  
                                                                                 
export const PRINCIPLED_SURFACE_WGSL =           `
fn apsSurfaceFromPrincipled(m: APSPrincipled, alpha: f32) -> Surface {
  var s=defaultSurface(m.normal); s.albedo=m.baseColor; s.alpha=alpha;
  s.roughness=m.roughness; s.metalness=m.metallic; s.ao=m.occlusion;
  s.emissive=m.emission; s.specularIntensity=2*m.specular;
  s.clearcoat=m.clearcoat; s.clearcoatNormal=m.clearcoatNormal;
  s.clearcoatRoughness=sqrt(mix(0.1,0.001,m.clearcoatGloss));
  s.sheenColor=m.sheen*mix(vec3f(1),apsTint(m.baseColor),m.sheenTint); return s;
}
`;
export const principledSurfaceModule = new ShaderModule({name:'aps-principled-surface',deps:[principledModule],code:PRINCIPLED_SURFACE_WGSL});
