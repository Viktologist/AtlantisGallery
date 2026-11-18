                                                                                 
export const OCEAN_SHORE_FILM_WGSL=        `
struct OceanShoreFilm {front:f32,coverage:f32,depth:f32,birth:f32,band:f32};
fn oceanFilmCycle(time:f32,along:f32)->f32 {return 0.5-0.5*cos(6.28318530718*(time/8.0-along*0.013));}
fn oceanFilmChartWeight(phase:f32)->f32 {return 0.5-0.5*cos(6.28318530718*phase);}
fn oceanFilmDepth(coverage:f32,pulse:f32,cycle:f32,ripple:f32)->f32 {
 return coverage*clamp((0.001+0.018*cycle+0.006*max(0.0,ripple))*(0.2+0.8*pulse),0.0,0.025);
}
fn oceanFilmBirth(coverage:f32,front:f32,cycle:f32,crest:f32,uprush:f32)->f32 {
 let edge=1.0-smoothstep(0.025,0.09,abs(front));
 return coverage*edge*(0.9*(0.15+0.85*cycle)*smoothstep(0.0,0.025,crest)+0.5*uprush);
}
fn oceanShoreFilmAt(p:vec2f,footprint:f32)->OceanShoreFilm {
 var o:OceanShoreFilm;if(shoreP.enabled==0u||shoreP.hs<=1e-6||!oceanBedKnown(p)){return o;}
 let ground=oceanBed(p)-frame.seaLevel;let coast=oceanFieldAt(p,1);let field=oceanFieldAt(p,0);
 if(ground<=-0.15||coast.a<=0.02||coast.x>=48.0||length(field.yz)<1e-5||length(coast.yz)<0.1){return o;}
 let dir=normalize(field.yz);let exposure=length(field.yz)*smoothstep(-0.15,0.6,-dot(dir,normalize(coast.yz)));
 let coupling=oceanFieldAt(p,2);let event=oceanSwashEvent(field.x,field.a,coupling,ground,exposure);
 let gradient=vec2f(oceanBed(p+vec2f(1,0))-oceanBed(p-vec2f(1,0)),oceanBed(p+vec2f(0,1))-oceanBed(p-vec2f(0,1)))*0.5;
 let gentle=1.0-smoothstep(0.25,0.45,length(gradient));
 o.band=smoothstep(-0.15,-0.025,ground)*smoothstep(0.02,0.8,coast.a)*(1.0-smoothstep(36.0,48.0,max(0.0,coast.x)))*gentle*clamp(exposure,0.0,1.0);
 if(o.band<=1e-6){return o;}
 let velocity=dir*clamp(event.rate/max(0.04,abs(dot(gradient,dir))),-1.5,1.5);
 // Two overlapping 8s charts advect real FFT samples, fading out at wrap.
 // Only the shortest two existing bands contribute. The spectrum is unchanged.
 var shortHeight=0.0;
 for(var i=0;i<2;i++){
  let phase=fract(shoreP.time/8.0+f32(i)*0.5);let weight=oceanFilmChartWeight(phase);
  let q=p-velocity*8.0*(phase-0.5);
  for(var c=2;c<4;c++){
   let sample=textureSampleLevel(oceanDisplacement,smpLinearRepeat,oceanUv(q,c),c,oceanLod(max(0.06,footprint),c));
   shortHeight+=sample.y*weight*select(0.22,1.0,c==3);
  }
 }
 let ripple=tanh(shortHeight/0.025);let cycle=oceanFilmCycle(shoreP.time,coupling.x);
 o.front=event.surface.x+0.04*ripple+0.025*(cycle-0.5)-ground;
 o.coverage=smoothstep(0.0,0.012,o.front);
 let pulse=oceanSwashPulse(event.phase,event.peak).x;
 o.depth=oceanFilmDepth(o.coverage,pulse,cycle,ripple);
 o.birth=oceanFilmBirth(o.coverage,o.front,cycle,max(0.0,shortHeight),event.surface.w);
 return o;
}
fn oceanAnimatedShoreCoverage(p:vec2f,footprint:f32,width:f32)->f32 {
 let original=oceanDryFrontCoverage(oceanDryShoreFront(p),width);let film=oceanShoreFilmAt(p,footprint);
 return mix(original,smoothstep(0.0,max(0.012,width),film.front),film.band);
}
`;
