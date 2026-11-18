import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {FrameUniforms} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/math/index.js';
import {cloudWeatherKey} from './lighting_math.js';
import {volumeShadowModule} from './volume_transport.js';
import {CLOUD_VIEW_TRACE_WGSL,CLOUD_VIEW_RESOLVE_WGSL} from './cloud_view_shaders.js';
import {createCloudViewComposite} from './cloud_view_composite.js';

                                                                        
                                                                     
export class CloudView {
 constructor(field){
  this.field=field;this.frames=0;this.resets=0;this.valid=false;this.steps=256;this.scale=.5;
  const tex=(name,format='rgba16float')=>new Texture({label:'Camera cloud '+name,width:1,height:1,format,usage:['sample','storage','copySrc','copyDst']});
  this.raw=tex('raw scattering');this.rawT=tex('raw transmittance');this.rawAir=tex('raw air scattering');
  this.output=tex('resolved scattering');this.outputT=tex('resolved transmittance');this.outputAir=tex('resolved air scattering');
  this.history=tex('history scattering');this.historyT=tex('history transmittance');this.historyAir=tex('history air scattering');
  this.depth=tex('cloud depth','r32float');this.guide=tex('scene endpoint','r32float');
  this.historyDepth=tex('history cloud depth','r32float');this.historyGuide=tex('history scene endpoint','r32float');
  this.images=[this.raw,this.rawT,this.rawAir,this.output,this.outputT,this.outputAir,this.history,this.historyT,this.historyAir,this.depth,this.guide,this.historyDepth,this.historyGuide];
  this.emptyDepth=new Texture({label:'Depthless sky compiler placeholder',width:1,height:1,format:'depth32float',usage:['sample','render']});
  this.params=new UniformBlock('CameraCloudView',{
   previous:['mat4x4f',new Matrix4()],origin:['vec3f',[0,2,0]],valid:['f32',0],previousEye:['vec3f',[0,2,0]],enabled:['f32',0],
   size:['vec2f',[1,1]],frame:['u32',0],steps:['u32',256],air:['f32',1],disk:['f32',1],pad:['vec2f',[0,0]],
  });
  this.trace=new ComputeKernel({label:'Camera depth-clipped cloud and air trace',modules:[field.transportModule,volumeShadowModule],bindings:{
   lab:{uniform:this.params},sceneDepth:{texture:()=>this.sceneDepth??this.emptyDepth},raw:{storageTexture:this.raw},rawT:{storageTexture:this.rawT},
   rawAir:{storageTexture:this.rawAir},depth:{storageTexture:this.depth},guide:{storageTexture:this.guide}},workgroupSize:[8,8,1],code:CLOUD_VIEW_TRACE_WGSL});
  this.resolve=new ComputeKernel({label:'Camera cloud joint transport reprojection',modules:[field.densityModule],bindings:{
   lab:{uniform:this.params},raw:{texture:this.raw},rawT:{texture:this.rawT},rawAir:{texture:this.rawAir},depth:{texture:this.depth},guide:{texture:this.guide},
   history:{texture:this.history},historyT:{texture:this.historyT},historyAir:{texture:this.historyAir},historyDepth:{texture:this.historyDepth},historyGuide:{texture:this.historyGuide},
   resolved:{storageTexture:this.output},resolvedT:{storageTexture:this.outputT},resolvedAir:{storageTexture:this.outputAir}},workgroupSize:[8,8,1],code:CLOUD_VIEW_RESOLVE_WGSL});
  this.compositeModule=createCloudViewComposite(this);
 }
 disable(){this.params.fields.enabled.value=0;this.valid=false;}
 update(weather,camera,width,height,sceneDepth){
  if(!sceneDepth||sceneDepth.format!=='depth32float')throw Error('Camera cloud transport requires current native scene depth');
  if(!Number.isInteger(this.steps)||this.steps<1||this.steps>512||!Number.isFinite(this.scale)||this.scale<=0||this.scale>1)throw RangeError('Invalid camera cloud quality');
  if(width<1||height<1||sceneDepth.width!==width||sceneDepth.height!==height)throw Error('Camera cloud depth/viewport mismatch');
  this.sceneDepth=sceneDepth;
  const w=Math.max(1,Math.ceil(width*this.scale)),h=Math.max(1,Math.ceil(height*this.scale));
  if(w!==this.raw.width||h!==this.raw.height){for(const t of this.images)t.resize(w,h);this.valid=false;}
  const key=cloudWeatherKey(weather)+JSON.stringify([weather.solarIrradiance,weather.rayleigh,weather.mie,weather.turbidity,this.steps,weather.aerialEnabled,this.field.environmentFrame.revision]);
  const eye=camera.position.toArray();
  if(key!==this.key||this.eye&&Math.hypot(...eye.map((x,i)=>x-this.eye[i]))>300){this.valid=false;this.key=key;}
  if(!this.valid)this.resets++;
  const u=this.params.fields;u.origin.value=this.field.environmentFrame.pointToEnvironment(eye);u.previousEye.value=this.eye??eye;
  u.size.value=[w,h];u.valid.value=Number(this.valid);u.enabled.value=1;u.frame.value=this.frames++;u.steps.value=this.steps;
  u.air.value=Number(weather.aerialEnabled);u.disk.value=Number(weather.directEnabled&&weather.displaySun);
  u.previous.value=this.previous??new Matrix4();
  this.trace.dispatch(this.trace.groups(w,h));this.resolve.dispatch(this.resolve.groups(w,h));
  const encoder=GPU.getEncoder();
  for(const [a,b] of [[this.output,this.history],[this.outputT,this.historyT],[this.outputAir,this.historyAir],[this.depth,this.historyDepth],[this.guide,this.historyGuide]]){
   encoder.copyTextureToTexture({texture:a.getGPU()},{texture:b.getGPU()},[w,h]);
  }
  this.previous=FrameUniforms.fields.viewProjNoJitter.value.clone();this.eye=eye;this.valid=true;
 }
 metadata(){return {method:'current-depth-clipped joint cloud/air transport + depth-aware reconstruction',resolution:[this.raw.width,this.raw.height],
  steps:this.steps,sun_samples:16,frames:this.frames,history_resets:this.resets,history:'joint scattering/transmittance, scene-endpoint disocclusion rejection',
  precision:'f32 compute / rgba16float scattering and RGB transmittance / r32float depth guides',
  scope:'foreground, in-cloud and above-cloud views; native current scene depth terminates the ray; exact ray fallback at unmatched edges',
  scene_depth_is_modified:false,probe_captures_depend_on_camera:false};}
 dispose(){for(const t of this.images)t.destroy();this.emptyDepth.destroy();this.params.buffer?.destroy();}
}

