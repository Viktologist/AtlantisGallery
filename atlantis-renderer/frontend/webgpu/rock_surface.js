                                                                                   
                                                                                 
export const ROCK_SURFACE = Object.freeze({
  schema:'aps-rock-surface/1', patchM:.48, fringeM:.024, grainM:.0035,
  reliefM:.0018, cellM:.22, crackM:.0025, crackDepthM:.003, strength:1, seed:17,
  stone:[.80,.79,.73], weathering:[.18,.19,.16], lichen:[.42,.39,.17],
});
export function rockSurfaceConfig(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Rock surface requires an object');
  for(const k of Object.keys(input))if(!(k in ROCK_SURFACE))throw Error('Unknown rock surface option '+k);
  const c={...ROCK_SURFACE,...input};
  if(c.schema!==ROCK_SURFACE.schema)throw Error('Unsupported rock surface schema');
  for(const k of ['patchM','fringeM','grainM','cellM','crackM'])if(!Number.isFinite(c[k])||c[k]<=0)throw Error('Invalid rock surface '+k);
  if(c.patchM<c.fringeM*4||c.fringeM<c.grainM*2)throw Error('Rock surface bands must remain separated');
  if(!Number.isFinite(c.reliefM)||c.reliefM<0||c.reliefM>.02)throw Error('Rock relief must be 0..0.02 metres');
  if(c.crackM>c.cellM*.1||!Number.isFinite(c.crackDepthM)||c.crackDepthM<0||c.crackDepthM>.02)throw Error('Invalid metric rock fracture');
  if(!Number.isFinite(c.strength)||c.strength<0||c.strength>1)throw Error('Invalid rock surface strength');
  if(!Number.isInteger(c.seed)||c.seed<0||c.seed>65535)throw Error('Invalid rock surface seed');
  for(const k of ['stone','weathering','lichen'])if(!Array.isArray(c[k])||c[k].length!==3||!c[k].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('Invalid rock sRGB '+k);
  return c;
}
const clamp=x=>Math.max(0,Math.min(1,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
export const rockSurfaceFade=(footprint,period)=>1-smooth(.16,.6,footprint/period);
function hash(x,y,z){let h=(Math.imul(x,1597334677)^Math.imul(y,3812015801)^Math.imul(z,2798796415))>>>0;h=Math.imul(h^(h>>>16),2246822519)>>>0;h=Math.imul(h^(h>>>13),3266489917)>>>0;return ((h^(h>>>16))>>>0)/4294967295;}
const gradients=[[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
                                                                             
export function rockSurfaceNoise(p){const i=p.map(Math.floor),f=p.map((v,k)=>v-i[k]),u=f.map(v=>v*v*v*(v*(v*6-15)+10));let n=0;for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const g=gradients[Math.min(11,Math.floor(hash(i[0]+x,i[1]+y,i[2]+z)*12))],v=g[0]*(f[0]-x)+g[1]*(f[1]-y)+g[2]*(f[2]-z);n+=v*(x?u[0]:1-u[0])*(y?u[1]:1-u[1])*(z?u[2]:1-u[2]);}return clamp(.5+.85*n);}
                                                                                
export function rockSurfaceFBm(P,period,offset=0,footprint=0,octaves=6){let p=P.map(v=>v/period+offset),sum=0,weight=0,a=1,frequency=1/period;for(let i=0;i<octaves;i++){sum+=a*(.5+(rockSurfaceNoise(p)-.5)*rockSurfaceFade(footprint,1/frequency));weight+=a;p=[2.03*(.8*p[1]+.6*p[2])+17.13,2.03*(-.8*p[0]+.36*p[1]-.48*p[2])+7.17,2.03*(-.6*p[0]-.48*p[1]+.64*p[2])+29.11];frequency*=2.03;a*=.52;}return sum/weight;}
                                                                        
                                                                                  
export function rockSurfaceWorley(P,cellM,seed=0,radius=1){const p=P.map(v=>v/cellM),cell=p.map(Math.floor);let a=Infinity,b=Infinity,va,vb,tag=0;for(let z=-radius;z<=radius;z++)for(let y=-radius;y<=radius;y++)for(let x=-radius;x<=radius;x++){const c=[cell[0]+x,cell[1]+y,cell[2]+z],j=[hash(c[0]+seed,c[1],c[2]),hash(c[0],c[1]+seed+97,c[2]),hash(c[0],c[1],c[2]+seed+211)],v=c.map((q,k)=>q+.5+.4*(j[k]-.5)-p[k]),d=v.reduce((s,q)=>s+q*q,0);if(d<a){b=a;vb=va;a=d;va=v;tag=j[0];}else if(d<b){b=d;vb=v;}}
 return {f1:Math.sqrt(a)*cellM,f2:Math.sqrt(b)*cellM,edgeM:.5*(b-a)/Math.max(1e-8,Math.hypot(...va.map((v,k)=>v-vb[k])))*cellM,tag};}
                                                                         
export function rockSurfaceMasks(P,footprint=0,input={}){
  const c=rockSurfaceConfig(input),s=c.patchM,offset=[c.seed*.731,c.seed*.379,c.seed*.193];
  const noise=(p,period,o)=>rockSurfaceNoise(p.map((v,i)=>v/period+o+offset[i]));
  const fbm=(p,period,o,octaves=6)=>rockSurfaceFBm(p.map((v,i)=>v+offset[i]*period),period,o,footprint,octaves);
  const warp=P.map((_,i)=>(fbm(P,s*.65,13+i*37,3)-.5)*s*.10);
  const q=P.map((v,i)=>v+warp[i]);
  const f=rockSurfaceFade(footprint,c.fringeM),fine=fbm(q,c.fringeM,71,3)-.5;
  const cells=rockSurfaceWorley(q,c.cellM,c.seed),cellFade=rockSurfaceFade(footprint,c.cellM);
  const d=.5+1.6*(fbm(q,s,3)-.5)+.04*(cells.tag-.5)*cellFade+.25*fine;
  const l=.5+1.6*(fbm(q,s*.73,127)-.5)-.20*fine+.08*(cells.f1/c.cellM-.5)*cellFade;
  const edge=.018+.18*Math.min(1,footprint/s),fade=rockSurfaceFade(footprint,s);
  const poreField=noise(q,c.fringeM*.5,251),poreFade=rockSurfaceFade(footprint,c.fringeM*.5);
  const pores=1-.78*(.14+(smooth(.62,.72,poreField)-.14)*poreFade);
  const fracture=(1-smooth(c.crackM*.5-Math.max(footprint*.7,c.crackM*.15),c.crackM*.5+Math.max(footprint*.7,c.crackM*.15),cells.edgeM))*cellFade*smooth(.48,.58,fbm(q,s*1.7,311,3));
  const rawDark=(.355*(1-fade)+smooth(.565-edge,.565+edge,d)*fade)*pores;
  const dark=rawDark+(1-rawDark)*fracture*.75;
  const colonization=.418*(1-fade)+smooth(.545-edge,.545+edge,l)*fade;
  const lichen=(1-dark)*colonization*(1-fracture*.6);
  const grain=fbm(P,c.grainM,211,3)-.5;
  const stone=1-dark-lichen;
  const mineral=.5+.4*fine+.25*(poreField-.5)*poreFade+.15*grain+.12*(cells.tag-.5)*cellFade;
  const granulation=clamp(.5+(mineral-.5)*2.8);
  const color=[0,1,2].map(i=>(stone*linear(c.stone[i])+dark*linear(c.weathering[i])+lichen*linear(c.lichen[i]))*(.48+1.04*granulation));
  return {stone,dark,lichen,grain,color,roughness:Math.max(.5,Math.min(1,.82*stone+.91*dark+.95*lichen+.25*(mineral-.5)+.08*fracture)),height:c.reliefM*(.10*lichen-.02*rawDark+.12*grain+.30*(mineral-.5))-c.crackDepthM*fracture,fracture};
}
const linear=x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);
const n=x=>Number(x).toFixed(9);
const v=a=>'vec3f('+a.map(n).join(',')+')';
export function createRockSurfaceWGSL(input={}){
 const c=rockSurfaceConfig(input);
 return           `
const APS_ROCK_PATCH_M:f32=${n(c.patchM)};
const APS_ROCK_FRINGE_M:f32=${n(c.fringeM)};
const APS_ROCK_GRAIN_M:f32=${n(c.grainM)};
const APS_ROCK_RELIEF_M:f32=${n(c.reliefM)};
const APS_ROCK_CELL_M:f32=${n(c.cellM)};
const APS_ROCK_CRACK_M:f32=${n(c.crackM)};
const APS_ROCK_CRACK_DEPTH_M:f32=${n(c.crackDepthM)};
const APS_ROCK_STRENGTH:f32=${n(c.strength)};
fn apsRockHash(p:vec3i)->f32 {
 var h=(bitcast<u32>(p.x)*1597334677u) ^ (bitcast<u32>(p.y)*3812015801u) ^ (bitcast<u32>(p.z)*2798796415u);
 h=(h^(h>>16u))*2246822519u;h=(h^(h>>13u))*3266489917u;
 return f32(h^(h>>16u))/4294967295.0;
}
fn apsRockGrad(i:vec3i,f:vec3f)->f32 {
 let g=array<vec3f,12>(vec3f(1,1,0),vec3f(-1,1,0),vec3f(1,-1,0),vec3f(-1,-1,0),vec3f(1,0,1),vec3f(-1,0,1),vec3f(1,0,-1),vec3f(-1,0,-1),vec3f(0,1,1),vec3f(0,-1,1),vec3f(0,1,-1),vec3f(0,-1,-1));
 return dot(g[min(11u,u32(apsRockHash(i)*12.))],f);
}
fn apsRockNoise(p:vec3f)->f32 {
 let i=vec3i(floor(p));let f=fract(p);let u=f*f*f*(f*(f*6.-15.)+10.);
 let a=apsRockGrad(i,f);let b=apsRockGrad(i+vec3i(1,0,0),f-vec3f(1,0,0));let c0=apsRockGrad(i+vec3i(0,1,0),f-vec3f(0,1,0));let d=apsRockGrad(i+vec3i(1,1,0),f-vec3f(1,1,0));
 let e=apsRockGrad(i+vec3i(0,0,1),f-vec3f(0,0,1));let g=apsRockGrad(i+vec3i(1,0,1),f-vec3f(1,0,1));let h=apsRockGrad(i+vec3i(0,1,1),f-vec3f(0,1,1));let j=apsRockGrad(i+vec3i(1,1,1),f-vec3f(1,1,1));
 return clamp(.5+.85*mix(mix(mix(a,b,u.x),mix(c0,d,u.x),u.y),mix(mix(e,g,u.x),mix(h,j,u.x),u.y),u.z),0.,1.);
}
fn apsRockBand(footprint:f32,period:f32)->f32{return 1.-smoothstep(.16,.6,footprint/period);}
fn apsRockN(P:vec3f,period:f32,offset:f32)->f32{return apsRockNoise(P/period+vec3f(offset)+${v([c.seed*.731,c.seed*.379,c.seed*.193])});}
fn apsRockFBm(P:vec3f,period:f32,offset:f32,footprint:f32,octaves:i32)->f32 {
 var p=P/period+vec3f(offset)+${v([c.seed*.731,c.seed*.379,c.seed*.193])};var sum=0.;var weight=0.;var a=1.;var frequency=1./period;
 for(var i=0;i<octaves;i++){
  sum+=a*(.5+(apsRockNoise(p)-.5)*apsRockBand(footprint,1./frequency));weight+=a;
  p=2.03*(mat3x3f(vec3f(0,-.8,-.6),vec3f(.8,.36,-.48),vec3f(.6,-.48,.64))*p)+vec3f(17.13,7.17,29.11);
  frequency*=2.03;a*=.52;
 }return sum/weight;
}
// f1,f2 and nearest-pair bisector distance in metres, plus nearest cell identity.
fn apsRockWorley(P:vec3f)->vec4f {
 let p=P/APS_ROCK_CELL_M;let cell=vec3i(floor(p));var a=1e10;var b=1e10;var va=vec3f(0.);var vb=vec3f(0.);var tag=0.;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let c0=cell+vec3i(x,y,z);let j=vec3f(apsRockHash(c0+vec3i(${c.seed},0,0)),apsRockHash(c0+vec3i(0,${c.seed+97},0)),apsRockHash(c0+vec3i(0,0,${c.seed+211})));
  let v0=vec3f(c0)+.5+.4*(j-.5)-p;let d=dot(v0,v0);
  if(d<a){b=a;vb=va;a=d;va=v0;tag=j.x;}else if(d<b){b=d;vb=v0;}
 }}}
 return vec4f(sqrt(a)*APS_ROCK_CELL_M,sqrt(b)*APS_ROCK_CELL_M,.5*(b-a)/max(length(va-vb),1e-8)*APS_ROCK_CELL_M,tag);
}
struct APSRockSurfaceSample {color:vec3f,height:f32,roughness:f32,masks:vec3f};
fn apsRockSurfaceSample(P:vec3f)->APSRockSurfaceSample {
 // All derivatives are unconditional; classification/cover masking happens later.
 let footprint=max(length(dpdx(P)),length(dpdy(P)));
 let s=APS_ROCK_PATCH_M;
 let warp=(vec3f(apsRockFBm(P,s*.65,13.,footprint,3),apsRockFBm(P,s*.65,50.,footprint,3),apsRockFBm(P,s*.65,87.,footprint,3))-.5)*s*.10;
 let q=P+warp;let fine=apsRockFBm(q,APS_ROCK_FRINGE_M,71.,footprint,3)-.5;
 let cells=apsRockWorley(q);let cellFade=apsRockBand(footprint,APS_ROCK_CELL_M);
 let d=.5+1.6*(apsRockFBm(q,s,3.,footprint,6)-.5)+.04*(cells.w-.5)*cellFade+.25*fine;
 let l=.5+1.6*(apsRockFBm(q,s*.73,127.,footprint,6)-.5)-.20*fine+.08*(cells.x/APS_ROCK_CELL_M-.5)*cellFade;
 let edge=.018+.18*min(1.,footprint/s);let fade=apsRockBand(footprint,s);
 // Subpixel classification tends to its area average, not a pale/black solid.
 let poreField=apsRockN(q,APS_ROCK_FRINGE_M*.5,251.);let poreFade=apsRockBand(footprint,APS_ROCK_FRINGE_M*.5);
 let pores=1.-.78*mix(.14,smoothstep(.62,.72,poreField),poreFade);
 let crackAA=max(footprint*.7,APS_ROCK_CRACK_M*.15);
 let fracture=(1.-smoothstep(APS_ROCK_CRACK_M*.5-crackAA,APS_ROCK_CRACK_M*.5+crackAA,cells.z))*cellFade*smoothstep(.48,.58,apsRockFBm(q,s*1.7,311.,footprint,3));
 let rawDark=mix(.355,smoothstep(.565-edge,.565+edge,d),fade)*pores;
 let dark=rawDark+(1.-rawDark)*fracture*.75;
 let lichen=(1.-dark)*mix(.418,smoothstep(.545-edge,.545+edge,l),fade)*(1.-fracture*.6);
 let stone=1.-dark-lichen;
 let grain=apsRockFBm(P,APS_ROCK_GRAIN_M,211.,footprint,3)-.5;
 let mineral=.5+.4*fine+.25*(poreField-.5)*poreFade+.15*grain+.12*(cells.w-.5)*cellFade;
 let granulation=clamp(.5+(mineral-.5)*2.8,0.,1.);
 let color=(stone*${v(c.stone.map(linear))}+dark*${v(c.weathering.map(linear))}+lichen*${v(c.lichen.map(linear))})*(.48+1.04*granulation);
 // Pigment boundaries are mostly stains, not raised contour lines. Fractures
 // carry deep relief; minerals and attached cover carry shallow microrelief.
 let h=APS_ROCK_RELIEF_M*(.10*lichen-.02*rawDark+.12*grain+.30*(mineral-.5))-APS_ROCK_CRACK_DEPTH_M*fracture;
 return APSRockSurfaceSample(color,h,clamp(.82*stone+.91*dark+.95*lichen+.25*(mineral-.5)+.08*fracture,.5,1.),vec3f(stone,dark,lichen));
}
fn apsRockSurfaceNormal(nIn:vec3f,geomN:vec3f,P:vec3f,h:f32,mask:f32)->vec3f {
 let px=dpdx(P);let py=dpdy(P);let hx=dpdx(h);let hy=dpdy(h);
 let N=normalize(geomN);let n=normalize(nIn);let rx=cross(py,N);let ry=cross(N,px);let det=dot(px,rx);
 var g=vec3f(0.);if(abs(det)>1e-5*max(length(px)*length(py),1e-20)){g=(hx*rx+hy*ry)/det;}
 g=g-n*dot(n,g);var perturb=-g*clamp(mask,0.,1.);
 perturb*=min(1.,.40402623/max(length(perturb),1e-10));
 return normalize(n+perturb);
}
`;}
export const rockSurfaceWGSL=createRockSurfaceWGSL();
