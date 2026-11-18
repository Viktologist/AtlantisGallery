                                                                           
export const FILM_WHITEWATER_WGSL=        `
fn oceanFilmFFTCompression(dx:f32,dz:f32,cross:f32)->f32 {
 return clamp(1.0-((1.0+dx)*(1.0+dz)-cross*cross),0.0,1.0);
}
fn oceanFilmChartStretch(age:f32,xx:f32,xz:f32,zx:f32,zz:f32)->f32 {
 // Largest singular value of I - age * grad(velocity). Never underfilter
 // the original page footprint even while the advected chart compresses.
 let tx=1.0-age*xx;let tz=1.0-age*zz;let cx=-age*xz;let cz=-age*zx;
 let a=tx*tx+cx*cx;let b=tx*cz+cx*tz;let c=cz*cz+tz*tz;
 return max(1.0,sqrt(0.5*(a+c+sqrt(max(0.0,(a-c)*(a-c)+4.0*b*b)))));
}
fn oceanFilmWhitewaterRate(coverage:f32,depth:f32,front:f32,cycle:f32,speed:f32,compression:f32,curl:f32,noise:f32)->f32 {
 let wet=coverage*smoothstep(0.0007,0.004,depth);
 let moving=smoothstep(0.04,0.65,abs(speed));
 let squeeze=smoothstep(0.004,0.14,compression);
 let eddy=smoothstep(0.03,0.9,abs(curl));
 let patches=smoothstep(0.22,0.75,noise);
 let edge=0.4+0.6*(1.0-smoothstep(0.035,0.15,abs(front)));
 return wet*clamp(edge*(0.45+0.55*cycle)*(0.4+1.1*patches)*(1.1*moving+3.4*squeeze+1.6*eddy+0.7*moving*patches),0.0,4.8);
}
fn oceanFilmWhitewaterFFT(p:vec2f,footprint:f32,velocity:vec2f,flowDx:vec2f,flowDz:vec2f)->vec2f {
 var dx=0.0;var dz=0.0;var cross=0.0;var fftVelocity=vec2f(0);
 // Same short bands and smooth advected charts as the wet-film front.
 // Read actual horizontal derivatives; dry-bed attenuation would erase them.
 for(var i=0;i<2;i++){
  let phase=fract(shoreP.time/8.0+f32(i)*0.5);let weight=oceanFilmChartWeight(phase);
  let age=8.0*(phase-0.5);let q=p-velocity*age;
  let chartFootprint=footprint*oceanFilmChartStretch(age,flowDx.x,flowDx.y,flowDz.x,flowDz.y);
  for(var c=2;c<4;c++){
   let uv=oceanUv(q,c);let lod=oceanLod(max(0.06,chartFootprint),c);let gain=weight*select(0.22,1.0,c==3);
   let d=textureSampleLevel(oceanDerivatives,smpLinearRepeat,uv,c,lod);
   let x=textureSampleLevel(oceanCross,smpLinearRepeat,uv,c,lod).x;
   dx+=d.z*ocean.choppiness*gain;dz+=d.w*ocean.choppiness*gain;cross+=x*ocean.choppiness*gain;
   fftVelocity+=textureSampleLevel(oceanVelocity,smpLinearRepeat,uv,c,lod).xz*(ocean.choppiness*gain);
  }
 }
 return vec2f(oceanFilmFFTCompression(dx,dz,cross),length(fftVelocity));
}
fn oceanFilmWhitewaterSource(p:vec2f,film:OceanShoreFilm,footprint:f32)->f32 {
 if(film.band*film.coverage<=1e-6){return 0.0;}
 let velocity=oceanPageFlow(p).xy;
 let e=max(0.25,oceanPageCell(p));let ex=vec2f(e,0);let ez=vec2f(0,e);
 let dx=(oceanPageFlow(p+ex).xy-oceanPageFlow(p-ex).xy)/(2.0*e);
 let dz=(oceanPageFlow(p+ez).xy-oceanPageFlow(p-ez).xy)/(2.0*e);
 let drivers=oceanFilmWhitewaterFFT(p,footprint,velocity,dx,dz);
 let curl=dx.y-dz.x;var noise=0.0;
 let anchor=p-shoreP.domain.xy-shoreP.domain.zw*0.5;
 for(var i=0;i<2;i++){
  let phase=fract(shoreP.time/8.0+f32(i)*0.5);let weight=oceanFilmChartWeight(phase);
  let age=8.0*(phase-0.5);let q=(anchor-velocity*age)/1.15;
  let chartFootprint=footprint*oceanFilmChartStretch(age,dx.x,dx.y,dz.x,dz.y);
  noise+=oceanFbm(q+vec2f(17.3,43.1),chartFootprint/1.15)*weight;
 }
 let cycle=oceanFilmCycle(shoreP.time,oceanFieldAt(p,2).x);
 let generated=oceanFilmWhitewaterRate(film.coverage,film.depth,film.front,cycle,length(velocity)+drivers.y,drivers.x,curl,noise);
 // Existing front births grow 2.6x. Interior patches require motion,
 // compression or curl; noise alone cannot paint whitewater on still sand.
 return film.band*min(6.0,2.6*film.birth+generated);
}
`;
