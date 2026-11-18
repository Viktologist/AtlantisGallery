                                                                                      
export const OCEAN_FOAM_WGSL =           `
fn oceanPerlinCorner(p:vec2f)->vec2f {let a=6.28318530718*fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);return vec2f(cos(a),sin(a));}
fn oceanPerlinGradient(p:vec2f)->vec2f {
 let i=floor(p);let f=fract(p);let u=f*f*f*(f*(f*6.0-15.0)+10.0);let du=30.0*f*f*(f-1.0)*(f-1.0);
 let a=oceanPerlinCorner(i);let b=oceanPerlinCorner(i+vec2f(1.0,0.0));let c=oceanPerlinCorner(i+vec2f(0.0,1.0));let d=oceanPerlinCorner(i+1.0);
 let na=dot(a,f);let nb=dot(b,f-vec2f(1.0,0.0));let nc=dot(c,f-vec2f(0.0,1.0));let nd=dot(d,f-1.0);
 return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)+vec2f(du.x*mix(nb-na,nd-nc,u.y),du.y*(mix(nc,nd,u.x)-mix(na,nb,u.x)));
}
fn oceanWarpStrength(depth:f32,speed:f32)->f32 {return smoothstep(0.12,0.6,depth)*mix(0.7,1.0,smoothstep(0.1,0.9,abs(speed)));}
fn oceanReturnMix(depth:f32,speed:f32)->f32 {return (1.0-smoothstep(0.06,0.35,depth))*(1.0-smoothstep(-0.35,-0.03,speed));}
fn oceanSimplexGradient(cell:vec2f)->vec2f {var h=fract(vec3f(cell.x,cell.y,cell.x)*vec3f(0.1031,0.103,0.0973));h+=dot(h,h.yxz+33.33);let g=fract((h.xx+h.yz)*h.zy)*2.0-1.0;return normalize(g+vec2f(0.0001,0.0));}
fn oceanWarpNoise(p:vec2f)->f32 {
 let i=floor(p+(p.x+p.y)*0.366025403784);let a=p-i+(i.x+i.y)*0.211324865405;
 let corner=select(vec2f(0.0,1.0),vec2f(1.0,0.0),a.x>a.y);let b=a-corner+0.211324865405;let c=a-1.0+2.0*0.211324865405;
 var w=max(vec3f(0.5)-vec3f(dot(a,a),dot(b,b),dot(c,c)),vec3f(0.0));w*=w;w*=w;
 return 0.5+30.0*dot(w,vec3f(dot(oceanSimplexGradient(i),a),dot(oceanSimplexGradient(i+corner),b),dot(oceanSimplexGradient(i+1.0),c)));
}
fn oceanFbm(p0:vec2f,footprint0:f32)->f32 {
 var p=p0;var footprint=footprint0;var value=0.0;var amp=0.5333333;
 for(var i=0;i<4;i++){value+=amp*mix(0.5,oceanWarpNoise(p),1.0-smoothstep(0.2,0.65,footprint));p=mat2x2f(0.8,0.6,-0.6,0.8)*p*2.03+vec2f(17.3,9.2);footprint*=2.03;amp*=0.5;}return value;
}
fn oceanDomainWarp(p:vec2f,footprint:f32,strength0:f32)->vec2f {
 let strength=clamp(strength0,0.0,1.0);if(strength<=1e-6){return p;}
 let q=vec2f(oceanFbm(p,footprint),oceanFbm(p+vec2f(13.7,7.9),footprint))-0.5;let wf=footprint*mix(1.0,3.7,strength);
 let r=vec2f(oceanFbm(p+q*(2.7*strength)+vec2f(5.1,19.3),wf),oceanFbm(p+q*(2.7*strength)+vec2f(27.8,3.2),wf))-0.5;
 return p+(q*1.6+r*3.6)*strength;
}
fn oceanFoamChart(anchor:vec2f,footprint:f32,strength:f32)->vec2f {
 let warped=oceanDomainWarp(anchor/2.4+vec2f(0.025,-0.019)*shoreP.time,footprint/2.4,strength)*2.4;
 let d=normalize(shoreP.incident+vec2f(1e-6,0.0));return vec2f(dot(warped,d)/3.0,dot(warped,vec2f(-d.y,d.x)))/0.8;
}
fn oceanFoamConcentration(p:vec2f,footprint:f32,strength:f32)->f32 {
 let anchor=p-shoreP.domain.xy-shoreP.domain.zw*0.5;let q=oceanFoamChart(anchor,footprint,strength);
 return smoothstep(0.28,0.72,oceanFbm(q+vec2f(9.8,31.2),footprint/0.8*mix(1.0,2.0,strength)));
}
fn oceanBeachFoamBlend(p:vec2f)->f32 {
 if(!oceanBedKnown(p)){return 0.0;}
 // Only the sheet ON land. No submerged swash/breaker region is selected.
 return smoothstep(0.0,0.03,oceanBed(p)-frame.seaLevel);
}
// PAGE_DEPENDENT
fn oceanPageWaterDepth(p:vec2f)->f32 {let s=oceanPageSupport(p);let d=oceanPageProfile(p);return max(0.0,frame.seaLevel+select(0.0,d.y/max(1e-6,s.x),s.x>1e-6)-oceanBed(p));}
fn oceanFoamVelocity(p:vec2f,direction:vec2f,speed:f32,wake:f32)->vec2f {
 return oceanPageFlow(p).xy;
}
`;

export const OCEAN_FOAM_SURFACE_WGSL =           `
struct OceanFoamFilm { coverage:f32,relief:f32 };
fn oceanShoreFoamStructure(p:vec2f,velocity:vec2f,density:f32,footprint:f32,strength:f32,returnMix:f32)->f32 {
 let anchor=p-shoreP.domain.xy-shoreP.domain.zw*0.5;var structure=0.0;
 for(var i=0;i<2;i++){
  let phase=fract(shoreP.time/8.0+f32(i)*0.5);let weight=1.0-abs(phase*2.0-1.0);
  let warped=oceanFoamChart(anchor-velocity*8.0*(phase-0.5),footprint,strength);
  let fp=max(footprint/0.8,max(length(dpdx(warped)),length(dpdy(warped))));
  let film=oceanFbm(warped+vec2f(23.1,4.7),fp);let threshold=mix(0.6,0.34,smoothstep(0.03,0.68,density));let aa=max(0.055,fwidth(film));
  var coverage=smoothstep(threshold-aa,threshold+aa,film);coverage=mix(coverage,smoothstep(0.08,0.65,density)*0.58,smoothstep(0.15,0.65,fp*0.8));structure+=coverage*weight;
 }return structure;
}
fn oceanFoamFilm(p:vec2f,base:vec2f,fftDensity:f32,surfDensity:f32,footprint:f32,jac:f32,worldY:f32)->OceanFoamFilm {
 let beach=oceanBeachFoamBlend(p);
 let shoreFilm=oceanShoreFilmAt(p,footprint);
 let filmCover=shoreFilm.coverage*shoreFilm.band;
 if(max(fftDensity,surfDensity)<1e-6){return OceanFoamFilm(0.0,0.0);}
 let capMask=select(0.0,1.0-smoothstep(0.0,0.5,jac),jac>0.0&&jac<0.5);
 let shoreDetail=smoothstep(0.0,max(0.025,fwidth(jac)),jac)*(1.0-smoothstep(0.0,0.99,jac));let capFilm=capMask*clamp(fftDensity*8.0,0.0,1.0);
 var velocity=ocean.wind;var warpSpeed=length(velocity);var signedSpeed=warpSpeed;
 let field=oceanFieldAt(base,0);let support=oceanPageSupport(base);let memory=shoreSimSample(base);
 if(oceanPageId(base)>=0){warpSpeed=abs(memory.a);signedSpeed=memory.a;let eddySupport=max(support.z,support.x*min(1.0,memory.x*2.0));
  if(length(field.yz)>1e-5){velocity=mix(velocity,oceanFoamVelocity(base,normalize(field.yz),memory.a,eddySupport),support.x);}}
 let waterDepth=max(0.0,worldY-oceanBed(p));let returnMix=oceanReturnMix(waterDepth,signedSpeed);let strength=max(oceanWarpStrength(waterDepth,warpSpeed),returnMix*0.9);
 var surfCoverage=0.0;if(surfDensity>1e-6){let sheet=oceanShoreFoamStructure(p,velocity,surfDensity,footprint,strength,returnMix);let filament=pow(clamp(shoreDetail,0.0,1.0),0.65);let body=mix(0.22,0.65,smoothstep(0.08,0.55,surfDensity));
 let film=max(sheet*(body+(1.0-body)*filament),0.85*filament);surfCoverage=(1.0-exp(-5.0*surfDensity))*film;}
 var coverage=max(surfCoverage,capFilm*smoothstep(0.025,0.16,fftDensity));var pores=0.0;var relief=0.0;let poreStrength=mix(0.55,0.9,smoothstep(0.02,0.55,max(fftDensity,surfDensity)));
 for(var i=0;i<2;i++){
  let phase=fract(shoreP.time/1.2+f32(i)*0.5);let weight=1.0-abs(phase*2.0-1.0);let q=p-velocity*1.2*(phase-0.5);
  let fp=max(footprint,max(length(dpdx(q)),length(dpdy(q))));let lod=max(0.0,log2(max(1.0,fp*512.0/0.5)));let detail=textureSampleLevel(oceanFoamPores,smpLinearRepeat,q/0.5,lod).rgb;
  var porous=mix(1.0,detail.g,poreStrength);porous=mix(porous,mix(1.0,0.83,poreStrength),smoothstep(0.00875,0.03,fp));pores+=porous*weight;relief+=detail.b*weight;
 }
 coverage=clamp(coverage*pores,0.0,1.0)*mix(1.0,filmCover,beach);return OceanFoamFilm(coverage,0.00175*relief*coverage);
}
`;

                                                                             
export const OCEAN_RESIDUE_WGSL =           `
fn oceanBeachFoamFragments(p:vec2f,footprint:f32)->f32 {
 // One unchanging world chart. The beach film is fragmented from first arrival,
 // not eroded from a solid sheet by wave age, density or periodic chart resets.
 let anchor=(p-shoreP.domain.xy-shoreP.domain.zw*0.5)/1.2;
 let axis=normalize(shoreP.incident+vec2f(1e-6,0.0));let tangent=vec2f(-axis.y,axis.x);
 let chart=vec2f(dot(anchor,axis)*0.75,dot(anchor,tangent)*1.2);
 let warped=oceanDomainWarp(chart,footprint/1.2,0.55);
 let fp=max(footprint/1.2,max(length(dpdx(warped)),length(dpdy(warped))));
 let clumps=oceanFbm(warped+vec2f(23.1,4.7),fp);
 let threads=oceanFbm(warped*1.7+vec2f(9.8,31.2),fp*1.7);
 let aa=max(0.018,fwidth(clumps));let ta=max(0.008,fwidth(threads));
 let pieces=smoothstep(0.53-aa,0.59+aa,clumps);
 let filaments=(1.0-smoothstep(0.018,0.055+ta,abs(threads-0.52)))*smoothstep(0.38-aa,0.50+aa,clumps);
 let pattern=max(pieces,filaments*0.8);
 // Unresolved fragments approach their area average instead of shimmering.
 return mix(0.38,pattern,1.0-smoothstep(0.18,0.65,fp));
}
fn oceanBeachFoamWorld(P:vec3f,footprint:f32)->vec2f {
 if(shoreP.enabled==0u||!oceanBedKnown(P.xz)){return vec2f(0.0);}
 let beach=oceanBeachFoamBlend(P.xz);if(beach<=0.0){return vec2f(0.0);}
 let contact=1.0-smoothstep(0.05,0.2,abs(P.y-oceanBed(P.xz)));
 // One transported concentration on the bed, including after the sheet returns.
 let density=max(0.0,shoreSimSample(P.xz).x)*0.72;
 if(density<=1e-6){return vec2f(0.0);}
 let lod=clamp(log2(max(1.0,footprint*512.0/0.512)),0.0,9.0);
 let detail=textureSampleLevel(oceanFoamPores,smpLinearRepeat,P.xz/0.512,lod);
 let pores=mix(detail.g,0.83,smoothstep(0.00875,0.03,footprint));
 let fragments=oceanBeachFoamFragments(P.xz,footprint);
 let film=oceanShoreFilmAt(P.xz,footprint);
 let stranded=1.0-film.coverage*film.band;
 let coverage=(1.0-exp(-5.0*density))*contact*beach*fragments*mix(1.0,pores,0.55)*stranded;
 return vec2f(coverage,0.00175*detail.b*coverage);
}
fn oceanReceiverResidueWorld(P:vec3f,footprint:f32)->f32 {
 if(shoreP.enabled==0u||!oceanBedKnown(P.xz)){return 0.0;}
 let bed=oceanBed(P.xz);if(bed<frame.seaLevel-0.02){return 0.0;}
 let contact=1.0-smoothstep(0.05,0.2,abs(P.y-bed));
 let lod=clamp(log2(max(1.0,footprint*512.0/0.512)),0.0,9.0);
 let detail=textureSampleLevel(oceanFoamPores,smpLinearRepeat,P.xz/0.512,lod);
 let pores=mix(detail.g,0.83,smoothstep(0.00875,0.03,footprint));
 return clamp(shoreSimSample(P.xz).z*contact*0.8*mix(1.0,pores,0.55),0.0,1.0);
}
`;
