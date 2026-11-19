import {PythonLogic} from './python-logic.js';

export async function installPythonVehicle(viewer,descriptor,modelURL,container){
  const module=new URL(descriptor.module,modelURL).href;
  const response=await fetch(new URL(descriptor.config,modelURL));
  if(!response.ok)throw Error('Vehicle configuration HTTP '+response.status);
  const config=await response.json();
  const p=document.createElement('section');p.setAttribute('aria-label','载具操作');container.replaceChildren(p);
  const help=document.createElement('p');help.textContent='WASD 行驶 · 鼠标环绕/炮塔追随 · 右键调俯仰 · 滚轮缩放 · R 重置 · F1 操作 / ESC 视窗';p.append(help);
  const mode=document.createElement('button');mode.textContent='F1 · 进入第三人称';p.append(mode);
  const hatchButtons=[];
  const labels={hull_hatch_L:'驾驶员舱盖',hull_hatch_R:'通信员舱盖',commander_hatch:'车长舱盖',loader_hatch:'装填手舱盖',turret_rear_hatch:'炮塔后舱门',engine_service_cover:'发动机检修盖'};
  const styleButton=button=>Object.assign(button.style,{padding:'8px 10px',margin:'4px 4px 4px 0',border:'1px solid #78908366',borderRadius:'5px',background:'#e4eade',color:'#173c30',cursor:'pointer',font:'inherit'});
  styleButton(mode);
  const reset=document.createElement('button');reset.textContent='重置';styleButton(reset);p.append(reset);
  const output=document.createElement('output');output.style.display='block';output.textContent='正在启动 Python…';p.append(output);
  const abort=new AbortController(),keys=new Set(),physical=new Set(),blocked=new Set(),nodes=new Map();
  const required=['hull','turret_yaw','gun_elevation',...config.wheels.map(x=>x.name),...Object.values(config.links).flat().map(x=>x.name)];
  const controlled=new Set([...required,...Object.keys(config.hinges)]);
  viewer.meshAsset.root.traverse(node=>{if(node.isMesh||!Number.isInteger(node.userData?.gltf_node)||!controlled.has(node.name))return;if(nodes.has(node.name))throw Error('Duplicate vehicle node '+node.name);nodes.set(node.name,node);});
  for(const name of required)if(!nodes.has(name))throw Error('Vehicle node missing: '+name);
  let enabled=false,rmb=false,yaw=0,pitch=22*Math.PI/180,distance=12,elevation=0,last=null,disposed=false;
  const listen=(target,name,fn,options={})=>target.addEventListener(name,fn,{...options,signal:abort.signal});
  const input=()=>({enabled,throttle:Number(keys.has('KeyW'))-Number(keys.has('KeyS')),steer:Number(keys.has('KeyA'))-Number(keys.has('KeyD')),aim_yaw:yaw,elevation});
  const send=()=>logic.event('input',input());
  const setMode=value=>{
    enabled=value;keys.clear();rmb=false;viewer.controls.enabled=!value;
    for(const key of physical)blocked.add(key);
    mode.textContent=value?'ESC · 返回视窗':'F1 · 进入第三人称';
    viewer.canvas.dataset.vehicleMode=value?'vehicle':'viewport';
    if(!value&&document.pointerLockElement===viewer.canvas)document.exitPointerLock();
    if(value){viewer.canvas.focus();viewer.canvas.requestPointerLock?.()?.catch(()=>{});}send();
  };
  const camera=()=>{
    if(!enabled||!last)return;
    const s=last.state,target=[s.x,config.ground_lift+1.3,-s.y],h=distance*Math.cos(pitch);
    viewer.setCamera({position:[target[0]-h*Math.cos(yaw),target[1]+distance*Math.sin(pitch),target[2]+h*Math.sin(yaw)],target});
  };
  const logic=new PythonLogic({module,config},snapshot=>{
    if(disposed)return;
    for(const [name,array]of Object.entries(snapshot.matrices??{})){
      const node=nodes.get(name);if(!node)throw Error('Motion node missing: '+name);
      node.matrixAutoUpdate=false;node.matrix.fromArray(array);node.matrixWorldNeedsUpdate=true;
    }
    last=snapshot;viewer.invalidateObjectTransforms?.([nodes.get('hull')]);
    viewer.depthSnapshot=null;for(const cascade of viewer.shadows?.cascades??[])cascade.dirty=true;
    output.textContent=`Python · ${((snapshot.state.left_speed+snapshot.state.right_speed)*1.8).toFixed(1)} km/h`;
    viewer.canvas.dataset.pythonState=JSON.stringify(snapshot.state);
    viewer.canvas.dataset.pythonReady='true';camera();
    viewer.canvas.dataset.motionProof=JSON.stringify({
      schema:'atlantis-vehicle-web-proof/1',runtime:'Pyodide 0.27.7',mode:enabled?'vehicle':'viewport',
      keys:[...keys],pointerLocked:document.pointerLockElement===viewer.canvas,
      state:snapshot.state,input:input(),camera:{position:viewer.camera.position.toArray(),target:viewer.controls.target.toArray()},
      nodes:nodes.size,links:required.length-25,wheels:config.wheels.length,
      poses:Object.fromEntries(['hull','turret_yaw','gun_elevation',config.wheels[0].name,config.links.L[0].name,config.links.R[0].name,'commander_hatch'].map(name=>[name,Array.from(nodes.get(name).matrix.elements)]))
    });
  },error=>{output.textContent=String(error);viewer.canvas.dataset.pythonError=String(error);setMode(false);});
  mode.onclick=()=>setMode(!enabled);reset.onclick=()=>{keys.clear();yaw=0;elevation=0;for(const hatch of hatchButtons)hatch.reset();logic.event('reset');send();};
  for(const [name,hinge]of Object.entries(config.hinges)){
    if(name.startsWith('suspension_'))continue;
    const button=document.createElement('button');button.textContent=labels[name]??name;styleButton(button);button.setAttribute('aria-pressed','false');let open=false;
    hatchButtons.push({reset:()=>{open=false;button.setAttribute('aria-pressed','false');}});
    button.onclick=()=>{open=!open;button.setAttribute('aria-pressed',String(open));logic.event('joint',{name,angle:open?hinge.limits[1]:0});};p.append(button);
  }
  listen(window,'keydown',e=>{
    if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
    physical.add(e.code);
    if(e.code==='F1'){e.preventDefault();if(!e.repeat&&!enabled)setMode(true);return;}
    if(e.code==='Escape'){if(enabled)e.preventDefault();setMode(false);return;}
    if(!enabled)return;
    if(['KeyW','KeyA','KeyS','KeyD'].includes(e.code)){e.preventDefault();if(!blocked.has(e.code))keys.add(e.code);send();}
    if(e.code==='KeyR'&&!e.repeat){e.preventDefault();reset.click();}
  },{capture:true});
  listen(window,'keyup',e=>{physical.delete(e.code);blocked.delete(e.code);if(keys.delete(e.code))send();});
  listen(window,'blur',()=>{keys.clear();physical.clear();blocked.clear();rmb=false;send();});
  listen(document,'visibilitychange',()=>{if(document.hidden){keys.clear();rmb=false;send();}});
  listen(viewer.canvas,'pointerdown',e=>{
    if(!enabled)return;
    e.preventDefault();rmb=e.button===2;
    if(document.pointerLockElement!==viewer.canvas)viewer.canvas.requestPointerLock?.();
  });
  listen(window,'pointerup',e=>{if(e.button===2)rmb=false;});
  listen(document,'pointerlockchange',()=>{if(!document.pointerLockElement){keys.clear();rmb=false;send();}});
  listen(window,'mousemove',e=>{
    if(!enabled||document.pointerLockElement!==viewer.canvas)return;
    const sensitivity=.12*Math.PI/180;yaw-=e.movementX*sensitivity;
    pitch=Math.max(5*Math.PI/180,Math.min(75*Math.PI/180,pitch+e.movementY*sensitivity));
    if(rmb)elevation=Math.max(config.gun_min,Math.min(config.gun_max,elevation-e.movementY*sensitivity));
    send();camera();
  });
  listen(viewer.canvas,'wheel',e=>{if(enabled){e.preventDefault();distance=Math.max(4,Math.min(24,distance+e.deltaY*.01));camera();}},{passive:false,capture:true});
  const component={update:()=>logic.update()};viewer.addComponent(component);
  setMode(false);
  return {exit:()=>setMode(false),dispose(){disposed=true;setMode(false);abort.abort();logic.dispose();viewer.removeComponent(component);p.remove();delete viewer.canvas.dataset.pythonReady;delete viewer.canvas.dataset.pythonState;}};
}
