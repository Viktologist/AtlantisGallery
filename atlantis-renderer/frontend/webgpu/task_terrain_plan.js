                                                                            
                                                                            
const ID=/^ba_[0-9a-f]{32}$/;
const PATH=/^\/api\/terrain\/(ba_[0-9a-f]{32})\/[0-9a-f]{64}\/r_[0-9a-f]{64}$/;
const KEY=/^[0-9a-f]{64}$/;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);

export function validTaskTerrainPose(pose){
  if(pose==null)return true;
  if(typeof pose!=='object'||Array.isArray(pose)||Object.keys(pose).some(k=>!['matrix','translation','rotation','scale'].includes(k)))return false;
  for(const [key,n] of [['matrix',16],['translation',3],['rotation',4],['scale',3]])
    if(pose[key]!==undefined&&(!Array.isArray(pose[key])||pose[key].length!==n||!pose[key].every(Number.isFinite)))return false;
  if(pose.matrix!==undefined){
    if(Object.keys(pose).length!==1)return false;
    const m=pose.matrix;
    if(m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1)return false;
    const determinant=m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]);
    return Number.isFinite(determinant)&&Math.abs(determinant)>=1e-15;
  }
  if(pose.scale){const determinant=pose.scale[0]*pose.scale[1]*pose.scale[2];if(!Number.isFinite(determinant)||Math.abs(determinant)<1e-15)return false;}
  if(pose.rotation&&Math.hypot(...pose.rotation)<1e-12)return false;
  return true;
}

export function primaryTaskTerrain(row,document,source){
  const primary=document?.assets?.[0],p=row?.transform;
  if(!row||row.pending===true||!validTaskTerrainPose(p)||primary?.id!=='task-terrain'||primary.kind!=='heightfield')return false;
  if(p?.matrix!==undefined&&!same(p.matrix,identity))return false;
  if(p?.translation!==undefined&&!same(p.translation,[0,0,0]))return false;
  if(p?.rotation!==undefined&&!same(p.rotation,[0,0,0,1])&&!same(p.rotation,[0,0,0,-1]))return false;
  if(p?.scale!==undefined&&!same(p.scale,[1,1,1]))return false;
  try{return taskTerrainURL(row,source)===primary.url;}catch(_){return false;}
}

export function taskTerrainURL(row,source){
  if(!row||!ID.test(row.id??'')||typeof row.file!=='string')throw Error('Invalid task terrain');
  const url=new URL(row.file,source),base=new URL(source),match=url.pathname.match(PATH);
  if(url.origin!==base.origin||url.search||url.hash||!match||match[1]!==row.id)throw Error('Invalid task terrain URL');
  return url.href;
}

                                                                          
export function planTaskTerrains(document,raw,source,records=new Map(),recordTaskKey=null){
  const key=raw?.gateway?.task_scene_key,rows=raw?.gateway?.task_terrain_instances;
  const pendingGroups=raw?.gateway?.task_terrain_instances_pending;
  if(!KEY.test(key??'')||key!==document?.gateway?.task_scene_key||!Array.isArray(rows)||
     (pendingGroups!==undefined&&pendingGroups!==true))return {valid:false,pending:true,actions:[]};
  const seen=new Set(),desired=[];
  try{
    for(const row of rows){
      if(!row||!ID.test(row.id??'')||seen.has(row.id)||!validTaskTerrainPose(row.transform)||
         Object.keys(row).some(k=>!['id','transform','pending','file'].includes(k)))throw Error('Invalid task terrain');
      seen.add(row.id);
      if(row.pending===true){if(row.file!==undefined)throw Error('Invalid pending terrain');desired.push({id:row.id,pending:true});continue;}
      if(row.pending!==undefined)throw Error('Invalid terrain state');
      const url=taskTerrainURL(row,source);
      desired.push({id:row.id,url,transform:row.transform??null,primary:primaryTaskTerrain(row,document,source)});
    }
  }catch(_){return {valid:false,pending:true,actions:[]};}
                                                                             
                                                     
  const old=recordTaskKey===key?records:new Map(),actions=[];
  let pending=pendingGroups===true;
  for(const row of desired){
    const previous=old.get(row.id);
    if(row.pending){pending=true;continue;}
    if(row.primary){if(previous)actions.push({type:'remove',id:row.id});continue;}
    if(!previous||previous.url!==row.url)actions.push({type:'load',...row});
    else if(JSON.stringify(previous.transform??null)!==JSON.stringify(row.transform))actions.push({type:'pose',...row});
  }
                                                                           
                                                                   
  if(!pendingGroups)for(const id of old.keys())if(!seen.has(id))actions.push({type:'remove',id});
  return {valid:true,pending,actions:pending?[]:actions,taskKey:key};
}
