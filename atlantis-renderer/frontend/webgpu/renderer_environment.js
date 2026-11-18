                                                                                  
                                                                               
                                                                           
import {normalizeRenderScale} from './render_resolution.js';
export const OCEAN_CONFIG_KEYS=Object.freeze(['sealevel','stormylevel','oceantype','seed','winddirection','quality','enabled','wetness','caustics','spray','reflections','maxDistance','choppiness','causticShadowAttenuation','causticCascadeMask','causticMinimumStep','shoreShadowFadeDistance','shallowDepthDisplayMax']);
const clone=value=>Array.isArray(value)?value.map(clone):value!==null&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)])):value;
export function normalizeRendererEnvironment(input={}){
                                                                                   
 if(input?.rendering?.renderScale!==undefined)normalizeRenderScale(input.rendering.renderScale);
 return clone(input!==null&&typeof input==='object'&&!Array.isArray(input)?input:{});
}
export function oceanSettings(ocean){
 if(!ocean)return null;
 const config=Object.fromEntries(OCEAN_CONFIG_KEYS.filter(key=>ocean.config[key]!==undefined).map(key=>[key,ocean.config[key]]));
 config.enabled=ocean.enabled;
 for(const [key,block,field] of [['caustics',ocean.shore?.params,'caustics'],['causticShadowAttenuation',ocean.caustics?.params,'shadowAttenuation'],['causticCascadeMask',ocean.caustics?.params,'cascadeMask'],['causticMinimumStep',ocean.caustics?.params,'minimumStep'],['shoreShadowFadeDistance',ocean.receiverParams,'shadowFadeDistance'],['shallowDepthDisplayMax',ocean.receiverParams,'depthDisplayMax']]){
  const value=block?.get(field);if(value!==undefined)config[key]=key==='caustics'?!!value:value;
 }
 return {config,paused:ocean.paused,time:ocean.time};
}
export function rendererEnvironment(viewer){
 return {weather:clone(viewer.lighting.weather),post:clone(viewer.renderPipeline.options),shadows:{enabled:viewer.shadows.enabled},rendering:{renderScale:viewer.renderScale??1},...(viewer.lighting.localLightData!==undefined?{local_lights:clone(viewer.lighting.localLightData)}:{}),...(viewer.ocean?{ocean:oceanSettings(viewer.ocean)}:{})};
}
export async function applyRendererEnvironment(viewer,input={}){
 const patch=normalizeRendererEnvironment(input),enabled=patch.shadows?.enabled??viewer.shadows?.enabled;
 if(patch.rendering?.renderScale!==undefined)viewer.setRenderScale(patch.rendering.renderScale);
 if(patch.weather)viewer.lighting.setWeather(patch.weather);
 if(Object.hasOwn(patch,'local_lights'))viewer.lighting.setLocalLights(clone(patch.local_lights));
                                                                                 
 if(enabled!==undefined)viewer.shadows.enabled=enabled;
 if(patch.post)viewer.renderPipeline.setOptions(patch.post);
 if(patch.ocean){
  if(patch.ocean.config){
   const current=oceanSettings(viewer.ocean),config={...current?.config,...patch.ocean.config};
   const live={enabled:'setEnabled',choppiness:'setChoppiness',maxDistance:'setMaxDistance',caustics:'setCausticsEnabled',causticShadowAttenuation:'setCausticShadowAttenuation',causticCascadeMask:'setCausticCascadeMask',causticMinimumStep:'setCausticMinimumStep',shoreShadowFadeDistance:'setShoreShadowFadeDistance',shallowDepthDisplayMax:'setShallowDepthDisplayMax'};
   if(viewer.ocean&&Object.keys(patch.ocean.config).every(key=>live[key]))for(const [key,value] of Object.entries(patch.ocean.config))viewer.ocean[live[key]](value);
   else await viewer.setOcean(config);
  }
  if(!viewer.ocean)throw Error('Ocean runtime options require a loaded ocean or environment.ocean.config');
  if(patch.ocean.paused!==undefined)viewer.ocean.paused=patch.ocean.paused;
  if(patch.ocean.time!==undefined)viewer.ocean.setReplayTime(patch.ocean.time);
 }
}
