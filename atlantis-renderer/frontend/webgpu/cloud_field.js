import {ShaderModule, UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {commonModule} from '../../vendor/tidewater/src/engine/render/wgsl/common.js';
import {JOINT_SKY_WGSL} from './cloud_transport.js';
import {CloudNoise,PROCEDURAL_DENSITY_WGSL} from './cloud_noise.js';
import {CloudView} from './cloud_view.js';
import {DEFAULT_WEATHER, cloudWeatherKey, cloudLightFrame, cloudLightCascadePlan} from './lighting_math.js';
import {EnvironmentFrame} from './environment_frame.js';
import {cloudAdvection} from './cloud_advection.js';
import {CloudDaylight} from './cloud_daylight.js';

const BASE_GEOMETRY_WGSL =           `
// Grow 8m segments geometrically, then cap at 64m so distant cloud detail
// cannot fall between arbitrarily large samples. Do not renormalize the whole
// partition when ceil(count) changes between adjacent view rays.
fn apsCloudMarchDistance(index: f32) -> f32 {
 let knee=ceil(log(8.0)/log(1.035));let n=min(index,knee);
 return 8.0*(pow(1.035,n)-1.0)/.035+max(0.0,index-knee)*64.0;
}
fn apsCloudMarchCount(distance: f32) -> u32 {
 let knee=ceil(log(8.0)/log(1.035));let middle=apsCloudMarchDistance(knee);
 let growing=ceil(log(1.0+distance*.035/8.0)/log(1.035));
 return u32(clamp(select(growing,knee+ceil((distance-middle)/64.0),distance>middle),1.0,65536.0));
}
fn apsCloudHash(p: vec3f) -> f32 {
  // .1031 has a mathematical 10000-cell period for integer lattice points.
  // Make that period explicit, including negative corners at the wrap seam.
  let cell=p-floor(p/10000.0)*10000.0;
  var q = fract(cell * vec3f(.1031));
  q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z);
}
fn apsCloudNoiseShift(p:vec3f,shift:vec3i)->f32 {
  let c = floor(p)+vec3f(shift); let t = fract(p); let u = t*t*(3.0-2.0*t);
  return mix(mix(mix(apsCloudHash(c), apsCloudHash(c+vec3f(1,0,0)), u.x),
    mix(apsCloudHash(c+vec3f(0,1,0)), apsCloudHash(c+vec3f(1,1,0)), u.x), u.y),
    mix(mix(apsCloudHash(c+vec3f(0,0,1)), apsCloudHash(c+vec3f(1,0,1)), u.x),
    mix(apsCloudHash(c+vec3f(0,1,1)), apsCloudHash(c+vec3f(1,1,1)), u.x), u.y), u.z);
}
fn apsCloudNoise(p:vec3f)->f32{return apsCloudNoiseShift(p,vec3i(0));}
// Accepted stable curved altitude, roots, seed/noise/time and erosion.
fn apsCloudAltitude(p: vec3f) -> f32 {return (dot(p,p)+2.0*6360000.0*p.y)/(length(p+vec3f(0,6360000,0))+6360000.0);}
fn apsCloudSphere(p: vec3f,d: vec3f,radius: f32) -> vec2f {
 let b=dot(p,d)+6360000.0*d.y;let c=dot(p,p)+2.0*6360000.0*p.y+(6360000.0-radius)*(6360000.0+radius);
 let h=b*b-c;if(h<0.0){return vec2f(-1);}return vec2f(-b-sqrt(h),-b+sqrt(h));
}
fn apsCloudInterval(P: vec3f,D: vec3f) -> vec2f {
 let p=P-vec3f(0,cloudParams.ground,0);let outer=apsCloudSphere(p,D,6360000.0+cloudParams.altitude+cloudParams.thickness);
 let inner=apsCloudSphere(p,D,6360000.0+cloudParams.altitude);let h=apsCloudAltitude(p);var start=max(0.0,outer.x);var end=outer.y;
 if(h<cloudParams.altitude){start=max(start,inner.y);}else if(inner.x>0.0){end=min(end,inner.x);}return vec2f(start,max(start,end));
}
`;

export const CLOUD_DENSITY_WGSL=BASE_GEOMETRY_WGSL+PROCEDURAL_DENSITY_WGSL;

export const CLOUD_LOOKUP_WGSL =           `
fn apsCloudTauAt(light: vec3f, cascade: i32) -> f32 {
  let b = cloudParams.bounds[cascade];
  let halfTexel = .5 / cloudParams.resolution;
  let uv = clamp((light.xy-b.xy)*b.w+.5, vec2f(halfTexel), vec2f(1.0-halfTexel));
  let depth = cloudParams.depthBounds[cascade];
  let z = sat((light.z-depth.x)*depth.z)*(cloudParams.slices-1.0);
  let lo = i32(floor(z)); let hi = min(i32(cloudParams.slices)-1,lo+1);
  let pages = i32(cloudParams.slices)/4;
  let a = textureSampleLevel(apsCloudOptical, smpLinearClamp, uv, cascade*pages+lo/4, 0.0);
  let bTau = textureSampleLevel(apsCloudOptical, smpLinearClamp, uv, cascade*pages+hi/4, 0.0);
  return mix(a[lo%4], bTau[hi%4], fract(z));
}
fn apsCloudSunVisibilityEnvironment(P: vec3f) -> f32 {
  if (cloudParams.ready < .5 || cloudParams.sun.y <= .005) { return 1.0; }
  let interval = apsCloudInterval(P,cloudParams.sun);
  if(interval.y<=interval.x){return 1.0;}
  // Empty air below the cloud has identical visibility to its cloud entry.
  let q = P+cloudParams.sun*interval.x-vec3f(0,cloudParams.ground,0);
  let light = vec3f(dot(q,cloudParams.right),dot(q,cloudParams.up),dot(q,cloudParams.sun));
  var cascade = 3;
  for (var i=0; i<3; i++) {
    let b = cloudParams.bounds[i];
    let depth = cloudParams.depthBounds[i];
    if (max(max(abs(light.x-b.x),abs(light.y-b.y)),abs(light.z-(depth.x+depth.y)*.5)) < b.z*.45) { cascade=i; break; }
  }
  var tau = apsCloudTauAt(light, cascade);
  if (cascade < 3) {
    let b = cloudParams.bounds[cascade];
    let depth = cloudParams.depthBounds[cascade];
    let edge = max(max(abs(light.x-b.x),abs(light.y-b.y)),abs(light.z-(depth.x+depth.y)*.5))/b.z;
    tau = mix(tau, apsCloudTauAt(light,cascade+1), smoothstep(.35,.45,edge));
  }
  return exp(-clamp(tau,0.0,80.0));
}
fn apsCloudSunVisibility(P:vec3f)->f32 {return apsCloudSunVisibilityEnvironment(apsEnvironmentPoint(P));}
// Pinned native water materials query at the local water entry plane.
fn cloudsShadow(xz: vec2f) -> f32 {return apsCloudSunVisibility(vec3f(xz.x,frame.seaLevel,xz.y));}
`;

const CUBE_DIRECTION =           `
fn apsCloudCubeDir(face: u32, pixel: vec2u, size: u32) -> vec3f {
  let u = (f32(pixel.x)+.5)/f32(size)*2.0-1.0;
  let v = (f32(pixel.y)+.5)/f32(size)*2.0-1.0;
  var d = vec3f(-u,-v,-1);
  switch face {
    case 0u: {d=vec3f(1,-v,-u);} case 1u: {d=vec3f(-1,-v,u);}
    case 2u: {d=vec3f(u,1,v);} case 3u: {d=vec3f(u,-1,-v);}
    case 4u: {d=vec3f(u,-v,1);} default: {}
  }
  return normalize(d);
}
`;

export class CloudOpticalDepthField {
  constructor({resolution = 128, slices = 128, spans = [4096,16384,65536,262144], panoramaSize = 256, atmosphere = null,environmentFrame=null} = {}) {
    if (!Number.isInteger(resolution) || resolution < 32 || resolution > 256 || spans.length !== 4 || spans.some((s,i) => !Number.isFinite(s) || s <= 0 || (i && s <= spans[i-1]))) throw new RangeError('Invalid cloud cascade dimensions');
    if(!Number.isInteger(slices)||slices<16||slices>128||slices%4)throw new RangeError('Invalid cloud light slices');
    this.environmentFrame=environmentFrame??new EnvironmentFrame();this.ownsEnvironmentFrame=!environmentFrame;
    this.resolution=resolution; this.slices=slices; this.spans=[...spans]; this.centers=Array(4).fill(null);
    this.revision=0; this.builds=0; this.densityBuilds=0; this.panoramaBuilds=0; this.lastDispatches=0; this.disposed=false;
    this.optical = new Texture({label:'APS sun-aligned cloud optical-depth volume', width:resolution, height:resolution, depth:slices, dimension:'2d-array', format:'rgba16float', usage:['sample','storage','copySrc']});
    this.panorama = new Texture({label:'APS cached cloud radiance and transmittance', width:panoramaSize, height:panoramaSize, dimension:'cube', format:'rgba16float', usage:['sample','storage']});
    this.params = new UniformBlock('APSCloudParams', {
      bounds:['vec4f[4]',spans.map(s=>[0,0,s,1/s])], sun:['vec3f',[0,1,0]], ready:['f32',0],
      depthBounds:['vec4f[4]',spans.map(s=>[-s/2,s/2,1/s,0])],right:['vec3f',[1,0,0]],slices:['f32',slices],up:['vec3f',[0,0,1]],padBasis:['f32',0],
      coverage:['f32',DEFAULT_WEATHER.cloudCoverage], density:['f32',DEFAULT_WEATHER.cloudDensity], altitude:['f32',DEFAULT_WEATHER.cloudAltitude], thickness:['f32',DEFAULT_WEATHER.cloudThickness],
      seed:['f32',17], time:['f32',0], ground:['f32',0], resolution:['f32',resolution],
      shapePhase:['vec4f',[0,0,0,0]],billowPhase:['vec4f',[0,0,0,0]],finePhase:['vec4f',[0,0,0,0]],weatherPhase:['vec4f',[0,0,0,0]],
      weatherCell:['vec4i',[0,0,0,0]],
      probe:['vec3f',[0,2,0]], rayleigh:['f32',1], solar:['vec3f',[3.5,3.4,3.2]], mie:['f32',1],
    });
    this.noise=new CloudNoise();
    this.densityModule=new ShaderModule({name:'apsCloudDensity',deps:[commonModule,this.noise.module,this.environmentFrame.module],uniforms:this.params,uniformName:'cloudParams',code:CLOUD_DENSITY_WGSL});
    this.module=new ShaderModule({name:'apsCloudField',deps:[this.densityModule],bindings:{apsCloudOptical:{texture:this.optical,viewDimension:'2d-array'}},code:CLOUD_LOOKUP_WGSL});
    this.daylight=new CloudDaylight(atmosphere);
    this.transportModule=new ShaderModule({name:'apsCloudTransportInputs',deps:[this.module,this.daylight.module],code:''});
                                                                                               
    this.buildParams=spans.map((span,i)=>new UniformBlock('APSCloudBuild'+i,{bound:['vec4f',[0,0,span,1/span]],depth:['vec4f',[-span/2,span/2,1/span,0]]}));
    this.kernels=this.buildParams.map((params,cascade)=>new ComputeKernel({label:'APS cloud cascade '+cascade,
      modules:[this.densityModule],bindings:{build:{uniform:params},outOptical:{storageTexture:this.optical,viewDimension:'2d-array'}},workgroupSize:[8,8,1],
      code:          `
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= ${resolution}u || gid.y >= ${resolution}u) {return;}
  let xy = build.bound.xy + ((vec2f(gid.xy)+.5)/${resolution}.0-.5)*build.bound.z;
  let P = vec3f(0,cloudParams.ground,0)+cloudParams.right*xy.x+cloudParams.up*xy.y+cloudParams.sun*build.depth.x;
  let interval = apsCloudInterval(P,cloudParams.sun);
  let distance = min(max(0.0,interval.y-interval.x),60000.0);
  let steps = apsCloudMarchCount(distance);
  // Sweep one ray backwards through the fixed sun-perpendicular slice planes.
  // Every density segment is evaluated once, even though it serves 128 slices.
  var segment=steps-1u;
  var a=interval.x+min(distance,apsCloudMarchDistance(f32(segment)));
  var b=interval.x+distance;
  var cursor=b;var rho=apsCloudDensity(P+cloudParams.sun*(a+b)*.5);var tau=0.0;var page=vec4f(0);
  for(var slice=${slices-1};slice>=0;slice--){
    let cut=clamp(f32(slice)/${slices-1}.0*(build.depth.y-build.depth.x),interval.x,interval.x+distance);
    while(cursor>cut){
      let next=max(cut,a);tau+=rho*(cursor-next)*.0015;cursor=next;
      if(cut>=a||segment==0u){break;}
      segment--;b=a;a=interval.x+min(distance,apsCloudMarchDistance(f32(segment)));
      rho=apsCloudDensity(P+cloudParams.sun*(a+b)*.5);
    }
    page[slice%4]=clamp(tau,0.0,80.0);
    if(slice%4==0){textureStore(outOptical,gid.xy,${cascade*slices/4}i+slice/4,page);}
  }
}`
    }));
    this.panoramaKernel=new ComputeKernel({label:'APS depth-ordered air/cloud sky',modules:[this.transportModule],
      bindings:{outCloudCube:{storageTexture:this.panorama,viewDimension:'2d-array'}},workgroupSize:[8,8,1],code:          `${CUBE_DIRECTION}
${JOINT_SKY_WGSL}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=${panoramaSize}u || gid.y>=${panoramaSize}u){return;}
 textureStore(outCloudCube,gid.xy,i32(gid.z),apsJointSky(apsCloudCubeDir(gid.z,gid.xy,${panoramaSize}u)));
}`});
    this.view=new CloudView(this);
    this.skyModule=new ShaderModule({name:'apsCloudSky',deps:[this.module],bindings:{apsCloudCube:{texture:this.panorama,viewDimension:'cube'}},code:          `
fn cloudsSample(dir: vec3f) -> vec4f {return textureSampleLevel(apsCloudCube,smpLinearClamp,dir,0.0);}
fn cloudsSampleView(dir: vec3f) -> vec4f {
 // Intermediate background for opaque/water reflection inputs only. The
 // final camera sky is integrated at its real origin after scene depth.
 return cloudsSample(apsEnvironmentDirection(dir));
}
fn cloudsSunTransmittance(T: f32) -> f32 {return clamp(T,0.0,1.0);}
`});
  }
  invalidate() {this.weatherKey=null; this.panoramaKey=null; this.centers.fill(null); this.params.fields.ready.value=0;}
  update(weather, cameraPosition) {
    if(this.disposed) return false;
    this.noise.bake();
    const key=cloudWeatherKey(weather), dirty=key!==this.weatherKey;
    if(dirty) {this.centers.fill(null); this.weatherKey=key;}
    const u=this.params.fields;
    for(const [a,b] of Object.entries({coverage:'cloudCoverage',density:'cloudDensity',altitude:'cloudAltitude',thickness:'cloudThickness',seed:'cloudSeed',time:'cloudTime',ground:'groundHeight'})) u[a].value=weather[b];
    const advection=cloudAdvection(weather.cloudTime);
    u.shapePhase.value=advection.shape;u.billowPhase.value=advection.billows;u.finePhase.value=advection.fine;
    u.weatherCell.value=advection.weather.map(Math.floor);u.weatherPhase.value=advection.weather.map(v=>v-Math.floor(v));
    u.sun.value=weather.sunDirection;u.solar.value=weather.solarIrradiance;
    u.rayleigh.value=weather.rayleigh;u.mie.value=weather.mie*weather.turbidity/2;
    const frame=cloudLightFrame(weather.sunDirection);u.right.value=frame.right;u.up.value=frame.up;
    const active=weather.cloudCoverage>0 && weather.cloudDensity>0 && weather.sunDirection[1]>.005;
    const plan=active?cloudLightCascadePlan([cameraPosition.x,cameraPosition.y-weather.groundHeight,cameraPosition.z],frame,weather.cloudAltitude+weather.cloudThickness*.5,this.spans,this.centers,this.resolution):[];
    const fromBank=this.dailyBank?.select(weather,cameraPosition)??false;
    this.lastDispatches=0;
    for(const {index,center} of plan) {
      const s=this.spans[index], b=[center[0],center[1],s,1/s],depth=[center[2]-s/2,center[2]+s/2,1/s,0];
      this.buildParams[index].fields.bound.value=b; u.bounds.value[index]=b;
      this.buildParams[index].fields.depth.value=depth;u.depthBounds.value[index]=depth;
      if(fromBank)this.dailyBank.dispatch(index);else{this.kernels[index].dispatch([Math.ceil(this.resolution/8),Math.ceil(this.resolution/8),1]);this.densityBuilds++;}
      this.centers[index]=center; this.builds++; this.lastDispatches++;
    }
    u.ready.value=active?1:0;
    if(dirty || plan.length) this.revision++;
    return dirty || plan.length>0;
  }
  updatePanorama(weather, cameraPosition, atmosphereKey) {
    const key=JSON.stringify([atmosphereKey,this.revision,weather.probePosition]);
    if(key===this.panoramaKey) return false;
                                                                     
    this.params.fields.probe.value=weather.probePosition;
    this.daylight.update(atmosphereKey);
    this.panoramaKernel.dispatch(this.panoramaKernel.groups(this.panorama.width,this.panorama.height,6));
    this.panoramaKey=key; this.panoramaBuilds++; return true;
  }
  async precomputeDaily(weather,cameraPosition,onProgress){
    throw Error('Lab density has a new definition: daily bank format versioning is required before export');
    const {CloudDailyOpticalBank}=await import('./cloud_daily_bank.js');
    const bank=new CloudDailyOpticalBank(this);
    try{await bank.precompute(weather,cameraPosition,onProgress);}catch(e){bank.dispose();throw e;}
    this.dailyBank?.dispose();this.dailyBank=bank;this.invalidate();return bank.metadata();
  }
  async loadDaily(blob){
    throw Error('Lab density differs from production: legacy daily optical banks cannot be imported');
    const {CloudDailyOpticalBank}=await import('./cloud_daily_bank.js');
    const bank=await CloudDailyOpticalBank.fromBlob(this,blob);
    this.dailyBank?.dispose();this.dailyBank=bank;this.invalidate();return bank.metadata();
  }
  metadata() {return {experiment:'shared procedural cloud transport',view:this.view.metadata(),density:'world-space envelope / weather coverage / height profiles / cellular erosion',noise:{revision:this.noise.coordinateRevision,envelope:[this.noise.base.width,this.noise.base.height],detail:[this.noise.detail.width,this.noise.detail.height,this.noise.detail.depth]},method:'WGSL direct cloud self-shadow plus ground optical-depth cascades',resolution:this.resolution,spans_m:this.spans,
    panorama_resolution:[this.panorama.width,this.panorama.height],panorama_faces:6,
    daily_precomputation:this.dailyBank?.metadata()??null,
    cloud_integration:{distribution:'geometric segment lengths, near to far, capped',first_step_m:8,growth:1.035,max_step_m:64,max_steps:65536,height_slice_weight:'partial segment overlap',partition:'absolute segment lengths; last segment clipped'},
    light_slices:this.slices,slice_axis:'towards sun; planes perpendicular to sunlight',light_basis:{right:this.params.fields.right.value,up:this.params.fields.up.value,sun:this.params.fields.sun.value},depth_bounds:this.params.fields.depthBounds.value,format:'rgba16float array: '+this.slices/4+' RGBA light-depth pages per cascade',centers:this.centers,
    revision:this.revision,build_dispatches:this.builds,density_build_dispatches:this.densityBuilds,last_dispatches:this.lastDispatches,panorama_bakes:this.panoramaBuilds,
    ready:!!this.params.fields.ready.value,per_pixel_solar_density_march:true,cache:'OutdoorLighting anchors cloud shadow and IBL at the accepted probe; view renders each frame; live yaw rotates queries only',
    limits:'60km column trace, '+this.slices+' sun-aligned slices, 24 quadratic air steps per segment; cloud segments grow from 8m to a 64m cap, max 65536; '+this.panorama.width+'px joint sky cube; outer field clamps, solar elevation <= .005 disables cloud sun shadow'};}
  dispose() {if(this.disposed)return; this.disposed=true;this.dailyBank?.dispose();this.params.fields.ready.value=0;this.view.dispose();this.daylight.dispose();this.noise.dispose();this.optical.destroy();this.panorama.destroy();this.params.buffer?.destroy();for(const p of this.buildParams)p.buffer?.destroy();if(this.ownsEnvironmentFrame)this.environmentFrame.dispose();}
}
