import {inspectPlantLODs,digestPlantBytes,plantLODKey,PLANT_LOD_POLICY,buildPlantLODs} from './plant_lod_builder.js';
const memory=new Map();let bytes=0,serial=Promise.resolve(),diskIndex;
const MAX_BYTES=128*1024*1024,MAX_ENTRIES=8;
const abort=signal=>{if(signal?.aborted){const e=new Error('Plant LOD construction cancelled');e.name='AbortError';throw e;}};
function remember(key,result){
 if(memory.has(key)){bytes-=memory.get(key).buffer.byteLength;memory.delete(key);}
 if(result.buffer.byteLength>MAX_BYTES)return;memory.set(key,result);bytes+=result.buffer.byteLength;
 while(memory.size>MAX_ENTRIES||bytes>MAX_BYTES){const old=memory.keys().next().value;bytes-=memory.get(old).buffer.byteLength;memory.delete(old);}
}
async function database(){
 if(typeof indexedDB==='undefined')return null;
 return new Promise(resolve=>{try{const r=indexedDB.open('aps-plant-lods',1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('lods'))r.result.createObjectStore('lods');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);r.onblocked=()=>resolve(null);}catch{resolve(null);}});
}
async function stored(key,value){
 const db=await database();if(!db)return null;
 return new Promise(resolve=>{try{const tx=db.transaction('lods',value?'readwrite':'readonly'),store=tx.objectStore('lods'),r=value?store.put(value,key):store.get(key);let found=null;r.onsuccess=()=>{found=r.result??null;};tx.oncomplete=()=>{db.close();resolve(found);};tx.onerror=tx.onabort=()=>{db.close();resolve(null);};}catch{db.close();resolve(null);}});
}
async function disk(key,signal){
 if(typeof location==='undefined'||!/^https?:$/.test(location.protocol))return null;
 try{
  diskIndex??=fetch(new URL('../../assets/plant_lod_cache/index.json',import.meta.url)).then(async r=>r.ok?{index:await r.json(),base:r.url}:null).catch(()=>null);
  const index=await diskIndex,entry=index?.index?.version===PLANT_LOD_POLICY.version?index.index.entries?.[key]:null;
  if(!entry)return null;abort(signal);
  const response=await fetch(new URL(entry.file,index.base),{signal});if(!response.ok)return null;
  return {buffer:await response.arrayBuffer(),report:entry.report};
 }catch(e){abort(signal);return null;}
}
function workerBuild(buffer,sourceSHA,signal){
 abort(signal);
 if(typeof Worker!=='function'){
  if(typeof process!=='undefined'&&process.versions?.node)return buildPlantLODs(buffer,{required:true,sourceSHA});
  throw Error('Plant LOD construction requires module Worker support');
 }
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./plant_lod_worker.js',import.meta.url),{type:'module'});
  const finish=(error,result)=>{signal?.removeEventListener('abort',cancel);worker.terminate();error?reject(error):resolve(result);};
  const cancel=()=>{const e=new Error('Plant LOD construction cancelled');e.name='AbortError';finish(e);};
  worker.onmessage=({data})=>data.error?finish(Error('Plant LOD: '+data.error)):finish(null,{buffer:data.buffer,report:data.report});
  worker.onerror=e=>finish(Error('Plant LOD worker failed: '+e.message));signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted){cancel();return;}
                                                                                     
  const copy=buffer.slice(0);worker.postMessage({id:sourceSHA,sourceSHA,buffer:copy},[copy]);
 });
}
export async function ensurePlantLODs(buffer,{required=false,signal,onProgress=null,persistent=true,diskCache=true,build=workerBuild}={}){
 abort(signal);const plan=await inspectPlantLODs(buffer,{required});abort(signal);
 if(!plan.plant||!plan.missing.length)return {buffer,report:{status:plan.plant?'authored':'not-plant',version:PLANT_LOD_POLICY.version,meshes:plan.authored}};
 const sourceSHA=await digestPlantBytes(buffer),key=plantLODKey(sourceSHA);
 const work=async()=>{
  abort(signal);
  for(const [status,read]of [['memory-cache',()=>memory.get(key)],['disk-cache',()=>diskCache?disk(key,signal):null],['persistent-cache',()=>persistent?stored(key):null]]){
   const result=await read();abort(signal);
                                                                         
                                                                                
                                                                           
                                                                 
   if(result?.buffer instanceof ArrayBuffer){remember(key,result);onProgress?.('植物 LOD · 缓存已就绪');return {buffer:result.buffer,report:{...(result.report??{}),cache:status}};}
  }
  abort(signal);onProgress?.('正在构建植物 LOD…');
  const result=await build(buffer,sourceSHA,signal);abort(signal);
  if(!(result?.buffer instanceof ArrayBuffer))throw Error('Plant LOD construction did not return an ArrayBuffer');
  remember(key,result);if(persistent){await stored(key,result);abort(signal);}
  onProgress?.('植物 LOD · 构建完成');return {buffer:result.buffer,report:{...(result.report??{}),cache:'built'}};
 };
 const pending=serial.catch(()=>{}).then(work);serial=pending.then(()=>{},()=>{});return pending;
}
export function clearPlantLODMemoryCache(){memory.clear();bytes=0;diskIndex=undefined;}
