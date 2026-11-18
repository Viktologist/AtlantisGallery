import {OCEAN_REFRACTION_RECEIVER_WGSL} from './ocean_refraction.js';
                                                                                     
export const OCEAN_OPTICAL_HELPERS =           `
struct APSOceanInterface {reflection:vec3f,transmission:vec3f,reflectance:f32};
fn apsOceanInterface(N:vec3f,V:vec3f,below:bool)->APSOceanInterface {
 let eta=select(1.333,1.0/1.333,below);let transmission=refract(-V,N,1.0/eta);
 let F=select(fresnelDielectric(clamp(dot(N,V),0.0,1.0),eta),1.0,dot(transmission,transmission)<1e-8);
 return APSOceanInterface(reflect(-V,N),transmission,F);
}
fn apsOceanJacobianColor(j:f32)->vec3f {
 let folded=vec3f(0.8,0.02,0.7);let compressed=vec3f(0.95,0.045,0.01);let squeezed=vec3f(1.0,0.55,0.025);let neutral=vec3f(0.07,0.09,0.11);let expanded=vec3f(0.025,0.3,1.0);
 if(j<0.0){return mix(compressed,folded,clamp(-j*2.0,0.0,1.0));}if(j<0.5){return mix(compressed,squeezed,j*2.0);}if(j<1.0){return mix(squeezed,neutral,(j-0.5)*2.0);}return mix(neutral,expanded,clamp(j-1.0,0.0,1.0));
}
struct APSOceanRay {radiance:vec3f,coverage:f32,path:f32};
fn apsOceanProject(P:vec3f)->vec3f {
 let h=oceanRefr.viewProjection*vec4f(P,1.0);
 return vec3f(h.x/max(h.w,1e-8)*0.5+0.5,0.5-h.y/max(h.w,1e-8)*0.5,h.w);
}
fn apsOceanDepth(uv:vec2f)->f32 {
 if(!oceanRefractionInside(uv)){return 0.0;}
 let size=vec2i(textureDimensions(waterRefrDepth));return textureLoad(waterRefrDepth,min(vec2i(uv*vec2f(size)),size-1),0).x;
}
${OCEAN_REFRACTION_RECEIVER_WGSL}
fn apsOceanBedRadiance(start:vec3f,hit:vec3f,uv:vec2f)->APSOceanRay {
 let size=vec2f(textureDimensions(waterRefrDepth));
 let e=oceanRefr.bedSpacing;let ex=vec2f(e,0);let ez=vec2f(0,e);
 let grad=vec2f(oceanBed(hit.xz+ex)-oceanBed(hit.xz-ex),oceanBed(hit.xz+ez)-oceanBed(hit.xz-ez))/(2.0*e);
 let normal=normalize(vec3f(-grad.x,1,-grad.y));let eye=normalize(hit-frame.cameraPos);
 let pixelWorld=length(hit-frame.cameraPos)*2.0*max(abs(oceanRefr.inverseProjection[0][0])/size.x,abs(oceanRefr.inverseProjection[1][1])/size.y);
 let tolerance=max(length(oceanRefr.receiverCell)*2.0,pixelWorld*1.5/max(0.025,abs(dot(normal,eye))));
 return apsOceanReceiverRadiance(start,hit,uv,tolerance,true);
}
fn apsOceanSceneTrace(start:vec3f,direction:vec3f,below:bool)->APSOceanRay {
 var result=APSOceanRay(vec3f(0),0.0,180.0);
 if(!below && shoreP.hasBed>0u) {
  var a=0.0;var b=0.12;
  for(var i=0;i<64;i++) {
   let p=start+direction*b;
   if(oceanBedKnown(p.xz)&&p.y<=oceanBed(p.xz)) {
    for(var j=0;j<8;j++){let mid=(a+b)*0.5;let q=start+direction*mid;if(oceanBedKnown(q.xz)&&q.y<=oceanBed(q.xz)){b=mid;}else{a=mid;}}
    let hit=start+direction*b;let source=apsOceanProject(hit);result.path=b;
    if(source.z<=0.0||!oceanRefractionInside(source.xy)){return result;}
    result=apsOceanBedRadiance(start,hit,source.xy);result.path=b;return result;
   }
   a=b;b=b*1.15+0.15;if(b>180.0){break;}
  }
  // Missing refracted receivers are handled by the validated straight gather.
  return result;
 }
 var distance=0.12;var previous=0.0;
 for(var i=0;i<36;i++) {
  let p=start+direction*distance;let source=apsOceanProject(p);
  if(source.z<=0.0||!oceanRefractionInside(source.xy)){return result;}
  let depth=apsOceanDepth(source.xy);
  if(depth>0.0) {
   let world=oceanRefractionWorld(source.xy,depth);let rayDepth=-(frame.view*vec4f(p,1)).z;let receiverDepth=-(frame.view*vec4f(world,1)).z;
   if(rayDepth>=receiverDepth) {
    var a=previous;var b=distance;var uv=source.xy;
    for(var j=0;j<5;j++) {
     let mid=(a+b)*0.5;let q=start+direction*mid;let cp=apsOceanProject(q);uv=cp.xy;
     let z=apsOceanDepth(uv);if(cp.z<=0.0||z<=0.0){a=mid;continue;}
     let receiver=oceanRefractionWorld(uv,z);
     if(-(frame.view*vec4f(q,1)).z>=-(frame.view*vec4f(receiver,1)).z){b=mid;}else{a=mid;}
    }
    let z=apsOceanDepth(uv);if(z<=0.0||!oceanRefractionInside(uv)){return result;}
    let receiver=oceanRefractionWorld(uv,z);
    result.path=length(receiver-start);if(result.path>=180.0){return result;}
    if(!below){let distance=result.path;result=apsOceanReceiverRadiance(start,receiver,uv,max(0.02,distance*0.002),true);result.path=distance;return result;}
    result.radiance=textureSampleLevel(waterRefrColor,smpLinearClamp,uv,0.0).rgb;result.coverage=1.0;return result;
   }
  }
  previous=distance;distance=distance*1.22+0.18;if(distance>180.0){break;}
 }
 return result;
}
fn apsOceanSmith(c:f32,alpha:f32)->f32 {return 1.0/max(c+sqrt(alpha*alpha*(1.0-c*c)+c*c),1e-6);}
fn apsOceanSpecular(N:vec3f,L:vec3f,V:vec3f,rough:f32,eta:f32)->vec3f {
 let nl=dot(N,L);let nv=dot(N,V);if(nl<=0.0||nv<=0.0){return vec3f(0);}
 let H=normalize(L+V);let nh=max(0.0,dot(N,H));let lh=max(0.0,dot(L,H));let alpha=max(0.001,rough*rough);let a2=alpha*alpha;
 let denom=(1.0-nh*nh)/a2+nh*nh;let D=1.0/(PI*a2*denom*denom);
 return vec3f(D*apsOceanSmith(nl,alpha)*apsOceanSmith(nv,alpha)*fresnelDielectric(lh,eta)*nl);
}
fn apsOceanFoamDirect(N:vec3f,L:vec3f,V:vec3f)->vec3f {
 let nl=dot(N,L);let nv=dot(N,V);if(nl<=0.0||nv<=0.0){return vec3f(0);}
 let H=normalize(L+V);let nh=max(0.0,dot(N,H));let lh=max(0.0,dot(L,H));let rough=0.78;let alpha=rough*rough;let a2=alpha*alpha;
 let fl=pow(1.0-nl,5.0);let fv=pow(1.0-nv,5.0);let fh=pow(1.0-lh,5.0);let fd90=0.5+2.0*rough*lh*lh;
 let diffuse=mix(1.0,fd90,fl)*mix(1.0,fd90,fv);
 let denom=(1.0-nh*nh)/a2+nh*nh;let D=1.0/(PI*a2*denom*denom);
 return (vec3f(0.98*diffuse/PI)+vec3f(D*apsOceanSmith(nl,alpha)*apsOceanSmith(nv,alpha)*mix(0.04,1.0,fh)))*nl;
}
fn apsOceanFoamEnvironment(N:vec3f,V:vec3f)->vec3f {
 let nv=max(0.0,dot(N,V));let dfg=DFGApprox(nv,0.78);let albedo=clamp(vec3f(0.04*dfg.x+dfg.y),vec3f(0),vec3f(1));
 return hookEnvSpecular(reflect(-V,N),0.78)*albedo+hookEnvDiffuse(N)*0.98*(1.0-albedo);
}
fn apsOceanReflection(N:vec3f,V:vec3f,rough:f32,variance:f32,thickness:f32,below:bool)->vec3f {
 let raw=reflect(-V,N);let r=pow(clamp(pow(rough,4.0)+4.0*variance,0.0,1.0),0.25);
 if(below){return hookEnvSpecular(raw,r);}
 let sigma=sqrt(max(0.0,variance));let horizon=normalize(vec3f(raw.x,0.004,raw.z));
 let sky=normalize(vec3f(raw.x,max(raw.y,0.004)+sigma*1.3*(1.0-max(raw.y,0.0)),raw.z));let thin=1.0-smoothstep(0.06,0.25,thickness);
 return mix(hookEnvSpecular(horizon,r)*0.35,hookEnvSpecular(sky,r),max(smoothstep(-0.12,0.08,raw.y),thin));
}
fn apsOceanWaterTransport(P:vec3f,N:vec3f,V:vec3f,direction:vec3f,medium:OceanSurfaceMedium,sunLight:vec3f,receiver:APSOceanRay)->vec3f {
 let absorb=medium.absorb;let scatter=medium.scatter;let extinction=absorb+scatter;let path=receiver.path;
 let trans=exp(-extinction*path);let sky=hookEnvDiffuse(vec3f(0,1,0));let L=normalize(frame.sunDir);let Ls=-refract(-L,vec3f(0,1,0),1.0/1.333);
 let muS=max(Ls.y,0.1);let muV=max(-direction.y,0.15);let phase=0.7*waterPhaseHG(dot(direction,Ls),0.86)+0.3/(4.0*PI);
 let bb=scatter*medium.backscatter;let ms=1.32*bb/max(absorb+bb,vec3f(1e-5));
 let kSun=extinction*(1.0+muV/muS);let kAmb=extinction*(1.0+muV/0.75);let sunIn=sunLight*(1.0-fresnelDielectric(max(L.y,0.02),1.333));
 let inSun=sunIn*(scatter*phase+ms*extinction/PI)*(1.0-exp(-kSun*path))/max(kSun,vec3f(1e-5));
 let inAmb=sky*(scatter*0.25+ms*extinction)*(1.0-exp(-kAmb*path))/max(kAmb,vec3f(1e-5));
 let vH=normalize(V.xz+vec2f(1e-5));let lH=normalize(L.xz+vec2f(1e-5));let back=pow(clamp(dot(vH,-lH)*0.6+0.4,0.0,1.0),2.5);
 let crest=clamp((P.y-frame.seaLevel)*0.9+0.1,0.0,1.0)*(clamp((1.0-N.y)*4.0,0.0,1.0)+0.25);
 let sss=sunIn*vec3f(0.12,0.55,0.45)*0.06*back*crest*smoothstep(0.0,0.25,L.y);
 return receiver.radiance*trans+inSun+inAmb+sss;
}
fn apsOceanTransmission(P:vec3f,N:vec3f,V:vec3f,direction:vec3f,medium:OceanSurfaceMedium,sunLight:vec3f,below:bool)->vec3f {
 if(dot(direction,direction)<1e-8){return vec3f(0);}
 let receiver=apsOceanSceneTrace(P+direction*0.0005,direction,below);
 if(below) {
  var incoming=receiver.radiance*receiver.coverage;
  if(receiver.coverage<=1e-6){incoming=skyReflectionRadiance(direction)*frame.envIntensity+skySunDisk(direction)*apsCloudSunVisibility(P);}
  return incoming;
 }
 let straight=apsOceanUndistortedReceiver(P);
 // Confidence selects receiver colour only. The water between the interface
 // and receiver is one medium: fixed straight-view thickness, current Snell
 // direction, and a single sun/ambient scattering evaluation across fallback.
 let colour=apsOceanTransmissionBlend(vec3f(0),straight.radiance,straight.coverage,receiver.radiance,receiver.coverage);
 let opticalReceiver=APSOceanRay(colour,1.0,straight.path);
 return apsOceanWaterTransport(P,N,V,direction,medium,sunLight,opticalReceiver);
}
`;

export function oceanOpticalOutput({T,SH,REFL},cameraHeight) {return           `
 let pos=in.P;let lagXZ=in.vs.vLagXZ;let screenUV=in.pixel*frame.invResolution;
 let footprint=max(1e-4,max(max(length(dpdx(lagXZ)),length(dpdy(lagXZ))),max(length(dpdx(pos)),length(dpdy(pos)))));
 let simState=shoreSimSample(pos.xz);
 let surf=waterSurfaceFragment(lagXZ,footprint,in.vs.vSeaDepth,in.vs.vFoam,in.vs.vShoreN,in.vs.vShoreFoam,simState.x,simState,in.vs.vSurfMask,pos);
 let bedGap=pos.y-oceanBed(pos.xz);let edgeWidth=max(0.0001,fwidth(bedGap));
 ${T&&SH?'let dryFront=oceanDryShoreFront(pos.xz);let frontWidth=max(.003,fwidth(dryFront.x));':''}
 let wetCoverage=${T&&SH?'smoothstep(-edgeWidth,edgeWidth,bedGap-0.0001)*oceanAnimatedShoreCoverage(pos.xz,footprint,frontWidth)':'1.0'};
 let V=normalize(frame.cameraPos-pos);let L=normalize(frame.sunDir);let below=frame.cameraPos.y<${cameraHeight};
 // The vertex normal follows the displaced macro surface, including shore film.
 // Orient that reference first; fine FFT/foam normals must keep its hemispheres.
 let geometrySide=select(normalize(in.vs.vShoreN),-normalize(in.vs.vShoreN),below);
 let face=select(1.0,-1.0,dot(geometrySide,V)<0.0);let geomN=geometrySide*face;
 let nUp=normalize(surf.normal);let nSide=select(nUp,-nUp,below)*face;
 let N=apsConsistentNormal(nSide,geomN,V,L);
 let foamSide=select(surf.foamNormal,-surf.foamNormal,below)*face;
 let foamN=apsConsistentNormal(normalize(foamSide),geomN,V,L);
 let foam=surf.foam;let variance=oceanUnresolvedVariance(lagXZ,footprint);
 let pixelVariance=0.5*(dot(dpdx(nUp),dpdx(nUp))+dot(dpdy(nUp),dpdy(nUp)));
 let rough=pow(min(0.0625,pow(mat.waterRoughness,4.0)+0.25*variance+pixelVariance*0.5),0.25);
 let eta=select(1.333,1.0/1.333,below);let boundary=apsOceanInterface(N,V,below);let F=boundary.reflectance;
 var sunLight=frame.sunColor*sunShadowPCF(pos,vec3f(0,1,0),in.pixel)*apsCloudSunVisibility(pos);
 let direct=mix(apsOceanSpecular(N,L,V,rough,eta),apsOceanFoamDirect(foamN,L,V),foam)*sunLight;
 var reflected=apsOceanReflection(N,V,rough,variance,max(0.0,bedGap),below);
 ${REFL?`if(mat.ssr>.5&&F>0.001&&foam<.999){let screen=oceanReflectionWorldSample(pos,boundary.reflection,rough,footprint);reflected=mix(reflected,screen.rgb,screen.a);}`:''}
 let waterIBL=reflected*F*(1.0-foam);let foamIBL=apsOceanFoamEnvironment(foamN,V)*foam;let indirect=waterIBL+foamIBL;
 var transmission=vec3f(0);
 if(F<1.0&&foam<1.0){transmission=apsOceanTransmission(pos,N,V,boundary.transmission,surf.medium,sunLight,below)*(1.0-F)*(1.0-foam);}
 var radiance=direct+indirect+transmission;
 // Public diagnostic numbers follow the accepted APS implementation.
 if(mat.debugMode==1){radiance=N*0.5+0.5;}
 if(mat.debugMode==2){radiance=indirect;}
 if(mat.debugMode==3){radiance=transmission;}
 if(mat.debugMode==4){radiance=vec3f(foam);}
 if(mat.debugMode==6){radiance=vec3f(wetCoverage);}
 if(mat.debugMode==7){radiance=vec3f(rough*2.0);}
 if(mat.debugMode==8){radiance=direct;}
 if(mat.debugMode==9){radiance=indirect+transmission;}
 if(mat.debugMode==10){radiance=vec3f(dot(sunLight,vec3f(0.3,0.6,0.1))/max(1e-5,dot(frame.sunColor,vec3f(0.3,0.6,0.1))));}
 if(mat.debugMode==11){let jac=oceanSurfaceJacobian(lagXZ,footprint);radiance=select(vec3f(0.005),apsOceanJacobianColor(jac),jac>0.0&&jac<1.0);}
 if(mat.debugMode==5){discard;}
 ${T&&SH?'if(bedGap < -edgeWidth||wetCoverage<=0.0){discard;}':''}
 if(mat.debugMode==0){radiance=mix(textureSampleLevel(waterSceneColor,smpLinearClamp,screenUV,0.0).rgb,radiance,wetCoverage);}
 r.color=vec4f(radiance,1.0);r.mask=vec4f(select(0.0,1.0,below)*wetCoverage,wetCoverage,0.0,wetCoverage);
`;}
