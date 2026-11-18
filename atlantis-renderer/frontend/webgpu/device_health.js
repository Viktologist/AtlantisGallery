export class WebGPUUnavailableError extends Error {
 constructor(stage,detail,cause){
  super(`WebGPU device unavailable (${stage}). Reload the page to restart the 3D viewer. Details: ${detail}`,{cause});
  this.name='WebGPUUnavailableError';this.code='WEBGPU_UNAVAILABLE';this.stage=stage;
 }
}

export function isGPUUnavailable(error){
                                                                                              
                                                                                            
                                                                                         
 return error?.code==='WEBGPU_UNAVAILABLE'||/valid external Instance reference no longer exists|instance[\s_-]*dropped|device (?:was |is |has been )?lost|device (?:was |is |has been )?destroyed/i.test(error?.message??String(error));
}

                                                                          
                                                                               
export function watchDevice(device,currentDevice,onUnavailable){
 let failure=null,disposed=false;
 const fail=(stage,detail,cause)=>{
  if(!failure){
   failure=new WebGPUUnavailableError(stage,detail,cause);
   if(!disposed){
                                                                                              
                                                             
    try{onUnavailable(failure);}catch(callbackError){console.error('WebGPU failure callback failed:',callbackError);}
   }
  }
  return failure;
 };
 device.lost.then(info=>{if(!disposed)fail('Device lost',`${info.reason??'unknown'}: ${info.message??''}`);});
 const check=()=>{
  if(disposed)throw Error('Viewer has been disposed');
  if(currentDevice()!==device)throw fail('Device replaced','Viewer resources belong to a different GPU device');
  if(failure)throw failure;
 };
 return {
  check,
  async wait(operation,stage){
   check();
   try{const value=await operation();check();return value;}
   catch(error){if(failure)throw failure;if(isGPUUnavailable(error))throw fail(stage,error.message,error);throw error;}
  },
  get failure(){return failure;},
  dispose(){disposed=true;}
 };
}
