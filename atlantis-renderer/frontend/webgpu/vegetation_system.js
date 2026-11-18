import {concatenateVegetation,vegetationLODView} from './vegetation_geometry.js';
import {GPU,StorageBuffer,Material,Texture,ShaderModule,UniformBlock,FrameUniforms,readBuffer,readTexture} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Mesh,BufferGeometry,Matrix4,Box3} from '../../vendor/tidewater/src/engine/index.js';
import {VEGETATION_CULL_WGSL,VEGETATION_CULL_WGSL_9STORAGE,VEGETATION_CULL_STORAGE_BINDINGS,VEGETATION_CULL_STORAGE_BINDINGS_WITH_LIGHT_CULL,VEGETATION_HIZ_COPY,VEGETATION_HIZ_REDUCE,VEGETATION_DISPATCH_COPY} from './vegetation_compute.js';
import {LIGHT_CULL_FLAG_ENABLED,LIGHT_CULL_FLAG_FORWARD_Z,LIGHT_CULL_FLAG_LEGACY_FULL,LIGHT_DEMAND_BYTES,LIGHT_CULL_PARAMS_BYTES,encodeLightCullParams} from './light_cull_wgsl.js';
import {projectBounds,visibleDepthRect,metricDepthBias} from './vegetation_math.js';
import {vegetationLODMask} from './vegetation_lod_mode.js';
import {prepareVegetationView} from './vegetation_visibility.js';
import {groundcoverBoundsExcluded} from './groundcover_math.js';
import {buildVegetationBlocks} from './vegetation_blocks.js';
import {SCREEN_AREA_LODS,GRASS_MIN_PIXELS} from './vegetation_area.js';
import {grassDensityUniforms} from './grass_density.js';
import {importedProjectionDensity} from './grass_projection_density.js';
import {excludeSubmergedRoots} from './lake_exclusion.js';
import {VegetationIntervention} from './vegetation_intervention.js';
import {INTERVENTION_MASK_POLICY,interventionMaskPolicy,interventionSourceForRole} from './terrain_intervention.js';

const pow2=n=>2**Math.ceil(Math.log2(Math.max(1,n)));
const destroyMaterial=m=>{m.dispose();m.uniformBlock.buffer?.destroy();};
const buffer=(label,count,type='u32',data=null,usage=[])=>new StorageBuffer({label,count,type,data,usage});
const shadowGroundcover=(pass,cover)=>{const captured=pass.groundcoverShadows?.get(cover)??pass.groundcoverShadow;return captured?.owner===cover?captured:cover;};

                                                                            
                                                                              
export class VegetationSystem {
  constructor(renderer,{frustum=true,occlusion=true,lod=true,thresholds=[200,55],occlusionBias_m=.02,spatial=true,blockSize=16,lodMetric='screen-area',densityOverlap=4}={}){
    if(!Number.isFinite(occlusionBias_m)||occlusionBias_m<0)throw Error('Finite nonnegative metric occlusion tolerance required');
    if(!(blockSize>0&&Number.isFinite(blockSize)))throw Error('Invalid vegetation block size');
    if(!(densityOverlap>0&&Number.isFinite(densityOverlap)))throw Error('Invalid prototype density overlap');
    this.renderer=renderer;this.options={frustum,occlusion,lod,thresholds,occlusionBias_m,spatial,blockSize,lodMetric,densityOverlap};this.models=[];this.views=new Map();this.depthMaterials=new Map();this.serial=0;this.disposed=false;
    this.intervention=new VegetationIntervention();this.interventionTerrain=null;
    this.interventionRole='both';this.maskPolicy=INTERVENTION_MASK_POLICY.existing;
  }
  async init(){
    const device=GPU.device;
                                                                                
                                                                                 
                                                                                   
                                                           
    const storageSlots=Number.isInteger(GPU.limits?.maxStorageBuffersPerShaderStage)?GPU.limits.maxStorageBuffersPerShaderStage:0;
    this.lightCullSupported=storageSlots>=VEGETATION_CULL_STORAGE_BINDINGS_WITH_LIGHT_CULL;
    this.cullStorageBindings=this.lightCullSupported?VEGETATION_CULL_STORAGE_BINDINGS_WITH_LIGHT_CULL:VEGETATION_CULL_STORAGE_BINDINGS;
    const module=device.createShaderModule({label:'APS conservative vegetation visibility',code:this.lightCullSupported?VEGETATION_CULL_WGSL:VEGETATION_CULL_WGSL_9STORAGE});
    this.cullLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
      ...[1,2,3,4,5,6].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding<3?'read-only-storage':'storage'}})),
      {binding:7,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
      {binding:8,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:9,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:10,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
      {binding:11,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
      {binding:12,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      ...(this.lightCullSupported?[
        {binding:13,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
        {binding:14,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}}]:[])]});
    const layout=device.createPipelineLayout({bindGroupLayouts:[this.cullLayout]});
    this.intervention.initGPU(device);
                                                                         
                                                                          
                                                                             
                                                                               
                     
    if(this.lightCullSupported){
      this.lightDummyUniform=device.createBuffer({label:'unused light cull params',size:LIGHT_CULL_PARAMS_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      this.lightDummyDemand=device.createBuffer({label:'unused receiver demand',size:LIGHT_DEMAND_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      GPU.queue.writeBuffer(this.lightDummyUniform,0,new Uint32Array(LIGHT_CULL_PARAMS_BYTES/4));
      GPU.queue.writeBuffer(this.lightDummyDemand,0,new Uint32Array(LIGHT_DEMAND_BYTES/4));
    }else{
      this.lightDummyUniform=null;this.lightDummyDemand=null;
    }
    this.dispatchCopyPipeline=await device.createComputePipelineAsync({label:'vegetation indirect dispatch copy',layout:'auto',compute:{module:device.createShaderModule({label:'APS vegetation indirect dispatch copy',code:VEGETATION_DISPATCH_COPY}),entryPoint:'copyDispatch'}});
    this.blockPipeline=await device.createComputePipelineAsync({label:'vegetation spatial block rejection',layout,compute:{module,entryPoint:'selectBlocks'}});
    [this.resetPipeline,this.selectPipeline,this.copyPipeline,this.reducePipeline]=await Promise.all([
      device.createComputePipelineAsync({label:'vegetation reset indirect',layout,compute:{module,entryPoint:'reset'}}),
      device.createComputePipelineAsync({label:'vegetation frustum LOD Hi-Z',layout,compute:{module,entryPoint:'selectInstances'}}),
      device.createComputePipelineAsync({label:'vegetation Hi-Z current depth',layout:'auto',compute:{module:device.createShaderModule({code:VEGETATION_HIZ_COPY}),entryPoint:'main'}}),
      device.createComputePipelineAsync({label:'vegetation Hi-Z farthest depth',layout:'auto',compute:{module:device.createShaderModule({code:VEGETATION_HIZ_REDUCE}),entryPoint:'main'}})]);
    this.dummyPyramid=device.createTexture({size:[1,1],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    GPU.queue.writeTexture({texture:this.dummyPyramid},new Float32Array([0]),{bytesPerRow:4},[1,1]);
    this.dummyVisibility=buffer('unused vegetation raster visibility',1,'u32',new Uint32Array([1]));this.dummyVisibility.getGPU();
    return this;
  }
                                                                        
                                                                             
                                                                               
                                                                       
  setInterventionPolicy(role,source,terrain=null){
    const maskPolicy=interventionMaskPolicy(role);
    this.interventionRole=role;this.maskPolicy=maskPolicy;
    return this.setIntervention(source,terrain);
  }
  resolveInterventionSource(source){
    return interventionSourceForRole(source,this.interventionRole);
  }
  setIntervention(source,terrain=null){
    if(terrain)this.interventionTerrain=terrain;
                                                                               
                                                                      
    const resolved=this.resolveInterventionSource(source);
    const native=terrain?.native??this.interventionTerrain?.native??this.population?.terrain?.native??this.screenGrass?.terrain?.native??resolved?.native??null;
    const change=this.intervention.set(resolved,{native});
    if(change.changed)this.applyInterventionChange(change);
    this.population?.setIntervention?.(resolved,terrain??this.interventionTerrain);
    this.screenGrass?.setIntervention?.(resolved,terrain??this.interventionTerrain);
    return change;
  }
  syncIntervention(){
    const raw=this.population?.viewer?.terrainIntervention??this.screenGrass?.viewer?.terrainIntervention??this.renderer?.terrainIntervention;
    if(raw===undefined)return false;
    if(raw===null&&!this.intervention.maskTexture&&!this.intervention.enabled)return false;
    const source=this.resolveInterventionSource(raw);
    const native=this.interventionTerrain?.native??this.renderer?.terrain?.native??this.population?.terrain?.native??this.screenGrass?.terrain?.native??source?.native??null;
    const change=this.intervention.set(source,{native});
    if(change.changed)this.applyInterventionChange(change);
    return change.changed;
  }
  applyInterventionChange(change){
    this.intervention.writeUniform();
    if(change.maskChanged||change.revisionChanged)for(const m of this.models)for(const c of m.contexts.values())c.groups=[];
    if(change.enabledChanged||change.maskChanged||change.registrationChanged||change.revisionChanged){
      this.onTransformChange?.();
      const cascades=this.renderer?.shadows?.cascades;if(Array.isArray(cascades))for(const c of cascades)c.dirty=true;
    }
  }
  register(source,lods,{thresholds=this.options.thresholds,margin=0,gpuPopulation=null,localBounds=null}={}){
    if(!source.isInstancedMesh||Array.isArray(source.material)||source.material.transparent)throw Error('Vegetation requires a static indexed instance prototype with opaque or MASK coverage');
    if(lods.length!==3||lods.some(g=>!g?.index||g.groups.length))throw Error('Vegetation LOD contract: three indexed single-material geometries, one coverage policy');
    const capacity=gpuPopulation?.capacity??source.count;
    if(!Number.isInteger(capacity)||capacity<1||capacity>GPU.limits.maxComputeWorkgroupsPerDimension*64)throw Error('Vegetation capacity exceeds compute dispatch limits');
    for(const geometry of lods)for(const [key,attribute] of Object.entries(source.geometry.attributes))if(!geometry.attributes[key]||geometry.attributes[key].itemSize!==attribute.itemSize)throw Error('LOD must preserve vertex semantic '+key);
    source.updateWorldMatrix(true,false);
    const n=capacity,matrices=gpuPopulation?null:new Float32Array(n*16),bounds=gpuPopulation?null:new Float32Array(n*8),box=new Box3().makeEmpty();
    for(const g of lods){g.computeBoundingBox();box.union(g.boundingBox);}
    if(localBounds)box.union(localBounds);
    const local=new Matrix4(),world=new Matrix4(),b=new Box3(),worldBounds=new Box3().makeEmpty();
    if(gpuPopulation)worldBounds.copy(gpuPopulation.worldBounds);
    else for(let i=0;i<n;i++){
      source.getMatrixAt(i,local);world.multiplyMatrices(source.matrixWorld,local);matrices.set(world.elements,i*16);b.copy(box).applyMatrix4(world);
      worldBounds.union(b);
      for(let k=0;k<3;k++){const axis=['x','y','z'][k];bounds[i*8+k]=(b.min[axis]+b.max[axis])*.5;bounds[i*8+4+k]=(b.max[axis]-b.min[axis])*.5+margin;}
    }
    if(!gpuPopulation)excludeSubmergedRoots(matrices,bounds,this.waterExclusion);
    if(margin<0||!Number.isFinite(margin)||!(thresholds[0]>thresholds[1]&&thresholds[1]>0))throw Error('Invalid vegetation bounds margin or LOD thresholds');
    const packed=concatenateVegetation(lods);
    const model={id:this.serial++,name:source.name,source,n,packed,lods:[...lods],thresholds,margin,localBounds:box.clone(),worldBounds:worldBounds.expandByScalar(margin),residentMask:7,draws:[],materials:[],contexts:new Map(),world:source.matrixWorld.elements.slice(),instanceVersion:source.instanceMatrix.version,
      projectionDensity:importedProjectionDensity(box,{overlap:this.options.densityOverlap}),gpuPopulation:!!gpuPopulation,keys:gpuPopulation?.keys??null,
      matrices:gpuPopulation?.matrices??buffer('vegetation immutable matrices',n,'mat4x4f',matrices),bounds:gpuPopulation?.bounds??buffer('vegetation conservative world bounds',n*2,'vec4f',bounds),counts:buffer('vegetation packed LOD ranges',9,'u32',packed.commands)};
    model.matrices.getGPU();model.bounds.getGPU();model.counts.getGPU();
    if(gpuPopulation){model.blocks=gpuPopulation.blocks;model.blockCount=gpuPopulation.blockCount;}else this.rebuildBlocks(model,bounds);this.models.push(model);model.active=this.context(model,'initial');
    for(let level=0;level<3;level++){
      const geometry=vegetationLODView(packed,level,n,box.clone());
      const material=source.material.clone();delete material.__pk;delete material.__pkFrame;
      const drawOffset=new UniformBlock('APSVegetationDraw',{base:['u32',level*n]});
      (model.drawOffsets??=[]).push(drawOffset);
      const depthVertex=`let apsOriginal=apsVegetationVisible[apsVegetationDraw.base+v.instance];v.model=apsVegetationMatrices[apsOriginal];v.prevModel=v.model;v.instance=${gpuPopulation?'apsVegetationKeys[apsOriginal]':'apsOriginal'};\n`;
      material.vertex=depthVertex+source.material.vertex;
      material.bindings.apsVegetationMatrices={storage:model.matrices,access:'read',visibility:'vertex'};
      material.bindings.apsVegetationVisible={storage:()=>model.active.visible,access:'read',type:'u32',visibility:'vertex'};
      material.bindings.apsVegetationDraw={uniform:drawOffset,visibility:'vertex'};
      if(gpuPopulation)material.bindings.apsVegetationKeys={storage:model.keys,access:'read',type:'u32',visibility:'vertex'};
      material.userData={...material.userData,apsVegetationManaged:true,apsVegetationDepthVertex:depthVertex};
      const mesh=new Mesh(geometry,material);mesh.name=source.name+' LOD '+level;mesh.count=n;mesh.frustumCulled=false;mesh.castShadow=source.castShadow;mesh.receiveShadow=source.receiveShadow;mesh.layers.mask=source.layers.mask;mesh.drawParams=source.drawParams?.slice();mesh.userData={apsVegetationManaged:true,model_id:model.id,lod:level};
      source.parent.add(mesh);model.draws.push(mesh);model.materials.push(material);
    }
    model.sourceVisible=source.visible;source.visible=false;source.userData.apsVegetationSource=true;return model;
  }
  setWaterExclusion(predicate){
    if(this.waterExclusion===predicate&&!this.waterExclusionDirty)return;
    this.waterExclusion=predicate;
                                                                            
                                                                            
    this.waterExclusionDirty=true;
    this.updateTransforms(true);
    this.waterExclusionDirty=false;
  }
  updateTransforms(waterOnly=false){
    for(const m of this.models){
      m.source.updateWorldMatrix(true,false);
      if(m.gpuPopulation){if(!m.world.every((x,i)=>x===m.source.matrixWorld.elements[i])||m.instanceVersion!==m.source.instanceMatrix.version)throw Error('GPU-owned grass requires its registered static prototype; CPU pose edits are unsupported');continue;}
      if(m.source.count!==m.n)throw Error('Changing vegetation capacity requires re-registration');
      const poseChanged=m.instanceVersion!==m.source.instanceMatrix.version||!m.world.every((x,i)=>x===m.source.matrixWorld.elements[i]);
      if(!poseChanged&&!waterOnly)continue;
      if(poseChanged&&(this.groundcover||this.screenGrass)&&!this.population){this.groundcover?.params.set('ready',0);throw Error('Bound groundcover poses changed; rebuild the measured coverage before rendering');}
      const matrices=new Float32Array(m.n*16),bounds=new Float32Array(m.n*8),local=new Matrix4(),world=new Matrix4(),box=new Box3(),worldBounds=new Box3().makeEmpty();
      for(let i=0;i<m.n;i++){m.source.getMatrixAt(i,local);world.multiplyMatrices(m.source.matrixWorld,local);matrices.set(world.elements,i*16);box.copy(m.localBounds).applyMatrix4(world);worldBounds.union(box);for(let k=0;k<3;k++){const axis=['x','y','z'][k];bounds[i*8+k]=(box.min[axis]+box.max[axis])*.5;bounds[i*8+4+k]=(box.max[axis]-box.min[axis])*.5+m.margin;}}
      m.waterExcluded=excludeSubmergedRoots(matrices,bounds,this.waterExclusion);
      m.worldBounds=worldBounds.expandByScalar(m.margin);
      m.bounds.write(bounds);
      if(poseChanged){m.matrices.write(matrices);this.rebuildBlocks(m,bounds);m.world=m.source.matrixWorld.elements.slice();m.instanceVersion=m.source.instanceMatrix.version;}
      this.onTransformChange?.();
    }
  }
  rebuildBlocks(model,bounds){
    const blocks=buildVegetationBlocks(bounds,this.options.blockSize);
    model.blocks?.destroy();model.blockCount=blocks.count;model.blocks=buffer('vegetation spatial blocks',blocks.data.length,'u32',blocks.data);model.blocks.getGPU();
    for(const c of model.contexts.values()){
                                                                             
                                                                              
      const previous=c.stats;c.stats=buffer('vegetation counters and surviving blocks',14+blocks.count);c.stats.getGPU();
      GPU.getEncoder().copyBufferToBuffer(previous.getGPU(),0,c.stats.getGPU(),0,56);
      GPU.onSubmit(null,()=>previous.destroy());c.groups=[];
    }
  }
  casterBounds(){if(this.population)return null;const box=new Box3().makeEmpty();for(const model of this.models)box.union(model.worldBounds);return box.isEmpty()?null:{min:box.min.toArray(),max:box.max.toArray()};}
  setGroundcover(next){
    if(this.groundcover===next)return;
    for(const model of this.models)for(const material of model.materials){
      const prior=material.userData.apsGroundcoverOriginal;
      if(prior){material.surface=prior.surface;material.modules=prior.modules;delete material.userData.apsGroundcoverOriginal;}
      if(next&&!this.isGrass){
        material.userData.apsGroundcoverOriginal={surface:material.surface,modules:material.modules};
        material.modules=[...material.modules,next.module];material.surface='if(!gcVisible(in.P)){discard;}\n'+material.surface;
      }
      material.userData.apsGroundcover=this.isGrass?null:next;material.needsUpdate=true;
    }
    for(const m of this.depthMaterials.values())destroyMaterial(m);this.depthMaterials.clear();this.groundcover=next;
  }
  ownsDraw(object){return this.models[object?.userData?.model_id]?.draws?.includes(object)??false;}
  context(model,key){
    if(model.contexts.has(key))return model.contexts.get(key);
    const ctx={visible:buffer('vegetation visible original IDs '+key,model.n*3),args:buffer('vegetation indexed indirect '+key,15,'u32',null,['indirect']),state:buffer('vegetation per-view LOD history '+key,model.n*(model.gpuPopulation?2:1),'u32',model.gpuPopulation?null:new Uint32Array(model.n).fill(3)),stats:buffer('vegetation counters and surviving blocks '+key,14+model.blockCount),dispatch:buffer('vegetation surviving block dispatch '+key,3,'u32',null,['indirect']),uniforms:[],groups:[]};
    for(let phase=0;phase<3;phase++)ctx.uniforms.push(GPU.device.createBuffer({label:'vegetation view '+key+' phase '+phase,size:224,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
    for(const name of ['visible','args','state','stats','dispatch'])ctx[name].getGPU();model.contexts.set(key,ctx);return ctx;
  }
  view(pass,occlusion=this.options.occlusion){
    const key=pass.label??pass.kind??'opaque';
    this.renderer.vegetationViews??=new Map();let v=this.renderer.vegetationViews.get(key);
    const fields=(pass.frameBlock??FrameUniforms).fields,res=fields.resolution.value;
    const w=Math.max(1,res.x|0),h=Math.max(1,res.y|0);
    const needsPyramid=pass.kind!=='depth'&&fields.reversedDepth.value!==0&&occlusion;
    if(!v){v={key,width:0,height:0,frame:0,seedPasses:0};this.renderer.vegetationViews.set(key,v);}
    this.views.set(key,v);
    if(v.width!==w||v.height!==h||needsPyramid&&!v.depth){
      v.depth?.destroy();v.pyramid?.destroy();v.solidRasterDepth?.destroy();v.solidRasterDepth=null;v.depth=null;v.pyramid=null;v.width=w;v.height=h;v.pw=pow2(w);v.ph=pow2(h);v.levels=Math.floor(Math.log2(Math.max(v.pw,v.ph)))+1;
      if(needsPyramid){
      v.depth=GPU.device.createTexture({label:key+' current vegetation depth',size:[w,h],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
      v.pyramid=GPU.device.createTexture({label:key+' conservative Hi-Z',size:[v.pw,v.ph],format:'r32float',mipLevelCount:v.levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
      v.pipelineOwner=null;
      }
    }
    if(needsPyramid&&v.pipelineOwner!==this){
      v.copy=GPU.device.createBindGroup({layout:this.copyPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:v.depth.createView()},{binding:1,resource:v.pyramid.createView({baseMipLevel:0,mipLevelCount:1})}]});
      v.reduce=[];for(let i=1;i<v.levels;i++)v.reduce.push(GPU.device.createBindGroup({layout:this.reducePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:v.pyramid.createView({baseMipLevel:i-1,mipLevelCount:1})},{binding:1,resource:v.pyramid.createView({baseMipLevel:i,mipLevelCount:1})}]}));
      v.pipelineOwner=this;
    }
    v.frame=GPU.frame;v.kind=pass.kind;v.reversed=fields.reversedDepth.value!==0;return v;
  }
  beginSelection(view,phase){
    const label=view.key+' shared vegetation selection '+phase;
    return GPU.getEncoder().beginComputePass({label,timestampWrites:this.timestamps(label)});
  }
  select(view,pass,phase,occlusion,sharedCompute=null){
    const f=(pass.frameBlock??FrameUniforms).fields;
    const light=pass.apsLightCull??null;
    if(light&&!this.lightCullSupported)throw Error('Nine-storage vegetation layout cannot consume ReceiverDemand; use the ordinary full vegetation draw');
    if(light&&(!light.demandBuffer||light.demandBuffer.size<LIGHT_DEMAND_BYTES))throw Error('Light cull requires a 128-byte ReceiverDemand GPUBuffer');
    view.cameraSnapshot={vp:f.viewProj.value.elements.slice(),near:pass.camera?.near??.1,far:pass.camera?.far??Infinity};
    const label=view.key+' vegetation '+(light?'light ':'' )+(occlusion?'occlusion':'frustum LOD');
    const compute=sharedCompute??GPU.getEncoder().beginComputePass({label,timestampWrites:this.timestamps(label)});
    this.syncIntervention();
    for(const m of this.models){
      if(pass.pointShadowModels&&!pass.pointShadowModels.has(m))continue;
      const c=this.context(m,view.key);m.active=c;
      const boundDemand=light?.demandBuffer??null;
      if(c.boundPyramid!==view.pyramid||c.boundDemand!==boundDemand){c.groups=[];c.boundPyramid=view.pyramid;c.boundDemand=boundDemand;}
      const budget=pass.vegetationShadowBudget,automatic=(this.lodMode??'auto')==='auto';
      const grassLOD2=this.isGrass&&!budget&&pass.kind!=='depth';
      const scale=budget&&automatic?budget.lodScale:1;
      const data=new ArrayBuffer(224),floats=new Float32Array(data),uints=new Uint32Array(data);floats.set(f.viewProj.value.elements,0);floats.set([view.width,view.height,...m.thresholds.map(x=>x*scale)],16);
      const density=pass.apsPointShadow?{eye:[0,0,0,0],policy:[1,1,2,8]}:grassDensityUniforms(this);floats.set(density.eye,48);floats.set(density.policy,52);
      const spatial=this.options.spatial&&m.blockCount<=GPU.limits.maxComputeWorkgroupsPerDimension;
      uints.set([m.blockCount,+spatial,budget&&automatic?budget.minLOD:0,Number(this.options.lodMetric==='screen-area')|(m.gpuPopulation?2:0)|(grassLOD2?4:0)],40);
      floats.set([SCREEN_AREA_LODS[0]*scale,SCREEN_AREA_LODS[1]*scale,this.isGrass&&!budget&&!pass.apsPointShadow?GRASS_MIN_PIXELS:0,SCREEN_AREA_LODS[2]],44);
      const groundcover=shadowGroundcover(pass,this.groundcover);
      let coverData=this.isGrass?null:groundcover?.cullData();
      if(this.isGrass&&budget){
        const eye=pass.vegetationShadowEye??[0,0,0],enabled=(pass.vegetationShadowLevel??0)<budget.grassLevels;
        coverData=[...eye,budget.grassEnd,m.worldBounds.min.y,m.worldBounds.max.y,1,enabled?-1:0];
        c.grassShadowParams??=new UniformBlock('APSGrassNearShadow',{eyeEnd:['vec4f',[0,0,0,8]],range:['vec4f',[4,1,0,0]]});
        c.grassShadowParams.set('eyeEnd',[...eye,budget.grassEnd]);c.grassShadowParams.set('range',[budget.grassStart,+enabled,0,0]);
      }
      const screenHandled=this.screenGrass?.unifiedNear&&pass.kind!=='depth'&&pass.camera===this.screenGrass.viewer.camera;
      const excludeCover=screenHandled||this.population?.active===0||groundcoverBoundsExcluded(m.worldBounds,coverData);
      if(coverData)floats.set(coverData,32);
      if(excludeCover){floats[38]=1;floats[39]=0;}                                                         
      uints.set([+this.options.frustum,Number(occlusion),+view.reversed,+this.options.lod],20);floats.set(pass.vegetationClip??[0,0,0,0],24);uints.set([m.n,vegetationLODMask(grassLOD2?2:this.lodMode??'auto',m.residentMask),0,0],28);
      if(pass.apsPointShadow){uints[23]=0;uints[29]=vegetationLODMask(0,m.residentMask);}
                                                                               
                                                                                  
      floats[30]=pass.camera?.near??.1;floats[31]=this.options.occlusionBias_m;
      GPU.queue.writeBuffer(c.uniforms[phase],0,data);
      if(light){
                                                                          
                                                                          
                                                                           
                                                                         
        c.lightUniform??=GPU.device.createBuffer({label:'vegetation light cull '+view.key,size:LIGHT_CULL_PARAMS_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        const params=encodeLightCullParams({
          level:light.level,
          flags:LIGHT_CULL_FLAG_ENABLED|LIGHT_CULL_FLAG_FORWARD_Z|(light.legacyFull?LIGHT_CULL_FLAG_LEGACY_FULL:0),
          padTexels:Number(light.padTexels??0),
          depthPad:Number(light.depthPad??0),
          demandIndex:light.level,
          global:light.global??null,reuse:light.reuse??null,
        });
        GPU.queue.writeBuffer(c.lightUniform,0,params);
      }
      if(!c.groups[phase]){
        const entries=[
          {binding:0,resource:{buffer:c.uniforms[phase]}},...[m.bounds,m.counts,c.args,c.visible,c.state,c.stats].map((b,i)=>({binding:i+1,resource:{buffer:b.getGPU()}})),{binding:7,resource:(occlusion?view.pyramid:this.dummyPyramid).createView()},
          {binding:8,resource:{buffer:(m.gpuPopulation?m.keys:(c.rasterVisible??this.dummyVisibility)).getGPU()}},{binding:9,resource:{buffer:m.blocks.getGPU()}},
          {binding:10,resource:{buffer:this.intervention.uniformBuffer}},{binding:11,resource:this.intervention.maskView()},{binding:12,resource:{buffer:m.matrices.getGPU()}}];
        if(this.lightCullSupported)entries.push(
          {binding:13,resource:{buffer:light?c.lightUniform:this.lightDummyUniform}},
          {binding:14,resource:{buffer:boundDemand??this.lightDummyDemand}});
        c.groups[phase]=GPU.device.createBindGroup({layout:this.cullLayout,entries});
      }
      compute.setBindGroup(0,c.groups[phase]);compute.setPipeline(this.resetPipeline);compute.dispatchWorkgroups(1);
      c.blockDispatch=spatial&&!excludeCover;
      c.skippedInstances=excludeCover;
      if(!excludeCover){compute.setPipeline(spatial?this.blockPipeline:this.selectPipeline);compute.dispatchWorkgroups(Math.ceil((spatial?m.blockCount:m.n)/64));}
      for(let i=0;i<3;i++)m.draws[i].geometry.indirect={buffer:c.args,offset:i*20};
    }
    if(!sharedCompute){compute.end();this.finishSelection(view,phase,pass.pointShadowModels);}
  }
                                                                 
                                                                              
                                                                           
                                                                        
                                                                               
  selectLight(view,pass,light,sharedCompute=null){
    if(!this.lightCullSupported)throw Error('Light cull unavailable: adapter storage-buffer limit cannot host the tenth binding');
    if(!light?.demandBuffer)throw Error('VegetationSystem.selectLight requires ReceiverDemand');
    view.lightLevel=light.level;
    return this.select(view,{...pass,kind:'depth',apsLightCull:light},0,true,sharedCompute);
  }
  finishSelection(view,phase,pointShadowModels=null){
    const contexts=this.models.filter(m=>!pointShadowModels||pointShadowModels.has(m)).map(m=>this.context(m,view.key)).filter(c=>c.blockDispatch);
    if(!contexts.length)return;
    const encoder=GPU.getEncoder();
    for(const c of contexts)encoder.copyBufferToBuffer(c.stats.getGPU(),28,c.dispatch.getGPU(),0,12);
    const label=view.key+' surviving vegetation blocks '+phase,compute=encoder.beginComputePass({label,timestampWrites:this.timestamps(label)});
    compute.setPipeline(this.selectPipeline);
    for(const c of contexts){compute.setBindGroup(0,c.groups[phase]);compute.dispatchWorkgroupsIndirect(c.dispatch.getGPU(),0);}
    compute.end();
  }
                                                                             
                                                                              
                                                                               
                                                                          
                                                         
  finishSelectionBatched(view,phase,compute){
    if(!compute?.dispatchWorkgroupsIndirect)throw Error('finishSelectionBatched requires the shared compute pass');
    const contexts=this.models.map(m=>this.context(m,view.key)).filter(c=>c.blockDispatch);
    if(!contexts.length)return 0;
    for(const c of contexts){
      if(!c.dispatchGroup)c.dispatchGroup=GPU.device.createBindGroup({layout:this.dispatchCopyPipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:c.stats.getGPU()}},{binding:1,resource:{buffer:c.dispatch.getGPU()}}]});
    }
    compute.setPipeline(this.dispatchCopyPipeline);
    for(const c of contexts){compute.setBindGroup(0,c.dispatchGroup);compute.dispatchWorkgroups(1);}
    compute.setPipeline(this.selectPipeline);
    for(const c of contexts){compute.setBindGroup(0,c.groups[phase]);compute.dispatchWorkgroupsIndirect(c.dispatch.getGPU(),0);}
    return contexts.length;
  }
                                                                             
                                                                              
                                                                            
                                          
  restoreDrawContext(view,phase=0){
    for(const m of this.models){
      const c=this.context(m,view.key);m.active=c;
      for(let i=0;i<3;i++)m.draws[i].geometry.indirect={buffer:c.args,offset:i*20};
    }
  }
  releaseView(key){
    for(const m of this.models){const c=m.contexts.get(key);if(!c)continue;const release=()=>{for(const k of ['visible','args','state','stats','dispatch'])c[k]?.destroy();for(const u of c.uniforms)u.destroy();c.rasterVisible?.destroy();c.grassShadowParams?.buffer?.destroy();c.lightUniform?.destroy();};if(GPU.encoder)GPU.onSubmit(null,release);else release();m.contexts.delete(key);}
    this.views.delete(key);
  }
  prepare(scene,pass,seed){
    prepareVegetationView([this],scene,pass,seed);
  }
  prepareRaster(view){
      view.solidRasterDepth??=new Texture({label:view.key+' immutable solid occlusion depth',width:view.width,height:view.height,format:'r32float',usage:['sample','copyDst']});
      for(const model of this.models){const ctx=this.context(model,view.key);if(!ctx.rasterVisible){ctx.rasterVisible=buffer('vegetation raster visibility '+view.key,model.n,'u32');ctx.groups=[];}GPU.getEncoder().clearBuffer(ctx.rasterVisible.getGPU());}
  }
  snapshotSolidDepth(view){
    GPU.getEncoder().copyTextureToTexture({texture:view.pyramid,mipLevel:0},{texture:view.solidRasterDepth.getGPU()},[view.width,view.height]);
  }
  buildPyramid(view){
    view.pyramidBuilds=(view.pyramidBuilds??0)+1;
    const p=GPU.getEncoder().beginComputePass({label:view.key+' current-frame depth pyramid',timestampWrites:this.timestamps(view.key+' Hi-Z')});p.setPipeline(this.copyPipeline);p.setBindGroup(0,view.copy);p.dispatchWorkgroups(Math.ceil(view.pw/8),Math.ceil(view.ph/8));
    p.setPipeline(this.reducePipeline);for(let i=1;i<view.levels;i++){p.setBindGroup(0,view.reduce[i-1]);p.dispatchWorkgroups(Math.ceil(Math.max(1,view.pw>>i)/8),Math.ceil(Math.max(1,view.ph>>i)/8));}p.end();
  }
  beginProfile(){if(!GPU.hasTimestamp)return false;if(this.profile)throw Error('Vegetation profile already active');this.profile={queries:GPU.device.createQuerySet({type:'timestamp',count:128}),labels:[]};return true;}
  timestamps(label){const p=this.profile;if(!p||p.labels.length>=64)return undefined;const i=p.labels.length*2;p.labels.push(label);return {querySet:p.queries,beginningOfPassWriteIndex:i,endOfPassWriteIndex:i+1};}
  async finishProfile(){
    const p=this.profile;if(!p)return null;this.profile=null;if(!p.labels.length){p.queries.destroy();return [];}const bytes=p.labels.length*16;
    const resolved=GPU.device.createBuffer({size:Math.max(16,bytes),usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
    GPU.getEncoder().resolveQuerySet(p.queries,0,p.labels.length*2,resolved,0);const values=new BigUint64Array(await readBuffer(resolved,bytes));
    const result=p.labels.map((label,i)=>({label,gpu_ms:Number(values[i*2+1]-values[i*2])/1e6}));resolved.destroy();p.queries.destroy();return result;
  }
  depthMaterial(original,pass,object){
    if(!original.userData?.apsVegetationManaged&&!pass.vegetationClip)return null;
    if(original.userData?.apsVegetationManaged&&!this.ownsDraw(object))return null;
    const cover=original.userData?.apsGroundcover,retention=shadowGroundcover(pass,cover);
    const nearGrass=this.isGrass&&pass.vegetationShadowBudget;
    const reuse=pass.apsShadowReuseCoverage??null;
    const clip=pass.vegetationClip??[0,0,0,0],raster=pass.apsRasterView,key=original.id+':'+original.version+':'+clip.join(',')+':'+(raster?.key??'')+':'+(raster?.solidRasterDepth?.id??'')+(retention?.key?':'+retention.key:'')+(nearGrass?':near-grass:'+pass.label:'')+(reuse?':reuse:'+reuse.key:'');
    if(this.depthMaterials.has(key))return this.depthMaterials.get(key);
    const prefix=clip.some(x=>x!==0)?`if(dot(vec4f(in.P,1.0),vec4f(${clip.map(x=>Number(x).toFixed(6)).join(',')}))<0.0){return false;}\n`:'';
    let material;
    const storage={};for(const k of ['apsVegetationMatrices','apsVegetationVisible','apsVegetationKeys','apsVegetationDraw'])if(original.bindings[k])storage[k]=original.bindings[k];
    const coverage=original.userData?.apsCoverageDepth;
    if(coverage){
      material=new Material({name:'vegetation alpha-only depth',lit:false,side:original.side,opacity:original.opacity,uniforms:coverage.uniforms,vertex:(original.userData.apsVegetationDepthVertex??'')+coverage.vertex,attributes:coverage.attributes,varyings:coverage.varyings,bindings:{...storage,...coverage.bindings},modules:[coverage.module],shadow:prefix+original.shadow});
      for(const name of ['opacity','alphaTest',...Object.keys(coverage.uniforms??{})])material.uniforms[name]=material.uniformBlock.fields[name]=original.uniforms[name];
    }else if(original.alphaTest>0||original.shadow){material=original.clone();material.shadow=prefix+(original.shadow||'let s=surfaceOf(in);return s.alpha>=mat.alphaTest;');}
    else if(original.userData?.apsVegetationManaged||object?.userData?.aps_native_static_geometry){material=new Material({name:'vegetation position-only depth',lit:false,side:original.side,vertex:original.userData.apsVegetationDepthVertex??'',bindings:storage,shadow:prefix?prefix+'return true;':'',depthTest:original.depthTest});}
    else {material=new Material({name:'native custom vertex depth',lit:false,side:original.side,vertex:original.vertex,varyings:original.varyings,attributes:original.attributes,bindings:original.bindings,modules:original.modules,uniforms:Object.fromEntries(original.uniformBlock.order.map(k=>[k,[original.uniformBlock.layout[k].typeStr,original.uniforms[k].value]])),shadow:prefix?prefix+'return true;':'',depthTest:original.depthTest});}
                                                                               
                                                                             
                                                                              
                                                                            
                                                                       
    if(reuse&&original.userData?.apsVegetationManaged){
      const entry=reuse.entry??'apsShadowReuseSkip';
      material.modules=[...material.modules,reuse.module];
      material.shadow=`if(${entry}(in)){return false;}\n`+(material.shadow||'return true;');
    }
    if(retention){
      material.modules=[...material.modules.filter(m=>m!==cover.module),retention.module];
      material.shadow='if(!gcVisible(in.P)){return false;}\n'+(material.shadow||'return true;');
    }
    if(nearGrass){
                                                                          
                                                                              
                                                                        
      const contextKey=pass.apsVegetationLightDraw?(pass.vegetationViewKey??pass.label):pass.label;
      const model=this.models[object.userData.model_id],ctx=this.context(model,contextKey);
      material.modules=[...material.modules,new ShaderModule({name:'aps-near-grass-shadow',uniforms:ctx.grassShadowParams,uniformName:'nearGrass',code:`
fn grassNearShadow(P:vec3f)->bool{
 if(nearGrass.range.y<.5){return false;}
 let p=vec3i(floor(P*2048.));var h=(bitcast<u32>(p.x)*1597334677u)^(bitcast<u32>(p.y)*3812015801u)^(bitcast<u32>(p.z)*2798796415u);h^=h>>16u;h*=2246822519u;h^=h>>13u;
 return f32(h>>8u)/16777216.<1.-smoothstep(nearGrass.range.x,nearGrass.eyeEnd.w,distance(P,nearGrass.eyeEnd.xyz));
}`})];
      material.shadow='if(!grassNearShadow(in.P)){return false;}\n'+(material.shadow||'return true;');
    }
    if(raster&&original.userData?.apsVegetationManaged){
      const model=this.models[object.userData.model_id],ctx=this.context(model,raster.key),body=material.shadow||'return true;',coverageName='apsRasterCoverage'+original.id;
      material.vertex+='\no.apsOriginalInstance=v.instance;';material.varyings={...material.varyings,apsOriginalInstance:'u32'};
      material.bindings.apsRasterVisible={storage:ctx.rasterVisible,access:'read_write',type:'atomic<u32>'};
      material.bindings.apsRasterSolidDepth={texture:raster.solidRasterDepth,sampleType:'unfilterable-float'};
      material.modules=[...material.modules,new ShaderModule({name:coverageName,code:`fn ${coverageName}(in:FragInput)->bool{${body}}`})];
      material.shadow=`if(!${coverageName}(in)){return false;}
let solid=textureLoad(apsRasterSolidDepth,vec2i(in.pixel),0).r;
let offset=frame.near/max(frame.far-frame.near,1e-6);let d=max(solid,in.vs.clip.z)+offset;
let bias=d*d*${this.options.occlusionBias_m}/(max(frame.near,1e-6)*(1.0+offset))+d*9.536743e-7;
if(in.vs.clip.z>=solid-bias){atomicStore(&apsRasterVisible[in.vs.apsOriginalInstance],1u);}
return true;`;
    }
    delete material.__pk;delete material.__pkFrame;material.output='';material.userData={...material.userData,apsVegetationDepth:true};this.depthMaterials.set(key,material);return material;
  }
                                                                              
                                                                             
  setResident(model,mask){if(!(mask&7))throw Error('Cannot evict every vegetation LOD');model.residentMask=mask&7;}
  async replaceLOD(model,level,load){
    if(typeof this.compile!=='function')throw Error('Streaming requires an actual GPU compilation callback');
    if(level<0||level>2)throw Error('Invalid LOD');const geometry=await load();if(this.disposed)throw Error('Disposed vegetation stream');
    geometry.computeBoundingBox();const bounds=model.draws[level].geometry.boundingBox;
    if(!geometry.index||geometry.groups.length||!bounds.containsBox(geometry.boundingBox))throw Error('Streamed LOD must satisfy original conservative bounds and indexed material layout');
    for(const [key,attribute] of Object.entries(model.source.geometry.attributes))if(!geometry.attributes[key]||geometry.attributes[key].itemSize!==attribute.itemSize)throw Error('Streamed LOD must preserve vertex semantic '+key);
    const priorPacked=model.packed,priorLODs=model.lods,priorGeometries=model.draws.map(d=>d.geometry);
    const lods=[...priorLODs];lods[level]=geometry;
    const packed=concatenateVegetation(lods),next=lods.map((_,i)=>vegetationLODView(packed,i,model.n,bounds));
    const priorMask=model.residentMask;
    try{
      for(let i=0;i<3;i++){next[i].indirect=priorGeometries[i].indirect;model.draws[i].geometry=next[i];}
      model.counts.write(packed.commands);model.packed=packed;model.lods=lods;
      await this.compile();this.setResident(model,priorMask|(1<<level));
      for(const g of priorGeometries)g.dispose();priorPacked.geometry.dispose();
    }catch(error){
      for(let i=0;i<3;i++)model.draws[i].geometry=priorGeometries[i];
      model.counts.write(priorPacked.commands);model.packed=priorPacked;model.lods=priorLODs;
      for(const g of next)g.dispose();packed.geometry.dispose();this.setResident(model,priorMask);throw error;
    }
  }

  metadata(){return {schema:'aps-vegetation-render/1',light_cull_supported:this.lightCullSupported===true,storage_bindings:this.cullStorageBindings??null,light_cull_layout_policy:'ten-storage light-cull layout only when maxStorageBuffersPerShaderStage>=10; otherwise the unchanged nine-storage full-draw path',models:this.models.length,instances:this.models.reduce((n,m)=>n+m.n,0),draw_api:'drawIndexedIndirect',matrix_upload:this.population?.gpuOwned?'none; GPU generates near-grass matrices and blocks':'once at registration; changed poses invalidate bounds/shadows',intervention:this.intervention.metadata(),options:{...this.options},lod_area_fractions:SCREEN_AREA_LODS,grass_min_area_pixels:this.isGrass?GRASS_MIN_PIXELS:0,screen_grass:this.screenGrass?.metadata()??null,population:this.population?.metadata()??null,occlusion:'shared current-view current-frame coverage depth; reversed-Z farthest Hi-Z; optional actual solid-depth raster visibility',light_occlusion:'forward-Z static-light farthest max Hi-Z; complete projected bbox + all covered cells; 128 B ReceiverDemand',shadow_occlusion:'hardware depth test; no extra shadow prepass',views:[...this.views.values()].map(v=>({name:v.key,kind:v.kind,frame:v.frame,resolution:[v.width,v.height],seed_passes:v.seedPasses,shared_systems:v.sharedSystems??1,solid_seed_passes:v.solidSeedPasses??0,hiz_builds:v.pyramidBuilds??0,reversed_z:v.reversed,raster_occlusion:v.rasterOcclusion??false,light_level:v.lightLevel??null,global_source_level:v.globalSourceLevel??null,forward_z:v.kind==='light-depth'||v.kind==='light-depth-global'})),lods:this.models.map(m=>({name:m.name,index_counts:m.packed.ranges.map(r=>r.indexCount),packed_ranges:m.packed.ranges,shared_geometry_buffers:true,spatial_blocks:m.blockCount,block_size_m:this.options.blockSize,resident_mask:m.residentMask,thresholds_pixels:m.thresholds,projection_density:m.projectionDensity})),audit:this.lastAudit?{frame:this.lastAudit.frame,rows:this.lastAudit.rows.map(({visible_ids,...r})=>r)}:null};}
  async audit({depthDiagnostics=false}={}){
    const result=[];GPU.submit();await GPU.queue.onSubmittedWorkDone();
    for(const view of this.views.values())for(const model of this.models){const c=model.contexts.get(view.key);if(!c)continue;
      const [a,s,ids]=await Promise.all([readBuffer(c.args,c.args.byteLength),readBuffer(c.stats,c.stats.byteLength),readBuffer(c.visible,c.visible.byteLength)]);
      const args=new Uint32Array(a),stats=new Uint32Array(s),visible=new Uint32Array(ids),lists=[0,1,2].map(l=>Array.from(visible.slice(l*model.n,l*model.n+args[l*5+1])));
      const all=lists.flat(),unique=new Set(all);if(all.length!==unique.size||all.some(i=>i>=model.n)||all.length+stats[0]+stats[1]+stats[6]+stats[10]+stats[11]+stats[12]+stats[13]!==model.n)throw Error('GPU vegetation compaction audit failed');
      result.push({view:view.key,model:model.name,total:model.n,spatial_blocks:model.blockCount,surviving_blocks:c.blockDispatch?stats[7]:null,instance_workgroups:c.skippedInstances?0:c.blockDispatch?stats[7]:Math.ceil(model.n/64),frustum_rejected:stats[0],occlusion_rejected:stats[1],reuse_rejected:stats[13],groundcover_rejected:stats[6],small_area_rejected:stats[10],density_rejected:stats[11],intervention_rejected:stats[12],lod_counts:Array.from(stats.slice(2,5)),near_protected:stats[5],triangles:lists.reduce((n,l,i)=>n+l.length*args[i*5]/3,0),indirect_args:Array.from(args),visible_ids:lists});
    }this.lastAudit={frame:GPU.frame,rows:result};
    if(depthDiagnostics){
      const diagnostics=[];
      for(const view of this.views.values())if(view.pyramid){
        const levels=[];
        for(let mip=0;mip<view.levels;mip++){
          const raw=await readTexture({format:'r32float',width:view.pw,height:view.ph,getGPU:()=>view.pyramid},{mip});
          const data=new Float32Array(raw.data);let occupied=0,max=0;for(const d of data){if(d>0)occupied++;max=Math.max(max,d);}
          levels.push({width:raw.width,height:raw.height,data,occupied,max});
        }
        const samples=[];
        for(const model of this.models){
          const row=result.find(r=>r.view===view.key&&r.model===model.name);if(!row)continue;
          const ids=row.visible_ids.flat();if(!ids.length)continue;
          const bounds=new Float32Array(await readBuffer(model.bounds,model.bounds.byteLength));
          for(let k=0;k<Math.min(8,ids.length);k++){
            const id=ids[Math.floor(k*ids.length/Math.min(8,ids.length))],p=projectBounds(view.cameraSnapshot.vp,Array.from(bounds.slice(id*8,id*8+3)),Array.from(bounds.slice(id*8+4,id*8+7)),view.width,view.height),rect=visibleDepthRect(p,view.width,view.height);
            if(!rect){samples.push({model:model.name,id,protectedNear:p.protectedNear});continue;}
            const mip=Math.min(view.levels-1,Math.ceil(Math.log2(Math.max(1,...rect.hi.map((v,i)=>v-rect.lo[i]))))),level=levels[mip],scale=2**mip;
            const a=rect.lo.map((v,i)=>Math.min([level.width,level.height][i]-1,Math.floor(v/scale))),b=rect.hi.map((v,i)=>Math.min([level.width,level.height][i]-1,Math.floor(v/scale)));
            const taps=[[a[0],a[1]],[b[0],a[1]],[a[0],b[1]],[b[0],b[1]]].map(([x,y])=>level.data[y*level.width+x]),farDepth=Math.min(...taps),nearest=p.hi[2],bias=metricDepthBias(Math.max(farDepth,nearest),view.cameraSnapshot.near,this.options.occlusionBias_m,view.cameraSnapshot.far);
            samples.push({model:model.name,id,mip,rect,nearest,farDepth,bias,taps,CPU_occluded:nearest<farDepth-bias});
          }
        }
        diagnostics.push({view:view.key,resolution:[view.width,view.height],camera:view.cameraSnapshot,levels:levels.map(({data,...meta})=>meta),samples});
      }
      this.lastAudit.depth_diagnostics=diagnostics;
    }
    return this.lastAudit;
  }
  clearModels(){
    for(const m of this.models)for(const block of m.drawOffsets??[])block.buffer?.destroy();
    for(const m of this.models){m.source.visible=m.sourceVisible;delete m.source.userData.apsVegetationSource;for(const d of m.draws){d.removeFromParent();d.geometry.dispose();}m.packed.geometry.dispose();for(const mat of m.materials)destroyMaterial(mat);for(const k of ['matrices','bounds','counts','blocks'])if(!m.gpuPopulation||k==='counts')m[k].destroy();for(const c of m.contexts.values()){for(const k of ['visible','args','state','stats','dispatch'])c[k].destroy();c.rasterVisible?.destroy();c.grassShadowParams?.buffer?.destroy();c.lightUniform?.destroy();for(const u of c.uniforms)u.destroy();}}
    for(const m of this.depthMaterials.values())destroyMaterial(m);this.depthMaterials.clear();this.views.clear();this.models=[];this.serial=0;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    this.profile?.queries.destroy();this.profile=null;this.screenGrass?.dispose();this.clearModels();this.population?.dispose();
    this.intervention.dispose();this.dummyPyramid?.destroy();this.dummyVisibility?.destroy();this.lightDummyUniform?.destroy();this.lightDummyDemand?.destroy();
  }
}


