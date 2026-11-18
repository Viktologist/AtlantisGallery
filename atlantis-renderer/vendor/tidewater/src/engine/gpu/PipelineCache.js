                                                                             
                                                                         
const devices=new WeakMap();
export function pipelineCacheFor(device){
 let cache=devices.get(device);
 if(cache)return cache;
 const objects=new WeakMap();let next=0;
 const encode=value=>{
  if(value===undefined)return undefined;
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(encode);
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null){let id=objects.get(value);if(id===undefined){id=++next;objects.set(value,id);}return {$gpu:id};}
  return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,encode(value[k])]));
 };
 cache={pipelines:new Map(),layouts:new Map(),hits:0,misses:0,
  key(desc){const {label,...state}=desc;return JSON.stringify(encode(state));},
  layout(desc){const key=this.key(desc);let layout=this.layouts.get(key);if(!layout){layout=device.createPipelineLayout(desc);this.layouts.set(key,layout);}return layout;},
  metadata(){return {pipelines:this.pipelines.size,layouts:this.layouts.size,hits:this.hits,misses:this.misses};}};
 devices.set(device,cache);return cache;
}
