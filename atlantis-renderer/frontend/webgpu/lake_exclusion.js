import {Vector3} from '../../vendor/tidewater/src/engine/math/Vector3.js';
import {terrainCoordinates} from './terrain_coordinates.js';

                                                                            
                                                             
export function worldLakeExclusion(root,origin,predicate){
  if(typeof predicate!=='function')return undefined;
  const point=new Vector3();let elements=null,inverse=null;
  return (x,y,z)=>{
    root.updateWorldMatrix(true,false);
    const current=root.matrixWorld.elements;
    if(!elements||current.some((value,index)=>value!==elements[index])){
      inverse=terrainCoordinates(root.matrixWorld,origin).nativeFromWorld;
      elements=Array.from(current);
    }
    point.set(x,y,z).applyMatrix4(inverse);
    return predicate(point.x,point.y,point.z);
  };
}

                                                                               
                                                                         
export function terrainWaterExclusion(viewer,primary=viewer.heightfield){
  const first=primary?.isLakeSubmerged;
  const extras=[...new Set(viewer.taskHeightfields?.values?.()??[])]
    .filter(terrain=>terrain!==primary&&typeof terrain?.isLakeSubmerged==='function')
    .map(terrain=>terrain.isLakeSubmerged);
  if(!extras.length)return first;
  const predicates=typeof first==='function'?[first,...extras]:extras;
  return (x,y,z)=>predicates.some(predicate=>predicate(x,y,z));
}

export function refreshTerrainWaterExclusions(viewer){
  const predicate=terrainWaterExclusion(viewer),changed=[];
  const restore=()=>{
    const failures=[];
    for(const [system,previous] of [...changed].reverse())try{system.setWaterExclusion(previous);}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Vegetation water exclusion restore failed');
  };
  try{
    const assets=[viewer.meshAsset,...(viewer.meshCompanions??[])],seen=new Set();
    for(const asset of assets){
      const system=asset?.vegetation;
      if(typeof system?.setWaterExclusion!=='function')continue;
      if(seen.has(system))continue;
      seen.add(system);
      changed.push([system,system.waterExclusion]);system.setWaterExclusion(predicate);
    }
  }catch(error){try{restore();}catch(rollback){throw new AggregateError([error,rollback],'Vegetation water exclusion rollback failed');}throw error;}
  return restore;
}

                                                                            
                                                                               
export function excludeSubmergedRoots(matrices,bounds,predicate){
  let count=0;if(!predicate)return count;
  for(let i=0;i<matrices.length/16;i++)if(predicate(matrices[i*16+12],matrices[i*16+13],matrices[i*16+14])){bounds[i*8+3]=-1;count++;}
  return count;
}
