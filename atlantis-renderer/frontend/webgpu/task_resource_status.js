import {planTaskTerrains} from './task_terrain_plan.js';

                                                                          
                                                                            
                                                                             
export function independentTerrainsReady(document,raw,source,records,recordTaskKey){
  const rows=raw?.gateway?.task_terrain_instances;
  if(!(records instanceof Map)||!Array.isArray(rows)||!rows.length)return false;
  const plan=planTaskTerrains(document,raw,source,records,recordTaskKey);
  return plan.valid&&!plan.pending&&plan.actions.length===0;
}

                                                                           
                                                                            
export function hasPendingTaskResources(document,raw,source,records=null,recordTaskKey=null){
  const gateway=raw?.gateway;
  if(!gateway)return false;
  if(gateway.task_scene_instances_pending!==undefined)return true;
  if(gateway.task_scene_projection_pending!==undefined)return true;
                                                                         
                                                                         
  if(gateway.task_terrain_intervention_pending!==undefined)return true;
  if(gateway.task_terrain_instances_pending!==undefined)return true;
  if(gateway.task_terrain_pending===true&&
     !independentTerrainsReady(document,raw,source,records,recordTaskKey))return true;
  if(gateway.task_scene_pending!==undefined&&
    (!Array.isArray(gateway.task_scene_pending)||gateway.task_scene_pending.length>0))return true;
  const instances=gateway.task_terrain_instances;
  if(instances===undefined)return false;
  if(!Array.isArray(instances))return true;
  if(records instanceof Map){
    const plan=planTaskTerrains(document,raw,source,records,recordTaskKey);
    return !plan.valid||plan.pending||plan.actions.length>0;
  }
  const primary=document?.assets?.[0];
  return instances.some(row=>{
    if(!row||row.pending===true||typeof row.file!=='string'||primary?.id!=='task-terrain'||primary.kind!=='heightfield')return true;
    const pose=row.transform;
    if(pose!=null){
      if(typeof pose!=='object'||Array.isArray(pose))return true;
      const keys=Object.keys(pose);
      const eq=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);
      if(keys.some(key=>!['translation','rotation','scale','matrix'].includes(key)))return true;
      if(pose.matrix!==undefined){
        if(keys.length!==1||!eq(pose.matrix,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]))return true;
      }else if((pose.translation!==undefined&&!eq(pose.translation,[0,0,0]))||
        (pose.rotation!==undefined&&!eq(pose.rotation,[0,0,0,1])&&!eq(pose.rotation,[0,0,0,-1]))||
        (pose.scale!==undefined&&!eq(pose.scale,[1,1,1])))return true;
    }
    try{
      const url=new URL(row.file,source),base=new URL(source);
      return url.origin!==base.origin||url.href!==primary.url||url.search!==''||url.hash!==''||
        !/^\/api\/terrain\/ba_[0-9a-f]{32}\/[0-9a-f]{64}\/r_[0-9a-f]{64}$/.test(url.pathname)||
        url.pathname.split('/')[3]!==row.id;
    }catch(_){return true;}
  });
}
