import {Matrix4,Quaternion,Vector3} from '../../vendor/tidewater/src/engine/index.js';
                                                                       
export function jointMotion(dof,value){
 if(!Number.isFinite(value))throw Error('关节坐标必须为有限数');
 const limits=dof.limits;
 if(limits&&((limits[0]!=null&&value<limits[0])||(limits[1]!=null&&value>limits[1])))throw RangeError('超出关节运动范围');
 const a=dof.axis_vector;if(!Array.isArray(a)||a.length!==3||!a.every(Number.isFinite)||Math.abs(Math.hypot(...a)-1)>1e-6)throw Error('无效关节轴');
 const [x,y,z]=a;
 if(dof.axis[0]==='t')return [1,0,0,0,0,1,0,0,0,0,1,0,x*value,y*value,z*value,1];
 if(dof.axis[0]!=='r')throw Error('不支持的关节类型');
 const c=Math.cos(value),s=Math.sin(value),t=1-c;
 return [t*x*x+c,t*x*y+s*z,t*x*z-s*y,0,t*x*y-s*z,t*y*y+c,t*y*z+s*x,0,t*x*z+s*y,t*y*z-s*x,t*z*z+c,0,0,0,0,1];
}

                                                                                         
function restFrame(joint){
 const f=joint.frame0;
 if(!Array.isArray(f)||f.length!==16||!f.every(Number.isFinite))throw Error('无效关节参考框架');
 const m=new Matrix4().fromArray(f),p=new Vector3(),q=new Quaternion(),scale=new Vector3();
 m.decompose(p,q,scale);
 if(![scale.x,scale.y,scale.z].every(v=>Number.isFinite(v)&&v>1e-12))throw Error('无效关节参考缩放');
 const e=m.elements, a=[e[0]/scale.x,e[1]/scale.x,e[2]/scale.x],b=[e[4]/scale.y,e[5]/scale.y,e[6]/scale.y],c=[e[8]/scale.z,e[9]/scale.z,e[10]/scale.z];
 const dot=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
 if(Math.max(Math.abs(dot(a,b)),Math.abs(dot(a,c)),Math.abs(dot(b,c)))>1e-6)throw Error('关节参考框架不是正交旋转');
 return {p,q,scale};
}
function jointMatrix(row,value){
 const motion=jointMotion(row.dof,value);
 if(!row.frame)return motion;
 const {p,q,scale}=row.frame,d=row.dof;
 const pos=p.clone(),rot=q.clone();
 if(d.axis[0]==='r')rot.multiply(new Quaternion().setFromAxisAngle(new Vector3(...d.axis_vector),value));
 else pos.add(new Vector3(...d.axis_vector).multiplyScalar(value));
 return new Matrix4().compose(pos,rot,scale).elements;
}

export class ArticulatedAsset {
 constructor(asset){
  this.asset=asset;this.joints=new Map();this.targets=new Map();this.values=new Map();
  const contract=asset.sceneData?.extras?.APS_articulation;
  if(contract?.schema!=='APS_articulation/1')throw Error('模型没有可用关节');
  const nodes=new Map();asset.root.traverse(node=>{if(!node.isMesh&&Number.isInteger(node.userData?.gltf_node))nodes.set(node.userData.gltf_node,node);});
  for(const j of contract.joints){
   if(j.dofs.length!==1)continue;
   const d=j.dofs[0],node=nodes.get(d.node);if(!node)throw Error('缺少关节节点');
   if(this.joints.has(j.name))throw Error('重复关节名');
   jointMotion(d,d.reference);const frame=contract.reference_state==='rest'?restFrame(j):null;this.joints.set(j.name,{dof:d,node,frame});this.values.set(j.name,d.reference);this.targets.set(j.name,d.reference);
  }
 }
 set(name,value,{immediate=false}={}){
  const row=this.joints.get(name);if(!row)throw Error('未知关节：'+name);
  const matrix=jointMatrix(row,value);this.targets.set(name,value);
  if(immediate){row.node.matrixAutoUpdate=false;row.node.matrix.fromArray(matrix);row.node.matrixWorldNeedsUpdate=true;this.values.set(name,value);}
 }
 update(dt){
  let changed=false;
  for(const [name,target]of this.targets){const value=this.values.get(name);if(value===target)continue;
   const next=Math.abs(target-value)<1e-5?target:value+(target-value)*Math.min(1,Math.max(0,dt)*9);
   this.set(name,next,{immediate:true});this.targets.set(name,target);changed=true;
  }
  if(changed)this.asset.root.updateMatrixWorld(true);return changed;
 }
 reset({immediate=false}={}){for(const [name,row]of this.joints)this.set(name,row.dof.reference,{immediate});}
 metadata(){return Object.fromEntries([...this.values].map(([name,value])=>[name,{value,target:this.targets.get(name),limits:this.joints.get(name).dof.limits,node:this.joints.get(name).dof.node}]));}
}

                                                                              
                                                                      
export function sharedArticulationModel(viewer,asset){
 if(!(viewer?.poseModels instanceof Map))throw Error('视图缺少共享姿态模型表');
 if(!asset?.root)throw Error('关节资产缺少根节点');
 const roots=viewer.assetRoots;if(!roots||typeof roots.entries!=='function')throw Error('视图缺少资产注册表');
 const matches=[];for(const entry of roots.entries())if(entry[1]?.api===asset||entry[1]?.root===asset.root)matches.push(entry);
 if(matches.length!==1)throw Error('共享关节模型的资产注册不唯一');
 const [id]=matches[0],existing=viewer.poseModels.get(id);
 if(existing!=null)return existing;
 const model=new ArticulatedAsset(asset);viewer.poseModels.set(id,model);return model;
}

export function installArticulationControls(viewer,{onError=()=>{}}={}){
 const panel=document.createElement('aside');panel.id='articulation-controls';panel.setAttribute('aria-label','车辆控制');panel.hidden=true;
 panel.style.cssText='position:fixed;left:24px;top:88px;z-index:12;max-width:min(480px,calc(100vw - 72px));padding:12px;background:#112021ed;border:1px solid #8aa5a780;border-radius:10px;box-shadow:0 4px 16px #0005';
 const title=document.createElement('strong');title.textContent='车辆控制';panel.append(title);
 const rows=document.createElement('div');rows.style.cssText='display:flex;flex-wrap:wrap;gap:6px;margin:10px 0';panel.append(rows);
 const note=document.createElement('p');note.className='control-note';note.textContent='照片重建 · 开合范围为近似';panel.append(note);document.body.append(panel);
 let model=null,config=null,rolling=false,epoch=-1,buttons=[],refreshSignature=null;
 const lists=()=>[...(config?.door_joints??[]),...(config?.lid_joints??[]),...(config?.steer_joints??[]),...(config?.roll_joints??[])];
 const refresh=()=>{const active=buttons.filter(({pressed})=>typeof pressed==='function'),states=active.map(({pressed})=>pressed()),signature=states.map(v=>v?1:0).join('');if(signature===refreshSignature)return;refreshSignature=signature;active.forEach(({button},index)=>button.setAttribute('aria-pressed',String(states[index])));};
 function button(text,action,pressed){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>{try{action();refresh();}catch(e){onError(e);}};rows.append(b);buttons.push({button:b,pressed});return b;}
 function opened(name){const row=model.joints.get(name),target=model.targets.has(name)?model.targets.get(name):row.dof.reference;return Math.abs(target-row.dof.reference)>1e-4;}
 function toggle(names){const open=!names.every(opened);for(const name of names){const d=model.joints.get(name).dof;const end=d.limits.reduce((a,b)=>Math.abs(a-d.reference)>Math.abs(b-d.reference)?a:b);model.set(name,open?end:d.reference);}}
 function clear(){model=null;config=null;rolling=false;buttons=[];refreshSignature=null;rows.replaceChildren();panel.hidden=true;}
 const component={update(dt){
  if(!model)return;if(epoch!==viewer.sceneEpoch){clear();return;}
  if(rolling)for(const name of config.roll_joints??[]){const row=model.joints.get(name);if(row.dof.limits)continue;model.set(name,model.values.get(name)+Math.max(0,Math.min(dt,.1))*2,{immediate:true});}
  const changed=model.update(dt)||rolling;
  if(changed){model.asset.root.updateMatrixWorld(true);viewer.invalidateObjectTransforms?.([model.asset.root]);}
  refresh();
 },dispose(){clear();panel.remove();}};
 viewer.addComponent(component);
 const api={
  bind(document){clear();refreshSignature=null;const cfg=document?.articulation_controls;if(!cfg)return false;
   title.textContent=cfg.title||'车辆控制';panel.setAttribute('aria-label',title.textContent);
   note.textContent=cfg.note||'照片重建 · 开合范围为近似';
   const assets=[viewer.meshAsset,...viewer.meshCompanions].filter(Boolean);
   const names=[...(cfg.door_joints??[]),...(cfg.lid_joints??[]),...(cfg.steer_joints??[]),...(cfg.roll_joints??[])];
   if(!names.length)return false;
   const candidates=assets.filter(a=>{const j=a.sceneData?.extras?.APS_articulation?.joints;return j&&names.every(n=>j.some(x=>x.name===n));});
   if(candidates.length!==1)throw Error('车辆关节绑定不唯一或不完整');
   model=sharedArticulationModel(viewer,candidates[0]);config=cfg;epoch=viewer.sceneEpoch;
   for(const name of lists())if(!model.joints.has(name))throw Error('场景引用了不存在的关节');
   for(const name of [...(cfg.door_joints??[]),...(cfg.lid_joints??[])]){const d=model.joints.get(name).dof;if(!d.limits?.every(Number.isFinite))throw Error('开合关节必须有有限限位');}
   if(cfg.door_joints?.length){if(cfg.door_joints.length===1&&cfg.door_label)button(cfg.door_label,()=>toggle(cfg.door_joints),()=>cfg.door_joints.every(opened));else{button('双门开 / 关',()=>toggle(cfg.door_joints),()=>cfg.door_joints.every(opened));cfg.door_joints.forEach((n,i)=>button(i===0?'左门':'右门',()=>toggle([n]),()=>opened(n)));}}
   cfg.lid_joints?.forEach((n,i)=>button(i===0?'前舱盖':'发动机盖',()=>toggle([n]),()=>opened(n)));
   if(cfg.steer_joints?.length)for(const [text,direction]of [['向左',1],['回正',0],['向右',-1]])button(text,()=>cfg.steer_joints.forEach((n,i)=>{const d=model.joints.get(n).dof;const sign=direction*(i<2?1:-1);model.set(n,sign>0?d.limits[1]:sign<0?d.limits[0]:d.reference);}));
   if(cfg.roll_joints?.length)button('车轮滚动 / 停止',()=>{rolling=!rolling;},()=>rolling);
   button('全部复位',()=>{rolling=false;model.reset({immediate:true});model.asset.root.updateMatrixWorld(true);viewer.invalidateObjectTransforms?.([model.asset.root]);refresh();});panel.hidden=false;refresh();return true;
  },clear,
  setJoint(name,value,options){if(!model)throw Error('未加载可动车辆');model.set(name,value,options);model.asset.root.updateMatrixWorld(true);viewer.invalidateObjectTransforms?.([model.asset.root]);refresh();},
  metadata(){return {bound:!!model,rolling,joints:model?.metadata()??{}};},
  dispose(){viewer.removeComponent(component);}
 };return api;
}
