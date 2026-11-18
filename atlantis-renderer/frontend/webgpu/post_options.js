import {normalizeCameraOptions,projectCameraSun,cameraEV100 as baseCameraEV100} from '../src/physical_camera_math.js';

                                                                          
                                                                              
const defaults=Object.freeze({ssao:true,ssaoRadius:1,ssaoIntensity:1,ssaoBias:.02,
 fogVolumetric:true,fogShadows:true,fogSteps:48,fogAnisotropy:.5,fogSunIntensity:1,fogAmbientIntensity:1,
 fog:true,fogDensity:.0005,fogColor:[.45,.55,.65],fogBaseHeight:0,fogHeightFalloff:.02,fogStart:0,fogMaxDistance:10000,fogMaxOpacity:.95,bloomMaxBrightness:64,lightShaftOcclusion:true,lightShaftBloom:true,
 lightShaftOcclusionDepthRange:1000,lightShaftOcclusionMaskDarkness:.05,
 lightShaftBloomScale:1,lightShaftBloomThreshold:1,lightShaftBloomTint:[1,1,1],
 lightShaftBloomAngularRadius:12,lightShaftOverrideDirection:[0,0,0]});
                                                                         
                                                                                
const cameraKeys=Object.freeze(['focalLength','sensorWidth','aperture','shutter','iso','exposureCompensation','radianceScale','autoExposure','minEV','maxEV','adaptationUp','adaptationDown','bloom','bloomThreshold','focusDistance','depthOfField','glow','lightShafts','lightShaftDensity','lightShaftDecay','lightShaftSamples','vignette','grain']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};
export function normalizePostOptions(input={},previous={}){
 const base=value=>Object.fromEntries(Object.entries(plain(value)).filter(([key])=>cameraKeys.includes(key)));
 const result={...normalizeCameraOptions(base(input),base(previous)),...defaults};
 for(const k of Object.keys(defaults))result[k]=Object.hasOwn(plain(input),k)?input[k]:plain(previous)[k]??defaults[k];
 for(const k of ['fogColor','lightShaftBloomTint','lightShaftOverrideDirection'])if(Array.isArray(result[k]))result[k]=Object.freeze([...result[k]]);
 return Object.freeze(result);
}
export function cameraEV100(options){return baseCameraEV100({aperture:options.aperture,shutter:options.shutter,iso:options.iso});}
export function projectLightShaftSun(sun,view,projection,override=[0,0,0]){
 const direction=Math.hypot(...override)>1e-8?override:sun;
 const projected=projectCameraSun(direction,view,projection);
 if(!projected.uv)return {...projected,fade:0,direction};
 const d=direction.map(x=>x/Math.hypot(...direction));
 const cosine=-(view[2]*d[0]+view[6]*d[1]+view[10]*d[2]);
 const t=Math.max(0,Math.min(1,cosine/.2));
 return {...projected,uv:[projected.uv[0],1-projected.uv[1]],fade:t*t*(3-2*t),direction:d};
}
