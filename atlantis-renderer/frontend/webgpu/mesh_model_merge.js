                                                                          
                                                                                 
                                                                                
                                                                             
                                                                                 
                                                                                
                                                                             
                      
import {BufferAttribute,BufferGeometry,Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {semanticLayerKey} from './building_layers.js';

export const MATERIAL_ID_ATTRIBUTE='apsMaterialId';
export const MATERIAL_SLOT_ATTRIBUTE='apsMaterialSlot';
export const MODEL_MERGE_SCHEMA='aps-model-merge/1';
                                                                       
export const MERGE_ATTRIBUTES=Object.freeze(['position','normal','tangent','color','uv','uv1','uv2','uv3']);

const IDENTITY_FIELDS=Object.freeze(['sourcePointIndex','instanceidx']);
const ordinalRange=count=>Array.from({length:count},(_,i)=>i);

export function supportedMatrix(matrix) {
  const e=matrix.elements,a=[e[0],e[1],e[2]],b=[e[4],e[5],e[6]],c=[e[8],e[9],e[10]],len=v=>Math.hypot(...v),dot=(x,y)=>x.reduce((s,v,i)=>s+v*y[i],0);
  const x=len(a),y=len(b),z=len(c);
  return e.every(Number.isFinite)&&Math.min(x,y,z)>1e-12&&matrix.determinant()>0&&Math.abs(dot(a,b))<x*y*1e-6&&Math.abs(dot(a,c))<x*z*1e-6&&Math.abs(dot(b,c))<y*z*1e-6;
}

                                                                             
                                         
export function occurrenceIdentity(userData) {
  if(!userData)return null;
  const values={};
  for(const field of IDENTITY_FIELDS) {
    const value=userData[field];
    if(!Number.isInteger(value)||value<0)return null;
    values[field]=value;
  }
  return values;
}

export function matrixEquals(a,b,tolerance=0) {
  const x=a.elements,y=b.elements;
  for(let i=0;i<16;i++)if(Math.abs(x[i]-y[i])>tolerance)return false;
  return true;
}
export function occurrenceKey(identity,ordinal) { return `${identity.sourcePointIndex}:${identity.instanceidx}:${ordinal}`; }

function attributeNames(geometry) {
  return MERGE_ATTRIBUTES.filter(name=>geometry.attributes[name]!==undefined);
}
function visibleInHierarchy(object) {
  for(let n=object;n;n=n.parent)if(!n.visible)return false;
  return true;
}
function topologyOf(material,geometry) {
  return material?.topology??geometry.userData?.topology??'triangle-list';
}
function uvSetsOf(geometry) {
  return [0,1,2,3].filter(i=>geometry.attributes[i?'uv'+i:'uv']!==undefined);
}
                                                                         
                                                                                   
function partDomain(row) {
  const geometry=row.mesh.geometry,merge=row.merge??{};
  const names=attributeNames(geometry),itemSizes=names.map(name=>`${name}:${geometry.attributes[name].itemSize}`);
  return {key:JSON.stringify([semanticLayerKey(row.mesh.userData),merge.mirrored?1:0,merge.doubleSided?1:0,topologyOf(row.mesh.material,geometry),names,itemSizes,uvSetsOf(geometry)]),
    attributes:names,itemSizes,topology:topologyOf(row.mesh.material,geometry),uvSets:uvSetsOf(geometry),
    hasNormal:geometry.attributes.normal!==undefined,hasTangent:geometry.attributes.tangent!==undefined,
    doubleSided:!!merge.doubleSided,mirrored:!!merge.mirrored};
}
                                                                         
                                                              
function geometryCounts(geometry,cache) {
  if(cache.has(geometry))return cache.get(geometry);
  const position=geometry.attributes.position,index=geometry.index;
  const result=position?{vertexCount:position.count,indexCount:index?index.count:0,indexArray:index?index.array:null}:null;
  cache.set(geometry,result);
  return result;
}
function partIsIntact(row,cache) {
  const geometry=row.mesh.geometry;
  if(cache.has(geometry))return cache.get(geometry);
  const valid=validateGeometry(geometry);
  cache.set(geometry,valid);return valid;
}
function validateGeometry(geometry) {
  const counts=geometryCounts(geometry,new Map());
  if(!counts||counts.vertexCount<1)return false;
  for(const name of attributeNames(geometry)) {
    const attribute=geometry.attributes[name];
    if(attribute.array.length!==counts.vertexCount*attribute.itemSize)return false;
    for(let i=0;i<attribute.array.length;i++)if(!Number.isFinite(attribute.array[i]))return false;
  }
  if(counts.indexArray)for(let i=0;i<counts.indexArray.length;i++)if(!(counts.indexArray[i]<counts.vertexCount))return false;
  return true;
}
function rowEligibility(row) {
  if(!row?.mesh)return 'missing_mesh';
                                                                            
                                                                          
  if(row.mesh.userData?.aps_static_roof||row.mesh.userData?.aps_no_instancing)return 'static_roof_plain_draw';
  if(row.deformed)return 'vertex_deformed';
  const merge=row.merge;
  if(!merge)return 'missing_merge_traits';
  if(merge.textured)return 'textured_material';
  if(merge.native)return 'native_closure_material';
  if(merge.unlit)return 'unlit_material';
  if((merge.alphaMode??'OPAQUE')!=='OPAQUE')return `alpha_${String(merge.alphaMode).toLowerCase()}`;
  if(row.mesh.material?.transparent)return 'transparent_material';
  if(!occurrenceIdentity(row.mesh.userData))return 'no_logical_identity';
  return null;
}

                                                                                 
                                                                                  
                                                                 
                                                                                   
                                                                                 
                                                                   
export function planModelMerges(readback,{transformTolerance=0,matrixCache=new WeakMap(),verifyDomain=null}={}) {
  const geometryIds=new Map(),intactCache=new Map(),countsCache=new Map();
  const rowReasons=new Map(),ordinalReasons=new Map(),candidates=[],prototypes=new Map();
  const domainEntries=new Map(),domainVerdict=new Map();
  const emptyStats={source_primitive_rows:readback.length,source_primitive_occurrences:0,source_triangles:0,
    merged_primitive_occurrences:0,merged_triangles:0,merged_rows:0,logical_instances:0,merged_prototypes:0,
    fallback_primitive_occurrences:0,fallback_triangles:0,retained_rows:0,fallback_reasons:{},multi_material_prototypes:0};
  if(!readback.length)return emptyPlan(readback,emptyStats);
  let ancestor=readback[0].mesh;while(ancestor.parent)ancestor=ancestor.parent;
  ancestor.updateMatrixWorld(true);
  const inverse=ancestor.matrixWorld.clone().invert();
  const geometryId=geometry=>{if(!geometryIds.has(geometry))geometryIds.set(geometry,geometryIds.size);return geometryIds.get(geometry);};
  for(const row of readback) {
    const mesh=row.mesh,total=mesh.isInstancedMesh?mesh.count:1;
    const reason=rowEligibility(row);
    if(reason!==null){rowReasons.set(row,reason);continue;}
    if(!visibleInHierarchy(mesh)){rowReasons.set(row,'invisible');continue;}
    if(topologyOf(mesh.material,mesh.geometry)!=='triangle-list'){rowReasons.set(row,'non_triangle_topology');continue;}
    if(!partIsIntact(row,intactCache)){rowReasons.set(row,'invalid_native_geometry');continue;}
    const node=matrixCache.get(row)??inverse.clone().multiply(mesh.matrixWorld);
    matrixCache.set(row,node);
    if(!supportedMatrix(node)){rowReasons.set(row,'unsupported_node_transform');continue;}
    const domain=partDomain(row),identity=occurrenceIdentity(mesh.userData),local=new Matrix4();
    for(let ordinal=0;ordinal<total;ordinal++) {
      const matrix=node.clone();
      if(mesh.isInstancedMesh){mesh.getMatrixAt(ordinal,local);matrix.multiply(local);}
      if(!supportedMatrix(matrix)){
        if(!ordinalReasons.has(row))ordinalReasons.set(row,new Map());
        ordinalReasons.get(row).set(ordinal,'unsupported_instance_transform');continue;
      }
      candidates.push({row,ordinal,matrix,identity,domain,geometryId:geometryId(mesh.geometry),
        entity_id:mesh.userData.instance_entity_ids?.[ordinal]??row.entity_id??null,
        sourceInstance:mesh.isInstancedMesh?row.sourceInstanceIndices?.[ordinal]??null:null,
        key:occurrenceKey(identity,ordinal)});
    }
  }
                                                                                  
                                                                                
                                                                 
  for(const candidate of candidates) {
    if(!domainEntries.has(candidate.domain.key))domainEntries.set(candidate.domain.key,new Map());
    const entries=domainEntries.get(candidate.domain.key);
    if(!entries.has(candidate.row.merge.materialId))entries.set(candidate.row.merge.materialId,candidate.row.merge);
  }
  const domainVerdictOf=domain=>{
    if(!domainVerdict.has(domain.key))domainVerdict.set(domain.key,verifyDomain?verifyDomain(domain,[...domainEntries.get(domain.key).values()])??null:null);
    return domainVerdict.get(domain.key);
  };
  const groups=new Map();
  for(const candidate of candidates){if(!groups.has(candidate.key))groups.set(candidate.key,[]);groups.get(candidate.key).push(candidate);}
  const mergedSignature=new Map(),rejectedGroup=new Map();
  for(const [key,parts] of [...groups.entries()].sort(compareEntries)) {
    const reject=reason=>rejectedGroup.set(key,reason);
    if(parts.some(part=>!matrixEquals(part.matrix,parts[0].matrix,transformTolerance))){reject('unequal_native_transform');continue;}
    if(parts.some(part=>part.domain.key!==parts[0].domain.key)){reject('domain_mismatch');continue;}
    if(parts.some(part=>!!part.row.mesh.castShadow!==!!parts[0].row.mesh.castShadow||!!part.row.mesh.receiveShadow!==!!parts[0].row.mesh.receiveShadow)){reject('shadow_state_mismatch');continue;}
    if(parts.some(part=>part.row.mesh.layers.mask!==parts[0].row.mesh.layers.mask)){reject('layer_mismatch');continue;}
    const verdict=domainVerdictOf(parts[0].domain);
    if(verdict){reject(verdict);continue;}
    const ordered=parts.map((part,index)=>({...part,index})).sort((a,b)=>a.geometryId-b.geometryId||a.index-b.index);
    const signature=JSON.stringify([parts[0].domain.key,parts[0].row.mesh.castShadow,parts[0].row.mesh.receiveShadow,parts[0].row.mesh.layers.mask,ordered.map(part=>part.geometryId)]);
    if(!prototypes.has(signature))prototypes.set(signature,{signature,domain:parts[0].domain,
      castShadow:!!parts[0].row.mesh.castShadow,receiveShadow:!!parts[0].row.mesh.receiveShadow,layersMask:parts[0].row.mesh.layers.mask,
      parts:ordered.map(part=>({geometry:part.row.mesh.geometry,geometryId:part.geometryId,materialId:part.row.merge.materialId,
        meshIndex:part.row.meshIndex,primitiveIndex:part.row.primitiveIndex,materialIndex:part.row.materialIndex})),instances:[]});
    prototypes.get(signature).instances.push({key,matrix:parts[0].matrix.clone(),entity_id:parts[0].entity_id,
      source_parts:ordered.map(part=>({nodeIndex:part.row.nodeIndex,sourceInstance:part.sourceInstance,ordinal:part.ordinal,
        materialId:part.row.merge.materialId,meshIndex:part.row.meshIndex,primitiveIndex:part.row.primitiveIndex,entity_id:part.entity_id}))});
    mergedSignature.set(key,signature);
  }
                                                                              
                                                                                
  const unsafeMeshes=new Set([...rowReasons.keys(),...ordinalReasons.keys()].map(row=>row.mesh));
  for(const [key,parts] of groups)if(rejectedGroup.has(key))for(const part of parts)unsafeMeshes.add(part.row.mesh);
  let changed=true;
  while(changed){changed=false;for(const [key,parts] of groups){
    if(!mergedSignature.has(key)||!parts.some(part=>unsafeMeshes.has(part.row.mesh)))continue;
    mergedSignature.delete(key);rejectedGroup.set(key,'whole_source_mesh_fallback');
    for(const part of parts)if(!unsafeMeshes.has(part.row.mesh)){unsafeMeshes.add(part.row.mesh);changed=true;}
  }}
  for(const [signature,prototype] of prototypes){
    prototype.instances=prototype.instances.filter(instance=>mergedSignature.has(instance.key));
    if(!prototype.instances.length)prototypes.delete(signature);
  }
                                                                                         
  for(const prototype of prototypes.values()) {
    let vertexOffset=0,indexOffset=0,triangles=0,indexed=true;
    for(const part of prototype.parts) {
      const counts=geometryCounts(part.geometry,countsCache);
      if(!counts)throw Error('Merged model part lost its native geometry');
      part.vertexOffset=vertexOffset;part.vertexCount=counts.vertexCount;
      part.indexOffset=indexOffset;part.indexCount=counts.indexCount||counts.vertexCount;
      part.triangles=part.indexCount/3;part.indexed=counts.indexCount>0;
      if(!counts.indexCount)indexed=false;
      vertexOffset+=counts.vertexCount;indexOffset+=part.indexCount;triangles+=part.triangles;
    }
    prototype.vertexCount=vertexOffset;prototype.indexCount=indexOffset;prototype.triangles=triangles;prototype.indexed=indexed;
  }
                                                                            
                                                                
  const stats={...emptyStats,fallback_reasons:{},merged_prototypes:prototypes.size};
  const fullyMergedMeshes=new Set(),partiallyMergedMeshes=new Set();
  for(const row of readback) {
    const mesh=row.mesh,total=mesh.isInstancedMesh?mesh.count:1,perOccurrence=row.trianglesPerOccurrence??0;
    const rowReason=rowReasons.get(row)??null,identity=rowReason?null:occurrenceIdentity(mesh.userData),ordinals=ordinalReasons.get(row)??null;
    let merged=0,fallback=0;
    for(let ordinal=0;ordinal<total;ordinal++) {
      let reason=rowReason??ordinals?.get(ordinal)??null,signature=null;
      if(!reason&&identity) {
        const key=occurrenceKey(identity,ordinal);
        signature=mergedSignature.get(key)??null;
        reason=signature?null:rejectedGroup.get(key)??'unassigned_occurrence';
      }
      if(signature)merged++;else {fallback++;stats.fallback_reasons[reason]=(stats.fallback_reasons[reason]??0)+1;}
    }
    stats.source_primitive_occurrences+=total;stats.source_triangles+=perOccurrence*total;
    stats.merged_primitive_occurrences+=merged;stats.merged_triangles+=perOccurrence*merged;
    stats.fallback_primitive_occurrences+=fallback;stats.fallback_triangles+=perOccurrence*fallback;
    if(total&&merged===total){stats.merged_rows++;fullyMergedMeshes.add(mesh);}
    else if(merged)partiallyMergedMeshes.add(mesh);
    if(fallback)stats.retained_rows++;
  }
  stats.logical_instances=[...prototypes.values()].reduce((n,prototype)=>n+prototype.instances.length,0);
  stats.multi_material_prototypes=[...prototypes.values()].filter(prototype=>new Set(prototype.parts.map(part=>part.materialId)).size>1).length;
  const list=[...prototypes.values()],domains=new Map();
  for(const prototype of list)if(!domains.has(prototype.domain.key))
    domains.set(prototype.domain.key,{key:prototype.domain.key,domain:prototype.domain,entries:[...domainEntries.get(prototype.domain.key).values()]});
  return {prototypes:list,instances:stats.logical_instances,domains,fullyMergedMeshes,partiallyMergedMeshes,
    stats:Object.freeze({...stats}),multiMaterialDrawGroups:stats.multi_material_prototypes};
}
function compareEntries(a,b) { return a[0]<b[0]?-1:a[0]>b[0]?1:0; }
function emptyPlan(readback,stats) {
  return {prototypes:[],instances:0,domains:new Map(),fullyMergedMeshes:new Set(),partiallyMergedMeshes:new Set(),stats:Object.freeze({...stats,fallback_reasons:{}}),multiMaterialDrawGroups:0};
}

                                                                            
                                                                                  
                                                                           
export function mergePrototypeGeometry(prototype,{resources}={}) {
  const {parts,domain}=prototype;
  if(!parts.length)throw Error('Merged prototype needs at least one native part');
  for(const part of parts)if(part.geometry.attributes.position.count!==part.vertexCount)throw Error('Merged prototype part vertex count changed');
  const geometry=new BufferGeometry();
  for(const name of domain.attributes) {
    const itemSize=parts[0].geometry.attributes[name].itemSize;
    for(const part of parts)if(part.geometry.attributes[name].itemSize!==itemSize)throw Error(`Merged part attribute ${name} item size differs`);
    const ArrayType=parts[0].geometry.attributes[name].array.constructor;
    const merged=new ArrayType(prototype.vertexCount*itemSize);
    let offset=0;for(const part of parts){const array=part.geometry.attributes[name].array;merged.set(array,offset);offset+=array.length;}
    geometry.setAttribute(name,new BufferAttribute(merged,itemSize));
  }
  const materialIds=new Uint32Array(prototype.vertexCount);
  const materialSlots=new Uint32Array(prototype.vertexCount);
  for(const part of parts)materialIds.fill(part.materialId,part.vertexOffset,part.vertexOffset+part.vertexCount);
  parts.forEach((part,slot)=>materialSlots.fill(slot,part.vertexOffset,part.vertexOffset+part.vertexCount));
  geometry.setAttribute(MATERIAL_ID_ATTRIBUTE,new BufferAttribute(materialIds,1));
  geometry.setAttribute(MATERIAL_SLOT_ATTRIBUTE,new BufferAttribute(materialSlots,1));
  const wide=prototype.vertexCount>65535||parts.some(part=>part.geometry.index?.array instanceof Uint32Array);
  const index=new (wide?Uint32Array:Uint16Array)(prototype.indexCount);
  let cursor=0;
  for(const part of parts) {
    const source=part.geometry.index?part.geometry.index.array:null,count=part.indexCount;
    if(source){if(source.length!==count)throw Error('Merged prototype index count changed');for(let i=0;i<count;i++)index[cursor+i]=source[i]+part.vertexOffset;}
    else for(let i=0;i<count;i++)index[cursor+i]=part.vertexOffset+i;
    cursor+=count;
  }
  geometry.setIndex(new BufferAttribute(index,1));
  geometry.userData={format:MODEL_MERGE_SCHEMA,aps_model_prototype:prototype.signature,aps_native_static_geometry:true,
    aps_source_parts:parts.map(part=>({mesh:part.meshIndex,primitive:part.primitiveIndex,material:part.materialId,vertexOffset:part.vertexOffset,vertexCount:part.vertexCount,indexOffset:part.indexOffset,indexCount:part.indexCount,triangles:part.triangles,indexed:part.indexed})),
    topology:domain.topology,material_ids:[...new Set(parts.map(part=>part.materialId))]};
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  if(resources?.geometries)resources.geometries.add(geometry);
  return geometry;
}

export function mergedTriangleTotal(prototypes) {
  return prototypes.reduce((sum,prototype)=>sum+prototype.triangles*prototype.instances.length,0);
}
