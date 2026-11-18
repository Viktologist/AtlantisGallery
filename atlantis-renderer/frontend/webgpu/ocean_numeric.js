                                                                                    
import {normalizeOceanConfig} from '../src/ocean_math.js';
import {CAUSTIC_ACCEPTED_SETTINGS} from './ocean_caustic_options.js';
export {createWaveBand} from '../src/ocean_spectrum.js';
export {createTidewaterShoreField, tidewaterShoreSettings} from '../src/ocean_tidewater_shore_math.js';
export {buildShoreTiles,fitShoreTiles} from '../src/ocean_shore_tiles_math.js';

export const OCEAN_REFERENCE = '4811ba48d795197de5621985f404e765c0b7c0ef';
export const FFT_SIZE = 256;
                                                                               
                                                                               
const BASE_KEYS = Object.freeze(['sealevel','stormylevel','oceantype','seed','winddirection','quality','enabled','wetness','caustics','spray','reflections','maxDistance','choppiness']);
export function oceanConfig(input = {}) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const aliases = {seaLevel:'sealevel',stormyLevel:'stormylevel',oceanType:'oceantype',windDirection:'winddirection'};
  const values = {...source};
  const shoreShadowFade=values.shoreShadowFadeDistance??2;delete values.shoreShadowFadeDistance;
  const depthDisplayMax=values.shallowDepthDisplayMax??1;delete values.shallowDepthDisplayMax;
  const causticShadowAttenuation=values.causticShadowAttenuation??.2;delete values.causticShadowAttenuation;
  const cascadeMask=values.causticCascadeMask??CAUSTIC_ACCEPTED_SETTINGS.cascadeMask;delete values.causticCascadeMask;
  const minimumStep=values.causticMinimumStep??CAUSTIC_ACCEPTED_SETTINGS.minimumStep;delete values.causticMinimumStep;
  for (const [from,to] of Object.entries(aliases)) if (Object.hasOwn(values,from)) {
                                                                                
    if (!Object.hasOwn(values,to)) values[to] = values[from];
    delete values[from];
  }
  const extras=Object.fromEntries(Object.entries(values).filter(([key])=>!BASE_KEYS.includes(key)));
  const baseInput=Object.fromEntries(Object.entries(values).filter(([key])=>BASE_KEYS.includes(key)));
                                                                             
                                                                             
  const base=normalizeOceanConfig(baseInput);
  const bands=Object.freeze(base.bands.map(b=>Object.freeze({...b,size:FFT_SIZE})));
  return Object.freeze({...extras,...base,fftSize:FFT_SIZE,bands,causticShadowAttenuation,causticCascadeMask:cascadeMask,causticMinimumStep:minimumStep,shoreShadowFadeDistance:shoreShadowFade,shallowDepthDisplayMax:depthDisplayMax});
}
export function assertNativeBed(native) {
                                                                        
                                                                              
                                                          
  return native ?? null;
}
export function spectralWaveData(band) {
  const n=band.size, out=new Float32Array(n*n*4), dk=2*Math.PI/band.length;
  for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
    const k=(y*n+x)*4, kx=(x<n/2?x:x-n)*dk, kz=(y<n/2?y:y-n)*dk, r=Math.hypot(kx,kz);
    if(r>0&&x!==n/2&&y!==n/2) out.set([kx,kz,1/r,Math.sqrt(9.81*r*Math.tanh(r*band.depth))],k);
  }
  return out;
}
                                                                              
export function packFrequency(h, hdot, wave, pack) {
  const [hr,hi]=h,[tr,ti]=hdot,[kx,kz,ik]=wave,fx=kx*ik,fz=kz*ik;
  if(pack===0){const q=-kx*kz*ik;return [-fx*hi-fz*hr,fx*hr-fz*hi,hr-q*hi,hi+q*hr];}
  if(pack===1){const a=-kx*kx*ik,b=-kz*kz*ik;return [-kx*hi-kz*hr,kx*hr-kz*hi,a*hr-b*hi,a*hi+b*hr];}
  if(pack===2) return [-fx*ti-ti,fx*tr+tr,-fz*ti,fz*tr];
  throw Error('Invalid FFT pack');
}
export function positiveCompression(j,upper) {return j>0&&j<upper?1-((j/upper)**2*(3-2*j/upper)):0;}
export function shoreRetention(depth,hs) {
  const lo=Math.max(.12,.18*hs),hi=Math.max(.9,1.1*hs),t=Math.max(0,Math.min(1,(depth-lo)/(hi-lo)));
  return 1-t*t*(3-2*t);
}
