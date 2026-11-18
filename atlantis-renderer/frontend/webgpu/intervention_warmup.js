                                                                                 
                                                                               
                                                                               
                                                                              
                                                                              
  
                                                                          
                                                                             
                                                                             
                                                                              
                                                                               
                                                                        
export const INTERVENTION_WARMUP_SCHEMA='aps-intervention-warmup/1';
export const INTERVENTION_STATES=Object.freeze(['before','after']);

export function validateInterventionState(state,label='intervention state'){
 if(!INTERVENTION_STATES.includes(state))throw Error(`${label} must be before or after`);
 return state;
}

function cancelled(viewer,signal){return !!viewer?.disposed||!!signal?.aborted;}

function cancelError(viewer,signal){
 const error=Error(viewer?.disposed?'Intervention warmup cancelled: viewer disposed':'Intervention warmup cancelled');
 error.name='AbortError';
 if(signal?.reason!==undefined)error.cause=signal.reason;
 return error;
}

function record(viewer,value){try{viewer.interventionWarmup=value;}catch{}}

                                                                            
                                                                          
                                                                             
const clone=value=>Array.isArray(value)?value.map(clone):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)])):value;
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?Math.abs(a-b)<=1e-6:a===b;
function sameVector(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>close(value,b[index]));}

                                                                           
                                                                            
                                                                         
function sameView(a,b){
 if(!a||!b)return false;
 for(const key of ['position','target'])if(!sameVector(a[key],b[key]))return false;
 for(const key of ['fov','near','far'])if(!close(a[key],b[key]))return false;
 return true;
}
function samePose(a,b){
 if(!sameView(a,b))return false;
 for(const key of ['minDistance','maxDistance'])if(!close(a[key],b[key]))return false;
 if(a.dimensions!==b.dimensions){
  if(!Array.isArray(a.dimensions)||!Array.isArray(b.dimensions)||!sameVector(a.dimensions,b.dimensions))return false;
 }
 if(a.grid||b.grid)return !!a.grid&&!!b.grid&&sameVector(a.grid.position,b.grid.position)&&sameVector(a.grid.scale,b.grid.scale);
 return true;
}

function namedView(value,index=0){
 const source=value?.pose??value?.view;
 if(!source||typeof source!=='object'||!Array.isArray(source.position??source.eye)||!Array.isArray(source.target))throw Error(`Warmup view ${index+1} requires an authored camera pose`);
 const name=typeof value?.name==='string'&&value.name?value.name:`view ${index+1}`;
 return {name,pose:{...source,position:source.position??source.eye}};
}

function snapshotView(viewer,intervention){
 const weather=viewer.lighting?.weather;
 return {
  pose:typeof viewer.savePose==='function'?clone(viewer.savePose()):null,
  state:intervention.metadata().state,
  time:viewer.time,
  paused:viewer.paused,
  ocean:viewer.ocean?{time:viewer.ocean.time,paused:viewer.ocean.paused}:null,
  weather:weather===undefined?null:clone(weather)
 };
}

function restoreView(viewer,intervention,snapshot){
 let error=null;
 try{
  if(snapshot.pose&&typeof viewer.setCamera==='function'&&
   (typeof viewer.savePose!=='function'||!samePose(viewer.savePose(),snapshot.pose)))viewer.setCamera(snapshot.pose);
  if(intervention.metadata().state!==snapshot.state)intervention.setState(snapshot.state);
  if(snapshot.weather!==null&&viewer.lighting&&typeof viewer.lighting.setWeather==='function'&&
   JSON.stringify(viewer.lighting.weather)!==JSON.stringify(snapshot.weather))viewer.lighting.setWeather(snapshot.weather);
  if(snapshot.time!==undefined)viewer.time=snapshot.time;
  if(snapshot.paused!==undefined)viewer.paused=snapshot.paused;
  if(snapshot.ocean&&viewer.ocean){
   viewer.ocean.paused=snapshot.ocean.paused;
   if(viewer.ocean.time!==snapshot.ocean.time){
    if(typeof viewer.ocean.setReplayTime==='function')viewer.ocean.setReplayTime(snapshot.ocean.time);
    else viewer.ocean.time=snapshot.ocean.time;
   }
  }
 }catch(failure){error=failure;}
 return error;
}

function restoration(viewer,intervention,snapshot){
 const pose=snapshot.pose&&typeof viewer.savePose==='function'?viewer.savePose():snapshot.pose;
 const camera=!snapshot.pose||samePose(pose,snapshot.pose);
 const state=intervention.metadata?.().state===snapshot.state;
 const environment=snapshot.weather===null||JSON.stringify(viewer.lighting?.weather)===JSON.stringify(snapshot.weather);
 const time=snapshot.time===undefined||viewer.time===snapshot.time;
 const paused=snapshot.paused===undefined||viewer.paused===snapshot.paused;
 const ocean=!snapshot.ocean||!!viewer.ocean&&viewer.ocean.time===snapshot.ocean.time&&viewer.ocean.paused===snapshot.ocean.paused;
 return {camera,state,environment,time,paused,ocean,ok:camera&&state&&environment&&time&&paused&&ocean};
}

                                                                                
                                                                                
                                                 
function grassWindow(viewer){
 const systems=viewer.meshRenderer?.vegetationSystems;
 if(!systems||typeof systems[Symbol.iterator]!=='function')return null;
 let count=0,radius=0,capacity=0;
 for(const system of systems){
  const population=system.population;if(!population)continue;count++;
  if(Number.isFinite(population.radius))radius=Math.max(radius,population.radius);
  if(Number.isFinite(population.capacity))capacity=Math.max(capacity,population.capacity);
 }
 return count?{systems:count,radius_m:radius,capacity}:null;
}

                                                                             
                                                                              
                                                                          
export async function warmupInterventionStates(viewer,intervention,{signal,initial=null,compile=null,onState=null,views=[],finalView=null}={}){
 if(!intervention)throw Error('Intervention warmup requires a terrain intervention');
 if(!viewer||typeof viewer.compile!=='function')throw Error('Intervention warmup requires Viewer.compile');
 if(typeof intervention.setState!=='function'||typeof intervention.metadata!=='function')throw Error('Intervention warmup requires the state coordinator');
 const requested=Array.isArray(views)?views.map(namedView):[];
 if(requested.length&&typeof viewer.setCamera!=='function')throw Error('Named-camera warmup requires Viewer.setCamera');
 const initialState=validateInterventionState(initial??intervention.manifest?.initial_state??'before','initial intervention state');
 const order=initialState==='before'?['after','before']:['before','after'];
                                                                           
                                                                         
 const snapshot=requested.length?snapshotView(viewer,intervention):
  {pose:null,state:intervention.metadata().state,time:undefined,paused:undefined,ocean:null,weather:null};
                                                                          
                                                                       
 snapshot.state=initialState;
 const final=requested.length?namedView(finalView??{name:'selected',pose:snapshot.pose},requested.length+1):null;
 if(requested.length&&!final.pose)throw Error('Named-camera warmup requires an authored final camera pose');
 const finalName=requested.find(view=>sameView(view.pose,final.pose))?.name??final?.name;
 const unique=[];
 for(const view of requested)if(!sameView(view.pose,final?.pose)&&!unique.some(seen=>sameView(seen.pose,view.pose)))unique.push(view);
 const viewPlan=requested.length?[...unique,{name:finalName,pose:final.pose}]:null;
 const viewRecords=viewPlan?.map(view=>({name:view.name,states:[],pipeline_handles:{}}))??null;
 const compiled=[],pipelineHandles={},startHandles=Array.isArray(viewer.pipelineHandles)?viewer.pipelineHandles.length:null;
 let recovered=false,restoreError=null,attemptedState=null,attemptedView=null;

 const compileState=async(state,index=null)=>{
  attemptedState=state;attemptedView=index===null?null:viewRecords[index].name;
  if(cancelled(viewer,signal))throw cancelError(viewer,signal);
  if(intervention.metadata().state!==state)intervention.setState(state);
  onState?.(state,attemptedView);
  const before=Array.isArray(viewer.pipelineHandles)?viewer.pipelineHandles.length:null;
  await (compile?compile(state):viewer.compile());
  if(before!==null){
   const delta=viewer.pipelineHandles.length-before;
   pipelineHandles[state]=(pipelineHandles[state]??0)+delta;
   if(index!==null)viewRecords[index].pipeline_handles[state]=delta;
  }
  compiled.push(state);
  if(cancelled(viewer,signal))throw cancelError(viewer,signal);
 };

 try{
  if(viewPlan){
   for(const [index,view] of viewPlan.entries()){
    attemptedView=view.name;attemptedState=null;
    if(cancelled(viewer,signal))throw cancelError(viewer,signal);
    viewer.setCamera(view.pose);
    for(const state of order){
     await compileState(state,index);
     viewRecords[index].states.push(state);
    }
    viewRecords[index].grass_window=grassWindow(viewer);
   }
  }else for(const state of order)await compileState(state);
  if(cancelled(viewer,signal))throw cancelError(viewer,signal);
  if(intervention.metadata().state!==initialState)intervention.setState(initialState);
  if(cancelled(viewer,signal))throw cancelError(viewer,signal);
 }catch(failure){
  const aborted=failure?.name==='AbortError'||cancelled(viewer,signal);
  const failedDuringInitial=attemptedState===initialState;
  if(!viewer.disposed)restoreError=restoreView(viewer,intervention,snapshot);
  const finalInitialCompiled=viewPlan?!!viewRecords.at(-1)?.states.includes(initialState):compiled.includes(initialState);
                                                                          
                                                                           
                                   
  if(!aborted&&!viewer.disposed&&!failedDuringInitial&&!restoreError&&!finalInitialCompiled){
   try{onState?.(initialState);await (compile?compile(initialState):viewer.compile());compiled.push(initialState);recovered=true;}catch(error){restoreError=error;}
  }
  const state=restoration(viewer,intervention,snapshot);
  record(viewer,{schema:INTERVENTION_WARMUP_SCHEMA,initial_state:initialState,order:[...order],states_compiled:[...compiled],
   views:viewRecords??[],view_order:viewPlan?.map(view=>view.name)??[],restored_initial:state.state,camera_restored:state.camera,
   environment_restored:state.environment,time_restored:state.time,paused_restored:state.paused,wave_time_restored:state.ocean,
   recovered_initial:recovered,failed:true,failed_view:attemptedView,failed_state:attemptedState,
   error:String(failure?.message??failure),aborted});
  if(restoreError){
   const error=Error(`Intervention warmup failed and initial state restore failed: ${restoreError.message}`);
   error.name='InterventionWarmupError';error.cause=failure;error.restore_error=restoreError;throw error;
  }
  throw failure;
 }
 const restoreFailure=restoreView(viewer,intervention,snapshot);
 const state=restoration(viewer,intervention,snapshot);
 if(restoreFailure||!state.ok){
  const reason=restoreFailure?.message??`camera=${state.camera} state=${state.state} environment=${state.environment} time=${state.time} paused=${state.paused} wave=${state.ocean}`;
  record(viewer,{schema:INTERVENTION_WARMUP_SCHEMA,initial_state:initialState,order:[...order],states_compiled:[...compiled],
   views:viewRecords??[],view_order:viewPlan?.map(view=>view.name)??[],restored_initial:state.state,camera_restored:state.camera,
   environment_restored:state.environment,time_restored:state.time,paused_restored:state.paused,wave_time_restored:state.ocean,
   recovered_initial:recovered,failed:true,error:`Intervention warmup restore failed: ${reason}`});
  const error=Error(`Intervention warmup restore failed: ${reason}`);
  error.name='InterventionWarmupError';if(restoreFailure)error.restore_error=restoreFailure;throw error;
 }
 const finalState=intervention.metadata().state;
 if(finalState!==initialState)throw Error('Intervention warmup did not restore the initial state');
 const total=Array.isArray(viewer.pipelineHandles)?viewer.pipelineHandles.length-startHandles:null;
 const result={schema:INTERVENTION_WARMUP_SCHEMA,initial_state:initialState,order:[...order],states_compiled:[...compiled],
  views:viewRecords??[],view_order:viewPlan?.map(view=>view.name)??[],restored_initial:true,camera_restored:true,
  environment_restored:true,time_restored:true,paused_restored:true,wave_time_restored:true,
  recovered_initial:recovered,compiles:compiled.length,pipeline_handles:pipelineHandles,
  pipeline_handles_total:total,ready:true};
 record(viewer,result);
 return result;
}
