import {GPU,Texture,StorageBuffer,UniformBlock,ShaderModule,ComputeKernel} from '../../vendor/tidewater/src/engine/webgpu.js';
import {OCEAN_FOAM_WGSL} from './ocean_foam.js';
import {FOAM_TRANSPORT_WGSL,FOAM_ADVANCE_WGSL} from './ocean_foam_transport.js';
import {FoamPagePool} from './ocean_foam_lod.js';
const prefix=OCEAN_FOAM_WGSL.split('// PAGE_DEPENDENT')[0];
const output=t=>({storageTexture:t,access:'write'}),read=b=>({storage:b,access:'read'}),sample=t=>({texture:t,sampleType:'unfilterable-float'});

export class ShorePages {
 constructor(s,surface,fineOptions={}){
  this.s=s;const l=s.layout,side=l.cells+2*l.halo,count=Math.max(1,l.tiles.length);
  if(count>GPU.limits.maxTextureArrayLayers||side>GPU.limits.maxTextureDimension2D||Math.max(...l.shape)>GPU.limits.maxTextureDimension2D)throw Error('Shore page layout exceeds device capacity');
  const adaptive=!!s.native&&(l.review==null||l.review.adaptive===true)&&fineOptions!==false;
  this.fineSide=adaptive?l.tileMetres/.25+2*l.halo:1;this.capacity=adaptive?(fineOptions.capacity??9):1;
  if(this.fineSide>GPU.limits.maxTextureDimension2D||this.capacity*this.fineSide**2*72>192*1024**2)throw Error('Adaptive .25m foam pool exceeds 192MiB or device dimensions');
  this.pool=adaptive?new FoamPagePool(l,{capacity:this.capacity,pixelsPerCell:fineOptions.pixelsPerCell??2}):null;
  const index=new Uint32Array(l.shape[0]*l.shape[1]),origins=new Float32Array(count*4);
  for(const t of l.tiles){index[t.key]=t.id+1;origins.set([...t.origin,0,0],t.id*4);}
  s.index=new Texture({label:'coarse shore world IDs',width:l.shape[0],height:l.shape[1],format:'r32uint',data:index});
  s.origins=new StorageBuffer({label:'coarse shore origins',count,data:origins});
  this.fineIndex=new Texture({label:'adaptive foam world-to-pool IDs',width:l.shape[0],height:l.shape[1],format:'r32uint',data:new Uint32Array(index.length)});
  this.fineOrigins=new StorageBuffer({label:'adaptive foam origins/cells/seed+exterior',count:this.capacity,data:new Float32Array(this.capacity*4)});
  this.oldOrigins=new StorageBuffer({label:'retiring foam origins/cells/coarse ID',count:this.capacity,data:new Float32Array(this.capacity*4)});
  const tex=(name,fine=false,flow=false)=>new Texture({label:name,width:fine?this.fineSide:side,height:fine?this.fineSide:side,depth:fine?this.capacity:count,dimension:'2d-array',format:flow?'rgba16float':'rgba32float',usage:['sample','storage','copyDst']});
  s.profile=tex('shore corrected wave XYZ/emission');s.support=tex('shore support/impact/potential');s.states=[tex('shore history A'),tex('shore history B')];s.front=0;
  this.fineProfile=tex('fine shore wave XYZ/emission',true);this.fineSupport=tex('fine shore support/impact/potential',true);this.fineStates=[tex('fine foam history A',true),tex('fine foam history B',true)];
  this.flow=tex('shore choppy transport and compression axis',false,true);this.fineFlow=tex('fine choppy transport and compression axis',true,true);
  s.pageParams=new UniformBlock('NativeOceanPages',{pageGrid:['vec4f',[...l.origin,l.tileMetres,l.cells]],halo:['f32',l.halo],pages:['u32',l.tiles.length],life:['vec2f',[2*(6+2*s.config.stormylevel),2*(9+2*s.config.stormylevel)]],fineCapacity:['u32',this.pool?this.capacity:0]});
  s.pageModule=new ShaderModule({name:'oceanShorePages',deps:[s.module],uniforms:s.pageParams,uniformName:'pageP',bindings:{
   shoreIndex:{texture:s.index},shoreProfile:sample(s.profile),shoreSupport:sample(s.support),fineIndex:{texture:this.fineIndex},fineOrigins:read(this.fineOrigins),fineProfile:sample(this.fineProfile),fineSupport:sample(this.fineSupport),
   shoreState:sample(()=>s.states[s.front]),fineState:sample(()=>this.fineStates[s.front]),shoreFlow:sample(this.flow),fineFlow:sample(this.fineFlow)},code:`
fn oceanPageId(p:vec2f)->i32 {let i=vec2i(floor((p-pageP.pageGrid.xy)/pageP.pageGrid.z));if(any(i<vec2i(0))||any(i>=vec2i(textureDimensions(shoreIndex)))){return -1;}return i32(textureLoad(shoreIndex,i,0).x)-1;}
fn oceanFineId(p:vec2f)->i32 {if(pageP.fineCapacity==0u){return -1;}let i=vec2i(floor((p-pageP.pageGrid.xy)/pageP.pageGrid.z));if(any(i<vec2i(0))||any(i>=vec2i(textureDimensions(fineIndex)))){return -1;}return i32(textureLoad(fineIndex,i,0).x)-1;}
fn oceanPageLoad(tex:texture_2d_array<f32>,p:vec2f)->vec4f {
 let id=oceanPageId(p);if(id<0){return vec4f(0);}let tile=floor((p-pageP.pageGrid.xy)/pageP.pageGrid.z)*pageP.pageGrid.z+pageP.pageGrid.xy;
 let q=(p-tile)*pageP.pageGrid.w/pageP.pageGrid.z+pageP.halo-0.5;let i=vec2i(floor(q));let f=fract(q);
 return mix(mix(textureLoad(tex,i,id,0),textureLoad(tex,i+vec2i(1,0),id,0),f.x),mix(textureLoad(tex,i+vec2i(0,1),id,0),textureLoad(tex,i+vec2i(1),id,0),f.x),f.y);
}
fn oceanFineLoad(tex:texture_2d_array<f32>,p:vec2f,id:i32)->vec4f {
 let origin=fineOrigins[id];let q=(p-origin.xy)*origin.z/pageP.pageGrid.z+pageP.halo-0.5;let i=vec2i(floor(q));let f=fract(q);
 return mix(mix(textureLoad(tex,i,id,0),textureLoad(tex,i+vec2i(1,0),id,0),f.x),mix(textureLoad(tex,i+vec2i(0,1),id,0),textureLoad(tex,i+vec2i(1),id,0),f.x),f.y);
}
fn oceanFineWeight(p:vec2f,id:i32)->f32 {
 if(id<0){return 0.0;}let packed=fineOrigins[id];let origin=packed.xy;let m=pageP.pageGrid.z;let exterior=u32(packed.w)>>1u;var edge=m;
 if((exterior&1u)!=0u){edge=min(edge,p.x-origin.x);}if((exterior&2u)!=0u){edge=min(edge,origin.x+m-p.x);}
 if((exterior&4u)!=0u){edge=min(edge,p.y-origin.y);}if((exterior&8u)!=0u){edge=min(edge,origin.y+m-p.y);}
 return smoothstep(0.0,4.0,edge);
}
fn oceanPageHybridLoad(coarse:texture_2d_array<f32>,fine:texture_2d_array<f32>,p:vec2f)->vec4f {
 let coarseValue=oceanPageLoad(coarse,p);let id=oceanFineId(p);if(id<0){return coarseValue;}return mix(coarseValue,oceanFineLoad(fine,p,id),oceanFineWeight(p,id));
}
fn oceanPageCell(p:vec2f)->f32 {let id=oceanFineId(p);let coarse=pageP.pageGrid.z/pageP.pageGrid.w;if(id<0){return coarse;}return mix(coarse,pageP.pageGrid.z/fineOrigins[id].z,oceanFineWeight(p,id));}
fn oceanPageProfile(p:vec2f)->vec4f{return oceanPageHybridLoad(shoreProfile,fineProfile,p);}
fn oceanPageSupport(p:vec2f)->vec4f{return oceanPageHybridLoad(shoreSupport,fineSupport,p);}
fn shoreSimSample(p:vec2f)->vec4f{return oceanPageHybridLoad(shoreState,fineState,p);}
fn oceanPageFlow(p:vec2f)->vec4f{return oceanPageHybridLoad(shoreFlow,fineFlow,p);}
fn oceanWetness(p:vec2f)->f32{return select(0.0,shoreSimSample(p).y,shoreP.enabled>0u&&shoreP.wetness>0u);}
${OCEAN_FOAM_WGSL}`});
                                                                              
                                                                           
  surface.bindPages(s);
  s.pageModule.code=s.pageModule.code.slice(s.pageModule.code.indexOf('fn shoreSimSample'));
  s.pageModule.deps=[surface.cacheModule];s.pageModule.bindings={shoreState:sample(()=>s.states[s.front]),fineState:sample(()=>this.fineStates[s.front]),shoreFlow:sample(this.flow),fineFlow:sample(this.fineFlow)};
  this.caches=[false,true].map(fine=>new ComputeKernel({label:`Ocean ${fine?'fine adaptive':'coarse fixed'} profile cache`,modules:[s.module,surface.filmModule],bindings:{pageP:{uniform:s.pageParams},origins:read(fine?this.fineOrigins:s.origins),oldState:sample(()=>fine?this.fineStates[s.front]:s.states[s.front]),profileOut:output(fine?this.fineProfile:s.profile),supportOut:output(fine?this.fineSupport:s.support)},workgroupSize:[8,8,1],code:`
${prefix}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=${fine?'pageP.fineCapacity':'pageP.pages'}){return;}let origin=origins[id.z];let cells=${fine?'origin.z':'pageP.pageGrid.w'};if(cells<1.0||any(id.xy>=vec2u(u32(cells)+u32(2.0*pageP.halo)))){return;}
 // Water keeps the accepted analytic breaking/run-up profile. Only foam
 // history is advected; no independently solved h/hu/hv changes this surface.
 let cell=pageP.pageGrid.z/cells;let p=origin.xy+(vec2f(id.xy)+0.5-pageP.halo)*cell;var wave=oceanAnalyticShore(p,cell);
 let film=oceanShoreFilmAt(p,cell);wave.disp.y=mix(wave.disp.y,oceanBed(p)-frame.seaLevel+film.depth,film.band);wave.weight=max(wave.weight,film.band*film.coverage);
 let speed=textureLoad(oldState,vec2i(id.xy),i32(id.z),0).a;let column=max(0.0,frame.seaLevel+wave.disp.y*wave.weight-oceanBed(p));let strength=max(oceanWarpStrength(column,speed),oceanReturnMix(column,speed)*0.9);
 textureStore(profileOut,id.xy,id.z,vec4f(wave.disp*wave.weight,wave.density*wave.weight));textureStore(supportOut,id.xy,id.z,vec4f(wave.weight,wave.progress*wave.weight,smoothstep(0.72,0.9,wave.progress)*wave.weight,oceanFoamConcentration(p,cell*0.5,strength)));
}` }));s.cache=this.caches[0];
  this.flows=[false,true].map(fine=>new ComputeKernel({label:`Ocean ${fine?'fine':'coarse'} choppy relaxation flow`,modules:[surface.displacementModule],bindings:{origins:read(fine?this.fineOrigins:s.origins),history:sample(()=>fine?this.fineStates[s.front]:s.states[s.front]),flowOut:output(fine?this.fineFlow:this.flow)},workgroupSize:[8,8,1],code:`
${prefix}
fn oceanPageWaterDepth(p:vec2f)->f32 {let sup=oceanPageSupport(p);let d=oceanPageProfile(p);return max(0.0,frame.seaLevel+select(0.0,d.y/max(1e-6,sup.x),sup.x>1e-6)-oceanBed(p));}
${FOAM_TRANSPORT_WGSL}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=${fine?'pageP.fineCapacity':'pageP.pages'}){return;}let origin=origins[id.z];let cells=${fine?'origin.z':'pageP.pageGrid.w'};if(cells<1.0||any(id.xy>=vec2u(u32(cells)+u32(2.0*pageP.halo)))){return;}
 let cell=pageP.pageGrid.z/cells;let p=origin.xy+(vec2f(id.xy)+0.5-pageP.halo)*cell;let support=oceanPageSupport(p);let column=oceanPageWaterDepth(p);
 if(support.x<1e-5||column<0.001){textureStore(flowOut,id.xy,id.z,vec4f(0));return;}
 let field=oceanFieldAt(p,0);let dir=field.yz/max(1e-5,length(field.yz));let speed=oceanShoreSpeedAt(p);let returnMix=oceanReturnMix(column,speed);
 let old=textureLoad(history,vec2i(id.xy),i32(id.z),0);var axis=vec3f(dir,0);var chop=vec2f(0);
 if(max(old.x,support.z)>0.001){let t=oceanCompositeTangents(p,cell);axis=oceanCompressionAxis(t[0],t[1]);chop=oceanChoppyRelaxation(oceanCompositeDisplacement(p,cell).xz,axis.xy,axis.z);}
 let h=1.0;let bedGrad=vec2f(oceanBed(p+vec2f(h,0))-oceanBed(p-vec2f(h,0)),oceanBed(p+vec2f(0,h))-oceanBed(p-vec2f(0,h)))/(2.0*h);
 var wash=dir*speed;if(length(bedGrad)>0.015){wash=mix(wash,-normalize(bedGrad)*abs(speed),returnMix);}
 let anchor=p-shoreP.domain.xy-shoreP.domain.zw*0.5;let g=0.7*oceanPerlinGradient(anchor*.34+vec2f(.035,-.025)*shoreP.time)+.3*oceanPerlinGradient(anchor*.71+vec2f(31.7,19.3)+vec2f(-.021,.032)*shoreP.time);
 let eddy=vec2f(g.y,-g.x)*(.45/max(1.0,length(g)));let foamActive=smoothstep(.005,.06,max(old.x,support.z));let strength=max(oceanWarpStrength(column,speed),returnMix*.9);
 let e=max(.25,oceanPageCell(p));let ex=vec2f(e,0);let ez=vec2f(0,e);
 // Keep the existing FBM DOMAIN-WARP potential gather, now added to the
 // physical choppy relaxation instead of replacing either contribution.
 let grad=vec2f(oceanPageSupport(p+ex).a-oceanPageSupport(p-ex).a,oceanPageSupport(p+ez).a-oceanPageSupport(p-ez).a)/(2.0*e);
 let gather=grad*(.95/max(.35,length(grad)));
 var velocity=wash+(chop+(eddy+gather)*strength)*foamActive;velocity*=7.0/max(7.0,length(velocity));textureStore(flowOut,id.xy,id.z,vec4f(velocity,axis.xy*axis.z));
}` }));
  const advance=fine=>[0,1].map(front=>{
   const oldModule=new ShaderModule({name:`oceanPagesOld${fine?'Fine':'Coarse'}${front}`,deps:[...s.pageModule.deps,surface.filmModule],bindings:{...s.pageModule.bindings,shoreState:sample(s.states[front]),fineState:sample(this.fineStates[front])},code:s.pageModule.code.replace('return oceanPageHybridLoad(shoreState,fineState,p);',fine?'return oceanPageHybridLoad(shoreState,fineState,p);':'return oceanPageLoad(shoreState,p);')});
   return new ComputeKernel({label:`Ocean ${fine?'fine':'coarse'} advect/stretch/diffuse ${front}`,modules:[oldModule],bindings:{origins:read(fine?this.fineOrigins:s.origins),stateOut:output(fine?this.fineStates[1-front]:s.states[1-front])},workgroupSize:[8,8,1],code:`
${FOAM_TRANSPORT_WGSL}
${FOAM_ADVANCE_WGSL}
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=${fine?'pageP.fineCapacity':'pageP.pages'}){return;}let origin=origins[id.z];let cells=${fine?'origin.z':'pageP.pageGrid.w'};if(cells<1.0||any(id.xy>=vec2u(u32(cells)+u32(2.0*pageP.halo)))){return;}
 let cell=pageP.pageGrid.z/cells;let p=origin.xy+(vec2f(id.xy)+0.5-pageP.halo)*cell;if(!oceanBedKnown(p)){textureStore(stateOut,id.xy,id.z,vec4f(0));return;}textureStore(stateOut,id.xy,id.z,oceanAdvanceFoam(p,cell));
}`});
  });s.advance=advance(false);this.fineAdvance=advance(true);
  this.restrict=new ComputeKernel({label:'Foam retiring fine history area restriction',bindings:{pageP:{uniform:s.pageParams},oldOrigins:read(this.oldOrigins),fineHistory:sample(()=>this.fineStates[s.front]),a:output(s.states[0]),b:output(s.states[1])},workgroupSize:[8,8,1],code:`
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=pageP.fineCapacity||any(id.xy>=vec2u(${side}u))){return;}let origin=oldOrigins[id.z];if(origin.z<1.0){return;}let ratio=u32(origin.z/pageP.pageGrid.w);var value=vec4f(0);var wet=0.0;
 // Only interior mass is authoritative; halo readback comes from neighboring
 // coarse pages after restriction, avoiding duplicate edge ownership.
 if(any(id.xy<vec2u(u32(pageP.halo)))||any(id.xy>=vec2u(u32(pageP.halo+pageP.pageGrid.w)))){return;}
 let base=(vec2i(id.xy)-vec2i(i32(pageP.halo)))*i32(ratio)+vec2i(i32(pageP.halo));
 for(var z=0u;z<ratio;z++){for(var x=0u;x<ratio;x++){let v=textureLoad(fineHistory,base+vec2i(i32(x),i32(z)),i32(id.z),0);value+=v;wet=max(wet,v.y);}}
 value/=f32(ratio*ratio);value.y=wet;textureStore(a,id.xy,u32(origin.w)-1u,value);textureStore(b,id.xy,u32(origin.w)-1u,value);
}`});
  this.prolong=new ComputeKernel({label:'Foam new or resized fine history prolongation',modules:[surface.cacheModule],bindings:{coarseHistory:sample(()=>s.states[s.front]),a:output(this.fineStates[0]),b:output(this.fineStates[1])},workgroupSize:[8,8,1],code:`
@compute @workgroup_size(WG_X,WG_Y,WG_Z) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.z>=pageP.fineCapacity){return;}let origin=fineOrigins[id.z];if(origin.z<1.0||(u32(origin.w)&1u)==0u||any(id.xy>=vec2u(u32(origin.z)+u32(2.0*pageP.halo)))){return;}
 let p=origin.xy+(vec2f(id.xy)+0.5-pageP.halo)*(pageP.pageGrid.z/origin.z);let value=oceanPageLoad(coarseHistory,p);textureStore(a,id.xy,id.z,value);textureStore(b,id.xy,id.z,value);
}`});
  this.kernels=[...this.caches,...this.flows,...s.advance,...this.fineAdvance,this.restrict,this.prolong];
 }
 remap(camera,height){
  if(!this.pool||!camera)return false;const forward=camera.getWorldDirection(camera.position.clone());
  const change=this.pool.update({position:camera.position.toArray(),forward:forward.toArray(),fov:camera.fov,height:height??900,seaLevel:this.s.config.sealevel});if(!change)return false;
                                                                                
  if(GPU.encoder)GPU.submit();this.oldOrigins.write(change.oldOrigins);
  this.restrict.dispatch([Math.ceil((this.s.layout.cells+2*this.s.layout.halo)/8),Math.ceil((this.s.layout.cells+2*this.s.layout.halo)/8),this.capacity]);GPU.submit();
  this.fineOrigins.write(change.origins);this.fineIndex.upload(change.index);
  this.prolong.dispatch([Math.ceil(this.fineSide/8),Math.ceil(this.fineSide/8),this.capacity]);return true;
 }
 update(dt,time,camera,height){
  const s=this.s;s.params.set('time',time);s.params.set('dt',dt);const remapped=this.remap(camera,height);if(!s.layout.tiles.length)return;
  const coarse=[Math.ceil((s.layout.cells+2*s.layout.halo)/8),Math.ceil((s.layout.cells+2*s.layout.halo)/8),s.layout.tiles.length],fine=[Math.ceil(this.fineSide/8),Math.ceil(this.fineSide/8),this.capacity];
  this.caches[0].dispatch(coarse);if(this.pool)this.caches[1].dispatch(fine);
  this.flows[0].dispatch(coarse);if(this.pool)this.flows[1].dispatch(fine);
  s.advance[s.front].dispatch(coarse);if(this.pool)this.fineAdvance[s.front].dispatch(fine);s.front=1-s.front;s.steps++;
  this.lastTime=time;return remapped;
 }
 metadata(){return this.pool?{...this.pool.metadata(),raw_pool_bytes:this.capacity*this.fineSide**2*72,water_surface:'analytic breaker + bounded FFT-driven periodic thin film; no water-volume solver',shore_film:{fft_bands:[2,3],chart_period_s:8,max_depth_m:.025,front_ripple_m:.04,foam_extra_decay_s:2.5,whitewater:{front_birth_gain:2.6,max_source_s:6,drivers:['film speed','short FFT horizontal velocity','short FFT Jacobian compression','flow curl','filtered advected FBM']},water_state_transport:false},transport:'analytic swash velocity + choppy relaxation; RK2 foam advection',foam_source:'local moving breaking/compression source, seeded trailing wake and wet-film speed/FFT/curl/noise births',diffusion_m2_s:{along:[.012,.037],across:[.002,.006]},backwash_full_white_fill:false}:null;}
 dispose(){for(const resource of [this.fineIndex,this.fineOrigins,this.oldOrigins,this.fineProfile,this.fineSupport,...this.fineStates,this.flow,this.fineFlow])resource.destroy();}
}
