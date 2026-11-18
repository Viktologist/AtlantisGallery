                                                                                  
                                                                                 
import {createRockSurfaceWGSL as oldWGSL,rockSurfaceFBm,rockSurfaceNoise,rockSurfaceFade} from './rock_surface.js';
export const ROCK_SURFACE=Object.freeze({schema:'aps-rock-plates/1',patchM:.48,fringeM:.024,grainM:.0035,reliefM:.0018,plateReliefM:.009,bevelM:.008,crackM:.0025,crackDepthM:.003,strength:1,seed:17,stone:[.80,.79,.73],weathering:[.18,.19,.16],lichen:[.42,.39,.17]});
export function rockSurfaceConfig(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Rock plates require an object');
 for(const k of Object.keys(input))if(!(k in ROCK_SURFACE))throw Error('Unknown rock plate option '+k);
 const c={...ROCK_SURFACE,...input};if(c.schema!==ROCK_SURFACE.schema)throw Error('Unsupported rock plate schema');
 for(const k of ['patchM','fringeM','grainM','bevelM','crackM'])if(!Number.isFinite(c[k])||c[k]<=0)throw Error('Invalid metric rock plate '+k);
 for(const k of ['reliefM','plateReliefM','crackDepthM'])if(!Number.isFinite(c[k])||c[k]<0||c[k]>.05)throw Error('Invalid metric rock plate '+k);
 if(c.bevelM+c.crackM>c.patchM*.2||c.fringeM<c.grainM*2)throw Error('Rock plate bands overlap');
 if(!Number.isInteger(c.seed)||c.seed<0||c.seed>65535||!Number.isFinite(c.strength)||c.strength<0||c.strength>1)throw Error('Invalid rock plate seed/strength');
 for(const k of ['stone','weathering','lichen'])if(!Array.isArray(c[k])||c[k].length!==3||!c[k].every(x=>Number.isFinite(x)&&x>=0&&x<=1))throw Error('Invalid rock plate palette '+k);
 return c;
}
function hash(x,y,z){let h=(Math.imul(x,1597334677)^Math.imul(y,3812015801)^Math.imul(z,2798796415))>>>0;h=Math.imul(h^(h>>>16),2246822519)>>>0;h=Math.imul(h^(h>>>13),3266489917)>>>0;return ((h^(h>>>16))>>>0)/4294967295;}
const clamp=x=>Math.max(0,Math.min(1,x)),smooth=(a,b,x)=>{let t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
export function rockPlateCell(P,period,seed=17){
 const p=P.map(v=>v/period),cell=p.map(Math.floor),sites=[];let nearest=null;
 for(let z=-1;z<=1;z++)for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){
  const c=[cell[0]+x,cell[1]+y,cell[2]+z],j=[hash(c[0]+seed,c[1],c[2]),hash(c[0],c[1]+seed+97,c[2]),hash(c[0],c[1],c[2]+seed+211)],v=c.map((q,k)=>q+.5+.4*(j[k]-.5)-p[k]);
  const s={v,j,d:v.reduce((a,b)=>a+b*b,0)};sites.push(s);if(!nearest||s.d<nearest.d)nearest=s;
 }
 let edge=1e9;for(const s of sites){const diff=s.v.map((x,i)=>x-nearest.v[i]),len=Math.hypot(...diff);if(len>1e-7)edge=Math.min(edge,s.v.reduce((a,x,i)=>a+(x+nearest.v[i])*.5*diff[i]/len,0));}
 return {edgeM:Math.max(0,edge)*period,local:nearest.v,random:nearest.j};
}
const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
export function rockSurfaceMasks(P,fp=0,input={}){
 const c=rockSurfaceConfig(input),cell=rockPlateCell(P,c.patchM,c.seed),r=cell.random;
 const fb=(period,seed)=>rockSurfaceFBm(P,period,seed+c.seed*.137,fp,3);
 const chip=fb(c.fringeM,13),grain=fb(c.grainM,31)-.5;
 const edge=cell.edgeM-(chip-.5)*c.fringeM*.12,aa=Math.max(fp*.7,c.crackM*.15),fade=rockSurfaceFade(fp,c.patchM);
 const crack=(1-smooth(c.crackM*.5-aa,c.crackM*.5+aa,edge))*fade;
 const interior=smooth(c.crackM*.5,c.crackM*.5+c.bevelM+aa,edge);
 const plane=c.plateReliefM*(r[0]-.5)+c.patchM*.075*cell.local.reduce((a,v,i)=>a+v*(r[(i+1)%3]-.5),0);
 const pits=(1-smooth(c.bevelM,c.bevelM*3,edge))*smooth(.55,.68,chip);
 const weathered=smooth(.62,.82,r[1]);
 const dark=clamp((weathered*.70+(1-interior)*.42+crack*.75)*fade+.28*(1-fade));
 const colony=smooth(.51,.60,fb(c.patchM*1.4,43));
 const lichen=(1-dark)*(1-crack)*(.34*(1-fade)+.75*colony*fade);
 const stone=1-dark-lichen;
 const mineral=.78+.38*(.5+(r[2]-.5)*fade)+.45*(chip-.5)+.30*grain;
 const color=[0,1,2].map(i=>clamp((stone*linear(c.stone[i])+dark*linear(c.weathering[i])+lichen*linear(c.lichen[i]))*mineral));
 const height=plane*interior*fade-c.crackDepthM*crack-c.reliefM*pits+c.reliefM*(.08*lichen+.10*grain);
 const roughness=clamp(.68*stone+.90*dark+.96*lichen+.10*(chip-.5)+.12*grain+.05*pits);
 return {stone,dark,lichen,color,height,roughness,crack,interior,grain};
}
const num=x=>Number(x).toFixed(9),v=a=>'vec3f('+a.map(num).join(',')+')';
export function createRockSurfaceWGSL(input={}){
 const c=rockSurfaceConfig(input);
                                                                                   
                                                                   
 const legacy=oldWGSL({patchM:c.patchM,fringeM:c.fringeM,grainM:c.grainM,reliefM:c.reliefM,cellM:c.patchM,crackM:c.crackM,crackDepthM:c.crackDepthM,strength:c.strength,seed:c.seed});
 const split=legacy.indexOf('struct APSRockSurfaceSample'),normal=legacy.indexOf('fn apsRockSurfaceNormal(');
 if(split<0||normal<split)throw Error('Rock noise primitive contract changed');
 return legacy.slice(0,split)+          `
struct APSRockPlateCell{edge:f32,local:vec3f,random:vec3f};
fn apsRockPlateSite(c:vec3i,p:vec3f)->APSRockPlateCell{
 let j=vec3f(apsRockHash(c+vec3i(${c.seed},0,0)),apsRockHash(c+vec3i(0,${c.seed+97},0)),apsRockHash(c+vec3i(0,0,${c.seed+211})));
 return APSRockPlateCell(0.,vec3f(c)+.5+.4*(j-.5)-p,j);
}
fn apsRockPlateCell(P:vec3f)->APSRockPlateCell{
 let p=P/APS_ROCK_PATCH_M;let cell=vec3i(floor(p));var best=1e10;var near=APSRockPlateCell(0.,vec3f(0),vec3f(0));
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let s=apsRockPlateSite(cell+vec3i(x,y,z),p);let d=dot(s.local,s.local);if(d<best){best=d;near=s;}}}}
 var edge=1e10;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let s=apsRockPlateSite(cell+vec3i(x,y,z),p);let delta=s.local-near.local;let len=length(delta);if(len>1e-7){edge=min(edge,dot((s.local+near.local)*.5,delta/len));}}}}
 near.edge=max(0.,edge)*APS_ROCK_PATCH_M;return near;
}
// Compact three-octave grunge, deliberately subordinate to explicit plates.
fn apsRockPlateGrunge(P:vec3f,period:f32,seed:f32,fp:f32)->f32{
 // Cancel the legacy large coordinate seed; integer cell identity seeds the structure.
 return apsRockFBm(P-${v([c.seed*.731,c.seed*.379,c.seed*.193])}*period,period,seed+${num(c.seed*.137)},fp,3);
}
struct APSRockSurfaceSample{color:vec3f,height:f32,roughness:f32,masks:vec3f};
fn apsRockSurfaceSample(P:vec3f)->APSRockSurfaceSample{
 let fp=max(length(dpdx(P)),length(dpdy(P)));let cell=apsRockPlateCell(P);let r=cell.random;
 let chip=apsRockPlateGrunge(P,APS_ROCK_FRINGE_M,13.,fp);let grain=apsRockPlateGrunge(P,APS_ROCK_GRAIN_M,31.,fp)-.5;
 let edge=cell.edge-(chip-.5)*APS_ROCK_FRINGE_M*.12;let aa=max(fp*.7,APS_ROCK_CRACK_M*.15);let fade=apsRockBand(fp,APS_ROCK_PATCH_M);
 let crack=(1.-smoothstep(APS_ROCK_CRACK_M*.5-aa,APS_ROCK_CRACK_M*.5+aa,edge))*fade;
 let interior=smoothstep(APS_ROCK_CRACK_M*.5,APS_ROCK_CRACK_M*.5+${num(c.bevelM)}+aa,edge);
 let plane=${num(c.plateReliefM)}*(r.x-.5)+APS_ROCK_PATCH_M*.075*dot(cell.local,r.yzx-.5);
 let pits=(1.-smoothstep(${num(c.bevelM)},${num(c.bevelM*3)},edge))*smoothstep(.55,.68,chip);
 let weathered=smoothstep(.62,.82,r.y);
 let dark=clamp((weathered*.70+(1.-interior)*.42+crack*.75)*fade+.28*(1.-fade),0.,1.);
 let colony=smoothstep(.51,.60,apsRockPlateGrunge(P,APS_ROCK_PATCH_M*1.4,43.,fp));
 let lichen=(1.-dark)*(1.-crack)*mix(.34,.75*colony,fade);let stone=1.-dark-lichen;
 let mineral=.78+.38*mix(.5,r.z,fade)+.45*(chip-.5)+.30*grain;
 let color=clamp((stone*${v(c.stone.map(linear))}+dark*${v(c.weathering.map(linear))}+lichen*${v(c.lichen.map(linear))})*mineral,vec3f(0),vec3f(1));
 let height=plane*interior*fade-APS_ROCK_CRACK_DEPTH_M*crack-APS_ROCK_RELIEF_M*pits+APS_ROCK_RELIEF_M*(.08*lichen+.10*grain);
 let roughness=clamp(.68*stone+.90*dark+.96*lichen+.10*(chip-.5)+.12*grain+.05*pits,0.,1.);
 return APSRockSurfaceSample(color,height,roughness,vec3f(stone,dark,lichen));
}
`+legacy.slice(normal);
}
export const rockSurfaceWGSL=createRockSurfaceWGSL();
