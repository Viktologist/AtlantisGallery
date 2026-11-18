import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {Vector3} from '../../vendor/tidewater/src/engine/math/Vector3.js';
import {groundcoverWGSL} from './groundcover_math.js';
import {createGroundDetail,groundDetailSurfaceWGSL} from './ground_detail.js';

export function createGroundcover(input,texture,viewer,terrainModule){
 if(!input)return null;
 const m=input.manifest,first=m.texture.levels[0],layers=Number.isInteger(m.texture.layers)&&m.texture.layers>0?m.texture.layers:2;
 const map=texture({label:'native groundcover moments',width:first.width,height:first.height,depth:layers,dimension:'2d-array',format:'rgba16float',mips:input.levels.length});
 map.getGPU();input.levels.forEach((v,mip)=>map.upload(v,{mip,layers}));map.apsPrefilteredLandscape=true;
 const params=new UniformBlock('APSGroundcover',{eye:['vec3f',new Vector3()],start:['f32',m.start_m],end:['f32',m.end_m],forced:['f32',-1],ready:['f32',0]});
 const module=new ShaderModule({name:'aps-shared-groundcover-transition',deps:[terrainModule],uniforms:params,uniformName:'gcParams',code:groundcoverWGSL});
 const detailModule=createGroundDetail(input.detail,texture);
 const surfaceModule=new ShaderModule({name:'aps-groundcover-appearance',deps:[module,detailModule].filter(Boolean),bindings:{gcMap:{texture:map}},code:`
struct GCState{color:vec3f,k:f32,alpha4:f32};
fn gcGround(P:vec3f,B:vec3f,dx:vec3f,dy:vec3f)->GCState{
 let q=gcRetained(P);
 let nativeP=apsTerrainNativePosition(P);
 let nativeDx=(terrainParams.nativeFromWorld*vec4f(dx,0.)).xyz;let nativeDy=(terrainParams.nativeFromWorld*vec4f(dy,0.)).xyz;
 let uv=(nativeP.xz-vec2f(${m.origin_xz_m.join(',')}))/vec2f(${m.extent_xz_m.join(',')});
 let a=textureSampleGrad(gcMap,smpLinearClamp,uv,0,nativeDx.xz/vec2f(${m.extent_xz_m.join(',')}),nativeDy.xz/vec2f(${m.extent_xz_m.join(',')}));
 let r=textureSampleGrad(gcMap,smpLinearClamp,uv,1,nativeDx.xz/vec2f(${m.extent_xz_m.join(',')}),nativeDy.xz/vec2f(${m.extent_xz_m.join(',')}));
 let c=clamp(a.a,0.,1.);let k=gcConditional(c,q);
 let leaf=clamp(a.rgb/max(c,1e-8),vec3f(0),vec3f(1));
 return GCState(mix(B,leaf,k),k,r.x/max(c,1e-8));
}`});
 const expected=new Set(m.foliage_assets.map(a=>a.sourceUrl)),attached=new Map(),solar=new Map();let disposed=false;
 const invalidateShadows=()=>{viewer.shadowRevision=(viewer.shadowRevision??0)+1;};
 let nativeCull=true;
                                                                               
                                                                           
                                                                         
 const cullData=p=>[...p.eye.value.toArray(),p.end.value,...(m.terrain_elevation_range_m??[-1e30,1e30]),nativeCull?p.ready.value:0,p.forced.value];
 function refresh(){const ready=attached.size===expected.size?1:0;if(params.fields.ready.value!==ready){params.set('ready',ready);invalidateShadows();}}
 function attach(asset){
  const source=asset.groundcoverSourceUrl??asset.sourceUrl;
  if(disposed||!expected.has(source))return false;
  if(attached.get(source)?.has(asset))throw Error('Duplicate groundcover foliage asset');
  if(!asset.vegetation)throw Error('Bound groundcover requires native vegetation runtime');
  if(asset.groundcover&&asset.groundcover!==api)throw Error('Foliage already belongs to another groundcover');
  asset.vegetation.setGroundcover(api);asset.groundcover=api;
  if(!attached.has(source))attached.set(source,new Set());
  attached.get(source).add(asset);refresh();return true;
 }
 function detach(asset){const source=asset.groundcoverSourceUrl??asset.sourceUrl,instances=attached.get(source);if(!instances?.has(asset))return;asset.vegetation?.setGroundcover(null);delete asset.groundcover;instances.delete(asset);if(!instances.size)attached.delete(source);refresh();}
 const api={module,surfaceModule,attach,detach,params,detailSurface:detailModule?groundDetailSurfaceWGSL:'',coverSurface:groundcoverSurfaceWGSL,surface:(detailModule?groundDetailSurfaceWGSL:'')+groundcoverSurfaceWGSL,
  update(camera,frame=null){const p=camera.position;
   if(frame){const e=frame.worldFromNative.elements;nativeCull=e.every((v,i)=>v===[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1][i]);}
   if(m.transition_pixel_height){const factor=m.source_height_m*(viewer.canvas?.height??760)/(2*Math.tan(camera.fov*Math.PI/360));params.set('start',factor/m.transition_pixel_height[1]);params.set('end',factor/m.transition_pixel_height[0]);}
   params.fields.eye.value.copy(p);},
  cullData(){return cullData(params.fields);},
                                                                            
                                                                              
                                                                              
                                                                 
  captureShadow(index,budget=null){
   if(!Number.isInteger(index)||index<0||index>=4)throw RangeError('Invalid groundcover solar level');
   let state=solar.get(index);
   if(!state){
    const block=new UniformBlock('APSGroundcoverSolar'+index,{eye:['vec3f',new Vector3()],start:['f32',0],end:['f32',1],forced:['f32',-1],ready:['f32',0]});
    state={owner:api,key:'solar:'+index,params:block,module:new ShaderModule({name:'aps-solar-groundcover-'+index,deps:[terrainModule],uniforms:block,uniformName:'gcParams',code:groundcoverWGSL}),cullData:()=>cullData(block.fields)};
    solar.set(index,state);
   }
   state.params.fields.eye.value.copy(params.fields.eye.value);
   for(const key of ['start','end','forced','ready'])state.params.set(key,params.fields[key].value);
   if(budget){
    const end=Math.min(params.fields.end.value,budget.grassEnd);
    state.params.set('end',end);state.params.set('start',Math.min(params.fields.start.value,budget.grassStart,end*.5));
    if(index>=budget.grassLevels)state.params.set('forced',0);
   }
   return state;
  },
  setRetention(value=-1){if(!Number.isFinite(value)||value<0&&value!==-1||value>1)throw Error('Retention must be -1 or [0,1]');if(params.fields.forced.value!==value){params.set('forced',value);invalidateShadows();}},
  metadata(){return {schema:m.schema,landscape_sha256:m.landscape_sha256,ready:params.fields.ready.value===1,expected_assets:expected.size,attached_assets:attached.size,start_m:params.fields.start.value,end_m:params.fields.end.value,transition_pixel_height:m.transition_pixel_height??null,forced_retention:params.fields.forced.value,resident_bytes:input.residentBytes,detail:input.detail?.manifest??null,filter:'joint premultiplied leaf colour / union coverage / alpha4 mips',solar_retention:'independent per-map capture; refreshed with solar depth, never invalidated by main camera motion',limitation:m.approximation};},
  dispose(){if(disposed)return;disposed=true;for(const instances of [...attached.values()])for(const a of [...instances])detach(a);params.buffer?.destroy();for(const state of solar.values())state.params.buffer?.destroy();solar.clear();}};
 return api;
}

export const groundcoverSurfaceWGSL=`
let gc=gcGround(in.P,apsTerrainCurrent.baseColor,dpdx(in.P),dpdy(in.P));
apsTerrainCurrent.baseColor=gc.color;
apsTerrainCurrent.roughness=pow(mix(pow(apsTerrainCurrent.roughness,4.),clamp(gc.alpha4,0.,1.),gc.k),.25);
if(terrainParams.mode==17){apsTerrainCurrent.emission=gc.color;}
if(terrainParams.mode==15){apsTerrainCurrent.emission=vec3f(apsTerrainCurrent.roughness);}
`;
