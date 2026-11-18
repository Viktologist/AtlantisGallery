import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {commonModule} from '../../vendor/tidewater/src/engine/render/wgsl/common.js';
import {CLOUD_FINE_SCALE} from './cloud_advection.js';

                                                                              
                                                                    
                                                                  

                                                                         
                                                                         
const NOISE =           `
fn ncWrap(p:vec3i,n:i32)->vec3u {return vec3u((p%n+n)%n);}
fn ncHash(p:vec3i,n:i32)->vec3f {return vec3f(pcg3(ncWrap(p,n)+vec3u(17,71,103)))/4294967295.0;}
fn ncWorley(p:vec3f,n:i32)->f32 {
 let c=vec3i(floor(p));let f=fract(p);var d=4.0;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let k=vec3i(x,y,z);let v=vec3f(k)+ncHash(c+k,n)-f;d=min(d,dot(v,v));
 }}}
 // The reference cellular spectrum uses squared distance. Taking sqrt here
 // changes both its lobe profile and the density remapping distribution.
 return 1.0-clamp(d,0.0,1.0);
}
fn ncValue(p:vec3f,n:i32)->f32 {
 let c=vec3i(floor(p));let f=fract(p);let u=f*f*(3.0-2.0*f);var v=0.0;
 for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let k=vec3i(x,y,z);let w=mix(1.0-u,u,vec3f(k));v+=ncHash(c+k,n).x*w.x*w.y*w.z;
 }}}
 return v;
}
fn ncCellFbm(p:vec3f,base:i32)->f32 {
 return (ncWorley(p*f32(base),base)+.5*ncWorley(p*f32(base*2),base*2)+.25*ncWorley(p*f32(base*4),base*4))/1.75;
}
`;
export class CloudNoise {
 constructor(){
  this.coordinateRevision='himalayas-swiss-envelope-4-fine-fringe';
  this.base=new Texture({label:'Himalayas multiscale cloud envelope',width:512,height:512,format:'rgba16float',usage:['sample','storage']});
  this.detail=new Texture({label:'Multiband cellular cloud erosion',dimension:'3d',width:96,height:96,depth:96,format:'rgba16float',usage:['sample','storage']});
  this.kernels=[this.base,this.detail].map((texture,index)=>new ComputeKernel({label:'Cloud bake '+texture.label,modules:[commonModule],bindings:{outNoise:{storageTexture:texture}},workgroupSize:index?[4,4,4]:[8,8,1],code:`${NOISE}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id>=vec3u(${texture.width}u))){return;}let uv=${index?'(vec3f(id)+.5)/96.0':'vec3f((vec2f(id.xy)+.5)/512.0,.5)'};
 ${index ? `
 let w1=ncWorley(uv*8.0,8);let w2=ncWorley(uv*16.0,16);
 // Himalayas' erosion texture contains nested cellular spectra rather than
 // three single Worley octaves. Resolve their small lobes in a real 3D bake.
 let a=(8.0*ncWorley(uv*3.0,3)+4.0*ncWorley(uv*6.0,6)+2.0*ncWorley(uv*12.0,12)+ncWorley(uv*24.0,24))/15.0;
 let b=(4.0*w1+2.0*w2+ncWorley(uv*32.0,32))/7.0;
 let c=(4.0*w2+2.0*ncWorley(uv*32.0,32)+ncWorley(uv*48.0,48))/7.0;
 textureStore(outNoise,id,vec4f(a,b,c,1));` : `
 var f=4;var amplitude=1.0;var sum=0.0;var weight=0.0;
 for(var octave=0;octave<6;octave++){sum+=amplitude*ncValue(uv*f32(f),f);weight+=amplitude;f*=2;amplitude*=.5;}
 let cellular=(ncCellFbm(uv,9)+.125*ncWorley(uv*72.0,72)+.0625*ncWorley(uv*144.0,144))/1.1875;
 let envelope=(.1+.9*sum/weight)*(.3+.7*cellular);
 let threshold=.625*ncCellFbm(uv,15)+.25*ncCellFbm(uv,19)+.125*ncCellFbm(uv,23)-1.0;
 textureStore(outNoise,id.xy,vec4f(envelope,threshold,1.0-cellular,1));`}
}` }));
  this.module=new ShaderModule({name:'labCloudNoiseTextures',deps:[commonModule],bindings:{labBaseNoise:{texture:this.base},labDetailNoise:{texture:this.detail}}});
 }
 bake(){if(this.baked)return;this.kernels[0].dispatch(this.kernels[0].groups(512,512,1));this.kernels[1].dispatch(this.kernels[1].groups(96,96,96));this.baked=true;}
 dispose(){this.base.destroy();this.detail.destroy();}
}

                                                                             
                                                                               
                                                                      
export const PROCEDURAL_DENSITY_WGSL=          `
// One envelope fetch and two different-scale 3D erosion fetches. Rotate the
// fields away from world axes and warp them with world-space weather.
// Weather is evaluated in world space, so its warp does not repeat with the tile.
fn labCloudWarp(weather:f32,kindNoise:f32)->vec3f {
 return vec3f(weather-.5,kindNoise-.5,weather-kindNoise)*.85;
}
fn labCloudShapeUVW(q:vec3f,weather:f32,kindNoise:f32)->vec2f {
 let rotation=mat2x2f(.8,.6,-.6,.8);
 return rotation*q.xz+labCloudWarp(weather,kindNoise).xz*.453;
}
fn labCloudDetailUVW(q:vec3f,weather:f32,kindNoise:f32)->vec3f {
 let rotation=mat3x3f(vec3f(.54403737,.77122213,-.33051439),vec3f(-.73685072,.25072219,-.62784504),vec3f(-.40134070,.58511093,.70467783));
 return rotation*q+labCloudWarp(weather,kindNoise)*.37;
}
fn labHeightProfile(h:f32,kind:f32)->f32 {
 let stratus=vec4f(.02,.05,.09,.11);let stratocumulus=vec4f(.02,.2,.48,.625);let cumulus=vec4f(.01,.0625,.78,1);
 let g=stratus*(1.0-clamp(kind*2.0,0.0,1.0))+stratocumulus*(1.0-abs(kind-.5)*2.0)+cumulus*clamp(kind-.5,0.0,.5)*2.0;
 return smoothstep(g.x,g.y,h)-smoothstep(g.z,g.w,h);
}
fn apsCloudDensity(P:vec3f)->f32 {
 let p=P-vec3f(0,cloudParams.ground,0);let h=(apsCloudAltitude(p)-cloudParams.altitude)/cloudParams.thickness;
 if(h<=0.0||h>=1.0||cloudParams.coverage<=0.0||cloudParams.density<=0.0){return 0.0;}
 let seed=vec3f(cloudParams.seed*.173,cloudParams.seed*.037,cloudParams.seed*.317);
 // Himalayas base UV frequency .00005*1.51 per metre. The baked base
 // combines four-cell value structure with nine-cell cellular billows
 // (~1.47km), then 19/23-cell shoulders. Retain
 // independent horizontal envelope and 3D detail rotations. The density is
 // volumetric, with its roof, underside and erosion varying through height.
 // Swiss Alps' height-dependent 250m shear keeps the crown off its base.
 let sheared=p+vec3f(.96152395,0,.27472113)*(250.0*h);
 let q=sheared*vec3f(1,1.8,1)*.0000755+seed;
 // Keep the weather warp at its prior physical scale while enlarging tiles.
 let weatherQ=p/6000.0+seed;
 let weather=apsCloudNoiseShift(vec3f(weatherQ.x*.7+cloudParams.weatherPhase.x,3.7,weatherQ.z*.7+cloudParams.weatherPhase.y),vec3i(cloudParams.weatherCell.x,0,cloudParams.weatherCell.y));
 let kindNoise=apsCloudNoiseShift(vec3f(weatherQ.x+cloudParams.weatherPhase.z,8.3,weatherQ.z+cloudParams.weatherPhase.w),vec3i(cloudParams.weatherCell.z,0,cloudParams.weatherCell.w));let kind=clamp(.68+.3*kindNoise,0.0,1.0);
 let coverage=clamp(cloudParams.coverage*(.65+.65*weather),0.0,1.0);
 let n=textureSampleLevel(labBaseNoise,smpLinearRepeat,labCloudShapeUVW(q,weather,kindNoise)+cloudParams.shapePhase.xy,0);
 let envelope=h*h*n.b+pow(1.0-h,12.0);
 let shape=clamp((n.r-envelope-n.g)/max(1.0-n.g,.001),0.0,1.0);
 // Both references shape the upper envelope with h^2 modulated by a
 // separate cellular channel and suppress the underside with (1-h)^N.
 // Use bounded envelope subtraction; coverage retains the public meaning
 // that larger values produce more cloud, including the exact clear case.
 var body=shape*labHeightProfile(h,kind)-(1.0-coverage);
 if(body<=0.0){return 0.0;}
 // Separate billow and fringe bands: the old one-frequency cut could only
 // nibble the silhouette, leaving the several-hundred-metre folds smooth.
 let billows=textureSampleLevel(labDetailNoise,smpLinearRepeat,labCloudDetailUVW(sheared/2200.0+seed,weather,kindNoise)+cloudParams.billowPhase.xyz,0).rgb;
 let detail=textureSampleLevel(labDetailNoise,smpLinearRepeat,labCloudDetailUVW(sheared/${CLOUD_FINE_SCALE.toFixed(1)}+seed,weather,kindNoise)+cloudParams.finePhase.xyz,0).rgb;
 // Reuse the existing three texture bands: more fine cellular spectrum,
 // same fetch count and normalized weights; preserve the large envelope.
 let fringe=dot(detail,vec3f(.375,.375,.25));
 let erosion=mix(fringe,1.0-fringe,clamp(h*4.0,0.0,1.0));
 // Erode the boundary, preserve the dense billowing interior. Himalayas
 // uses .225 detail strength; Swiss Alps skips erosion inside dense cores.
 let edge=1.0-smoothstep(.5,1.0,shape);
 let cut=(.10*(1.0-dot(billows,vec3f(.625,.25,.125)))+.225*erosion)*edge;
 // Himalayas finishes the eroded envelope with a narrow smooth boundary.
 // Without this step the full interior is a shallow density ramp: silhouettes
 // blur together and self-shadow loses the cauliflower-scale folds.
 body=smoothstep(0.0,.10,body-cut);
 return pow(body,(1.0-h)*.8+.5)*cloudParams.density*3.0;
}
`;
