                                                                              
const clamp=(v,a,b,d)=>Number.isFinite(v)?Math.min(b,Math.max(a,v)):d;
export function terrainMossMoistureConfig(input){
 if(input===undefined||input===null)return null;
 const value=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
 const dry=clamp(value.dry,0,.99,.08),wet=clamp(value.wet,.01,1,.65);
 return {
  ...value,
  dry:Math.min(dry,wet-.001),
  wet:Math.max(wet,dry+.001),
  regionalM:clamp(value.regionalM,.001,1e6,24),
  patchM:clamp(value.patchM,.001,1e6,2.4),
  fringeM:clamp(value.fringeM,.0001,1e6,.18),
  strength:clamp(value.strength,0,1,1)
 };
}
export function terrainMossCoverWGSL(input){
 const c=terrainMossMoistureConfig(input);if(!c)return '';
 const f=v=>Number(v).toFixed(9);
 return           `
// Candidate habitat is not final coverage. Noise leaves gaps and islands in
// both drainage banks and deep AO pockets, independent of camera and lighting.
fn apsTerrainMoistureMoss(P:vec3f,fp:f32,drainageSupport:f32,original:vec3f)->vec3f{
 let wetness=smoothstep(${f(c.dry)},${f(c.wet)},drainageSupport);
 let Q=P+vec3f(31.7,9.2,73.1);
 let regional=apsLygia_filteredFbm3(Q,${f(c.regionalM)},fp,3);
 let patchNoise=apsLygia_filteredFbm3(Q+vec3f(7,19,3),${f(c.patchM)},fp,3);
 let fringe=apsLygia_filteredFbm3(Q+vec3f(13,2,41),${f(c.fringeM)},fp,2);
 let field=.30*regional+.50*patchNoise+.20*fringe;
 let threshold=mix(.14,-.08,wetness);
 let aa=.065+min(.20,fp/${f(c.patchM)}*.3);
 let growth=smoothstep(threshold-aa,threshold+aa,field);
 let erosion=1.-.4*smoothstep(.08,.32,patchNoise+.5*fringe);
 let moss=clamp(${f(c.strength)}*.9*wetness*growth*erosion,0.,.9);
 // Drier exposed parts can retain lichen. The partition remains normalized.
 let lichen=clamp(original.z*(1.-moss)*mix(1.,.55,wetness),0.,1.-moss);
 return vec3f(1.-moss-lichen,moss,lichen);
}`;
}
