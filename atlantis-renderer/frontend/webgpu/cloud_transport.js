                                                                     
export const JOINT_SKY_WGSL =           `
fn apsSkyDensity(h0:f32)->vec3f {let h=max(h0,0.0);return vec3f(exp(-h/8000.0)*cloudParams.rayleigh,exp(-h/1200.0)*cloudParams.mie,max(0.0,1.0-abs(h-25000.0)/15000.0));}
fn apsSkyExtinction(d:vec3f)->vec3f {return vec3f(5.802,13.558,33.100)*1e-6*d.x+vec3f(4.440e-6*d.y)+vec3f(.650,1.881,.085)*1e-6*d.z;}
fn apsSkySolar(p:vec3f)->vec3f {
 if(apsCloudSphere(p,cloudParams.sun,6360000.0).x>0.0){return vec3f(0);}
 let distance=max(0.0,apsCloudSphere(p,cloudParams.sun,6460000.0).y);var optical=vec3f(0);
 for(var i=0;i<12;i++){let a=f32(i)/12.0;let b=f32(i+1)/12.0;
 optical+=apsSkyExtinction(apsSkyDensity(apsCloudAltitude(p+cloudParams.sun*distance*.5*(a*a+b*b))))*distance*(b*b-a*a);}
 return exp(-optical);
}
fn apsSkyHG(mu:f32,g:f32)->f32 {return (1.0-g*g)/(4.0*PI*pow(max(1.0+g*g-2.0*g*mu,.001),1.5));}
fn labSunTau(P:vec3f,jitter:f32)->f32 {
 let span=apsCloudInterval(P,cloudParams.sun);let length=min(24000.0,max(0.0,span.y));var tau=0.0;
 for(var i=0;i<16;i++){
  let a=f32(i)/16.0;let b=f32(i+1)/16.0;let ds=length*(b*b-a*a);
  tau+=apsCloudDensity(P+cloudParams.sun*length*mix(a*a,b*b,jitter))*ds*.0015;
 }
 return tau;
}
struct APSSkyState {T:vec3f,L:vec3f,cloudT:f32,depthWeight:f32,airL:vec3f}
struct LabSkySample {color:vec4f,depth:f32}
fn apsSkyTransportStep(p:vec3f,d:vec3f,t:f32,ds:f32,jitter:f32,hasCloud:bool,includeAir:bool,visibility:f32,state:ptr<function,APSSkyState>){
 let point=p+d*t;let density=select(vec3f(0),apsSkyDensity(apsCloudAltitude(point)),includeAir);let world=point+vec3f(0,cloudParams.ground,0);
 var cloud=0.0;if(hasCloud){cloud=apsCloudDensity(world)*.0015;}
 let mu=dot(d,cloudParams.sun);let solar=apsSkySolar(point)*cloudParams.solar;
 var cloudSun=1.0;var tau=0.0;
 if(cloud>1e-7){tau=labSunTau(world,jitter);cloudSun=exp(-tau);}
 let localUp=normalize(point+vec3f(0,6360000,0));
 let multiple=atmosphereSampleMultiScat((6360000.0+apsCloudAltitude(point))*.001,dot(localUp,cloudParams.sun))*cloudParams.solar;
 let scattering=vec3f(5.802,13.558,33.100)*1e-6*density.x+vec3f(3.996e-6*density.y);
 // The LUT contains unit-solar isotropic radiance. Convert km only at lookup;
 // the local scattering coefficient remains per metre. Shadows affect direct light.
 let airSource=solar*(vec3f(5.802,13.558,33.100)*1e-6*density.x*3.0*(1.0+mu*mu)/(16.0*PI)+vec3f(3.996e-6*density.y*apsSkyHG(mu,.8)))*visibility+multiple*scattering;
 var source=airSource;
 if(cloud>0.0){
  // Himalayas' forward/backward lobes reveal lit billow rims from both sides
  // of the sun. Keep normalized HG functions and our actual solar transport.
  let phase=.5*apsSkyHG(mu,.8)+.5*apsSkyHG(mu,-.2);
  // Two attenuated scattering orders: bounded approximation, not path tracing.
  let scattered=phase*cloudSun+.35*apsSkyHG(mu,.3)*exp(-tau*.45)+.12/(4.0*PI)*exp(-tau*.2);
  let ambient=apsCloudIncidentDaylight();
  source+=cloud*(solar*scattered*visibility+ambient);
 }
 let extinction=apsSkyExtinction(density)+vec3f(cloud);let optical=extinction*ds;let stepT=exp(-optical);
 let integral=select((vec3f(1)-stepT)/max(extinction,vec3f(1e-10)),vec3f(ds)*(1.0-optical*.5),optical<vec3f(.001));
 (*state).airL+=(*state).T*airSource*integral;(*state).L+=(*state).T*source*integral;(*state).T*=stepT;
 let nextT=(*state).cloudT*exp(-cloud*ds);(*state).depthWeight+=((*state).cloudT-nextT)*t;(*state).cloudT=nextT;
}
fn apsSkyStep(p:vec3f,d:vec3f,t:f32,ds:f32,jitter:f32,hasCloud:bool,state:ptr<function,APSSkyState>){
 apsSkyTransportStep(p,d,t,ds,jitter,hasCloud,true,1.0,state);
}
fn apsSkyAirSegment(p:vec3f,d:vec3f,a:f32,b:f32,state:ptr<function,APSSkyState>){
 for(var i=0;i<24;i++){let x=f32(i)/24.0;let y=f32(i+1)/24.0;
 let start=mix(a,b,x*x);let end=mix(a,b,y*y);apsSkyStep(p,d,(start+end)*.5,end-start,.5,false,state);}
}
fn labJointSky(origin:vec3f,d:vec3f,jitter:f32,budget:u32)->LabSkySample {
 let p=origin-vec3f(0,cloudParams.ground,0);var distance=max(0.0,apsCloudSphere(p,d,6460000.0).y);
 let ground=apsCloudSphere(p,d,6360000.0);let hitsGround=ground.x>0.0;if(hitsGround){distance=min(distance,ground.x);}
 let clouds=clamp(apsCloudInterval(origin,d),vec2f(0),vec2f(distance));var state=APSSkyState(vec3f(1),vec3f(0),1.0,0.0,vec3f(0));
 if(cloudParams.coverage<=0.0||clouds.y<=clouds.x){apsSkyAirSegment(p,d,0.0,distance,&state);}
 else{
  apsSkyAirSegment(p,d,0.0,clouds.x,&state);
  let length=min(clouds.y-clouds.x,80000.0);let count=clamp(u32(ceil(length/40.0)),64u,budget);
  for(var i=0u;i<count;i++){
   let a=f32(i)/f32(count);let b=f32(i+1u)/f32(count);
   let start=clouds.x+length*pow(a,1.35);let end=clouds.x+length*pow(b,1.35);
   apsSkyStep(p,d,mix(start,end,jitter),end-start,fract(jitter+.381966),true,&state);
   if(max(state.T.x,max(state.T.y,state.T.z))<.001){break;}
  }
  apsSkyAirSegment(p,d,clouds.x+length,distance,&state);
 }
 if(hitsGround){let hit=p+d*distance;let normal=normalize(hit+vec3f(0,6360000,0));let q=hit+normal*2.0;
  state.L+=state.T*vec3f(.18,.20,.16)*cloudParams.solar*apsSkySolar(q)*apsCloudSunVisibilityEnvironment(q+vec3f(0,cloudParams.ground,0))*max(dot(normal,cloudParams.sun),0.0)/PI;}
 let depth=select(100000.0,state.depthWeight/max(1.0-state.cloudT,.0001),state.cloudT<.999);
 return LabSkySample(vec4f(max(state.L,vec3f(0)),state.cloudT),depth);
}
fn apsJointSky(d:vec3f)->vec4f {return labJointSky(cloudParams.probe,d,.5,128u).color;}
`;

                                                                          
                                                                    
export const VIEW_TRANSPORT_WGSL=JOINT_SKY_WGSL+          `
struct APSViewTransport {L:vec3f,T:vec3f,air:vec3f,depth:f32,cloudT:f32}
fn apsViewStep(p:vec3f,d:vec3f,t:f32,ds:f32,jitter:f32,cloud:bool,air:bool,state:ptr<function,APSSkyState>){
 let world=apsEnvironmentWorldPoint(p+d*t+vec3f(0,cloudParams.ground,0));
 apsSkyTransportStep(p,d,t,ds,jitter,cloud,air,apsVolumeSunVisibility(world),state);
}
fn apsViewAirSegment(p:vec3f,d:vec3f,a:f32,b:f32,count:u32,air:bool,state:ptr<function,APSSkyState>){
 if(!air||b<=a||max((*state).T.x,max((*state).T.y,(*state).T.z))<.001){return;}
 let towardsGround=apsCloudAltitude(p+d*a)>apsCloudAltitude(p+d*b);
 for(var i=0u;i<count;i++){
  let x=f32(i)/f32(count);let y=f32(i+1u)/f32(count);
  let start=mix(a,b,select(x*x,1.0-(1.0-x)*(1.0-x),towardsGround));
  let end=mix(a,b,select(y*y,1.0-(1.0-y)*(1.0-y),towardsGround));
  apsViewStep(p,d,(start+end)*.5,end-start,.5,false,true,state);
 }
}
fn apsTraceViewTransport(origin:vec3f,d:vec3f,jitter:f32,budget:u32,sceneDistance:f32,sky:bool,airEnabled:bool)->APSViewTransport {
 let p=origin-vec3f(0,cloudParams.ground,0);let atmosphere=apsCloudSphere(p,d,6460000.0);
 var distance=max(0.0,atmosphere.y);if(!sky){distance=min(distance,max(0.0,sceneDistance));}
 let ground=apsCloudSphere(p,d,6360000.0);let hitsGround=sky&&ground.x>0.0;
 if(hitsGround){distance=min(distance,ground.x);}
 let start=min(distance,max(0.0,atmosphere.x));
 let clouds=clamp(apsCloudInterval(origin,d),vec2f(start),vec2f(distance));
 let air=sky||airEnabled;let airSteps=select(8u,24u,sky);
 var state=APSSkyState(vec3f(1),vec3f(0),1.0,0.0,vec3f(0));
 if(cloudParams.coverage<=0.0||cloudParams.density<=0.0||clouds.y<=clouds.x){apsViewAirSegment(p,d,start,distance,airSteps,air,&state);}
 else{
  apsViewAirSegment(p,d,start,clouds.x,airSteps,air,&state);
  // Distribute the bounded budget over the WHOLE visible cloud interval.
  // No 80km truncation followed by an incorrect clear-air tail.
  // Resolve the finer fringe with a smaller target step, keeping the existing
  // 64 minimum and hard camera budget. Long rays still stop at that budget.
  let length=clouds.y-clouds.x;let count=clamp(u32(ceil(length/32.0)),min(64u,budget),budget);
  for(var i=0u;i<count;i++){
   let a=f32(i)/f32(count);let b=f32(i+1u)/f32(count);
   let lo=clouds.x+length*pow(a,1.35);let hi=clouds.x+length*pow(b,1.35);
   apsViewStep(p,d,mix(lo,hi,jitter),hi-lo,fract(jitter+.381966),true,air,&state);
   if(max(state.T.x,max(state.T.y,state.T.z))<.001){break;}
  }
  apsViewAirSegment(p,d,clouds.y,distance,airSteps,air,&state);
 }
 if(hitsGround){let hit=p+d*distance;let normal=normalize(hit+vec3f(0,6360000,0));let q=hit+normal*2.0;
  state.L+=state.T*vec3f(.18,.20,.16)*cloudParams.solar*apsSkySolar(q)*apsCloudSunVisibilityEnvironment(q+vec3f(0,cloudParams.ground,0))*max(dot(normal,cloudParams.sun),0.0)/PI;}
 let fallback=select(sceneDistance,100000.0,sky);
 let depth=select(fallback,state.depthWeight/max(1.0-state.cloudT,.0001),state.cloudT<.999);
 return APSViewTransport(max(state.L,vec3f(0)),clamp(state.T,vec3f(0),vec3f(1)),max(state.airL,vec3f(0)),depth,state.cloudT);
}
`;
