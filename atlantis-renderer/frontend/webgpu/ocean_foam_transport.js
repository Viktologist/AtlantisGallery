import {FILM_WHITEWATER_WGSL} from './ocean_film_whitewater.js';
                                                                            
                                                                                 
export const FOAM_TRANSPORT_WGSL=        `
fn oceanShoreSpeedAt(p:vec2f)->f32 {
 let packed=oceanPageProfile(p);let support=oceanPageSupport(p);let ground=oceanBed(p)-frame.seaLevel;
 let cov=select(support.x,1.0,ground < -0.03);let d=packed.xyz/max(1e-6,support.x);
 let sh=oceanFieldAt(p,0);let dir=sh.yz/max(1e-5,length(sh.yz));let depth=max(0.0,-ground);let eta=d.y;
 var speed=clamp(sqrt(9.81*max(0.015,depth))*eta/(depth+max(eta,-depth*0.8)+0.15),-2.5,4.0);
 let coupling=oceanFieldAt(p,2);let coast=oceanFieldAt(p,1);
 var exposure=length(sh.yz);if(length(coast.yz)>0.1){exposure*=smoothstep(-0.15,0.6,-dot(dir,normalize(coast.yz)));}
 let event=oceanSwashEvent(sh.x,sh.a,coupling,ground,exposure);let sw=event.surface;let up=event.phase<event.peak;let dRdt=event.rate;
 let bedSlope=vec2f(oceanBed(p+vec2f(1,0))-oceanBed(p-vec2f(1,0)),oceanBed(p+vec2f(0,1))-oceanBed(p-vec2f(0,1)))*0.5;
 let inland=max(0.0,ground);let rel=clamp(inland/max(sw.x,0.5),0.0,1.0);
 // Swash run-up is a vertical height. Convert front motion to metric beach
 // speed using the actual slope before applying bounded backwash acceleration.
 let wash=clamp(dRdt/max(0.04,abs(dot(bedSlope,dir)))*select((1.0-rel)*0.6+0.9,clamp((inland+3.0)/(sw.x+3.0),0.15,1.0),up),-4.0,4.0);
 speed=mix(speed,wash,oceanSwashBlend(ground))*cov;
 let analytic=mix(speed,speed*1.6,oceanReturnMix(oceanPageWaterDepth(p),speed));
 return analytic;
}
fn oceanCompressionAxis(tx:vec3f,tz:vec3f)->vec3f {
 let a=dot(tx.xz,tx.xz);let b=dot(tx.xz,tz.xz);let c=dot(tz.xz,tz.xz);
 let root=sqrt(max(0.0,(a-c)*(a-c)+4.0*b*b));let lambda=max(0.0,0.5*(a+c-root));
 var axis=vec2f(b,lambda-a);if(dot(axis,axis)<1e-10){axis=select(vec2f(0,1),vec2f(1,0),a<=c);}else{axis=normalize(axis);}
 let j=tx.x*tz.z-tx.z*tz.x;let compression=(1.0-smoothstep(0.18,0.98,j))*(1.0-smoothstep(0.7,1.0,sqrt(lambda)));
 return vec3f(axis,compression);
}
fn oceanChoppyRelaxation(offset:vec2f,axis:vec2f,compression:f32)->vec2f {
 // metres / .8 seconds => m/s. Full offset provides crossing trajectories;
 // its most-compressed axis receives additional attraction, not a J mask fill.
 let v=(offset*0.65+axis*dot(offset,axis)*(0.85*compression))/0.8;
 return v*(3.0/max(3.0,length(v)));
}
fn oceanReturnDiffusivity(returnMix:f32)->vec2f {
 // m²/s: along filament, across filament. Avoid the former .45m²/s flattening.
 return vec2f(0.012+0.025*returnMix,0.002+0.004*returnMix);
}
fn oceanDiffusionMix(diffusivity:vec2f,dt:f32,cell:f32)->f32 {
 return 1.0-exp(-2.0*(diffusivity.x+diffusivity.y)*dt/(cell*cell));
}
`;

export const FOAM_SOURCE_WGSL=        `
${FILM_WHITEWATER_WGSL}
fn oceanLocalFoamSource(p:vec2f,speed:f32,seed:f32)->f32 {
 // Wet-film whitewater responds to speed, actual short FFT compression/curl
 // and filtered moving noise. History still uses the existing RK2 transport.
 let beach=oceanBeachFoamBlend(p);let footprint=max(0.06,oceanPageCell(p)*0.5);let film=oceanShoreFilmAt(p,footprint);
 let filmBirth=oceanFilmWhitewaterSource(p,film,footprint);
 if(beach>=1.0){return filmBirth;}
 let packed=oceanPageProfile(p);let support=oceanPageSupport(p);let ground=oceanBed(p)-frame.seaLevel;
 let cov=select(support.x,1.0,ground < -0.03);let returnMix=oceanReturnMix(oceanPageWaterDepth(p),speed);
 let compression=clamp(length(oceanPageFlow(p).zw),0.0,1.0);let moving=smoothstep(0.15,1.2,abs(speed));
 let sh=oceanFieldAt(p,0);let crestAge=fract((shoreP.time-sh.x)/shoreP.period+0.5)-0.5;
 let trailing=smoothstep(0.005,0.035,crestAge)*(1.0-smoothstep(0.25,0.45,crestAge));let seeded=smoothstep(0.02,0.18,seed);
 let wake=0.35*support.z*trailing*seeded*(1.0-returnMix);
 // Direct breaking/compression creates foam even when history is zero.
 // Only the trailing wake requires a previous foam seed. No water state.
 return 6.3*cov*moving*(0.08+1.75*support.a*support.a)*(packed.a*0.65+wake+support.z*compression)*(1.0-beach)+filmBirth;
}
`;
export const FOAM_ADVANCE_WGSL=        `
${FOAM_SOURCE_WGSL}
fn velocityAt(p:vec2f)->vec2f{return oceanPageFlow(p).xy;}
fn oceanDiffuseFoam(back:vec2f,axis:vec2f,dt:f32,cell:f32,returnMix:f32,advected:f32)->f32 {
 let along=vec2f(-axis.y,axis.x)*cell;let across=axis*cell;let D=oceanReturnDiffusivity(returnMix);
 var sum=0.0;var weight=0.0;
 for(var k=0;k<4;k++){
  var offset=along;var coefficient=D.x;if(k==1){offset=-along;}if(k==2){offset=across;coefficient=D.y;}if(k==3){offset=-across;coefficient=D.y;}
  let q=back+offset;let history=shoreSimSample(q);let waterWet=smoothstep(0.002,0.025,oceanPageWaterDepth(q))*oceanPageSupport(q).x;
  // The wet beach film still diffuses after the moving water edge has returned.
  let wet=mix(waterWet,history.y,oceanBeachFoamBlend(q));
  sum+=history.x*coefficient*wet;weight+=coefficient*wet;
 }
 if(weight<=1e-6){return advected;}return mix(advected,sum/weight,oceanDiffusionMix(D,dt,cell));
}
fn oceanAdvanceFoam(p:vec2f,cell:f32)->vec4f {
 let dt=shoreP.dt;let packed=oceanPageProfile(p);let support=oceanPageSupport(p);let ground=oceanBed(p)-frame.seaLevel;
 let cov=select(support.x,1.0,ground < -0.03);let d=packed.xyz/max(1e-6,support.x);let speed=oceanShoreSpeedAt(p);
 let here=shoreSimSample(p);let mid=p-velocityAt(p)*dt*0.5;let vel=velocityAt(mid);let back=p-vel*dt;var prev=shoreSimSample(back);
 let ex=vec2f(cell,0);let ez=vec2f(0,cell);let waterDepth=oceanPageWaterDepth(p);let returnMix=oceanReturnMix(waterDepth,speed);
 let flow=oceanPageFlow(p);let compression=clamp(length(flow.zw),0.0,1.0);var axis=flow.zw;
 if(length(axis)<1e-5){let field=oceanFieldAt(p,0);axis=field.yz/max(1e-5,length(field.yz));if(length(axis)<0.1){axis=vec2f(1,0);}}else{axis=normalize(axis);}
 prev.x=oceanDiffuseFoam(back,axis,dt,cell,returnMix,prev.x);
 let div=clamp((velocityAt(mid+ex).x-velocityAt(mid-ex).x+velocityAt(mid+ez).y-velocityAt(mid-ez).y)/(2.0*cell),-3.0,3.0);
 let life=mix(pageP.life.x,pageP.life.y,smoothstep(-0.35,-0.05,ground));
 let film=oceanShoreFilmAt(p,max(0.06,cell*0.5));
 let retained=clamp(prev.x*exp(-dt*(1.0/life+div+film.band/2.5)),0.0,1.0);
 let gen=oceanLocalFoamSource(p,speed,max(here.x,prev.x));
 let foam=1.0-(1.0-retained)*exp(-gen*dt);let wet=max(here.y*exp(-dt/28.0),cov);let stranded=min(here.x*2.4,1.0)*(1.0-cov)*(1.0-exp(-dt*30.0));
 let residue=max(here.z*exp(-dt*mix(0.2,9.75113577,cov)),stranded)*(1.0-oceanBeachFoamBlend(p));return vec4f(foam,wet,residue,speed);
}
`;
