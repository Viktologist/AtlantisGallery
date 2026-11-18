import {Atmosphere} from '../../vendor/tidewater/src/sky/Atmosphere.js';
import {Environment} from '../../vendor/tidewater/src/sky/Environment.js';
import {Sky} from '../../vendor/tidewater/src/sky/Sky.js';
import {ShaderModule, UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {SceneLighting} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {skyWeatherKey} from './lighting_math.js';

export function destroyUniform(block) {if(block?.buffer){block.buffer.destroy();block.buffer=null;}}
export function destroyReadback(readback) {if(!readback)return; readback.onData=null;for(const slot of readback.ring)slot.buffer?.destroy();}
export function releaseAfterSubmit(release) {if(GPU.encoder)GPU.onSubmit(null,release);else release();}

                                                                                              
export class CachedAtmosphere extends Atmosphere {
  constructor(renderer=null) {
    super(renderer);this.skyUpdates=0;this.staticUpdates=0;
    const skyDispatch=this.skyViewKernel.dispatch.bind(this.skyViewKernel);
    this.skyViewKernel.dispatch=(...args)=>{this.skyUpdates++;return skyDispatch(...args);};
    const staticDispatch=this.transmittanceKernel.dispatch.bind(this.transmittanceKernel);
    this.transmittanceKernel.dispatch=(...args)=>{this.staticUpdates++;return staticDispatch(...args);};
  }
  updateWeather(dt, height, weather) {
    const probeHeight=weather.probePosition[1],key=skyWeatherKey(weather,probeHeight);
    if(key!==this.cacheKey){this.cacheKey=key;this.irrDirty=true;}
    const wasPending=this._irrPending;
    this._irrTimer=this.irrDirty&&!wasPending?0:Infinity;
    super.update(0,probeHeight-weather.groundHeight);
    if(!wasPending && this._irrPending){this.irrDirty=false;this.irrRequestKey=key;}
    return key;
  }
  _onIrradiance(buf) {
    if(this.irrRequestKey!==this.cacheKey){this._irrPending=false;return;}
    super._onIrradiance(buf);
  }
  dispose() {
    this.onIrradiance=null; destroyReadback(this.readback);
    for(const texture of [this.transmittanceLUT,this.multiScatLUT,this.skyViewLUT])texture.destroy();
    this.irrBuffer.destroy(); destroyUniform(this.params);
  }
}

                                                                                      
export class OutdoorSky extends Sky {
  constructor(atmosphere){super(atmosphere);this.solar=new UniformBlock('APSDisplaySolar',{irradiance:['vec3f',[0,0,0]],pad:['f32',0]});}
  _buildModule() {
    return new ShaderModule({name:'apsOutdoorSky',deps:[this.clouds.module],uniforms:this.solar,uniformName:'apsDisplaySolar',code:          `
fn skySolarRadiance(disk: f32) -> vec3f {
 return apsDisplaySolar.irradiance/(PI*pow(sin(0.004675),2.0))*disk*skyParams.sunDiskIntensity;
}
fn apsCanonicalSunDisk(dir: vec3f) -> vec3f {return skySolarRadiance(step(cos(0.004675),dot(dir,cloudParams.sun)));}
fn skySunDisk(dir:vec3f)->vec3f {return apsCanonicalSunDisk(apsEnvironmentDirection(dir));}
fn skyDisplayDisk(dir: vec3f) -> vec3f {
 let mu=dot(apsEnvironmentDirection(dir),cloudParams.sun);let edge=cos(0.004675);let width=max(fwidth(mu),1e-7);
 let disk=smoothstep(edge-width,edge+width,mu);
 return skySolarRadiance(disk);
}
fn skyRadianceWithClouds(dir: vec3f,withSun: bool) -> vec3f {
 let c=cloudsSample(dir);var L=c.rgb;if(withSun){L+=apsCanonicalSunDisk(dir)*c.a;}return L;
}
fn skyReflectionRadiance(dir: vec3f) -> vec3f {return cloudsSample(apsEnvironmentDirection(dir)).rgb;}
fn skyViewRadiance(dir: vec3f) -> vec3f {
 let c=cloudsSampleView(dir);return c.rgb*frame.envIntensity+skyDisplayDisk(dir)*c.a;
}
` ,bindings:{skyParams:{uniform:this.params}}});
  }
}

export class CachedEnvironment extends Environment {
  updateKey(key) {
    if(key===this.cacheKey)return false;
    super.update(0,true);                                                                 
    this.cacheKey=key;this.bakes=(this.bakes||0)+1;return true;
  }
  dispose() {
    this.source.destroy();for(const t of this.targets)t.destroy();for(const b of this.sh)b.destroy();
    destroyUniform(this.envUniforms);
  }
}

                                                                                             
export function combinedDirectModule(cloudModule, base = null, terrainModule = null) {
  let adapted=base;
  if(base) {
    if(!/\bfn\s+hookDirectModulation\s*\(/.test(base.code)) throw new Error('Ocean directModulationModule must define hookDirectModulation(P,N) -> vec3f');
    adapted=new ShaderModule({name:'apsOceanDirectAdapter',deps:base.deps,bindings:base.bindings,
      code:base.code.replace(/\bhookDirectModulation\b/g,'apsOceanDirectModulation')});
  }
  return new ShaderModule({name:'apsCombinedSunModulation',deps:[cloudModule,adapted,terrainModule].filter(Boolean),code:          `
fn apsHookReceiverShadow(P:vec3f,visibility:f32)->f32 {
 return ${base&&/fn\s+oceanReceiverShadowVisibility\(/.test(base.code)?'oceanReceiverShadowVisibility(P,visibility)':'visibility'};
}
fn hookDirectModulation(P: vec3f, N: vec3f) -> vec3f {
  var modulation=vec3f(apsCloudSunVisibility(P));
  ${base?'modulation *= apsOceanDirectModulation(P,N);':''}
  // Terrain and other native receivers apply the CSM once in their BRDF.
  return modulation;
}`});
}
export function captureHooks() {return {...SceneLighting.hooks};}
