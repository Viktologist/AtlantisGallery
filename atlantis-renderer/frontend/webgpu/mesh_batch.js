import {InstancedMesh,Matrix4,Box3,Group} from '../../vendor/tidewater/src/engine/index.js';
import {planModelMerges,mergePrototypeGeometry,supportedMatrix} from './mesh_model_merge.js';
import {createMeshModelMaterial,attachStaticInstanceRemap} from './mesh_material.js';
import {StorageBuffer} from '../../vendor/tidewater/src/engine/webgpu.js';
import {fillModelMaterialPalette} from './model_material_palette.js';
import {STATIC_DRAW_ID_REGIONS} from './static_draw_gpu_plan.js';
import {inheritedBuildingData,semanticLayerKey} from './building_layers.js';

const supported=supportedMatrix;
                                                                                  
                                                                                  
                                                                                   
                                                                                    
                                                                                    
                                                        
export function batchStaticOccurrences(root,readback,resources,hasAnimations,options={}) {
  if(hasAnimations)return {occurrences:0,drawGroups:0,nestedGpuInstances:false,skipped:'animations'};
  root.updateMatrixWorld(true);
  const paletteBuffer=new StorageBuffer({label:'native per-instance material assignments',type:'u32',count:1});
                                                                            
                                                                               
                                                                            
  const maxInstances=readback.reduce((n,row)=>n+Math.max(1,row.mesh?.count??1),0);
                                                                               
                                                                             
                                                                                
                                       
  const instanceRegion=Math.max(1,maxInstances);
  const instanceIdBuffer=new StorageBuffer({label:'native static source instance IDs',type:'u32',count:Math.max(16,instanceRegion*STATIC_DRAW_ID_REGIONS)});
  resources.buffers??=new Set();resources.buffers.add(paletteBuffer);resources.buffers.add(instanceIdBuffer);
  const domains=new Map(),domainErrors=[];
  const plan=planModelMerges(readback,{transformTolerance:options.transformTolerance??0,verifyDomain:(domain,entries)=>{
    try {
      domains.set(domain.key,createMeshModelMaterial(entries,{hasNormal:domain.hasNormal,hasTangent:domain.hasTangent,uvSets:domain.uvSets,
        topology:domain.topology,mirrored:domain.mirrored,doubleSided:domain.doubleSided,lighting:options.lighting,
        materialLibrary:options.materialLibrary??'',materialTextures:options.materialTextures??{},paletteBuffer,instanceIdBuffer}));
      return null;
    } catch(error) {domainErrors.push({domain:domain.key,materials:entries.map(entry=>entry.materialId),message:error.message});return 'dispatch_domain_rejected';}
  }});
  if(plan.instances>maxInstances)throw Error(`Static instance ID capacity ${maxInstances} is below ${plan.instances} logical instances`);
  const palette=fillModelMaterialPalette(plan.prototypes,paletteBuffer);
  if(!palette.entries)resources.buffers.delete(paletteBuffer);
  root.userData.aps_material_palette=palette;
  for(const material of domains.values())resources.materials.add(material);
  const merged={draw_groups:0,logical_instances:0,primitive_occurrences:0,triangles:0,materials:0};
  const rowsByPart=new Map();
  for(const row of readback)rowsByPart.set(`${row.nodeIndex}:${row.primitiveIndex}`,row);
  let index=0;
  let instanceOffset=0;
  for(const prototype of plan.prototypes) {
    const material=domains.get(prototype.domain.key);
    if(!material)throw Error('Merged model prototype lost its verified dispatch material');
    const geometry=mergePrototypeGeometry(prototype,{resources});
    const batch=new InstancedMesh(geometry,material,prototype.instances.length);
    const range=palette.ranges.get(prototype.signature);
    batch.drawParams=[range.offset,range.partCount,-1];
    batch.name=`NativeMergedModel_${index++}`;
    batch.castShadow=prototype.castShadow;batch.receiveShadow=prototype.receiveShadow;batch.layers.mask=prototype.layersMask;
    batch.matrixAutoUpdate=false;
    batch.userData={...inheritedBuildingData(prototype.parts[0].row.mesh),aps_flattened_native_instances:true,aps_merged_model_prototype:true,
      aps_static_instance_id:{buffer:instanceIdBuffer,base:instanceOffset,region:instanceRegion},
      aps_model_signature:prototype.signature,aps_material_ids:[...new Set(prototype.parts.map(part=>part.materialId))],
      aps_source_primitive_rows:prototype.parts.length,aps_source_occurrences:prototype.parts.length*prototype.instances.length,
      aps_logical_occurrence_keys:prototype.instances.map(instance=>instance.key),
      aps_source_parts:prototype.parts.map(part=>({mesh:part.meshIndex,primitive:part.primitiveIndex,material_id:part.materialId})),
      instance_entity_ids:prototype.instances.map(instance=>instance.entity_id),
      aps_instance_sources:prototype.instances.map(instance=>({key:instance.key,parts:instance.source_parts.map(part=>({gltf_node:part.nodeIndex,source_instance:part.sourceInstance,ordinal:part.ordinal,material_id:part.materialId}))}))};
    instanceOffset+=prototype.instances.length;
    prototype.instances.forEach((instance,i)=>batch.setMatrixAt(i,instance.matrix));
    batch.instanceMatrix.needsUpdate=true;batch.computeBoundingBox();batch.computeBoundingSphere();
    root.add(batch);resources.meshes.add(batch);markNativeStaticGeometry(batch);
    prototype.instances.forEach((instance,i)=>{for(const part of instance.source_parts) {
      const row=rowsByPart.get(`${part.nodeIndex}:${part.primitiveIndex}`);
      if(!row)continue;row.mergedMesh=batch;row.mergedInstances??=[];row.mergedInstances.push(i);
    }});
    merged.draw_groups++;merged.logical_instances+=prototype.instances.length;merged.primitive_occurrences+=prototype.parts.length*prototype.instances.length;
    merged.triangles+=prototype.triangles*prototype.instances.length;
  }
  merged.materials=domains.size;
                                                                            
                                                                              
                          
  for(const mesh of plan.fullyMergedMeshes)mesh.removeFromParent();
                                                                                   
                                                                                  
                                                        
  const legacyRows=readback.filter(row=>!plan.fullyMergedMeshes.has(row.mesh)&&!plan.partiallyMergedMeshes.has(row.mesh)
    &&!row.mesh.userData?.aps_static_roof&&!row.mesh.userData?.aps_no_instancing);
  const legacy=batchLegacyOccurrences(root,legacyRows,resources);
                                                                              
                                                           
  const detach=detachEmptyStaticGroups(root);
                                                                               
                                                                                
                                                              
  const sourceInstances=bindStaticSourceInstances(root,instanceIdBuffer,{region:instanceRegion,base:instanceOffset});
  const triangles={source:plan.stats.source_triangles,source_parts:plan.stats.source_primitive_occurrences,
    merged:merged.triangles,legacy:legacy.triangles,retained_fallback:plan.stats.fallback_triangles-legacy.triangles,
    fallback_triangles:plan.stats.fallback_triangles,fallback_occurrences:plan.stats.fallback_primitive_occurrences,reconciled:false};
  triangles.reconciled=triangles.merged+triangles.legacy+triangles.retained_fallback===triangles.source;
  if(!triangles.reconciled)throw Error(`Static instancing lost triangles: ${triangles.source} source vs ${triangles.merged}+${triangles.legacy}+${triangles.retained_fallback}`);
  const result={occurrences:merged.logical_instances+legacy.occurrences,drawGroups:merged.draw_groups+legacy.drawGroups,nestedGpuInstances:false,
    model_merge:plan.stats,merged,legacy,detach,triangles,domains:domains.size,domain_errors:domainErrors,
    material_palette:{entries:palette.entries,bytes:paletteBuffer.byteLength,per_instance:true},
    static_instance_ids:{regions:STATIC_DRAW_ID_REGIONS,capacity:instanceRegion,logical_instances:plan.instances,
      source_instances:sourceInstances.candidates,source_instance_count:sourceInstances.instances,bytes:instanceIdBuffer.byteLength}};
  root.userData.aps_static_instance_compilation=result;root.userData.aps_detached_provenance=detach.provenance;
  return result;
}
                                                                                
                                                                           
                                                                           
                                                                         
function sourceInstanceDrawable(mesh) {
  if(!mesh?.isInstancedMesh||!Number.isInteger(mesh.count)||mesh.count<=0)return false;
  const userData=mesh.userData??{};
  if(userData.aps_merged_model_prototype||userData.aps_vegetation_lods||userData.apsVegetationManaged
    ||userData.aps_deformed||userData.aps_animated||userData.aps_skinned||userData.aps_static_visibility_disabled)return false;
                                                                            
  if(userData.gltf_mesh===undefined&&!userData.aps_flattened_native_instances)return false;
  if(userData.aps_static_instance_id)return false;
                                                                                
                                                                    
  if(mesh.instanceColor)return false;
  const material=Array.isArray(mesh.material)?null:mesh.material;
  if(!material||material.transparent||(material.alphaTest??0)>0||(material.topology??'triangle-list')!=='triangle-list')return false;
                                                                             
                                                                    
  if(typeof material.vertex!=='string'||material.vertex.indexOf('o.apsLocalPosition=v.position;')<0)return false;
  const geometry=mesh.geometry;
  if(!geometry?.index||!geometry.attributes?.position||geometry.groups?.length)return false;
  if(geometry.drawRange&&geometry.drawRange.count!==Infinity)return false;
  if(geometry.index.count<3||geometry.index.count%3!==0)return false;
  if(!mesh.instanceMatrix?.array||mesh.instanceMatrix.array.length<mesh.count*16)return false;
  return true;
}

                                                                           
                                                                              
                                                                                
                                                                            
                                                                          
export function bindStaticSourceInstances(root,instanceIdBuffer,{region,base=0}={}) {
  if(!instanceIdBuffer||!Number.isInteger(region)||region<=0)throw Error('Static source instances require a positive shared ID region');
  const candidates=[];
  root?.traverse?.(mesh=>{if(sourceInstanceDrawable(mesh))candidates.push(mesh);});
  let next=base;
  for(const mesh of candidates) {
    if(next+mesh.count>region)throw Error(`Static source instance ID capacity ${region} is below ${next+mesh.count}`);
    const drawParams=Array.isArray(mesh.drawParams)?mesh.drawParams:[];
    mesh.drawParams=[drawParams[0]??0,drawParams[1]??0,-1];
    mesh.userData.aps_static_source_instance=true;
    mesh.userData.aps_static_instance_id={buffer:instanceIdBuffer,base:next,region};
    next+=mesh.count;
  }
  const materials=new Set(candidates.map(mesh=>mesh.material));
  for(const material of materials)attachStaticInstanceRemap(material,instanceIdBuffer);
                                                                              
                                                                                
                                                           
  if(materials.size)root?.traverse?.(mesh=>{
    if(!mesh?.isMesh||!materials.has(mesh.material))return;
    if(!Array.isArray(mesh.drawParams))mesh.drawParams=[0,0,-1];
    else if(mesh.drawParams.length<3)mesh.drawParams[2]=-1;
  });
  return {candidates:candidates.length,instances:next-base,base_end:next,region};
}

                                                                           
                                                       
function batchLegacyOccurrences(root,readback,resources) {
  root.updateMatrixWorld(true);const inverse=root.matrixWorld.clone().invert(),groups=new Map();
  for(const row of readback) {
    const mesh=row.mesh;
    if(!mesh.userData.aps_component_id||row.deformed||mesh.material.transparent)continue;
    let visible=true;for(let n=mesh;n;n=n.parent)if(!n.visible)visible=false;if(!visible)continue;
    const matrix=inverse.clone().multiply(mesh.matrixWorld),rows=[];
    if(!supported(matrix))continue;
    for(let i=0;i<mesh.count;i++) {
      const local=new Matrix4();if(mesh.isInstancedMesh)mesh.getMatrixAt(i,local);
      const world=matrix.clone().multiply(local);
      if(!supported(world)){rows.length=0;break;}
      rows.push({row,matrix:world,sourceInstance:mesh.isInstancedMesh?row.sourceInstanceIndices[i]:null,entity_id:mesh.userData.instance_entity_ids?.[i]??row.entity_id});
    }
    if(!rows.length)continue;
    let byMaterial=groups.get(mesh.geometry);if(!byMaterial)groups.set(mesh.geometry,byMaterial=new Map());
    const key=[mesh.material.id,mesh.castShadow,mesh.receiveShadow,mesh.layers.mask,semanticLayerKey(mesh.userData)].join(':');
    if(!byMaterial.has(key))byMaterial.set(key,[]);byMaterial.get(key).push(...rows);
  }
  let occurrences=0,drawGroups=0,triangles=0;
  for(const byMaterial of groups.values())for(const rows of byMaterial.values()) {
    if(rows.length<2)continue;
    const original=rows[0].row.mesh,batch=new InstancedMesh(original.geometry,original.material,rows.length);
    batch.name='NativeStaticInstances';batch.castShadow=original.castShadow;batch.receiveShadow=original.receiveShadow;batch.layers.mask=original.layers.mask;
    batch.matrixAutoUpdate=false;
    batch.userData={...inheritedBuildingData(original),aps_flattened_native_instances:true,
      instance_entity_ids:rows.map(r=>r.entity_id),aps_instance_sources:rows.map(r=>({...r.row.mesh.userData,sourceInstance:r.sourceInstance,gltf_node:r.row.nodeIndex}))};
    rows.forEach((r,i)=>{batch.setMatrixAt(i,r.matrix);r.row.batchMesh=batch;r.row.batchInstances??=[];r.row.batchInstances.push(i);});
    batch.instanceMatrix.needsUpdate=true;batch.computeBoundingBox();batch.computeBoundingSphere();root.add(batch);resources.meshes.add(batch);markNativeStaticGeometry(batch);
    for(const mesh of new Set(rows.map(r=>r.row.mesh)))mesh.removeFromParent();
    occurrences+=rows.length;drawGroups++;
    triangles+=rows.reduce((sum,r)=>sum+(r.row.trianglesPerOccurrence??0),0);
  }
  return {occurrences,drawGroups,triangles};
}
                                                                              
                                                                                 
                                                                                    
export function detachEmptyStaticGroups(root,{provenance=new Group()}={}) {
  provenance.name='NativeStaticProvenance';provenance.matrixAutoUpdate=false;
  let detachedGroups=0,detachedRoots=0;const detachedNodes=[];
  const containsMesh=node=>{let found=false;node.traverse(object=>{if(object.isMesh)found=true;});return found;};
  const prune=node=>{
    for(const child of [...node.children]) {
      if(child.isMesh||child.userData?.aps_keep_in_hierarchy||child.userData?.aps_dynamic_hierarchy)continue;
      if(child.userData?.gltf_node===undefined)continue;
      if(containsMesh(child)){prune(child);continue;}
      node.remove(child);provenance.add(child);detachedNodes.push(child);
      child.traverse(object=>{if(!object.isMesh)detachedGroups++;});
      detachedRoots++;
    }
  };
  prune(root);
  const result={detached:detachedGroups,detached_groups:detachedGroups,detached_roots:detachedRoots};
  Object.defineProperties(result,{detachedNodes:{value:detachedNodes},provenance:{value:provenance}});
  return result;
}
                                                                                  
                                                                                  
                 
export function nativeStaticDepthSafe(material) { return !!material&&!material.transparent&&!(material.alphaTest>0)&&!material.shadow; }
export function markNativeStaticGeometry(mesh) {
  if(!nativeStaticDepthSafe(mesh.material))return false;
  mesh.userData.aps_native_static_geometry=true;
  if(mesh.geometry)mesh.geometry.userData.aps_native_static_geometry=true;
  return true;
}
export function validateMeshBounds(root) {
  root.updateMatrixWorld(true);const bounds=new Box3().makeEmpty();let vertices=0;
  root.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const pos=mesh.geometry.attributes.position;if(!pos?.count||mesh.count===0)return;
    const box=mesh.isInstancedMesh?mesh.boundingBox:mesh.geometry.boundingBox;
    if(!box||box.isEmpty())return;
    const world=box.clone().applyMatrix4(mesh.matrixWorld);
    if(![...world.min.toArray(),...world.max.toArray()].every(Number.isFinite))throw Error('Nonfinite candidate mesh bounds');
    bounds.union(world);vertices+=pos.count*mesh.count;
  });
  if(!vertices||bounds.isEmpty()||![...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite))throw Error('Model has no valid nonempty finite browsable geometry');
  return bounds;
}
