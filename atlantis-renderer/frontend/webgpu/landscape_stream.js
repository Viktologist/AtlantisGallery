import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {LandscapePageCache} from './landscape_pages.js';

export function virtualLandscapeWGSL(layout){
 const descriptors=layout.stacks.flatMap(s=>s.levels).map(l=>`vec4u(${l.width}u,${l.height}u,${l.offset}u,${l.tableLayer}u)`);
 const lengths=layout.stacks.map(s=>s.levels.length),size=layout.config.page_size,side=size+2*layout.config.border;
 return           `
var<private> lpRecordFeedback:bool;
const lpLevels=array<vec4u,${descriptors.length}>(${descriptors.join(',')});
fn lpLevel(stack:i32,level:i32)->vec4u{return lpLevels[level+select(0,${lengths[0]},stack==1)];}
fn lpLast(stack:i32)->i32{return select(${lengths[0]-1},${lengths[1]-1},stack==1);}
fn lpPage(uv:vec2f,level:vec4u)->vec2u{return min(vec2u(clamp(uv,vec2f(0),vec2f(1))*vec2f(level.xy)),level.xy-1u)/${size}u;}
fn lpAge(entry:vec4u)->f32{
 if(entry.x==0u){return 0.;}if(entry.w==1u){return 1.;}
 let born=clamp(f32(lpStream.frame-entry.y)/${layout.config.fade_frames}.,0.,1.);
 let retire=select(1.,1.-clamp(f32(lpStream.frame-entry.z)/${layout.config.fade_frames}.,0.,1.),entry.z>0u);return born*retire;
}
fn lpEntry(page:vec2u,level:vec4u)->vec4u{return textureLoad(lpTable,vec2i(page),i32(level.w),0);}
fn lpPageFade(uv:vec2f,page:vec2u,level:vec4u,entry:vec4u)->f32{
 let age=lpAge(entry);let local=clamp(uv,vec2f(0),vec2f(1))*vec2f(level.xy)-vec2f(page*${size}u);
 let span=vec2f(min(vec2u(${size}u),level.xy-page*${size}u));let dims=(level.xy+${size-1}u)/${size}u;
 var fade=age;
 if(page.x>0u){fade=min(fade,mix(min(age,lpAge(lpEntry(page-vec2u(1,0),level))),age,smoothstep(0.,4.,local.x)));}
 if(page.y>0u){fade=min(fade,mix(min(age,lpAge(lpEntry(page-vec2u(0,1),level))),age,smoothstep(0.,4.,local.y)));}
 if(page.x+1u<dims.x){fade=min(fade,mix(min(age,lpAge(lpEntry(page+vec2u(1,0),level))),age,smoothstep(0.,4.,span.x-local.x)));}
 if(page.y+1u<dims.y){fade=min(fade,mix(min(age,lpAge(lpEntry(page+vec2u(0,1),level))),age,smoothstep(0.,4.,span.y-local.y)));}
 return fade;
}
fn lpFineAvailability(stack:i32,uv:vec2f)->f32{let level=lpLevel(stack,0);let page=lpPage(uv,level);return lpPageFade(uv,page,level,lpEntry(page,level));}
fn lpVirtualLevel(stack:i32,uv:vec2f,channel:i32,requested:i32)->vec4f{
 let start=clamp(requested,0,lpLast(stack));let wanted=lpLevel(stack,start);let wantedPage=lpPage(uv,wanted);
 if(lpRecordFeedback){let cols=(wanted.x+${size-1}u)/${size}u;atomicAdd(&lpRequests[wanted.z+wantedPage.y*cols+wantedPage.x],1u);}
 var result=vec4f(0);var remaining=1.;
 for(var mip=start;mip<=lpLast(stack);mip++){
  let level=lpLevel(stack,mip);let page=lpPage(uv,level);let entry=lpEntry(page,level);
  if(entry.x==0u){continue;}
  let fade=lpPageFade(uv,page,level,entry);
  let q=(clamp(uv,vec2f(0),vec2f(1))*vec2f(level.xy)-vec2f(page*${size}u)+${layout.config.border}.)/${side}.;
  result+=remaining*fade*textureSampleLevel(lpPhysical,smpLinearClamp,q,i32(entry.x-1u)*3+channel,0.);
  remaining*=1.-fade;if(remaining<1e-5){break;}
 }return result;
}
fn lpVirtualSample(stack:i32,uv:vec2f,channel:i32,lod:f32)->vec4f{
 let level=clamp(lod,0.,f32(lpLast(stack)));let low=i32(floor(level));
 let a=lpVirtualLevel(stack,uv,channel,low);let t=fract(level);
 if(t<1e-5){return a;}return mix(a,lpVirtualLevel(stack,uv,channel,low+1),t);
}
`;
}

export async function createLandscapeStream(input,texture,terrainModule){
 const {layout,fetchPage}=input.virtual,c=layout.config;
 if(c.cache_pages*3>GPU.device.limits.maxTextureArrayLayers)throw Error('Landscape physical cache exceeds array layer limit');
 const physical=texture({label:'landscape fixed physical page cache',width:c.page_size+2*c.border,height:c.page_size+2*c.border,depth:c.cache_pages*3,dimension:'2d-array',format:'rgba16float'});
 const table=texture({label:'landscape residency table',width:layout.tableWidth,height:layout.tableHeight,depth:layout.tableLayers,dimension:'2d-array',format:'rgba32uint',data:new Uint32Array(layout.tableWidth*layout.tableHeight*layout.tableLayers*4)});
 physical.getGPU();table.getGPU();physical.apsPrefilteredLandscape=table.apsPrefilteredLandscape=true;
 const feedback=GPU.device.createBuffer({label:'landscape visible fragment demands',size:layout.feedbackBytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
 const staging=Array.from({length:2},()=>({busy:false,buffer:GPU.device.createBuffer({label:'landscape asynchronous demand readback',size:layout.feedbackBytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})}));
 const params=new UniformBlock('LandscapeStream',{frame:['u32',1]});
 const stats={loaded:0,evicted:0,bytes_fetched:0,feedback_reads:0,feedback_pages_seen:0,rejected:0,discarded:0,coarsening_bias:0};
 const errors=[],pending=new Map(),ready=new Map(),retry=new Map(),abort=new AbortController();let disposed=false,frame=1,lastRead=-100,queue=[];
 const cache=new LandscapePageCache(layout,(page,entry)=>{
  if(disposed)return;
  const data=entry?new Uint32Array([entry.slot+1,entry.born,entry.retire,page.pinned?1:0]):new Uint32Array(4);
  table.upload(data,{width:1,height:1,layers:1,layer:page.level.tableLayer,x:page.x,y:page.y});
 });
 function upload(page,data){const entry=cache.claim(page.id);if(!entry)return false;
  physical.upload(data,{layer:entry.slot*3,layers:3});cache.publish(entry);stats.loaded++;return true;
 }
 function plan(counts){if(disposed)return;stats.feedback_reads++;stats.feedback_pages_seen+=counts.filter(v=>v>0).length;queue=cache.demand(counts);stats.coarsening_bias=cache.bias;}
 function pump(){if(disposed)return;
  for(const [id,data]of ready){if(!cache.wanted.has(id)){ready.delete(id);stats.discarded++;continue;}if(upload(layout.pages[id],data))ready.delete(id);}
  for(const {id}of queue){if(pending.size+ready.size>=c.max_inflight)break;if(cache.resident.has(id)||pending.has(id)||ready.has(id)||(retry.get(id)||0)>frame)continue;
   const page=layout.pages[id];const task=fetchPage(page,{signal:abort.signal}).then(data=>{if(disposed)return;stats.bytes_fetched+=data.byteLength;if(cache.wanted.has(id))ready.set(id,data);else stats.discarded++;}).catch(e=>{if(disposed)return;stats.rejected++;retry.set(id,frame+180);errors.push({id,error:String(e)});if(errors.length>8)errors.shift();}).finally(()=>pending.delete(id));pending.set(id,task);
  }
 }
 function readFeedback(){const target=staging.find(s=>!s.busy);if(!target)return;
  target.busy=true;const encoder=GPU.device.createCommandEncoder({label:'landscape previous-frame feedback'});
  encoder.copyBufferToBuffer(feedback,0,target.buffer,0,layout.feedbackBytes);GPU.queue.submit([encoder.finish()]);GPU.queue.writeBuffer(feedback,0,new Uint32Array(layout.pages.length));
  target.buffer.mapAsync(GPUMapMode.READ).then(()=>{if(disposed)return;const data=new Uint32Array(target.buffer.getMappedRange()).slice();target.buffer.unmap();plan(data);}).catch(e=>{if(!disposed)errors.push({error:'feedback '+e});}).finally(()=>{target.busy=false;});
 }
 const api={module:new ShaderModule({name:'aps-landscape-virtual-pages',deps:[terrainModule],uniforms:params,uniformName:'lpStream',bindings:{lpPhysical:{texture:physical},lpTable:{texture:table,sampleType:'uint'},lpRequests:{storage:feedback,wgslType:'array<atomic<u32>>',access:'read_write'}},code:virtualLandscapeWGSL(layout)}),
  update(nextFrame){if(disposed)return;frame=Math.max(1,nextFrame??frame+1);cache.advance(frame);params.set('frame',frame);if(frame-lastRead>=c.feedback_interval){lastRead=frame;readFeedback();}pump();stats.evicted=cache.evictions;},
  request(counts){plan(counts);pump();},
  metadata(){return {...stats,virtual_pages:layout.pages.length,resident_pages:cache.resident.size,physical_page_budget:c.cache_pages,pinned_tail_pages:layout.pinned.length,physical_cache_bytes:layout.cacheBytes,page_table_bytes:layout.tableBytes,feedback_bytes:layout.feedbackBytes*3,inflight:pending.size,ready_pages:ready.size,errors:[...errors]};},
  dispose(){if(disposed)return;disposed=true;abort.abort();pending.clear();ready.clear();feedback.destroy();for(const s of staging)s.buffer.destroy();params.buffer?.destroy();}};
 try{for(let offset=0;offset<layout.pinned.length;offset+=c.max_inflight){const pages=layout.pinned.slice(offset,offset+c.max_inflight);const data=await Promise.all(pages.map(p=>fetchPage(p,{signal:abort.signal})));for(let i=0;i<pages.length;i++){if(!upload(pages[i],data[i]))throw Error('Landscape mip tail residency failed');stats.bytes_fetched+=data[i].byteLength;}}}
 catch(e){api.dispose();throw e;}
 return api;
}
