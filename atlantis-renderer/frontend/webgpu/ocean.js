import {GPU,G,ShaderModule,Texture,StorageBuffer,UniformBlock,ComputeKernel,generateMipmaps,LAYERS} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Mesh,BufferGeometry,Float32BufferAttribute,Uint32BufferAttribute} from '../../vendor/tidewater/src/engine/index.js';
import {buildOceanScreenGrid} from '../src/ocean_math.js';
import {createFoamDetail} from '../src/ocean_foam_detail.js';
import {oceanConfig,OCEAN_REFERENCE} from './ocean_numeric.js';
import {NativeOceanFFT512} from './ocean_fft.js';
import {NativeShore} from './ocean_shore.js';
import {NativeWaterSurface} from './ocean_surface.js';
import {OceanPhysicalMaterial,OceanScreenSpaceReflection,RefractionPass,oceanReceiverModule} from './ocean_optics.js';
import {OceanSpray} from './ocean_spray.js';
import {OceanCaustics} from './ocean_caustics.js';
import {causticCascadeMask,causticMinimumStep} from './ocean_caustic_options.js';
import {OCEAN_RESIDUE_WGSL} from './ocean_foam.js';
import {OCEAN_RECEIVER_SURFACE_WGSL,oceanSimulationStep} from './ocean_surface_contract.js';
import {shoreShadowFadeDistance,shallowDepthDisplayMax,OCEAN_SHALLOW_DEPTH_WGSL} from './ocean_shore_controls.js';
import {unlinkWaterHook} from './water_hook_chain.js';

export class Ocean {
  constructor(viewer,config={},terrainApi=null,options={}) {
    this.viewer=viewer;this.config=oceanConfig(config);this.terrainApi=terrainApi??viewer.heightfield??null;this.time=0;this.paused=false;this.disposed=false;this.initialized=false;this.enabled=this.config.enabled;
    this.integrationNeeds=[];this.pipelineHandles=[];
    this.shoreReview=options.shoreReview??null;
    this.foamLOD=options.foamLOD??{};
  }
  async init() {
    if(this.disposed)throw Error('Ocean disposed');if(this.initialized)return this;
    const v=this.viewer;
    const started=performance.now();v.oceanStartupTrace=[];
    const stage=async name=>{
      const record={stage:name,elapsed_ms:Math.round(performance.now()-started)};
      v.oceanStartupTrace.push(record);v.options?.onLoadProgress?.('海面 · '+name);
      console.info('Ocean startup',record);
      await new Promise(resolve=>setTimeout(resolve,0));
      if(this.disposed||v.disposed)throw Error('Ocean initialization cancelled');
    };
    if(!GPU.device)throw Error('Ocean requires the coordinator-initialized pinned GPU singleton');
    const storageBuffers=GPU.limits.maxStorageBuffersPerShaderStage;
    if(storageBuffers<11)throw Error(`Ocean rendering requires maxStorageBuffersPerShaderStage >= 11; this device supports ${storageBuffers}. Ordinary model viewing remains available.`);
    if(!v.scene||!v.camera||!v.meshRenderer||!v.sceneRenderer?.opaqueCopy)throw Error('Ocean requires engine scene/camera/meshRenderer/sceneRenderer.opaqueCopy');
    if(!v.lighting?.sky?.module)throw Error('Await viewer.lighting.init() before Ocean.init(): native sky.module is required');
    const fftThreads=this.config.fftSize/2,fftSharedBytes=this.config.fftSize*16;
    if(GPU.limits.maxComputeInvocationsPerWorkgroup<fftThreads||GPU.limits.maxComputeWorkgroupSizeX<fftThreads||GPU.limits.maxComputeWorkgroupStorageSize<fftSharedBytes||GPU.limits.maxStorageTexturesPerShaderStage<4)throw Error(`Ocean FFT${this.config.fftSize} needs ${fftThreads} threads, ${fftSharedBytes}-byte shared storage and four storage textures`);
    try {
      await stage('FFT 输入');this.fft=new NativeOceanFFT512(this.config);
      await stage('岸线与浪涌场');this.shore=new NativeShore(this.config,this.terrainApi,this.shoreReview,this.foamLOD);
      await stage('海面着色器');
      this.surface=new NativeWaterSurface(this.fft,this.shore,this.terrainApi,this.config);
                                                                               
                                                                                 
      await stage('泡沫纹理');
      const detail=createFoamDetail(512),bytes=new Uint8Array(detail.data.length);detail.data.forEach((x,i)=>bytes[i]=Math.round(Math.max(0,Math.min(1,x))*255));
      this.foamTexture=new Texture({label:'accepted ocean microscopic foam pores',width:512,height:512,format:'rgba8unorm',mips:true,data:bytes});this.foamTexture.getGPU();generateMipmaps(this.foamTexture);
      await stage('岸线 GPU 页面');this.surface.foamTexture=this.foamTexture;this.shore.attach(this.surface);
      this.surfaceModule=this.surface.module;
      this.receiverParams=new UniformBlock('OceanReceiverOptions',{shadowFadeDistance:['f32',this.config.shoreShadowFadeDistance],depthDisplayMax:['f32',this.config.shallowDepthDisplayMax]});
      this.receiverModule=oceanReceiverModule(this.surface,this.shore,this.receiverParams);
      await stage('焦散与光学');this.caustics=new OceanCaustics(this);
      this.terrainWetnessModule=new ShaderModule({name:'oceanTerrainWetness',deps:[this.receiverModule],bindings:{oceanFoamPores:{texture:this.foamTexture}},code:OCEAN_RESIDUE_WGSL+OCEAN_RECEIVER_SURFACE_WGSL+OCEAN_SHALLOW_DEPTH_WGSL});
      this.receiverSurfaceModule=this.terrainWetnessModule;
      this.wetnessModule=this.terrainWetnessModule;
      this.directModulationModule=new ShaderModule({name:'oceanSceneDirectModulation',deps:[this.caustics.module],code:`
fn hookDirectModulation(P:vec3f,N:vec3f)->vec3f {
 if(shoreP.enabled==0u){return vec3f(1.0);}
 let footprint=max(0.08,max(length(lightDPdx.xz),length(lightDPdy.xz)));
 #if UNDERWATER_LIGHTING == 0
 return vec3f(1.0);
 #else
 return oceanReceiverDirectModulation(P,N,footprint,oceanCausticScreenFootprint(P,lightDPdx,lightDPdy));
 #endif
}`});
      this.directModulationModule.code+='\nfn oceanReceiverShadowVisibility(P:vec3f,visibility:f32)->f32{return oceanCausticShadowVisibility(P,visibility);}';
      this.ambientModulationModule=new ShaderModule({name:'oceanSceneAmbientModulation',deps:[this.receiverModule],code:'fn hookAmbientModulation(P:vec3f,N:vec3f)->vec3f{if(shoreP.enabled==0u){return vec3f(1.0);}return oceanAmbientModulation(P);}'});
      this.refraction=new RefractionPass({meshRenderer:v.meshRenderer,scene:v.scene,camera:v.camera,sceneRenderer:v.sceneRenderer,scale:0.5,bedSpacing:this.terrainApi?.native?.spacing??1.25});
      if(this.config.reflections)this.reflection=new OceanScreenSpaceReflection(v,this.config.sealevel);
      this.material=new OceanPhysicalMaterial({surface:this.surface,sky:v.lighting.sky,sceneCopy:v.sceneRenderer.opaqueCopy,sceneDepthHalf:v.sceneRenderer.opaqueDepthHalf?.texture,refraction:this.refraction,reflection:this.reflection});
      this.cameraState=new StorageBuffer({label:'ocean GPU Eulerian camera water height',count:1});
      this.cameraParams=new UniformBlock('OceanCameraQuery',{xz:['vec2f',[0,0]]});
      this.cameraModule=new ShaderModule({name:'oceanCameraState',bindings:{oceanCameraState:{storage:this.cameraState,access:'read'}},code:'fn oceanCameraWaterHeight()->f32{return oceanCameraState[0].x;}'});
      this.cameraQuery=new ComputeKernel({label:'Ocean current GPU Eulerian camera water query',modules:[this.surface.displacementModule],bindings:{cameraQueryP:{uniform:this.cameraParams},cameraStateOut:{storage:this.cameraState,access:'read_write'}},workgroupSize:[1,1,1],code:`
@compute @workgroup_size(1) fn main(){let p=cameraQueryP.xz;var q=p;for(var i=0;i<5;i++){let d=oceanCompositeDisplacement(q,0.25).xyz;q=p-d.xz;}
 let d=oceanCompositeDisplacement(q,0.25).xyz;let n=oceanSurfaceNormal(q,0.25);cameraStateOut[0]=vec4f(frame.seaLevel+d.y,n.x,n.z,oceanBed(p));
}`});
      const height=new String('oceanCameraWaterHeight()');height.module=this.cameraModule;this.material.cameraWaterHeightNode=height;
      this.material.clouds=v.lighting.cloudField??null;this.material.params.roughness.value=this.config.roughness;this.material.params.ssr.value=Number(this.config.reflections);
      const topology=buildOceanScreenGrid(256,128),geometry=new BufferGeometry();
                                                                            
      for(let i=0;i<topology.vertexCount;i++){const y=topology.positions[i*3+1];topology.positions[i*3+1]=0;topology.positions[i*3+2]=y;}
      geometry.setAttribute('position',new Float32BufferAttribute(topology.positions,3));geometry.setAttribute('normal',new Float32BufferAttribute(topology.normals,3));geometry.setAttribute('uv',new Float32BufferAttribute(topology.uvs,2));
      geometry.setAttribute('nodeData',new Float32BufferAttribute(new Float32Array(topology.vertexCount*4),4));geometry.setIndex(new Uint32BufferAttribute(topology.indices,1));
      this.geometry=geometry;this.mesh=new Mesh(geometry,this.material);this.mesh.name='NativeOceanFFT512';this.mesh.layers.set(LAYERS.WATER);this.mesh.frustumCulled=false;this.mesh.castShadow=false;this.mesh.visible=this.enabled;
      this.mesh.userData={oceanNative:true,reference_commit:OCEAN_REFERENCE};this.grid={columns:256,rows:128,vertices:topology.vertexCount,triangles:topology.triangleCount,topology_rebuilt_on_camera_change:false,gpu_projection:true};
      await stage('组装海面 WGSL');this.material.pipelineKey();                                         
      if(this.config.spray)this.spray=new OceanSpray(this);
      this.pipelineHandles=[this.fft.rows,this.fft.columns,...this.fft.pack,...this.fft.mips,...this.shore.pages.kernels,this.caustics.kernel,this.caustics.fallbackKernel,
        this.cameraQuery,...(this.spray?[this.spray.kernel]:[])].map(k=>k.handle);
      await stage('等待海面 GPU 计算管线');
      const timer=setInterval(()=>{const waiting=this.pipelineHandles.filter(h=>!h.pipeline&&!h.failed).map(h=>h.label);v.options?.onLoadProgress?.('海面 GPU · '+Math.round((performance.now()-started)/1000)+'秒 · '+waiting.length+'条待编译 · '+waiting.slice(0,2).join(', '));},1000);
      try{await GPU.pipelinesReady();}finally{clearInterval(timer);}
      const failed=this.pipelineHandles.filter(h=>h.failed);if(failed.length)throw Error('Ocean compute compilation failed: '+failed.map(h=>h.label).join(', '));
      if(this.disposed||v.disposed)throw Error('Ocean initialization cancelled');
      v.scene.add(this.mesh);
      const previous=v.sceneRenderer.onBeforeWater;const base=previous?.oceanOwner?previous.base:previous;
      this.beforeWater=()=>{this.beforeWater.base?.();if(!this.enabled||this.disposed)return;this.refraction.render(this.config.sealevel);this.reflection?.render();};
      this.beforeWater.oceanOwner=this;this.beforeWater.base=base;v.sceneRenderer.onBeforeWater=this.beforeWater;
                                                                           
                                                                                 
      this.integrationNeeds=[
        'Call terrainApi.setOcean(ocean) and lighting.bindOcean(ocean) on publication; receiverSurfaceModule exposes oceanApplyReceiverMaterial(P,footprint,baseColor,roughness,coat,gloss) AFTER the saved recipe for terrain AND ordinary meshes; do not merge shore history into recipe wet prior.',
        'Lighting binds ambientModulationModule for underwater optical attenuation and directModulationModule for per-frame screen-depth caustics afterCSM.',
        'Terrain apsTerrainShade already consumes hookDirectModulation, so lighting.bindOcean wires actual receiver caustics without changing terrain.',
        'Retain frame singletons, set camera before compute, render geometry-only shadows before sceneRenderer.render; reuse main opaque colour/depth for refraction and prior opaque depth for caustics; onBeforeWater prepares SSR colour coverage/mips from the same main opaque pass; no reflected camera or geometry pass.',
      ];
      this.initialized=true;return this;
    } catch(error){this.dispose();throw error;}
  }
  update(dt=0,time=this.time,camera=this.viewer.camera) {
    if(this.disposed||!this.initialized||!this.enabled)return;
                                                                              
                                                       
    if(!Number.isFinite(dt)||dt<0)throw Error('Ocean expects finite nonnegative dt');
    const step=oceanSimulationStep(dt,this.paused);this.time+=step;
    G.seaLevel.value=this.config.sealevel;G.waterAbsorption.value.fromArray(this.config.absorption);G.waterScattering.value.fromArray(this.config.scatter);G.windDir.value.fromArray(this.config.winddirection);G.windSpeed.value=this.config.windSpeed;
                                                                          
                                                                        
    G.cameraWaterHeight.value=this.config.sealevel;G.cameraUnderwater.value=camera.position.y<this.config.sealevel?1:0;
    const pagingChanged=this.shore.pages?.remap(camera,this.viewer.canvas?.height??900);
    if(this.lastTime!==this.time||step>0||pagingChanged){
      if(this.lastTime!==this.time||step>0)this.fft.update(step,this.time);
      this.shore.update(step,this.time);this.spray?.update(step,this.time);this.lastTime=this.time;
    }
    this.cameraParams.set('xz',[camera.position.x,camera.position.z]);this.cameraQuery.dispatch(1);
  }
                                                                              
                                                                               
                                                                       
  setReplayTime(time){this.time=time;this.lastTime=null;}
  setChoppiness(value){this.config=Object.freeze({...this.config,choppiness:value});this.fft.params.set('choppiness',value);this.lastTime=null;}
  setMaxDistance(value){this.config=Object.freeze({...this.config,maxDistance:value});this.surface.params.set('maxDistance',value);}
  prepareLighting(){if(!this.disposed&&this.initialized)this.caustics.update();}
  setEnabled(enabled){this.enabled=enabled;this.shore?.params.set('enabled',enabled?1:0);if(this.mesh)this.mesh.visible=enabled&&!this.shallowDepthVisualization;if(this.spray)this.spray.mesh.visible=enabled&&!this.shallowDepthVisualization;}
  setShallowDepthVisualization(enabled){this.shallowDepthVisualization=enabled;this.setEnabled(this.enabled);}
  setShoreShadowFadeDistance(value){this.receiverParams?.set('shadowFadeDistance',shoreShadowFadeDistance(value));}
  setShallowDepthDisplayMax(value){this.receiverParams?.set('depthDisplayMax',shallowDepthDisplayMax(value));}
  setCausticsEnabled(enabled){this.shore?.params.set('caustics',enabled?1:0);}
  setCausticShadowAttenuation(value){this.caustics?.params.set('shadowAttenuation',value);}
  setCausticCascadeMask(value){this.caustics?.params.set('cascadeMask',causticCascadeMask(value));}
  setCausticMinimumStep(value){this.caustics?.params.set('minimumStep',causticMinimumStep(value));}
  setDiagnosticMode(mode){if(!Number.isInteger(mode)||mode<0||mode>11)throw Error('Ocean diagnostic mode must be an integer in [0,11]');this.material.debugMode.value=mode;this.spray?.material.set('rawDiagnostic',mode);this.viewer.renderPipeline?.setDiagnosticMode(mode!==0);return this;}
  metadata(){return {backend:'native WebGPU WGSL',reference_commit:OCEAN_REFERENCE,config:this.config,initialized:this.initialized,time_s:this.time,paused:this.paused,fft:this.fft?.metadata(),shore:this.shore?.metadata(),grid:this.grid,terrain_binding:{sha256:this.terrainApi?.native?.sha256??null,shape:this.terrainApi?.native?.shape,spacing:this.terrainApi?.native?.spacing,origin:this.terrainApi?.native?.origin,native_dem_mutated:false},
    shore_controls:{shadow_fade_distance_m:this.receiverParams?.get('shadowFadeDistance'),depth_display_max_m:this.receiverParams?.get('depthDisplayMax'),depth_visualization:!!this.shallowDepthVisualization,depth_source:'same cached profile/support-derived oceanPageWaterDepth as foam-flow stage; support>=1e-5 and h>=1mm',wet_sand:'restored original 28s wetness roughness/clearcoat response; sand pigment stays uniform'},
    optics:{physical_native_material:true,ior:1.333,absorption_per_m:this.config.absorption,scatter_per_m:this.config.scatter,reflection:'one current-fragment dielectric interface; screen-space reflected ray in current main opaque depth, continuous confidence and roughness filtering',reflection_source:this.reflection?.metadata(),refraction:'same fragment interface Fresnel and exact Snell direction; accepted native bed/object receiver and TIR',refraction_source:this.refraction?.metadata(),shore_protections:{original_dem_fragment_clip:!!this.surface?.shore,metric_film_separation_m:0.0003,residual_uses_actual_column:true,bed_conforming_film_normals:true,raster_depth_bias:this.material?.depthBias??0,raster_slope_bias:this.material?.depthBiasSlopeScale??0},caustics:this.caustics?.metadata(),wetness:'fixed-world 28s native shoreline history; terrainReceiverWetness'},
    spray:{enabled:!!this.spray,budget:this.spray?.count??0,backend:'GPU fresh-source world particles; accepted wind relaxation, gravity, bed/water collisions, 0.25m soft depth and subpixel energy',droplet_size_m:[0.003,0.015],offshore_patch_m:128},integration_needs:this.integrationNeeds,pipeline_failures:this.pipelineHandles.filter(h=>h.failed).map(h=>h.label),verification:{gpu_island:false,visual_review:false},limitations:['analytic overturning and delayed run-up/backwash, local foam birth and foam-only advection; no depth-integrated water solver','screen-space receiver availability plus planar local reflections','first-interface volume boundary and bounded screen-space receiver approximation']};}
  dispose(){if(this.disposed)return;this.disposed=true;if(this.mesh)this.viewer.scene?.remove(this.mesh);
    unlinkWaterHook(this.viewer.sceneRenderer,this.beforeWater,this.beforeWater?.base);
    const release=()=>{this.spray?.dispose();this.caustics?.dispose();this.cameraState?.destroy();this.cameraParams?.buffer?.destroy();this.receiverParams?.buffer?.destroy();this.material?.dispose();this.material?.uniformBlock.buffer?.destroy();this.geometry?.dispose();this.foamTexture?.destroy();this.reflection?.dispose();this.refraction?.dispose();this.surface?.dispose();this.shore?.dispose();this.fft?.dispose();};
    if(GPU.encoder)GPU.onSubmit(null,release);else release();
  }
}



