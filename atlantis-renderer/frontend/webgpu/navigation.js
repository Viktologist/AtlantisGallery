import {Vector3,Vector4,Quaternion,MathUtils} from '../../vendor/tidewater/src/engine/math/index.js';
import {EventDispatcher} from '../../vendor/tidewater/src/engine/core/EventDispatcher.js';
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {wheelPixels,wheelFraction,panMetresPerPixel} from '../src/pixel_navigation_math.js';
import {selectAtPixel} from './selection.js';

                                                                                
                                                    
export class PixelPicker {
  constructor(viewer){this.viewer=viewer;this.samples=0;this.disposed=false;}
  async init(){
    const d=GPU.device,code=`@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var<uniform> pixel:vec4u;
@group(0) @binding(2) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(1) fn main(){out[0]=textureLoad(depth,vec2i(pixel.xy),0);}`;
    const m=d.createShaderModule({label:'pixel depth pick',code});
    const pipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:m,entryPoint:'main'}});if(!this.disposed)this.pipeline=pipeline;
  }
  async pick(clientX,clientY){
    const v=this.viewer,snapshot=v.depthSnapshot,tex=v.sceneRenderer?.sceneRT.depthTexture;
    if(this.disposed||!this.pipeline||!snapshot||!tex)return null;
    const rect=v.canvas.getBoundingClientRect(),u=(clientX-rect.left)/rect.width,w=(clientY-rect.top)/rect.height;
    if(u<0||w<0||u>1||w>1)return null;
    const d=GPU.device,coord=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),out=d.createBuffer({size:4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=d.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    d.queue.writeBuffer(coord,0,new Uint32Array([Math.min(tex.width-1,Math.floor(u*tex.width)),Math.min(tex.height-1,Math.floor(w*tex.height)),0,0]));
    const enc=d.createCommandEncoder({label:'navigation pixel request'}),pass=enc.beginComputePass();
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,d.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:tex.view()},{binding:1,resource:{buffer:coord}},{binding:2,resource:{buffer:out}}]}));pass.dispatchWorkgroups(1);pass.end();enc.copyBufferToBuffer(out,0,read,0,4);d.queue.submit([enc.finish()]);
    try{
      await read.mapAsync(GPUMapMode.READ);const depth=new Float32Array(read.getMappedRange())[0];read.unmap();this.samples++;
      if(this.disposed||snapshot.revision!==v.cameraRevision)return null;
      if(depth>0&&Number.isFinite(depth)){
        const p=new Vector4(u*2-1,1-w*2,depth,1).applyMatrix4(snapshot.inverse);
        return {point:new Vector3(p.x/p.w,p.y/p.w,p.z/p.w),source:'webgpu_main_depth',frame:snapshot.frame};
      }
      const p=new Vector4(u*2-1,1-w*2,.5,1).applyMatrix4(snapshot.inverse),ray=new Vector3(p.x/p.w,p.y/p.w,p.z/p.w).sub(snapshot.eye).normalize();
      const forward=snapshot.forward,denom=ray.dot(forward),distance=snapshot.target.clone().sub(snapshot.eye).dot(forward);
      if(denom<=1e-8)return null;
      return {point:snapshot.eye.clone().addScaledVector(ray,Math.max(v.camera.near,distance)/denom),source:'focus_plane',frame:snapshot.frame};
    }finally{coord.destroy();out.destroy();read.destroy();}
  }
  dispose(){this.disposed=true;this.pipeline=null;}
}

export class PixelNavigation extends EventDispatcher {
  constructor(viewer){
    super();this.viewer=viewer;this.element=viewer.canvas;this.target=new Vector3();this.enabled=true;this.drag=null;this.last=null;this.touches=new Map();this.minDistance=0;this.maxDistance=Infinity;this.picker=new PixelPicker(viewer);this.wheelQueue=Promise.resolve();this.wheelPending=[];this.wheelRunning=false;this.wheelEpoch=0;this.pointerMoveEvents=0;this.pointerCameraUpdates=0;
    this.handlers={pointerdown:e=>this.down(e),pointermove:e=>this.move(e),pointerup:e=>this.up(e),pointercancel:e=>this.up(e),lostpointercapture:e=>this.up(e),wheel:e=>this.wheel(e),contextmenu:e=>e.preventDefault(),keydown:e=>this.key(e),dblclick:e=>{if(this.enabled)selectAtPixel(this.viewer,e.clientX,e.clientY).catch(error=>this.viewer.reportError(error));}};
    for(const [name,handler]of Object.entries(this.handlers))this.element.addEventListener(name,handler,{passive:false});
  }
  update(){this.viewer.camera.lookAt(this.target);this.viewer.camera.updateMatrixWorld();}
  changed(){this.viewer.cameraRevision++;this.update();this.dispatchEvent({type:'change'});}
  down(e){
    if(e.pointerType==='touch'){this.touchDown(e);return;}if(!this.enabled||this.drag||![0,2].includes(e.button))return;e.preventDefault();this.element.focus({preventScroll:true});
    this.cancelWheel();
    const pending={id:e.pointerId,button:e.button,x:e.clientX,y:e.clientY,latestX:e.clientX,latestY:e.clientY,pending:true};this.drag=pending;try{this.element.setPointerCapture(e.pointerId);}catch{}
    this.picker.pick(e.clientX,e.clientY).then(hit=>{
      if(this.drag!==pending)return;if(!hit){this.drag=null;return;}
      const c=this.viewer.camera,offset=hit.point.clone().sub(c.position);Object.assign(pending,{pivot:hit.point.clone(),distance:offset.length(),depth:Math.max(c.near,offset.dot(c.getWorldDirection(new Vector3()))),pending:false});
      this.last={action:pending.button===0?'rotate':'pan',source:hit.source,pivot:hit.point.toArray(),distance_m:pending.distance,picked_frame:hit.frame,camera_before:c.position.toArray(),target_before:this.target.toArray()};this.dispatchEvent({type:'start'});
                                                                              
                                                                     
    }).catch(error=>this.viewer.reportError(error));
  }
  move(e){if(e.pointerType==='touch'){this.touchMove(e);return;}const d=this.drag;if(!d||d.id!==e.pointerId)return;e.preventDefault();this.pointerMoveEvents++;d.latestX=e.clientX;d.latestY=e.clientY;if(!(e.buttons&(d.button===0?1:2)))this.up(e);}
  flushInput(){const d=this.drag;if(this.enabled&&d&&!d.pending)this.applyMove(d.latestX,d.latestY);}
  applyMove(x,y){
    const d=this.drag;if(!d||d.pending)return;const dx=x-d.x,dy=y-d.y;d.x=x;d.y=y;if(!dx&&!dy)return;
    this.pointerCameraUpdates++;const c=this.viewer.camera,h=Math.max(1,this.element.getBoundingClientRect().height);
    if(d.button===0){
      const up=c.up.clone().normalize(),yaw=new Quaternion().setFromAxisAngle(up,-dx*2*Math.PI/h),forward=c.getWorldDirection(new Vector3()).applyQuaternion(yaw),right=new Vector3().crossVectors(forward,up).normalize(),elev=Math.asin(MathUtils.clamp(forward.dot(up),-1,1)),limit=Math.PI/2-.01;
      const pitch=MathUtils.clamp(-dy*2*Math.PI/h,-limit-elev,limit-elev),q=new Quaternion().setFromAxisAngle(right,pitch).multiply(yaw);
      c.position.sub(d.pivot).applyQuaternion(q).add(d.pivot);this.target.sub(d.pivot).applyQuaternion(q).add(d.pivot);
    }else{
      const scale=panMetresPerPixel(d.depth,c.fov,h),right=new Vector3().setFromMatrixColumn(c.matrixWorld,0),up=new Vector3().setFromMatrixColumn(c.matrixWorld,1),delta=right.multiplyScalar(-dx*scale).addScaledVector(up,dy*scale);
      c.position.add(delta);this.target.add(delta);d.pivot.add(delta);this.last.pan_metres_per_css_pixel=scale;
    }
    this.changed();this.last.camera_after=c.position.toArray();this.last.target_after=this.target.toArray();
  }
  up(e){if(e.pointerType==='touch'){this.touchUp(e);return;}if(this.drag?.id!==e.pointerId)return;e.preventDefault();this.flushInput();this.drag=null;try{if(this.element.hasPointerCapture(e.pointerId))this.element.releasePointerCapture(e.pointerId);}catch{}this.dispatchEvent({type:'end'});}
  wheel(e){
    if(!this.enabled)return;e.preventDefault();if(this.drag||this.touches.size)return;const {clientX:x,clientY:y,deltaY,deltaMode}=e;
    if(!wheelPixels(deltaY,deltaMode,this.element.clientHeight))return;
    this.wheelPending.push({x,y,deltaY,deltaMode});
    if(this.wheelRunning)return;
    this.wheelRunning=true;this.wheelQueue=this.drainWheel().catch(error=>{this.cancelWheel();if(!this.viewer.disposed)this.viewer.reportError(error);});
  }
  cancelWheel(){this.wheelEpoch++;this.wheelPending.length=0;}
  async drainWheel(){
    try{
      while(this.wheelPending.length){
        if(!this.enabled||this.drag||this.touches.size||this.viewer.disposed){this.cancelWheel();return;}
        const request=this.wheelPending[0],epoch=this.wheelEpoch;
                                                                              
                                                                             
        if(this.viewer.depthSnapshot?.revision!==this.viewer.cameraRevision)this.viewer.renderFrame(0);
        const revision=this.viewer.cameraRevision,hit=await this.picker.pick(request.x,request.y);
        if(epoch!==this.wheelEpoch)continue;
        if(!this.enabled||this.drag||this.touches.size||this.viewer.disposed){this.cancelWheel();return;}
        if(!hit||revision!==this.viewer.cameraRevision){this.wheelPending.shift();continue;}
        while(this.wheelPending.length&&this.wheelPending[0].x===request.x&&this.wheelPending[0].y===request.y){
          if(epoch!==this.wheelEpoch||!this.enabled||this.drag||this.touches.size||this.viewer.disposed)break;
          const event=this.wheelPending.shift(),c=this.viewer.camera,offset=hit.point.clone().sub(c.position),distance=offset.length();
          const fraction=wheelFraction(wheelPixels(event.deltaY,event.deltaMode,this.element.clientHeight),distance,c.near),delta=offset.multiplyScalar(fraction);
          this.last={action:'wheel',source:hit.source,pivot:hit.point.toArray(),distance_m:distance,step_m:delta.length(),fraction,picked_frame:hit.frame,camera_before:c.position.toArray(),target_before:this.target.toArray()};
          this.dispatchEvent({type:'start'});c.position.add(delta);this.target.add(delta);this.changed();this.dispatchEvent({type:'end'});this.last.camera_after=c.position.toArray();this.last.target_after=this.target.toArray();
        }
      }
    }finally{this.wheelRunning=false;}
  }
  rotateTarget(dx,dy){const c=this.viewer.camera,pivot=this.target,up=c.up.clone().normalize(),h=Math.max(1,this.element.clientHeight),yaw=new Quaternion().setFromAxisAngle(up,-dx*2*Math.PI/h),offset=c.position.clone().sub(pivot).applyQuaternion(yaw),right=new Vector3().crossVectors(c.getWorldDirection(new Vector3()).applyQuaternion(yaw),up).normalize(),elev=Math.asin(MathUtils.clamp(offset.clone().normalize().dot(up),-1,1)),limit=Math.PI/2-1e-6,pitch=MathUtils.clamp(-dy*2*Math.PI/h,-limit+elev,limit+elev);offset.applyQuaternion(new Quaternion().setFromAxisAngle(right,pitch));c.position.copy(pivot).add(offset);this.changed();}
  panTarget(dx,dy){const c=this.viewer.camera,scale=panMetresPerPixel(c.position.distanceTo(this.target),c.fov,Math.max(1,this.element.clientHeight)),delta=new Vector3().setFromMatrixColumn(c.matrixWorld,0).multiplyScalar(-dx*scale).addScaledVector(new Vector3().setFromMatrixColumn(c.matrixWorld,1),dy*scale);c.position.add(delta);this.target.add(delta);this.changed();}
  touchState(){const t=[...this.touches.values()];return t.length>1?{x:(t[0].x+t[1].x)/2,y:(t[0].y+t[1].y)/2,d:Math.hypot(t[0].x-t[1].x,t[0].y-t[1].y)}:t[0];}
  touchDown(e){if(!this.enabled||this.touches.size>=2)return;e.preventDefault();this.element.focus({preventScroll:true});this.cancelWheel();this.drag=null;this.touches.set(e.pointerId,{x:e.clientX,y:e.clientY});try{this.element.setPointerCapture(e.pointerId);}catch{}this.touchPrevious=this.touchState();this.dispatchEvent({type:'start'});}
  touchMove(e){if(!this.enabled||!this.touches.has(e.pointerId))return;e.preventDefault();const before=this.touchPrevious;this.touches.set(e.pointerId,{x:e.clientX,y:e.clientY});const next=this.touchState();if(this.touches.size===1)this.rotateTarget(next.x-before.x,next.y-before.y);else{const c=this.viewer.camera,distance=c.position.distanceTo(this.target),newDistance=MathUtils.clamp(distance*Math.pow((before.d||1)/(next.d||1),1),this.minDistance,this.maxDistance);c.position.sub(this.target).multiplyScalar(newDistance/Math.max(distance,1e-12)).add(this.target);this.panTarget(next.x-before.x,next.y-before.y);}this.touchPrevious=next;this.last={action:this.touches.size===1?'touch_rotate':'touch_dolly_pan',pointers:this.touches.size};}
  touchUp(e){if(!this.touches.delete(e.pointerId))return;e.preventDefault();try{if(this.element.hasPointerCapture(e.pointerId))this.element.releasePointerCapture(e.pointerId);}catch{}this.touchPrevious=this.touchState();this.dispatchEvent({type:'end'});}
  key(e){if(!this.enabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();if(e.ctrlKey||e.metaKey||e.shiftKey){this.rotateTarget(e.key==='ArrowLeft'?1:e.key==='ArrowRight'?-1:0,e.key==='ArrowUp'?1:e.key==='ArrowDown'?-1:0);}else this.panTarget(e.key==='ArrowLeft'?7:e.key==='ArrowRight'?-7:0,e.key==='ArrowUp'?7:e.key==='ArrowDown'?-7:0);}
  metadata(){return {policy:'GPU pixel distance wheel; locked click pivot orbit; locked click depth pan',pointer_sampling:'latest position per animation frame; final delta flushed on release',pointer_move_events:this.pointerMoveEvents,pointer_camera_updates:this.pointerCameraUpdates,wheel:'same-pixel pending events share actual depth; each event uses current point distance',pending_wheel_events:this.wheelPending.length,gpu_depth_samples:this.picker.samples,dragging:!!this.drag,last:this.last};}
  dispose(){this.enabled=false;this.cancelWheel();this.drag=null;this.touches.clear();for(const[name,handler]of Object.entries(this.handlers))this.element.removeEventListener(name,handler);this.picker.dispose();}
}
