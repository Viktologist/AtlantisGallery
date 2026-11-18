import {Box3,Vector3} from '../../vendor/tidewater/src/engine/index.js';
import {GPU,Texture,StorageBuffer,readBuffer} from '../../vendor/tidewater/src/engine/webgpu.js';
import {grassWorldLayout} from './grass_world.js';
import {GRASS_POPULATION_WGSL} from './grass_population_compute.js';
import {VegetationIntervention} from './vegetation_intervention.js';

export function grassHash32(value){let h=value>>>0;h^=h>>>16;h=Math.imul(h,2246822519);h^=h>>>13;h=Math.imul(h,3266489917);h^=h>>>16;return (h>>>8)/16777216;}
export function nativeGrassSurface(native,x,z){
 const [ox,oz]=native.origin,[dx,dz]=native.spacing,[nz,nx]=native.shape;
 const gx=(x-ox)/dx,gz=(z-oz)/dz;if(gx<0||gz<0||gx>=nx-1||gz>=nz-1)return null;
 const ix=Math.floor(gx),iz=Math.floor(gz),u=gx-ix,v=gz-iz,a=native.data[iz*nx+ix],b=native.data[iz*nx+ix+1],c=native.data[(iz+1)*nx+ix],d=native.data[(iz+1)*nx+ix+1];
 const lower=u+v<=1,height=lower?a*(1-u-v)+b*u+c*v:d*(u+v-1)+b*(1-v)+c*(1-u);
 const sx=(lower?b-a:d-c)/dx,sz=(lower?c-a:d-b)/dz,len=Math.hypot(sx,1,sz);
 return {height,normal:[-sx/len,1/len,-sz/len],slope:[sx,sz],cell:iz*(nx-1)+ix};
}

                                                                              
                                                                                 
export class GrassPopulation{
 constructor(viewer,system,terrain,rows){
  this.viewer=viewer;this.system=system;this.terrain=terrain;this.rows=rows;this.updates=0;this.active=null;this.gpuOwned=true;
  const field=terrain.grassCells.manifest;this.step=Math.sqrt(1/field.density_per_m2);
  this.world=grassWorldLayout({min:terrain.grassCells.origin,extent:terrain.grassCells.extent},this.step);this.step=this.world.step;
  let diameter=0;for(const row of rows)diameter=Math.max(diameter,Math.hypot(row.box.max.x-row.box.min.x,row.box.max.y-row.box.min.y,row.box.max.z-row.box.min.z));
  this.diameter=diameter;this.radiusFor=()=>Math.max(12,viewer.canvas.height/(2*Math.tan(viewer.camera.fov*Math.PI/360))*diameter/32+diameter+8);
                                                                                    
  let lo=Infinity,hi=-Infinity;for(const y of terrain.native.data){lo=Math.min(lo,y);hi=Math.max(hi,y);}
  const [x,z]=terrain.grassCells.origin,[w,h]=terrain.grassCells.extent;
  this.worldBounds=new Box3(new Vector3(x-diameter,lo-diameter,z-diameter),new Vector3(x+w+diameter,hi+diameter,z+h+diameter));
  this.mask=new Texture({label:'GPU near grass native CELL mask',width:terrain.grassCells.shape[1],height:terrain.grassCells.shape[0],format:'r8unorm',data:terrain.grassCells.data});this.mask.getGPU();
  this.intervention=new VegetationIntervention();
 }
 async init(){
  const shader=GPU.device.createShaderModule({label:'GPU near grass world population',code:GRASS_POPULATION_WGSL});
  const errors=(await shader.getCompilationInfo()).messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  this.layout=GPU.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},{binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'float'}},...[3,4,5,6,7].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}})),{binding:8,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}}]});
  const layout=GPU.device.createPipelineLayout({bindGroupLayouts:[this.layout]});
  [this.preparePipeline,this.generatePipeline]=await Promise.all(['preparePopulation','generatePopulation'].map(entryPoint=>GPU.device.createComputePipelineAsync({label:entryPoint,layout,compute:{module:shader,entryPoint}})));
  this.intervention.initGPU(GPU.device);
  if(!this.intervention.source&&this.system.intervention?.source)this.intervention.set(this.system.resolveInterventionSource?.(this.system.intervention.source)??this.system.intervention.source,{native:this.terrain.native});
  this.syncIntervention();
  this.allocate(this.radiusFor());return this;
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
  if(change.maskChanged||change.heightChanged||change.registrationChanged||change.revisionChanged)for(const row of this.rows)row.group=null;
  if(change.enabledChanged||change.maskChanged||change.registrationChanged||change.revisionChanged)this.system.onTransformChange?.();
 }
 activeHeightView(){return this.intervention.heightView()??this.terrain.terrainModule.bindings.terrainHeight.texture.view();}
 bindRows(){for(const row of this.rows){if(row.group)continue;row.group=GPU.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:row.uniform}},{binding:1,resource:this.activeHeightView()},{binding:2,resource:this.mask.view()},...[row.gpu.matrices,row.gpu.bounds,row.gpu.blocks,row.gpu.keys,this.state].map((b,i)=>({binding:i+3,resource:{buffer:b.getGPU()}})),{binding:8,resource:this.intervention.maskView()}]});}}

 allocate(radius){
  const side=Math.ceil(radius*2/this.step)+4,tileSide=Math.ceil((side+7)/8),capacity=tileSide*tileSide*64,limit=Math.min(GPU.limits.maxComputeWorkgroupsPerDimension*64,Math.floor(GPU.limits.maxStorageBufferBindingSize/64));
  if(capacity>limit)throw Error('Near-grass population exceeds GPU instance-buffer capacity');
  this.radius=radius;this.side=tileSide*8;this.tileSide=tileSide;this.capacity=capacity;
  this.state?.destroy();this.dispatch?.destroy();
  this.state=new StorageBuffer({label:'GPU near grass window and population counts',count:12+this.rows.length,type:'u32'});this.state.getGPU();
  this.dispatch=new StorageBuffer({label:'GPU near grass regeneration dispatch',count:3,type:'u32',usage:['indirect']});this.dispatch.getGPU();
  const native=this.terrain.native,field=this.terrain.grassCells,m=field.manifest;
  for(const [index,row] of this.rows.entries()){
   for(const b of Object.values(row.gpu??{}))b?.destroy?.();row.uniform?.destroy();
   const make=(label,count,type)=>{const b=new StorageBuffer({label,count,type});b.getGPU();return b;};
   row.gpu={capacity,matrices:make('GPU near grass matrices',capacity,'mat4x4f'),bounds:make('GPU near grass world AABBs',capacity*2,'vec4f'),blocks:make('GPU near grass 8x8 world blocks',tileSide*tileSide*72,'u32'),keys:make('GPU near grass stable world IDs',capacity,'u32'),blockCount:tileSide*tileSide,worldBounds:this.worldBounds.clone()};
   row.uniform=GPU.device.createBuffer({label:'near grass camera and recipe parameters',size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});row.data=new Float32Array(44);const ints=new Int32Array(row.data.buffer),uints=new Uint32Array(row.data.buffer);
   row.data.set([...native.origin,...native.spacing],0);uints.set([native.shape[1],native.shape[0],tileSide,capacity],4);row.data.set([...field.origin,...field.extent],12);
   row.data.set([this.step,m.root_radius_m,m.max_height_error_m,row.margin],16);row.data.set([row.box.min.x,row.box.min.y,row.box.min.z,0],20);row.data.set([row.box.max.x,row.box.max.y,row.box.max.z,0],24);uints.set([m.seed,index,this.rows.length,0],28);ints.set([...this.world.min,...this.world.shape],32);
   row.data.set(this.intervention.uniforms,36);
   row.group=null;
  }
  this.bindRows();
 }
 update(force=false){
  if(this.disposed)return;const {camera}=this.viewer;
  this.syncIntervention();
  const needed=this.radiusFor(),resized=needed>this.radius+.5;
  if(resized){
                                                                               
                                                                              
   GPU.submit();
   this.system.clearModels();this.allocate(needed);this.registerModels();
   for(const [i,row] of (this.system.screenGrass?.models??[]).entries())row.model=this.system.models[i];
  }
  if(this.rows.some(row=>!row.group))this.bindRows();
  for(const row of this.rows){row.data.set(this.intervention.uniforms,36);row.data.set([camera.position.x,camera.position.y,camera.position.z,this.radius],8);GPU.queue.writeBuffer(row.uniform,0,row.data);}
  const prepare=GPU.getEncoder().beginComputePass({label:'GPU near grass window check'});prepare.setPipeline(this.preparePipeline);prepare.setBindGroup(0,this.rows[0].group);prepare.dispatchWorkgroups(1);prepare.end();
  GPU.getEncoder().copyBufferToBuffer(this.state.getGPU(),32,this.dispatch.getGPU(),0,12);
  const generate=GPU.getEncoder().beginComputePass({label:'GPU near grass generation and block bounds'});generate.setPipeline(this.generatePipeline);for(const row of this.rows){generate.setBindGroup(0,row.group);generate.dispatchWorkgroupsIndirect(this.dispatch.getGPU(),0);}generate.end();
  const key=[Math.floor((camera.position.x-this.radius)/4),Math.floor((camera.position.z-this.radius)/4)].join(',');
  if((force||resized||key!==this.key)&&this.viewer.shadows?.cascades?.[0])this.viewer.shadows.cascades[0].dirty=true;this.key=key;this.updates++;
 }
 registerModels(){for(const row of this.rows)this.system.register(row.source,row.lods,{...row,gpuPopulation:row.gpu});}
 metadata(){return {representation:'GPU-owned world-seeded near grass; toroidal 8x8 world-cell blocks',eligible_area_m2:this.terrain.grassCells.manifest.domain.grass_area_m2,seed:this.terrain.grassCells.manifest.seed,density_per_m2:this.terrain.grassCells.manifest.density_per_m2,capacity:this.capacity,active:null,active_source:'GPU counter, explicit audit only',radius_m:this.radius,parameter_updates:this.updates,CPU_matrix_upload_bytes_per_frame:0,CPU_instance_scans_per_frame:0,block_cells:[8,8],source_GLB_and_tree_poses_unchanged:true,coverage_certificate:false,intervention:this.intervention.metadata()};}
 async audit(){GPU.submit();const values=new Uint32Array(await readBuffer(this.state,this.state.byteLength));return {...this.metadata(),active:values[11],airborne:!!values[3],gpu_epoch:values[4],regenerated:!!values[5],model_active:Array.from(values.slice(12))};}
 dispose(){if(this.disposed)return;this.disposed=true;this.mask.destroy();this.state?.destroy();this.dispatch?.destroy();this.intervention.dispose();for(const row of this.rows){row.uniform?.destroy();for(const b of Object.values(row.gpu??{}))b?.destroy?.();}}
}

export async function configureGrassPopulation(viewer,system,terrain){
 if(!terrain.grassCells||system.population)return;
 const rows=system.models.map(m=>({source:m.source,lods:m.lods,margin:m.margin,thresholds:m.thresholds,box:m.localBounds.clone()}));
 for(const row of rows){row.source.updateWorldMatrix(true,false);if(row.source.matrixWorld.elements.some((x,i)=>Math.abs(x-(i%5===0?1:0))>1e-5))throw Error('Runtime grass population requires a baked world/Y-up prototype');}
 system.clearModels();
 const population=new GrassPopulation(viewer,system,terrain,rows);system.population=population;await population.init();population.registerModels();population.update(true);
 system.onTransformChange=()=>{if(viewer.shadows?.cascades?.[0])viewer.shadows.cascades[0].dirty=true;};
}
