import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {CloudOpticalDepthField} from './cloud_field.js';
import {normalizeWeather,sunAtHour,cloudLightFrame} from './lighting_math.js';
import {dailyCloudSlots,cloudGeometryKey} from './cloud_daily_math.js';

const MAGIC=new TextEncoder().encode('APSCLD01');
const sourceFields=()=>({bounds:['vec4f[4]',Array.from({length:4},()=>[0,0,1,1])],depth:['vec4f[4]',Array.from({length:4},()=>[0,1,1,0])],right:['vec3f',[1,0,0]],enabled:['f32',0],up:['vec3f',[0,0,1]],pad:['f32',0],sun:['vec3f',[0,1,0]],padSun:['f32',0]});

function sourceLookup(name,pages,slices){return `
fn dailyTau${name}(P:vec3f)->f32{
 if(bank${name}.enabled<.5){return 0.0;}
 let span=apsCloudInterval(P,bank${name}.sun);if(span.y<=span.x){return 0.0;}
 let q=P+bank${name}.sun*span.x-vec3f(0,cloudParams.ground,0);
 let light=vec3f(dot(q,bank${name}.right),dot(q,bank${name}.up),dot(q,bank${name}.sun));
 var cascade=3;
 for(var c=0;c<3;c++){let b=bank${name}.bounds[c];let d=bank${name}.depth[c];
  if(max(max(abs(light.x-b.x),abs(light.y-b.y)),abs(light.z-(d.x+d.y)*.5))<b.z*.45){cascade=c;break;}}
 var result=0.0;
 for(var levelPass=0;levelPass<2;levelPass++){
  let c=min(3,cascade+levelPass);let b=bank${name}.bounds[c];let d=bank${name}.depth[c];let halfTexel=.5/cloudParams.resolution;
  let uv=clamp((light.xy-b.xy)*b.w+.5,vec2f(halfTexel),vec2f(1.0-halfTexel));
  let z=clamp((light.z-d.x)*d.z,0.0,1.0)*${slices-1}.0;let lo=i32(floor(z));let hi=min(${slices-1},lo+1);
  let a=textureSampleLevel(source${name},smpLinearClamp,uv,c*${pages}+lo/4,0.0);
  let bTau=textureSampleLevel(source${name},smpLinearClamp,uv,c*${pages}+hi/4,0.0);
  let tau=mix(a[lo%4],bTau[hi%4],fract(z));
  if(levelPass==0){result=tau;}else{let inner=bank${name}.bounds[cascade];let dep=bank${name}.depth[cascade];
   let edge=max(max(abs(light.x-inner.x),abs(light.y-inner.y)),abs(light.z-(dep.x+dep.y)*.5))/inner.z;
   result=mix(result,tau,smoothstep(.35,.45,edge));}
 }
 return result;
}`;}

async function readVolume(texture){
  const size=texture.width*texture.height*texture.depth*8;
  const buffer=GPU.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  GPU.getEncoder().copyTextureToBuffer({texture:texture.getGPU()},{buffer,bytesPerRow:texture.width*8,rowsPerImage:texture.height},{width:texture.width,height:texture.height,depthOrArrayLayers:texture.depth});
  GPU.submit();await buffer.mapAsync(GPUMapMode.READ);
  const bytes=buffer.getMappedRange().slice(0);buffer.unmap();buffer.destroy();return bytes;
}
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');}

export class CloudDailyOpticalBank {
  constructor(field){
    this.field=field;this.slots=[];this.active=false;this.resampleDispatches=0;
    this.sources=['A','B'].map(name=>({texture:new Texture({label:'daily cloud source '+name,width:field.resolution,height:field.resolution,depth:field.slices,dimension:'2d-array',format:'rgba16float',usage:['sample','copyDst']}),params:new UniformBlock('APSCloudDaily'+name,sourceFields())}));
    this.blend=new UniformBlock('APSCloudDailyBlend',{weight:['f32',0]});
    const pages=field.slices/4;
    this.kernels=field.buildParams.map((build,cascade)=>new ComputeKernel({label:'APS precomputed cloud resample '+cascade,modules:[field.densityModule],bindings:{build:{uniform:build},bankA:{uniform:this.sources[0].params},bankB:{uniform:this.sources[1].params},dailyBlend:{uniform:this.blend},sourceA:{texture:this.sources[0].texture,viewDimension:'2d-array'},sourceB:{texture:this.sources[1].texture,viewDimension:'2d-array'},outOptical:{storageTexture:field.optical,viewDimension:'2d-array'}},workgroupSize:[8,8,1],code:`
${sourceLookup('A',pages,field.slices)}
${sourceLookup('B',pages,field.slices)}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=${field.resolution}u||gid.y>=${field.resolution}u||gid.z>=${pages}u){return;}
 let xy=build.bound.xy+((vec2f(gid.xy)+.5)/${field.resolution}.0-.5)*build.bound.z;var tau=vec4f(0);
 for(var k=0u;k<4u;k++){
  let z=mix(build.depth.x,build.depth.y,f32(gid.z*4u+k)/${field.slices-1}.0);
  let P=vec3f(0,cloudParams.ground,0)+cloudParams.right*xy.x+cloudParams.up*xy.y+cloudParams.sun*z;
  tau[k]=mix(dailyTauA(P),dailyTauB(P),dailyBlend.weight);
 }
 textureStore(outOptical,gid.xy,${cascade*pages}+i32(gid.z),tau);
}`}));
  }
  async precompute(weather,camera,onProgress){
    this.key=cloudGeometryKey(weather,this.field);this.anchor=[camera.x,camera.y,camera.z];
    const scratch=new CloudOpticalDepthField({resolution:this.field.resolution,slices:this.field.slices,spans:this.field.spans,panoramaSize:32});
    try{
      await GPU.pipelinesReady();
      for(let index=0;index<48;index++){
        const hour=index/2,w=normalizeWeather({timeOfDay:hour,sunDirection:sunAtHour(hour)},weather);
        scratch.update(w,camera);GPU.submit();await GPU.queue.onSubmittedWorkDone();
        const u=scratch.params.fields,active=!!u.ready.value;
        const entry={hour,active,frame:{bounds:structuredClone(u.bounds.value),depth:structuredClone(u.depthBounds.value),right:[...u.right.value],up:[...u.up.value],sun:[...u.sun.value]},data:active?await readVolume(scratch.optical):null};
        entry.sha256=entry.data?await hash(entry.data):null;this.slots.push(entry);
        onProgress?.({completed:index+1,total:48,hour,active,bytes:this.slots.reduce((n,s)=>n+(s.data?.byteLength??0),0)});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }finally{scratch.dispose();}
    this.ready=true;
  }
  select(weather,camera){
    this.active=false;
    if(!this.ready||cloudGeometryKey(weather,this.field)!==this.key)return false;
    const expected=sunAtHour(weather.timeOfDay);
    if(expected.some((v,k)=>Math.abs(v-weather.sunDirection[k])>1e-6))return false;
    if(Math.hypot(camera.x-this.anchor[0],camera.y-this.anchor[1],camera.z-this.anchor[2])>this.field.spans[3]*.2)return false;
    const pair=dailyCloudSlots(weather.timeOfDay);
    [pair.first,pair.second].forEach((slot,k)=>{
      const source=this.sources[k],entry=this.slots[slot];
      if(source.index===slot)return;
      source.index=slot;
      for(const [name,value] of Object.entries({...entry.frame,enabled:entry.active?1:0}))source.params.fields[name].value=value;
      if(entry.data)GPU.queue.writeTexture({texture:source.texture.getGPU()},entry.data,{bytesPerRow:this.field.resolution*8,rowsPerImage:this.field.resolution},{width:this.field.resolution,height:this.field.resolution,depthOrArrayLayers:this.field.slices});
    });
    this.blend.fields.weight.value=pair.weight;this.pair=pair;this.active=true;return true;
  }
  dispatch(index){this.kernels[index].dispatch([Math.ceil(this.field.resolution/8),Math.ceil(this.field.resolution/8),this.field.slices/4]);this.resampleDispatches++;}
  metadata(){return {ready:!!this.ready,slots:this.slots.length,step_hours:.5,active_slots:this.slots.filter(s=>s.active).length,bytes:this.slots.reduce((n,s)=>n+(s.data?.byteLength??0),0),anchor:this.anchor,active:this.active,pair:this.pair,resample_dispatches:this.resampleDispatches,lookup:'query both sun coordinate systems, interpolate optical depth in world space',invalidated_by:'cloud geometry/weather/time animation or leaving precomputed region; manual off-orbit sun uses native integration'};}
  toBlob(){
    if(!this.ready)throw Error('Daily cloud precomputation is incomplete');
    let offset=0;
    const entries=this.slots.map(({data,...s})=>{const out={...s,offset,bytes:data?.byteLength??0};offset+=out.bytes;return out;});
    const manifest={schema:'aps-cloud-daily/1',key:this.key,anchor:this.anchor,resolution:this.field.resolution,slices:this.field.slices,spans:this.field.spans,entries};
    const json=new TextEncoder().encode(JSON.stringify(manifest)),header=new ArrayBuffer(12);new Uint8Array(header).set(MAGIC);new DataView(header).setUint32(8,json.byteLength,true);
    return new Blob([header,json,...this.slots.filter(s=>s.data).map(s=>s.data)],{type:'application/octet-stream'});
  }
  static async fromBlob(field,blob){
    const header=await blob.slice(0,12).arrayBuffer();
    if(new Uint8Array(header).slice(0,8).some((v,k)=>v!==MAGIC[k]))throw Error('Invalid daily cloud file');
    const length=new DataView(header).getUint32(8,true);if(length>1048576)throw Error('Invalid daily cloud manifest');
    const m=JSON.parse(await blob.slice(12,12+length).text());
    if(m.schema!=='aps-cloud-daily/1'||m.entries.length!==48||m.resolution!==field.resolution||m.slices!==field.slices||JSON.stringify(m.spans)!==JSON.stringify(field.spans))throw Error('Incompatible daily cloud bank');
    if(!Array.isArray(m.anchor)||m.anchor.length!==3||!m.anchor.every(Number.isFinite)||typeof m.key!=='string')throw Error('Invalid daily cloud anchor');
    const bank=new CloudDailyOpticalBank(field);bank.key=m.key;bank.anchor=m.anchor;
    try{
      let offset=0;
      for(const [index,entry] of m.entries.entries()){
        const expected=entry.active?field.resolution**2*field.slices*8:0;
        if(entry.hour!==index/2||typeof entry.active!=='boolean'||entry.bytes!==expected||entry.offset!==offset||12+length+entry.offset+entry.bytes>blob.size)throw Error('Invalid daily cloud payload bounds');
        const basis=cloudLightFrame(sunAtHour(entry.hour));
        for(const name of ['sun','right','up'])if(!Array.isArray(entry.frame[name])||entry.frame[name].length!==3||entry.frame[name].some((v,k)=>!Number.isFinite(v)||Math.abs(v-basis[name][k])>1e-6))throw Error('Invalid daily cloud light frame');
        for(const name of ['bounds','depth'])if(!Array.isArray(entry.frame[name])||entry.frame[name].length!==4||entry.frame[name].some(row=>!Array.isArray(row)||row.length!==4||!row.every(Number.isFinite)))throw Error('Invalid daily cloud volume bounds');
        const data=entry.bytes?await blob.slice(12+length+entry.offset,12+length+entry.offset+entry.bytes).arrayBuffer():null;
        if(data&&await hash(data)!==entry.sha256)throw Error('Daily cloud payload hash mismatch');
        bank.slots.push({...entry,data});offset+=entry.bytes;
      }
      if(12+length+offset!==blob.size)throw Error('Unexpected daily cloud trailing payload');
      await GPU.pipelinesReady();bank.ready=true;return bank;
    }catch(e){bank.dispose();throw e;}
  }
  dispose(){for(const s of this.sources){s.texture.destroy();s.params.buffer?.destroy();}this.blend.buffer?.destroy();this.slots=[];this.ready=false;}
}
