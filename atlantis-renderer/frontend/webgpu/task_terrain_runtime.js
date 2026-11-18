import {Group} from '../../vendor/tidewater/src/engine/index.js';
import {applySceneAssetTransform} from './scene_document.js';
import {terrainCoordinates} from './terrain_coordinates.js';
import {planTaskTerrains} from './task_terrain_plan.js';
import {refreshTerrainWaterExclusions} from './lake_exclusion.js';

function invalidate(viewer){
  viewer.shadowUnified?.invalidate?.('task-terrain');
  viewer.invalidateScene?.();viewer.invalidateVisibility?.();
}
function release(viewer,record){
  if(!record)return;
  try{viewer.releaseAux?.(record.root);}finally{try{record.api.dispose();}finally{record.root.removeFromParent();}}
}
export function clearTaskTerrains(viewer){
  const records=viewer.taskTerrainRecords,fields=viewer.taskHeightfields,key=viewer.taskTerrainKey;
  viewer.taskTerrainRecords=new Map();viewer.taskHeightfields=new Map();viewer.taskTerrainKey=null;
  if(records?.size)try{refreshTerrainWaterExclusions(viewer);}catch(error){
    viewer.taskTerrainRecords=records;viewer.taskHeightfields=fields;viewer.taskTerrainKey=key;
    viewer.lastRecoverableError={operation:'task_terrain_water',message:String(error?.message??error)};
    throw error;
  }
  for(const record of records?.values?.()??[]){
    try{release(viewer,record);}catch(error){viewer.lastRecoverableError={operation:'task_terrain_cleanup',message:String(error?.message??error)};}
  }
  if(records?.size)invalidate(viewer);
}

                                                                             
                                                                               
export async function syncTaskTerrains(viewer,current,raw){
  if(!current?.document||viewer.sceneDocument!==current)return {pending:true};
  const key=raw?.gateway?.task_scene_key;
  const initial=planTaskTerrains(current.document,raw,current.source,new Map(),key);
  if(!initial.valid)return {pending:true};
  try{
    return await viewer.queueScene(async()=>{
      if(viewer.disposed||viewer.sceneDocument!==current||current.document?.gateway?.task_scene_key!==key)
        throw Error('Scene changed during terrain synchronization');
      if(viewer.taskTerrainKey!==key){clearTaskTerrains(viewer);viewer.taskTerrainKey=key;}
      const plan=planTaskTerrains(current.document,raw,current.source,viewer.taskTerrainRecords,viewer.taskTerrainKey);
      if(!plan.valid||plan.pending)return {pending:true};
      if(plan.actions.length)await applyTaskTerrainBatch(viewer,current,key,plan.actions);
      return {pending:false};
    });
  }catch(error){
    if(viewer.sceneDocument===current&&!viewer.disposed)viewer.lastRecoverableError={operation:'task_terrain_update',message:String(error?.message??error)};
    return {pending:true};
  }
}

async function applyTaskTerrainBatch(viewer,current,key,actions){
  const records=viewer.taskTerrainRecords,fields=viewer.taskHeightfields;
  const previousRecords=new Map(records),previousFields=new Map(fields),candidates=new Map(),retired=[];
  const oldState=new Map([...records].map(([id,record])=>[id,{visible:record.root.visible,transform:record.transform}]));
  const errors=viewer.errors?.length,pipelines=viewer.pipelineHandles?.length,compiled=viewer.compiled;
  let restoreWater,waterAttempted=false,changed=false,committed=false;
  const valid=()=>!viewer.disposed&&viewer.sceneDocument===current&&
    current.document?.gateway?.task_scene_key===key&&viewer.taskTerrainKey===key&&
    records===viewer.taskTerrainRecords&&fields===viewer.taskHeightfields;
  const transform=(id,root,pose)=>applySceneAssetTransform(viewer,{id,kind:'glb',transform:pose},root);
  viewer.loading++;
  try{
                                                                             
    for(const action of actions){
      if(action.type!=='load')continue;
      const api=await viewer.loadHeightfieldAsset(action.url,{deferCommit:true});
      const root=new Group();root.name='Task terrain '+action.id;root.add(api.root);
      candidates.set(action.id,{api,root,url:action.url,transform:action.transform});
      if(!valid())throw Error('Scene changed during terrain loading');
      transform(action.id,root,action.transform);api.root.updateWorldMatrix(true,false);
      terrainCoordinates(api.root.matrixWorld,api.native.origin);
    }
    if(!valid())throw Error('Scene changed during terrain synchronization');
    for(const action of actions){
      const old=records.get(action.id);
      if(action.type==='pose'){
        if(!old)throw Error('Terrain no longer exists');
        changed=true;transform(action.id,old.root,action.transform);old.api.update(viewer.camera);
        records.set(action.id,{...old,transform:action.transform});
      }else if(action.type==='load'){
        const next=candidates.get(action.id);
        changed=true;viewer.scene.add(next.root);next.api.root.updateWorldMatrix(true,false);
        next.api.setOcean?.(null);next.api.inlandOptics?.install();next.api.update(viewer.camera);
        if(old){old.root.visible=false;retired.push(old);}
        records.set(action.id,next);fields.set(action.id,next.api);
      }else if(action.type==='remove'){
        if(old){changed=true;old.root.visible=false;retired.push(old);records.delete(action.id);fields.delete(action.id);}
      }else throw Error('Unknown terrain update');
    }
    if(changed){waterAttempted=true;restoreWater=refreshTerrainWaterExclusions(viewer);invalidate(viewer);}
    if(candidates.size)await viewer.compile();
    if(!valid())throw Error('Scene changed during terrain compilation');
    committed=true;
    for(const old of retired)try{release(viewer,old);}catch(error){viewer.lastRecoverableError={operation:'task_terrain_cleanup',message:String(error?.message??error)};}
    if(changed)invalidate(viewer);
  }catch(error){
    if(committed)throw error;
    const failures=[];
    if(!committed&&records===viewer.taskTerrainRecords&&fields===viewer.taskHeightfields){
      records.clear();for(const [id,record] of previousRecords)records.set(id,record);
      fields.clear();for(const [id,api] of previousFields)fields.set(id,api);
      for(const [id,record] of previousRecords){
        const state=oldState.get(id);record.root.visible=state.visible;
        try{transform(id,record.root,state.transform);record.api.update(viewer.camera);}catch(rollback){failures.push(rollback);}
      }
      try{
        if(restoreWater)restoreWater();
        else if(waterAttempted)refreshTerrainWaterExclusions(viewer);
      }catch(rollback){failures.push(rollback);}
    }
    for(const candidate of candidates.values())try{release(viewer,candidate);}catch(cleanup){failures.push(cleanup);}
    if(!viewer.disposed){if(Number.isInteger(errors))viewer.errors.splice(errors);if(Number.isInteger(pipelines))viewer.pipelineHandles.splice(pipelines);viewer.compiled=compiled;invalidate(viewer);}
    if(failures.length)throw new AggregateError([error,...failures],'Terrain batch rollback failed');
    throw error;
  }finally{viewer.loading--;}
}
