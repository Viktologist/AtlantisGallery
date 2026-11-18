import {GPU,Texture,StorageBuffer,Material,ShaderModule,createViewUniforms,setFrameCamera,readBuffer} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Scene,Mesh} from '../../vendor/tidewater/src/engine/index.js';
import {terrainSamplingWGSL} from './terrain_sampling.js';
import {terrainVertexWGSL} from './terrain_material.js';
import {vegetationLODView} from './vegetation_geometry.js';
import {grassRegion} from './grass_screen_math.js';
import {GRASS_SCREEN_WGSL} from './grass_screen_compute.js';
import {GRASS_MIN_PIXELS,GRASS_SAMPLE_MIN_PIXELS,GRASS_SAMPLE_STEP,GRASS_NEAR_SAMPLE_STEP} from './vegetation_area.js';
import {grassWorldLayout} from './grass_world.js';
import {buildGrassTiles,grassFarClipW} from './grass_tiles.js';
import {grassDensityUniforms} from './grass_density.js';
import {impostorPixelClamp} from './grass_impostor.js';
import {VegetationIntervention} from './vegetation_intervention.js';

export class ScreenGrass {
 constructor(viewer,system,terrain){
  this.viewer=viewer;this.system=system;this.terrain=terrain;this.models=[];this.width=0;this.height=0;this.frames=0;
  this.unifiedNear=!!system.population?.gpuOwned;
  this.frameBlock=createViewUniforms('full-resolution grass terrain camera');
  this.depth=new Texture({label:'full-resolution terrain grass sample depth',width:1,height:1,format:'depth32float',usage:['render','sample','copySrc']});
  const nativeModule=terrain.terrainModule;
  const module=new ShaderModule({name:'grass-native-terrain-only',bindings:{terrainHeight:nativeModule.bindings.terrainHeight,terrainParams:nativeModule.bindings.terrainParams},code:terrainSamplingWGSL.split('// Reference ocean convention')[0]});
  this.terrainMaterial=new Material({name:'full-resolution native terrain depth for grass',lit:false,side:'double',modules:[module],attributes:{apsPatch:'vec4f'},varyings:{terrainSkirt:'f32'},vertex:terrainVertexWGSL,shadow:'return in.vs.terrainSkirt<.001;'});
  this.scene=new Scene();this.mesh=new Mesh(terrain.mesh.geometry,this.terrainMaterial);this.mesh.matrixAutoUpdate=false;this.mesh.frustumCulled=false;this.mesh.castShadow=true;this.scene.add(this.mesh);
  this.intervention=new VegetationIntervention();
 }
 async init(){
  const shader=GPU.device.createShaderModule({label:'GPU near/far screen grass selection',code:GRASS_SCREEN_WGSL});
  const info=await shader.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw Error('Screen grass WGSL: '+errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  this.layout=GPU.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},...[1,2,3,10,12].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:binding===1?'depth':binding===3?'float':'unfilterable-float'}})),...[4,5,6,7,8,9,11].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===8?'read-only-storage':'storage'}}))]});
  this.intervention.initGPU(GPU.device);
  if(!this.intervention.source&&this.system.intervention?.source)this.intervention.set(this.system.resolveInterventionSource?.(this.system.intervention.source)??this.system.intervention.source,{native:this.terrain.native});
  this.syncIntervention();
  const layout=GPU.device.createPipelineLayout({bindGroupLayouts:[this.layout]});this.pipelines={};
  await Promise.all(['resetGrass','clearGrassBins','maskGrass','selectGrassTiles','dispatchGrassTiles','competeGrassDepth','resolveGrassIDs','emitGrass'].map(async entryPoint=>{this.pipelines[entryPoint]=await GPU.device.createComputePipelineAsync({label:entryPoint,layout,compute:{module:shader,entryPoint}});}));
  for(const model of this.system.models){
   const impostor=this.system.grassImpostor;
   if(impostor&&this.system.models.length!==1)throw Error('Register an impostor per grass prototype');
   const region=grassRegion(model.source,model.worldBounds,model.localBounds,512,this.terrain.grassCells);
   const mask=new Texture({label:'native grass planting region',width:region.width,height:region.height,format:'r8unorm',data:region.data});mask.getGPU();
   const range=impostor?.range??model.packed.ranges[2];
   const commands=new Uint32Array(32);commands.set([range.indexCount,0,range.firstIndex,range.baseVertex,0]);const nearRange=model.packed.ranges[2];commands.set([nearRange.indexCount,0,nearRange.firstIndex,nearRange.baseVertex,0],18);
   const args=new StorageBuffer({label:'near/far grass indirect commands and counters',count:32,type:'u32',usage:['indirect'],data:commands});args.getGPU();
   const geometry=impostor?impostor.geometry.clone():vegetationLODView(model.packed,2,1,model.localBounds.clone());geometry.indirect={buffer:args,offset:0};
   const sourceMaterial=impostor?.material??model.source.material,material=sourceMaterial.clone();
   const step=this.terrain.grassCells?Math.sqrt(1/this.terrain.grassCells.manifest.density_per_m2):Math.max(.05,Math.max(model.localBounds.max.x-model.localBounds.min.x,model.localBounds.max.z-model.localBounds.min.z)*.5*Math.max(...region.scale));
   const radius=Math.hypot(Math.max(Math.abs(model.localBounds.min.x),Math.abs(model.localBounds.max.x)),model.localBounds.max.y-model.localBounds.min.y,Math.max(Math.abs(model.localBounds.min.z),Math.abs(model.localBounds.max.z)))*Math.max(...region.scale);
   const world=grassWorldLayout(region,step),tiles=buildGrassTiles(world,region,this.terrain.native,radius);
   if(tiles.bounds.length/8>=2**20||(tiles.bounds.length/8*64+4)*4>GPU.limits.maxStorageBufferBindingSize)throw Error('Far grass work queue exceeds packed ID/buffer limits');
   const row={model,impostor,region,mask,args,geometry,material,world,radius,tiles,seed:this.terrain.grassCells?.manifest.seed??9173,matrices:null,keys:null,pixels:null,capacity:0,uniform:GPU.device.createBuffer({label:'world grass projection parameters',size:400,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})};
   row.tileBounds=new StorageBuffer({label:'native world grass tile bounds',count:tiles.bounds.length/4,type:'vec4f',data:tiles.bounds});row.tileBounds.getGPU();
   row.queue=new StorageBuffer({label:'surviving world grass tiles',count:tiles.bounds.length/8*64+4,type:'u32'});row.queue.getGPU();
   row.dispatch=new StorageBuffer({label:'world grass tile dispatch',count:3,type:'u32',usage:['indirect']});row.dispatch.getGPU();
   material.bindings.apsScreenGrassMatrices={storage:()=>row.matrices,type:'mat4x4f',access:'read',visibility:'vertex'};
   material.bindings.apsScreenGrassKeys={storage:()=>row.keys,type:'u32',access:'read',visibility:'vertex'};
   const depthVertex='let apsScreenSlot=v.instance;v.model=apsScreenGrassMatrices[apsScreenSlot];v.prevModel=v.model;v.instance=apsScreenGrassKeys[apsScreenSlot];\n';
   material.vertex=depthVertex+sourceMaterial.vertex;
   const clamp=impostor?impostorPixelClamp(impostor.bounds):null,post=impostor?'\nv.worldPos=apsImpostorPosition(v.model,v.position);v.worldNormal=cofactor3(v.model)*v.normal;v.useWorld=true;':'';
   if(clamp){material.modules.push(clamp);material.vertex+=post;}
   material.userData={...material.userData,apsScreenGrassDepthVertex:depthVertex,apsScreenGrassDepthPostVertex:post,apsScreenGrassDepthModules:clamp?[clamp]:[]};
   const mesh=new Mesh(geometry,material);mesh.name=model.name+(impostor?' native impostor':' terrain-sampled LOD2');mesh.frustumCulled=false;mesh.castShadow=false;mesh.receiveShadow=true;mesh.layers.mask=model.draws[2].layers.mask;mesh.userData={apsGrassGenerated:true,apsGrassBand:'far',apsGrassViewCamera:this.viewer.camera};
   if(this.unifiedNear){
    if(!model.gpuPopulation)throw Error('Near screen bins require the native GPU world population');
    const geometry=vegetationLODView(model.packed,2,1,model.localBounds.clone());geometry.indirect={buffer:args,offset:18*4};
    const material=model.source.material.clone();material.bindings.apsScreenGrassMatrices={storage:()=>row.matrices,type:'mat4x4f',access:'read',visibility:'vertex'};material.bindings.apsScreenGrassKeys={storage:()=>row.keys,type:'u32',access:'read',visibility:'vertex'};
    const prefix=`let apsScreenSlot=v.instance+u32(ceil(frame.resolution.x/${GRASS_SAMPLE_STEP}.0))*u32(ceil(frame.resolution.y/${GRASS_SAMPLE_STEP}.0));v.model=apsScreenGrassMatrices[apsScreenSlot];v.prevModel=v.model;v.instance=apsScreenGrassKeys[apsScreenSlot];\n`;
    material.vertex=prefix+model.source.material.vertex;material.userData={...material.userData,apsScreenGrassDepthVertex:prefix};
    const mesh=new Mesh(geometry,material);mesh.name=model.name+` screen ${GRASS_NEAR_SAMPLE_STEP}x${GRASS_NEAR_SAMPLE_STEP} LOD2`;mesh.frustumCulled=false;mesh.castShadow=false;mesh.receiveShadow=true;mesh.layers.mask=model.draws[2].layers.mask;mesh.userData={apsGrassGenerated:true,apsGrassBand:'near',apsGrassViewCamera:this.viewer.camera};
    model.source.parent.add(mesh);row.near={geometry,material,mesh,uniform:GPU.device.createBuffer({label:'native near grass screen selection',size:400,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})};
   }
   model.source.parent.add(mesh);row.mesh=mesh;this.models.push(row);
  }
  this.resize();return this;
 }
 setIntervention(source,terrain=this.terrain){
  if(terrain)this.terrain=terrain;
  const resolved=this.system?.resolveInterventionSource?.(source)??source;
  const change=this.intervention.set(resolved,{native:(terrain??this.terrain)?.native});
  if(change.changed)this.applyInterventionChange(change);
  return change;
 }
 syncIntervention(){
  const raw=this.viewer?.terrainIntervention;
  if(raw===undefined)return false;
  if(raw===null&&!this.intervention.maskTexture&&!this.intervention.enabled)return false;
  const source=this.system?.resolveInterventionSource?.(raw)??raw;
  const change=this.intervention.set(source,{native:this.terrain.native});
  if(change.changed)this.applyInterventionChange(change);
  return change.changed;
 }
 applyInterventionChange(change){
  if(change.maskChanged||change.heightChanged||change.registrationChanged||change.revisionChanged)for(const row of this.models){row.group=null;if(row.near)row.near.group=null;}
  if(change.enabledChanged||change.maskChanged||change.registrationChanged||change.revisionChanged)this.system.onTransformChange?.();
 }
 activeHeightView(){return this.intervention.heightView()??this.terrain.terrainModule.bindings.terrainHeight.texture.view();}
 resize(){
  const fullW=this.viewer.canvas.width,fullH=this.viewer.canvas.height,w=fullW,h=fullH;
  if(w===this.width&&h===this.height&&this.depth.width===fullW&&this.depth.height===fullH)return;
  this.width=w;this.height=h;this.tileWidth=Math.ceil(w/GRASS_SAMPLE_STEP);this.tileHeight=Math.ceil(h/GRASS_SAMPLE_STEP);this.nearWidth=this.unifiedNear?Math.ceil(w/GRASS_NEAR_SAMPLE_STEP):0;this.nearHeight=this.unifiedNear?Math.ceil(h/GRASS_NEAR_SAMPLE_STEP):0;this.depth.resize(fullW,fullH);this.depth.getGPU();
  this.fallbackView?.pyramid.destroy();this.fallbackView=null;
  for(const row of this.models){
   const farCount=this.tileWidth*this.tileHeight,nearCount=this.nearWidth*this.nearHeight,count=farCount+nearCount;
   if(count*64>GPU.limits.maxStorageBufferBindingSize)throw Error('Screen grass matrix capacity exceeds GPU buffer limits');
   row.matrices?.destroy();row.matrices=new StorageBuffer({label:'GPU near/far grass matrices',count,type:'mat4x4f'});row.matrices.getGPU();row.capacity=farCount;row.nearCapacity=nearCount;row.geometry.instanceCount=farCount;if(row.near){row.near.geometry.instanceCount=nearCount;row.near.group=null;}
   row.keys?.destroy();row.keys=new StorageBuffer({label:'stable world grass identities',count,type:'u32'});row.keys.getGPU();
   row.pixels?.destroy();row.pixels=new StorageBuffer({label:`${GRASS_SAMPLE_STEP}x${GRASS_SAMPLE_STEP} far and ${GRASS_NEAR_SAMPLE_STEP}x${GRASS_NEAR_SAMPLE_STEP} near grass depth and world IDs`,count:count*3,type:'u32'});row.pixels.getGPU();
   row.maskPixels?.destroy();row.maskPixels=new StorageBuffer({label:'full-resolution grass eligibility mask',count:w*h,type:'u32'});row.maskPixels.getGPU();row.group=null;
   row.args.write(new Uint32Array([0]),4);row.args.write(new Uint32Array([0]),19*4);
  }
 }
 prepare(){
  if(this.disposed)return;
  this.syncIntervention();
  const v=this.viewer,t=this.terrain;
  if(v.heightfield!==t){for(const row of this.models){row.mesh.visible=false;if(row.near)row.near.mesh.visible=false;}return;}
  this.resize();setFrameCamera(v.camera,v.canvas.width,v.canvas.height,{block:this.frameBlock});
  t.mesh.updateWorldMatrix(true,false);this.mesh.matrix.copy(t.mesh.matrixWorld);this.mesh.count=t.mesh.count;
  v.meshRenderer.render(this.scene,{label:'full-resolution terrain grass sampling',kind:'depth',camera:v.camera,frameBlock:this.frameBlock,apsGrassTerrainSample:true,depthView:this.depth.view(),depthFormat:'depth32float',clearDepth:0,depthCompare:'greater-equal'});
  const camera=this.frameBlock.fields,native=t.native;
  for(const row of this.models){
   if(!row.impostor&&row.geometry.userData.apsVegetationBufferOwner!==row.model.packed.geometry){
    const old=row.geometry;row.geometry=vegetationLODView(row.model.packed,2,row.capacity,row.model.localBounds.clone());row.geometry.indirect={buffer:row.args,offset:0};row.mesh.geometry=row.geometry;
    const range=row.model.packed.ranges[2];row.args.write(new Uint32Array([range.indexCount,0,range.firstIndex,range.baseVertex,0]));old.dispose();
   }
   if(row.near&&row.near.geometry.userData.apsVegetationBufferOwner!==row.model.packed.geometry){
    const old=row.near.geometry;row.near.geometry=vegetationLODView(row.model.packed,2,row.nearCapacity,row.model.localBounds.clone());row.near.geometry.indirect={buffer:row.args,offset:18*4};row.near.mesh.geometry=row.near.geometry;
    const range=row.model.packed.ranges[2];row.args.write(new Uint32Array([range.indexCount,0,range.firstIndex,range.baseVertex,0]),18*4);old.dispose();
   }
   let visible=true;for(let o=row.model.source.parent;o;o=o.parent)visible&&=o.visible;
   row.mesh.visible=visible;if(row.near)row.near.mesh.visible=visible;
   const data=new Float32Array(100),b=row.model.localBounds;
   const density=grassDensityUniforms(this.system,v);data.set(density.eye,76);data.set(density.policy,80);
   data.set(camera.invViewProj.value.elements,0);data.set(camera.viewProj.value.elements,16);
   data.set([v.canvas.width,v.canvas.height,this.tileWidth,this.tileHeight],32);data.set([...row.region.min,...row.region.extent],36);
   data.set([b.min.x,b.min.y,b.min.z,row.model.margin],40);data.set([b.max.x,b.max.y,b.max.z,0],44);data.set([...row.region.scale,0],48);
   data.set([...native.origin,...native.spacing],52);data.set([native.shape[1],native.shape[0],t.uniforms.seaLevel.value,row.world.shape[1]],56);data.set([GRASS_MIN_PIXELS,row.impostor?1e30:grassFarClipW(camera.viewProj.value.elements,this.width,this.height,row.radius,GRASS_SAMPLE_MIN_PIXELS),0,+visible],60);const uints=new Uint32Array(data.buffer);uints[62]=row.seed;data.set([GRASS_SAMPLE_STEP,+!!row.impostor,v.camera.near,row.impostor?0:GRASS_SAMPLE_MIN_PIXELS],64);data.set([row.world.step,...row.world.min,row.world.shape[0]],68);uints.set([...row.tiles.shape,GPU.limits.maxComputeWorkgroupsPerDimension,0],72);
   uints.set([this.nearWidth,this.nearHeight,row.capacity,0],84);data.set([row.model.projectionDensity.target_root_area_m2,this.unifiedNear?1:0,0,0],88);
   data.set(this.intervention.uniforms,92);GPU.queue.writeBuffer(row.uniform,0,data);
   if(row.near){uints[87]=row.model.n;GPU.queue.writeBuffer(row.near.uniform,0,data);}
  }
  this.pendingFrame=GPU.frame;this.selectedFrame=null;this.frames++;
 }
 terrainPyramid(){
  if(!this.fallbackView){
   const pw=2**Math.ceil(Math.log2(this.width)),ph=2**Math.ceil(Math.log2(this.height)),levels=Math.floor(Math.log2(Math.max(pw,ph)))+1;
   const pyramid=GPU.device.createTexture({label:'standalone grass terrain Hi-Z',size:[pw,ph],format:'r32float',mipLevelCount:levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
   const v={key:'standalone grass terrain',pw,ph,levels,pyramid};
   v.copy=GPU.device.createBindGroup({layout:this.system.copyPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.depth.view()},{binding:1,resource:pyramid.createView({baseMipLevel:0,mipLevelCount:1})}]});
   v.reduce=[];for(let i=1;i<levels;i++)v.reduce.push(GPU.device.createBindGroup({layout:this.system.reducePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:pyramid.createView({baseMipLevel:i-1,mipLevelCount:1})},{binding:1,resource:pyramid.createView({baseMipLevel:i,mipLevelCount:1})}]}));
   this.fallbackView=v;
  }
  this.system.buildPyramid(this.fallbackView);return this.fallbackView.pyramid;
 }
 select(view=null,pass=null){
  if(this.disposed||this.pendingFrame!==GPU.frame||this.selectedFrame===GPU.frame||pass&&(pass.kind==='depth'||pass.camera!==this.viewer.camera))return;
  this.syncIntervention();
  const shared=!!(view?.pyramid&&view.reversed&&view.width===this.width&&view.height===this.height),pyramid=shared?view.pyramid:this.terrainPyramid();
  this.lastHiZ=shared?'shared current-frame terrain/solid/tall-plant Hi-Z':'standalone current-frame terrain Hi-Z';
  const height=this.activeHeightView(),mask=this.intervention.maskView();
  for(const row of this.models){
   if(!row.group||row.boundPyramid!==pyramid||row.heightView!==height||row.maskView!==mask){
    row.boundPyramid=pyramid;row.heightView=height;row.maskView=mask;row.group=GPU.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:row.uniform}},{binding:1,resource:this.depth.view()},{binding:2,resource:height},{binding:3,resource:row.mask.view()},{binding:10,resource:pyramid.createView()},{binding:11,resource:{buffer:row.maskPixels.getGPU()}},{binding:12,resource:mask},...[row.matrices,row.args,row.pixels,row.keys,row.tileBounds,row.queue].map((b,i)=>({binding:4+i,resource:{buffer:b.getGPU()}}))]});
   }
   if(row.near&&(!row.near.group||row.near.pyramid!==pyramid||row.near.source!==row.model.matrices||row.near.heightView!==height||row.near.maskView!==mask)){
    row.near.pyramid=pyramid;row.near.source=row.model.matrices;row.near.heightView=height;row.near.maskView=mask;
    row.near.group=GPU.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:row.near.uniform}},{binding:1,resource:this.depth.view()},{binding:2,resource:height},{binding:3,resource:row.mask.view()},{binding:10,resource:pyramid.createView()},{binding:11,resource:{buffer:row.maskPixels.getGPU()}},{binding:12,resource:mask},...[row.matrices,row.args,row.pixels,row.keys,row.model.matrices,row.model.keys].map((b,i)=>({binding:4+i,resource:{buffer:b.getGPU()}}))]});
   }
   const compute=(name,dispatch)=>{const c=GPU.getEncoder().beginComputePass({label:name});c.setBindGroup(0,row.group);c.setPipeline(this.pipelines[name]);dispatch(c);c.end();};
   compute('resetGrass',c=>c.dispatchWorkgroups(1));
   compute('clearGrassBins',c=>c.dispatchWorkgroups(Math.ceil(this.tileWidth/8),Math.ceil(this.tileHeight/8)));
   compute('maskGrass',c=>c.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8)));
   compute('selectGrassTiles',c=>c.dispatchWorkgroups(Math.ceil(row.tiles.shape[0]*row.tiles.shape[1]/64)));
   compute('dispatchGrassTiles',c=>c.dispatchWorkgroups(1));
   GPU.getEncoder().copyBufferToBuffer(row.queue.getGPU(),0,row.dispatch.getGPU(),0,12);
   for(const name of ['competeGrassDepth','resolveGrassIDs'])compute(name,c=>{
    if(row.near){c.setBindGroup(0,row.near.group);c.dispatchWorkgroups(Math.ceil(row.model.n/64));c.setBindGroup(0,row.group);}
    c.dispatchWorkgroupsIndirect(row.dispatch.getGPU(),0);
   });
   compute('emitGrass',c=>{
    if(row.near){c.setBindGroup(0,row.near.group);c.dispatchWorkgroups(Math.ceil(this.nearWidth/8),Math.ceil(this.nearHeight/8));c.setBindGroup(0,row.group);}
    c.dispatchWorkgroups(Math.ceil(this.tileWidth/8),Math.ceil(this.tileHeight/8));
   });
  }
  this.selectedFrame=GPU.frame;
 }
 metadata(){
  const impostor=this.system.grassImpostor;
  return {method:'shared grass_screen_compute WGSL: classify -> nearest depth -> stable world ID -> near LOD2 and far indirect draws',world_stable:true,resolution:[this.width,this.height],winner_grid_resolution:[this.tileWidth,this.tileHeight],terrain_depth_resolution:[this.depth.width,this.depth.height],sample_step_pixels:GRASS_SAMPLE_STEP,max_points_per_screen_tile:1,
   near_screen_grid:this.unifiedNear?{step_pixels:GRASS_NEAR_SAMPLE_STEP,resolution:[this.nearWidth,this.nearHeight],max_points_per_screen_tile:1,density:'Imported bbox world-density floor plus continuous inverse projected-area retention; fixed world-ID rank',lod:2,source:'exact native GPU population matrices',old_main_draw_disabled:true}:null,
   pixel_winner:'nearest positive reversed-Z among retained candidates; exact depth ties use minimum world ID',candidate_lattice:impostor?'far world-cell stride 1/2/4/8/16; original world IDs retained':'all far world cells',shared_compute_pipelines:['competeGrassDepth','resolveGrassIDs','emitGrass'],global_sync:'separate dispatches for depth competition, ID resolution and emission',view_scope:'main camera; other cameras retain native vegetation selection',
   hiz:this.lastHiZ??null,frames:this.frames,area_pixels:[impostor?0:GRASS_SAMPLE_MIN_PIXELS,GRASS_MIN_PIXELS],minimum_display_pixels:impostor?[8,8]:null,classification_before_display_enlargement:true,impostor:impostor?.metadata()??null,casts_solar_shadow:false,ao:'current opaque depth SSAO',intervention:this.intervention.metadata(),
   regions:this.models.map(r=>({model:r.model.name,projection_density:r.model.projectionDensity,min:r.region.min,extent:r.region.extent,mask_resolution:[r.region.width,r.region.height],mask_method:r.region.method,world_cell_size_m:r.world.step,world_tiles:r.tiles.shape,occupied_world_tiles:r.tiles.occupied,seed:r.seed,far_capacity:r.capacity,near_capacity:r.nearCapacity}))};
 }
 async audit(){GPU.submit();return Promise.all(this.models.map(async row=>{const commands=Array.from(new Uint32Array(await readBuffer(row.args,row.args.byteLength))),queue=new Uint32Array(await readBuffer(row.queue,16));return {model:row.model.name,commands,intervention_rejected:commands[31],masked_pixels:commands[5],eligible_screen_tiles:commands[15],unoccupied_mask_tiles:commands[14],candidate_points:commands[12],eligible_points:commands[8],density_rejected:commands[16],surviving_tiles:commands[17],candidate_workgroups:queue[3],tile_frustum_rejected:commands[9],tile_hiz_rejected:commands[10],tile_area_bound_rejected:commands[11],point_hiz_rejected:commands[13],near:{step_pixels:GRASS_NEAR_SAMPLE_STEP,count:commands[19],capacity:row.nearCapacity,triangles:commands[18]*commands[19]/3,candidate_points:commands[23],eligible_points:commands[27],hiz_rejected:commands[25],density_rejected:commands[28],projection_density_rejected:commands[29],source_lookup_errors:commands[30]},far_capacity:row.capacity};}));}
 dispose(){
  if(this.disposed)return;this.disposed=true;
  this.depth.destroy();this.fallbackView?.pyramid.destroy();this.frameBlock.buffer?.destroy();this.terrainMaterial.dispose();this.terrainMaterial.uniformBlock.buffer?.destroy();this.intervention.dispose();
  for(const row of this.models){row.mesh.removeFromParent();row.geometry.dispose();row.material.dispose();row.material.uniformBlock.buffer?.destroy();for(const k of ['mask','args','matrices','keys','pixels','maskPixels','tileBounds','queue','dispatch'])row[k]?.destroy();row.uniform.destroy();}
  for(const row of this.models)if(row.near){row.near.mesh.removeFromParent();row.near.geometry.dispose();row.near.material.dispose();row.near.material.uniformBlock.buffer?.destroy();row.near.uniform.destroy();}
  this.system.grassImpostor?.dispose();this.system.grassImpostor=null;
 }
}
