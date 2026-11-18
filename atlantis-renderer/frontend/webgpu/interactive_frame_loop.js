                                                                                 
                                                                                
export class InteractiveFrameLoop {
 constructor({render,flushInput=()=>{},queue,reportError,active=()=>true,
  requestFrame=cb=>requestAnimationFrame(cb),cancelFrame=id=>cancelAnimationFrame(id),maxInFlight=2}){
  if(!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>2)throw RangeError('Interactive frame limit must be 1 or 2');
  Object.assign(this,{render,flushInput,queue,reportError,active,requestFrame,cancelFrame,maxInFlight});
  this.inFlight=0;this.submitted=0;this.skipped=0;this.running=false;
  this.tick=now=>{
   if(!this.running)return;
   this.raf=this.requestFrame(this.tick);
   try{
    if(!this.active())return;
    this.flushInput();
    if(this.inFlight>=this.maxInFlight){this.skipped++;return;}
    this.render(now);this.submitted++;this.inFlight++;
    let completion;
    try{completion=this.queue.onSubmittedWorkDone();}catch(error){this.inFlight--;throw error;}
    Promise.resolve(completion).then(()=>{this.inFlight--;},error=>{this.inFlight--;this.fail(error);});
   }catch(error){this.fail(error);}
  };
 }
 start(){if(!this.running){this.running=true;this.raf=this.requestFrame(this.tick);}return this;}
 stop(){this.running=false;this.cancelFrame(this.raf);}
 fail(error){if(!this.running)return;this.stop();this.reportError(error);}
 metadata(){return {max_frames_in_flight:this.maxInFlight,frames_in_flight:this.inFlight,submitted:this.submitted,backpressure_skips:this.skipped,waits_inside_animation_callback:false};}
}
