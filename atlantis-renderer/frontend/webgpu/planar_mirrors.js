import {PerspectiveCamera,Matrix4,Vector3} from '../../vendor/tidewater/src/engine/index.js';
import {GPU,RenderTarget,ShaderModule,UniformBlock,FullscreenPass,readTexture} from '../../vendor/tidewater/src/engine/webgpu.js';
import {createViewUniforms,setFrameCamera} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {LAYERS} from '../../vendor/tidewater/src/engine/render/SceneRenderer.js';
import {mirrorPlaneGeometry,mirrorSurface,reflectionMatrix,obliqueMirrorProjection} from './planar_mirror_math.js';
import {boxIntersectsClip} from './point_light_math.js';
import {meshWorldBounds} from './scene_bounds.js';
import {activeVegetationSystems} from './vegetation_visibility.js';
import {mirrorOptions} from './planar_mirror_contract.js';

export const PLANAR_MIRROR_REVISION='nearest-planar-mirror-repair-r10';
const visible=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
const release=fn=>{if(GPU.encoder)GPU.onSubmit(null,fn);else fn();};

export class PlanarMirrors {
 constructor(viewer,{resolutionScale=.5,maxSize=1024}={}){
  if(!(resolutionScale>0&&resolutionScale<=1)||!Number.isInteger(maxSize)||maxSize<16)throw RangeError('Invalid planar mirror resolution');
  this.viewer=viewer;this.scale=resolutionScale;this.maxSize=maxSize;this.records=new Map();this.sourceRevision=-1;
  this.camera=new PerspectiveCamera();this.camera.matrixAutoUpdate=false;this.camera.matrixWorldAutoUpdate=false;this.block=createViewUniforms('nearest mirror reflection view');
  this.stats={captures:0,draws:0,selection_changes:0};this.active=null;this.capturing=false;
  this.clipParams=new UniformBlock('APSReflectionPlane',{equation:['vec4f',[0,0,1,0]],bias:['f32',.002],debug:['i32',0],rayInverse:['mat4x4f',new Matrix4()]});
  this.clipModule=new ShaderModule({name:'aps-reflection-plane-clip',uniforms:this.clipParams,uniformName:'apsReflectionPlane',code:''});this.clipMaterials=new Map();
 }
 clippedMaterial(original){const prior=this.clipMaterials.get(original);if(prior?.version===original.version)return prior.material;
  if(prior)release(()=>{prior.material.dispose();prior.material.uniformBlock.buffer?.destroy();});
  const material=original.clone();material.modules=[...original.modules,this.clipModule];material.surface='if(dot(vec4f(in.P,1.0),apsReflectionPlane.equation)<apsReflectionPlane.bias){discard;}\n'+original.surface;
  material.output=`if(apsReflectionPlane.debug==1){r.color=vec4f(s.albedo,1);}else if(apsReflectionPlane.debug==2){r.color=vec4f(s.normal*.5+.5,1);}else if(apsReflectionPlane.debug==3){r.color=vec4f(vec3f(dot(s.normal,in.V)*.5+.5),1);}else if(apsReflectionPlane.debug==4){r.color=vec4f(normalize(in.vs.normal)*.5+.5,1);}else if(apsReflectionPlane.debug==5){r.color=vec4f(in.P,1);}else if(apsReflectionPlane.debug==6){r.color=vec4f(vec3f(select(0.0,1.0,in.front)),1);}else{${original.output}}`;
  material.name=original.name+' reflection clip';material.needsUpdate=true;delete material.__pk;delete material.__pkFrame;this.clipMaterials.set(original,{version:original.version,material});return material;
 }
 register(object,options={}){
  options=mirrorOptions(options);if(options===false)throw Error('Cannot register a disabled planar mirror');
  if(!object?.isMesh||Array.isArray(object.material))throw Error('Mirror must be one planar Mesh primitive');
  if(object.layers.mask&(1<<LAYERS.WATER))throw Error('Water surfaces do not use the planar mirror camera');
  const geometryKey=JSON.stringify([object.geometry.id,object.geometry.attributes.position.uuid,object.geometry.attributes.position.version,object.geometry.index?.uuid,object.geometry.index?.version,options]);
  const old=this.records.get(object);if(old?.geometryKey===geometryKey&&object.material===old.material)return old;if(old)this.unregister(object);
  const local=mirrorPlaneGeometry(object.geometry,options),original=object.material;
  const params=new UniformBlock('APSPlanarMirrorSurface',{viewProjection:['mat4x4f',new Matrix4()],selected:['i32',-1],tint:['vec3f',options.tint??[1,1,1]]});
  const module=new ShaderModule({name:'aps-planar-mirror-surface',uniforms:params,uniformName:'apsMirror',bindings:{apsMirrorColor:{texture:()=>this.target.texture}},code:`
fn apsPlanarMirrorSample(P:vec3f)->vec3f{
 let h=apsMirror.viewProjection*vec4f(P,1.0);let uv=h.xy/h.w*vec2f(.5,-.5)+.5;
 return textureSampleLevel(apsMirrorColor,smpLinearClamp,clamp(uv,vec2f(0),vec2f(1)),0.0).rgb*apsMirror.tint;
}`});
  this.ensureTarget();const material=original.clone();material.side='double';material.name=original.name+' planar mirror';material.modules=[...material.modules,module];material.varyings={...material.varyings,apsMirrorInstance:'u32'};material.vertex+='\no.apsMirrorInstance=v.instance;';
  material.output=`if(apsMirror.selected>=0 && in.vs.apsMirrorInstance==u32(apsMirror.selected)){r.color=vec4f(apsPlanarMirrorSample(in.P),s.alpha);}else{${original.output}}`;
  material.needsUpdate=true;
  const record={object,options,geometryKey,local,original,material,params};this.records.set(object,record);object.material=material;return record;
 }
 unregister(object){const record=this.records.get(object);if(!record)return false;if(object.material===record.material)object.material=record.original;this.records.delete(object);if(this.active?.object_id===object.id)this.active=null;release(()=>{record.material.dispose();record.material.uniformBlock.buffer?.destroy();record.params.buffer?.destroy();});return true;}
 mark(object,options={}){object.userData.aps_planar_mirror=options;this.register(object,options);this.viewer.invalidateScene();return object;}
 unmark(object){object.userData.aps_planar_mirror=false;this.unregister(object);this.viewer.invalidateScene();}
 sync(){
  const v=this.viewer;if(this.sourceRevision===(v.shadowRevision??0))return;const found=new Set();
  v.scene.traverse(object=>{const spec=object.userData?.aps_planar_mirror;if(!object.isMesh||!spec)return;found.add(object);this.register(object,typeof spec==='object'?spec:{});});
  for(const object of this.records.keys())if(!found.has(object))this.unregister(object);this.sourceRevision=v.shadowRevision??0;
 }
 ensureTarget(){
  const v=this.viewer,scale=Math.min(this.scale,this.maxSize/v.canvas.width,this.maxSize/v.canvas.height),w=Math.max(16,Math.ceil(v.canvas.width*scale)),h=Math.max(16,Math.ceil(v.canvas.height*scale));
  if(this.target&&this.target.width===w&&this.target.height===h)return;
  const old=this.target;this.target=new RenderTarget(w,h,{colors:['rgba16float'],depth:'depth32float',label:'nearest planar mirror HDR'});if(old)release(()=>{old.texture.destroy();old.depthTexture.destroy();});
 }
 choose(){
  const v=this.viewer,camera=v.camera;camera.updateMatrixWorld();const vp=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);let best=null;
  for(const record of this.records.values()){
   const o=record.object;record.params.set('selected',-1);if(!visible(o))continue;o.updateWorldMatrix(true,false);
   const count=o.isInstancedMesh?o.count:1;
   for(let i=0;i<count;i++){
    const matrix=o.matrixWorld.clone();if(o.isInstancedMesh){const instance=new Matrix4();o.getMatrixAt(i,instance);matrix.multiply(instance);}
    const surface=mirrorSurface(record.local,matrix,camera.position),distance=surface.plane.normal.dot(camera.position)+surface.plane.constant;
    if(Math.abs(distance)<=.005||!boxIntersectsClip(surface.box,vp))continue;
    if(distance<0){surface.plane.normal.negate();surface.plane.constant=-surface.plane.constant;}
    if(!best||surface.distanceSq<best.distanceSq)best={record,instance:i,...surface};
   }
  }
  return best;
 }
 render(){
  if(this.capturing||!this.records.size)return;
  const v=this.viewer,r=v.meshRenderer,selected=this.choose(),prior=this.active;
  this.active=selected?{object:selected.record.object.name,object_id:selected.record.object.id,instance:selected.instance,distance:Math.sqrt(selected.distanceSq)}:null;
  if(prior?.object_id!==this.active?.object_id||prior?.instance!==this.active?.instance)this.stats.selection_changes++;
  if(!selected)return;this.ensureTarget();
  const {record,plane}=selected,camera=this.camera;this.selectedPlane={normal:plane.normal.toArray(),constant:plane.constant,point:record.local.point.clone().applyMatrix4(record.object.matrixWorld).toArray()};camera.fov=v.camera.fov;camera.aspect=v.camera.aspect;camera.near=v.camera.near;camera.far=v.camera.far;camera.reversedDepth=true;
  this.clipParams.set('equation',[...plane.normal.toArray(),plane.constant]);this.clipParams.set('bias',record.options.clipBias??.002);
  camera.matrixWorld.multiplyMatrices(reflectionMatrix(plane),v.camera.matrixWorld);camera.matrix.copy(camera.matrixWorld);camera.matrixWorldInverse.copy(camera.matrixWorld).invert();camera.position.setFromMatrixPosition(camera.matrixWorld);
                                                                           
                                                                             
  this.clipParams.set('rayInverse',new Matrix4().multiplyMatrices(v.camera.projectionMatrix,camera.matrixWorldInverse).invert());
  camera.projectionMatrix.copy(obliqueMirrorProjection(v.camera.projectionMatrix,camera.matrixWorld,plane,record.options.clipBias??.002));camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  const vp=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);record.params.set('viewProjection',vp);record.params.set('selected',selected.instance);
  setFrameCamera(camera,this.target.width,this.target.height,{block:this.block});
  const systems=activeVegetationSystems(r.vegetationSystems),contexts=systems.flatMap(s=>s.models.map(m=>({model:m,active:m.active,indirect:m.draws.map(d=>d.geometry.indirect)})));
  const sync=r.syncPipelines;this.capturing=true;let terrainView;
  try{
   r.syncPipelines=true;terrainView=v.heightfield?.beginPlanarReflection?.(camera);
   const filter=o=>!this.records.has(o)&&!o.userData?.apsShadowOnly&&!o.userData?.apsDiagnosticOverlay&&o!==v.heightfield?.mesh&&(o.userData?.apsVegetationManaged||boxIntersectsClip(meshWorldBounds(o),vp));
   const pass={label:'nearest planar mirror',kind:'color',camera,frameBlock:this.block,apsPlanarReflection:true,cull:false,flipWinding:true,colorViews:[this.target.texture.view()],colorFormats:['rgba16float'],depthView:this.target.depthTexture.view(),depthTexture:this.target.depthTexture,depthFormat:'depth32float',clearDepth:0,clearColors:[[0,0,0,1]],depthCompare:'greater-equal',layerMask:(1<<LAYERS.OPAQUE)|(1<<LAYERS.TRANSPARENT)|(1<<LAYERS.REFLECT_ONLY),filter,vegetationClip:[...plane.normal.toArray(),plane.constant-(record.options.clipBias??.002)]};
   for(const system of systems){const view=system.view(pass,false);system.select(view,pass,0,false);}
   const items=r.collect(v.scene,pass);if(terrainView)items.opaque.push({object:terrainView.mesh,geometry:terrainView.mesh.geometry,material:terrainView.mesh.material,start:0,count:Infinity});
   for(const item of [...items.opaque,...items.transparent]){item.material=this.clippedMaterial(item.material);item.pipeKey=item.material.id;}
   const skyModule=v.lighting.external?.sky.module??v.lighting.sky.module;
   if(this.skyModule!==skyModule){this.skyModule=skyModule;this.sky=new FullscreenPass({label:'planar mirror sky',modules:[skyModule,this.clipModule],colorFormats:['rgba16float'],depthFormat:'depth32float',depthCompare:'equal',depth:0,code:'fn fragment(in:FSIn)->vec4f{let q=apsReflectionPlane.rayInverse*ndcFromUv(in.uv,.5);let dir=normalize(q.xyz/q.w-frame.cameraPos);return vec4f(skyViewRadiance(dir),1.0);}'});}
   r.render(v.scene,{...pass,items,betweenLists:rp=>this.sky.draw(rp,this.block)});
   if(!r.precompiling){this.stats.captures++;this.stats.draws=items.opaque.length+items.transparent.length;}
  }finally{
   terrainView?.restore();for(const {model,active,indirect}of contexts){model.active=active;model.draws.forEach((d,i)=>{d.geometry.indirect=indirect[i];});}r.syncPipelines=sync;this.capturing=false;
  }
 }
 async inspectShading(){const v=this.viewer,enabled=v.navigation.enabled;v.navigation.cancelWheel();v.navigation.drag=null;v.navigation.enabled=false;
  const decode=h=>{const e=(h>>10)&31,m=h&1023;return (h&32768?-1:1)*(e?Math.pow(2,e-15)*(1+m/1024):m*Math.pow(2,-24));};const samples=[];
  try{for(let mode=0;mode<7;mode++){this.clipParams.set('debug',mode);v.renderFrame(0);if(!this.active)throw Error('Face a mirror before inspecting it');
    const r=[...this.records.values()].find(r=>r.object.id===this.active.object_id),points=r.local.triangles.flat(),center=points.reduce((p,v)=>p.add(v),new Vector3()).multiplyScalar(1/points.length).applyMatrix4(r.object.matrixWorld),q=center.applyMatrix4(r.params.get('viewProjection'));
    const result=await readTexture(this.target.texture),raw=new Uint16Array(result.data),offset=(Math.floor((q.x*.5+.5)*result.width)+Math.floor((.5-q.y*.5)*result.height)*result.width)*4;
    samples.push({mode,rgb:[decode(raw[offset]),decode(raw[offset+1]),decode(raw[offset+2])]});
   }this.lastShadingAudit=samples;return samples;
  }finally{this.clipParams.set('debug',0);v.renderFrame(0);v.navigation.enabled=enabled;}
 }
 async inspect(){if(!this.target)throw Error('No mirror reflection target');await GPU.queue.onSubmittedWorkDone();const result=await readTexture(this.target.texture),raw=new Uint16Array(result.data),depth=new Float32Array((await readTexture(this.target.depthTexture)).data);
  const half=h=>{const sign=h&32768?-1:1,e=(h>>10)&31,m=h&1023;return sign*(e?Math.pow(2,e-15)*(1+m/1024):m*Math.pow(2,-24));};
  let lit=0,maximum=0,total=0,skyPixels=0,skyLit=0,skyMax=0;for(let i=0;i<raw.length;i+=4){const l=Math.max(half(raw[i]),half(raw[i+1]),half(raw[i+2]));if(l>.01)lit++;maximum=Math.max(maximum,l);total+=l;if(depth[i/4]===0){skyPixels++;if(l>.01)skyLit++;skyMax=Math.max(skyMax,l);}}
  const grid=Array.from({length:8},(_,y)=>Array.from({length:8},(_,x)=>{const pixel=Math.floor((x+.5)*result.width/8)+Math.floor((y+.5)*result.height/8)*result.width;return {depth:depth[pixel],rgb:[0,1,2].map(k=>half(raw[pixel*4+k]))};}));
  return {...this.metadata(),sky_texture:{pixels:skyPixels,lit_pixels:skyLit,max:skyMax},grid,shading:this.lastShadingAudit,reflected_eye:this.camera.position.toArray(),plane:this.selectedPlane,selected_materials:[...this.records.values()].map(r=>{
   const points=r.local.triangles.flat(),center=points.reduce((p,v)=>p.add(v),new Vector3()).multiplyScalar(1/points.length).applyMatrix4(r.object.matrixWorld);
   const q=center.clone().applyMatrix4(r.params.get('viewProjection')),uv=[q.x*.5+.5,.5-q.y*.5],pixel=[Math.floor(uv[0]*result.width),Math.floor(uv[1]*result.height)],offset=(pixel[0]+pixel[1]*result.width)*4;
   return {object:r.object.id,selected:r.params.get('selected'),material:r.object.material.name,world:r.object.matrixWorld.toArray(),center:center.toArray(),uv,center_depth:depth[offset/4],center_rgb:[half(raw[offset]),half(raw[offset+1]),half(raw[offset+2])],output:r.object.material.output};
  }),texture:{pixels:raw.length/4,lit_pixels:lit,max:maximum,mean_max_channel:total/(raw.length/4)}};
 }
 metadata(){return {revision:PLANAR_MIRROR_REVISION,registered:this.records.size,active:this.active,target:this.target?[this.target.width,this.target.height]:null,stats:{...this.stats},water_reflection_camera:false,max_captures_per_frame:1,clipping:'reverse-Z WebGPU oblique near plane',recursion:false};}
 clear(){for(const o of [...this.records.keys()])this.unregister(o);for(const {material}of this.clipMaterials.values())release(()=>{material.dispose();material.uniformBlock.buffer?.destroy();});this.clipMaterials.clear();this.active=null;this.sourceRevision=-1;const target=this.target;this.target=null;if(target)release(()=>{target.texture.destroy();target.depthTexture.destroy();});}
 dispose(){this.clear();this.block.buffer?.destroy();this.clipParams.buffer?.destroy();for(const {material}of this.clipMaterials.values()){material.dispose();material.uniformBlock.buffer?.destroy();}this.clipMaterials.clear();}
}
