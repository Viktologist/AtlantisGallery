                                                                                
import {lygiaNoiseWGSL} from './lygia_noise.js';
export const LYGIA_ROCK=Object.freeze({schema:'aps-rock-lygia/1',patchM:.32,fringeM:.014,grainM:.0018,reliefM:.0007,structureM:1.4,structureReliefM:.008,jointM:.75,jointWidthM:.004,jointDepthM:.004,jointStrength:1,strength:1,seed:17,stone:[.84,.82,.75],weathering:[.115,.12,.10],lichen:[.43,.39,.16],debug:'pbr'});
export function lygiaRockConfig(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('LYGIA rock requires an object');
 for(const k of Object.keys(input))if(!(k in LYGIA_ROCK))throw Error('Unknown LYGIA rock option '+k);
 const c={...LYGIA_ROCK,...input};if(c.schema!==LYGIA_ROCK.schema)throw Error('Unsupported LYGIA rock schema');
 for(const k of ['patchM','fringeM','grainM','structureM','jointM','jointWidthM'])if(!Number.isFinite(c[k])||c[k]<=0)throw Error('Invalid metric LYGIA rock '+k);
 if(c.patchM<c.fringeM*4||c.fringeM<c.grainM*2)throw Error('LYGIA rock scales overlap');
 for(const k of ['reliefM','structureReliefM','jointDepthM'])if(!Number.isFinite(c[k])||c[k]<0||c[k]>.05)throw Error('Invalid LYGIA relief '+k);
 if(c.jointWidthM>c.jointM*.1)throw Error('Global rock joint width exceeds structure scale');
 if(!Number.isFinite(c.jointStrength)||c.jointStrength<0||c.jointStrength>1)throw Error('Invalid global joint strength');
 if(!Number.isInteger(c.seed)||c.seed<0||c.seed>65535||!Number.isFinite(c.strength)||c.strength<0||c.strength>1)throw Error('Invalid LYGIA rock seed/strength');
 for(const k of ['stone','weathering','lichen'])if(!Array.isArray(c[k])||c[k].length!==3||!c[k].every(x=>Number.isFinite(x)&&x>=0&&x<=1))throw Error('Invalid LYGIA rock palette '+k);
 if(!['pbr','albedo','roughness','normal','height','masks','simplex','fbm','voronoise','worley','structure','fractures'].includes(c.debug))throw Error('Unknown LYGIA rock diagnostic');
 return c;
}
const num=x=>Number(x).toFixed(9),vec=a=>'vec3f('+a.map(num).join(',')+')';
const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
export function createLygiaRockWGSL(input={}){
 const c=lygiaRockConfig(input);
 return lygiaNoiseWGSL+          `
const APS_ROCK_STRENGTH:f32=${num(c.strength)};
const APS_ROCK_STONE_BASE:vec3f=${vec(c.stone.map(linear))};
struct APSRockSurfaceSample{color:vec3f,height:f32,roughness:f32,masks:vec3f,rockTint:vec3f,fracture:f32};
fn apsRockSurfaceSampleAt(P:vec3f,fp:f32)->APSRockSurfaceSample{
 let seed=${vec([c.seed*.173,c.seed*.367,c.seed*.531])};let Q=P+seed*${num(c.patchM)};
 let broad=apsLygia_filteredFbm3(Q,${num(c.patchM)},fp,4);
 let middle=apsLygia_filteredFbm3(Q+vec3f(11.3,3.7,5.1)*${num(c.patchM)},${num(c.patchM*.29)},fp,3);
 let fringe=apsLygia_filteredGradient3(Q,${num(c.fringeM)},fp,3).x;
 let grain=apsLygia_filteredGradient3(Q+vec3f(4,7,2)*${num(c.grainM)},${num(c.grainM)},fp,2).x;
 let macroFade=apsLygia_band(fp,${num(c.patchM)});
 // Global rock structure stays independent of all repeating PBR detail tiles.
 let structure=apsLygia_filteredFbm3(Q,${num(c.structureM)},fp,4);
 // A thresholded anisotropic signed noise field, not a Voronoi cell boundary.
 // Dividing by its analytic metric gradient approximates local band width.
 let jointScale=${vec([c.jointM,c.jointM*.42,c.jointM*1.7])};
 let jointField=apsLygia_noised3(Q/jointScale+vec3f(7.1,3.2,9.7));
 let jointDistance=abs(jointField.x)/max(length(jointField.yzw/jointScale),.08/${num(c.jointM)});
 let jointAA=max(fp*.65,${num(c.jointWidthM*.1)});
 let fracture=${num(c.jointStrength)}*(1.-smoothstep(${num(c.jointWidthM*.5)}-jointAA,${num(c.jointWidthM*.5)}+jointAA,jointDistance))*smoothstep(-.15,.10,structure+.25*middle)*apsLygia_band(fp,${num(c.jointM)});
 // Hard islands with nested erosion, no heavy coordinate swirl or raised pigment contours.
 let thresholdWidth=.025+fp/${num(c.patchM)}*.7;
 let stainField=broad+.32*middle+.18*fringe;
 let stain=smoothstep(.135-thresholdWidth,.135+thresholdWidth,stainField);
 // Nested erosion exposes mineral inside the weathered regions, not just on outlines.
 let erosion=smoothstep(.10,.28,middle+.30*fringe);
 let rawDark=mix(.22,stain*(1.-.82*erosion),macroFade);
 var colony=.5;if(macroFade>0.){colony=apsLygia_voronoise3(Q/${num(c.patchM*.48)}+vec3f(4.1,9.2,7.3),.87,.52);}
 let colonyBreak=apsLygia_filteredFbm3(Q+vec3f(19,3,7)*${num(c.patchM)},${num(c.patchM*.63)},fp,3);
 let growth=colony+.40*colonyBreak+.30*fringe;
 let coat=mix(.24,smoothstep(.565-thresholdWidth,.565+thresholdWidth,growth),macroFade);
 // Pitting follows the weathering field; no cell edges are interpreted as joints.
 let pits=smoothstep(.14,.33,fringe)*smoothstep(.06,.20,middle);
 let dark=rawDark;
 let lichen=(1.-dark)*coat*.86;let stone=1.-dark-lichen;
 let mineral=clamp(.94+.40*fringe+.55*grain+.18*middle,.6,1.2);
 let weatheredColor=${vec(c.weathering.map(linear))}*(.75+2.*smoothstep(-.23,.27,fringe+.40*middle));
 let lichenColor=${vec(c.lichen.map(linear))}*(.8+.55*smoothstep(-.25,.25,fringe+.25*grain));
 var color=clamp((stone*${vec(c.stone.map(linear))}+dark*weatheredColor+lichen*lichenColor)*mineral,vec3f(0),vec3f(1));
 let rockTint=${vec(c.stone.map(linear))}*clamp(.86+.65*structure+.18*broad,.4,1.2);
 color*=clamp(.86+.65*structure,.4,1.2)*(1.-.65*fracture);
 let height=${num(c.structureReliefM)}*structure-${num(c.jointDepthM)}*fracture+${num(c.reliefM)}*(.30*grain+.12*fringe-.5*pits);
 let roughness=clamp(.72*stone+.87*dark+.96*lichen+.11*fringe+.08*grain+.06*pits+.10*fracture,.52,1.);
 ${c.debug==='simplex'?`color=vec3f(.5+.5*apsLygia_snoise3(Q/${num(c.patchM)}));`:''}
 ${c.debug==='fbm'?`color=vec3f(.5+broad);`:''}
 ${c.debug==='voronoise'?`color=vec3f(colony);`:''}
 ${c.debug==='worley'?`color=vec3f(apsLygia_worley32(Q/${num(c.patchM)}).x);`:''}
 ${c.debug==='structure'?'color=vec3f(.5+structure);':''}
 ${c.debug==='fractures'?'color=vec3f(1.-fracture);':''}
 ${c.debug==='masks'?'color=vec3f(stone,dark,lichen);':''}
 ${c.debug==='roughness'?'color=vec3f(roughness);':''}
 ${c.debug==='height'?`color=vec3f(.5+height/${num(Math.max(.0001,c.reliefM)*2)});`:''}
 return APSRockSurfaceSample(color,height,roughness,vec3f(stone,dark,lichen),rockTint,fracture);
}
fn apsRockSurfaceSample(P:vec3f)->APSRockSurfaceSample{return apsRockSurfaceSampleAt(P,max(length(dpdx(P)),length(dpdy(P))));}
fn apsLygiaMicro(P:vec3f,fp:f32)->vec4f{
 let Q=P+${vec([c.seed*.173*c.patchM,c.seed*.367*c.patchM,c.seed*.531*c.patchM])};
 let grain=apsLygia_filteredGradient3(Q+vec3f(4,7,2)*${num(c.grainM)},${num(c.grainM)},fp,2);
 let fringe=apsLygia_filteredGradient3(Q,${num(c.fringeM)},fp,3);
 return ${num(c.reliefM)}*(.30*grain+.12*fringe);
}
fn apsRockSurfaceNormal(nIn:vec3f,geomN:vec3f,P:vec3f,h:f32,mask:f32)->vec3f{
 let px=dpdx(P);let py=dpdy(P);let micro=apsLygiaMicro(P,max(length(px),length(py)));let structuralHeight=h-micro.x;
 let hx=dpdx(structuralHeight);let hy=dpdy(structuralHeight);let N=normalize(geomN);let n=normalize(nIn);
 let rx=cross(py,N);let ry=cross(N,px);let det=dot(px,rx);var g=vec3f(0.);
 if(abs(det)>1e-5*max(length(px)*length(py),1e-20)){g=(hx*rx+hy*ry)/det;}
 g+=micro.yzw;g-=n*dot(n,g);var perturb=-g*clamp(mask,0.,1.);perturb*=min(1.,.40402623/max(length(perturb),1e-10));return normalize(n+perturb);
}
`;
}
