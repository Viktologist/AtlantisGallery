                                                       
  
                                                                               
                                                                                
                                                                             
                                                                              
                                                                                 
  
                                                                            
                                                                                 
                                                                                 
                                                                          
                                                                         
                                                                       

import {Box3, Matrix4} from '../../vendor/tidewater/src/engine/index.js';

export const INSTANCE_BOUNDS_SCHEMA='aps-instance-aware-bounds/1';

const _instanceMatrix=new Matrix4();
const _instanceBox=new Box3();
let _cache=new WeakMap();
let _geometryCache=new WeakMap();

function finiteBox(box){return [...box.min.toArray(),...box.max.toArray()].every(Number.isFinite);}

function geometryBounds(mesh){
  const geometry=mesh.geometry;
  if(!geometry)return null;
  const position=geometry.attributes?.position;
  const prior=_geometryCache.get(geometry);
  if(geometry.boundingBox==null||(prior&&(prior.position!==position||prior.array!==position?.array||prior.version!==position?.version)))geometry.computeBoundingBox?.();
  _geometryCache.set(geometry,{position,array:position?.array,version:position?.version});
  const box=geometry.boundingBox;
  if(!box||box.isEmpty())return null;
  if(!finiteBox(box))throw Error('Nonfinite native geometry bounds');
  return box;
}

function instanceLocalBounds(mesh){
  const count=mesh.count;
  if(!Number.isInteger(count)||count<0)throw Error('Invalid InstancedMesh instance count');
                                                                        
                                                                            
  if(count===0)return null;
  const buffer=mesh.instanceMatrix;
  const capacity=buffer?.count??0;
  if(!buffer||count>capacity)throw Error(`InstancedMesh count ${count} exceeds native instance capacity ${capacity}`);
  const geometry=mesh.geometry;
  const source=geometryBounds(mesh);
  if(!source)return null;
  const position=geometry.attributes?.position;
  const signature=JSON.stringify([count,buffer.version,capacity,position?.version??-1,...source.min.toArray(),...source.max.toArray()]);
  const cached=_cache.get(mesh);
  if(cached?.signature===signature&&cached.buffer===buffer&&cached.array===buffer.array&&cached.geometry===geometry&&cached.position===position)return cached.box;
  const box=new Box3().makeEmpty();
  for(let i=0;i<count;i++){
    mesh.getMatrixAt(i,_instanceMatrix);
    _instanceBox.copy(source).applyMatrix4(_instanceMatrix);
    if(!finiteBox(_instanceBox))throw Error('Nonfinite native instance transform');
    box.union(_instanceBox);
  }
  if(box.isEmpty())return null;
  _cache.set(mesh,{signature,box,buffer,array:buffer.array,geometry,position});
  return box;
}

                                                                               
                                                                     
export function meshWorldBounds(mesh){
  if(!mesh?.isMesh)return null;
  const local=mesh.isInstancedMesh?instanceLocalBounds(mesh):geometryBounds(mesh);
  if(!local)return null;
  const world=local.clone().applyMatrix4(mesh.matrixWorld);
  if(world.isEmpty())return null;
  if(!finiteBox(world))throw Error('Nonfinite native mesh world bounds');
  return world;
}

                                                                            
                                                                                
                                                       
export function instanceAwareBounds(root,{visibleOnly=true}={}){
  const bounds=new Box3().makeEmpty();
  if(!root)return bounds;
                                                                                
                                              
  if(root.updateWorldMatrix)root.updateWorldMatrix(true,true);
  else root.updateMatrixWorld?.(true);
  const visit=object=>{
    if(!object)return;
    if(visibleOnly&&object.visible===false)return;
    if(object.isMesh){
      const box=meshWorldBounds(object);
      if(box)bounds.union(box);
    }
    for(const child of object.children??[])visit(child);
  };
  visit(root);
  return bounds;
}

                                                                            
                                  
export function clearInstanceBoundsCache(){_cache=new WeakMap();_geometryCache=new WeakMap();}
