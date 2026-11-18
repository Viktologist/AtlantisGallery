                                                                               
                                                                               
import {ShaderModule,UniformBlock,LAYERS} from '../../vendor/tidewater/src/engine/webgpu.js';
import {SceneLighting,surfaceModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {OceanScreenSpaceReflection} from './ocean_optics.js';
import {unlinkWaterHook} from './water_hook_chain.js';

export function attachReflectingPool(viewer,asset,options) {
 const keys=['ior','roughness','surface_y','bottom_y','absorption','scatter'];
 if(!options||Object.keys(options).some(k=>!keys.includes(k))||!Number.isFinite(options.ior)||options.ior<1.01||options.ior>2||!Number.isFinite(options.roughness)||options.roughness<.01||options.roughness>.3||!Number.isFinite(options.surface_y)||!Number.isFinite(options.bottom_y)||options.bottom_y>=options.surface_y)throw Error('Invalid bounded water optics');
 for(const k of ['absorption','scatter'])if(!Array.isArray(options[k])||options[k].length!==3||options[k].some(x=>!Number.isFinite(x)||x<0))throw Error('Invalid bounded water medium');
 const reflection=new OceanScreenSpaceReflection(viewer,options.surface_y);
 let params,hook,system;const meshes=[];
 try {
 params=new UniformBlock('APSReflectingPool',{ior:['f32',options.ior],roughness:['f32',options.roughness],surface:['f32',options.surface_y],bottom:['f32',options.bottom_y],absorption:['vec3f',options.absorption],pad:['f32',0],scatter:['vec3f',options.scatter],pad2:['f32',0]});
 const spec=SceneLighting.hooks.envSpecular;
 const module=new ShaderModule({name:'apsBoundedDielectricWater',deps:[reflection.module,spec,surfaceModule],uniforms:params,uniformName:'poolP',bindings:{poolOpaque:{texture:()=>viewer.sceneRenderer.opaqueCopy.texture}},code:          `
fn poolFresnel(c:f32)->f32 {let eta=poolP.ior;let t=sqrt(max(0.0,1.0-(1.0-c*c)/(eta*eta)));let rs=(c-eta*t)/max(1e-6,c+eta*t);let rp=(eta*c-t)/max(1e-6,eta*c+t);return .5*(rs*rs+rp*rp);}
fn apsPoolShade(P:vec3f,V:vec3f,pixel:vec2f)->vec3f {
 var slope=vec2f(0);
 for(var k=0u;k<3u;k++){let angle=.7+f32(k)*1.93;let d=vec2f(cos(angle),sin(angle));let wavelength=select(select(.065,.13,k==1u),.24,k==0u);let amplitude=select(select(.00045,.0007,k==1u),.0012,k==0u);let wave=6.2831853/wavelength;let phase=dot(P.xz,d)*wave-frame.time*sqrt(9.81*wave);let footprint=abs(dpdx(phase))+abs(dpdy(phase));let bandWeight=1.0-smoothstep(1.0,3.14159,footprint);slope+=d*(amplitude*wave*cos(phase)*bandWeight);}
 let N=normalize(vec3f(-slope.x,1,-slope.y));let nv=max(.001,dot(N,V));let R=reflect(-V,N);let T=refract(-V,N,1.0/poolP.ior);
 let footprint=max(length(dpdx(P)),length(dpdy(P)));let F=poolFresnel(nv);
 let reflected=oceanReflectionWorldSample(P,R,poolP.roughness,footprint);
 let reflectionColor=mix(hookEnvSpecular(R,poolP.roughness),reflected.rgb,reflected.a);
 let refracted=oceanReflectionWorldSample(P,T,poolP.roughness,footprint);
 let size=vec2i(textureDimensions(poolOpaque));let original=textureLoad(poolOpaque,clamp(vec2i(pixel),vec2i(0),size-1),0).rgb;
 let opticalPath=max(.0,P.y-poolP.bottom)/max(.05,-T.y);
 let transmittance=exp(-poolP.absorption*opticalPath);
 let through=mix(original,refracted.rgb,refracted.a)*transmittance+poolP.scatter*(1.0-transmittance);
 let f0=pow((poolP.ior-1.0)/(poolP.ior+1.0),2.0);
 let sun=BRDF_GGX(frame.sunDir,V,N,vec3f(f0),1.0,poolP.roughness)*frame.sunColor*max(0.0,dot(N,frame.sunDir))*sunShadow(P,N,pixel);
 return reflectionColor*F+through*(1.0-F)+sun;
}`});
 asset.root.traverse(mesh=>{if(!mesh.isMesh)return;const original=mesh.material;
  const material=original.clone();
  meshes.push({mesh,original,material,layers:mesh.layers.mask,castShadow:mesh.castShadow});
  delete material.__pk;delete material.__pkFrame;delete material.setOceanReceiver;
  Object.assign(material,{name:'bounded water / IOR 1.333 / scene SSR',modules:[...original.modules,module],output:'r.color=vec4f(apsPoolShade(in.P,in.V,in.pixel),1.0);',lit:false,transparent:true,blending:'none',depthWrite:true,side:'front',receiveShadows:true});material.needsUpdate=true;
  mesh.material=material;mesh.layers.set(LAYERS.WATER);mesh.castShadow=false;
 });
 if(!meshes.length)throw Error('Bounded water requires a compiled mesh');
 viewer.meshRenderer?.prepareImportedRoot?.(asset.root,{cameras:viewer.camera?[viewer.camera]:[]});
 const previous=viewer.sceneRenderer.onBeforeWater;
 system={disposed:false,metadata(){return {surface:'compiled GLB',ior:options.ior,roughness:options.roughness,ripple_amplitudes_m:[.0012,.0007,.00045],ripple_wavelengths_m:[.24,.13,.065],reflection:reflection.metadata(),refraction:'Snell ray in current opaque depth; Beer attenuation to known planar basin bottom',limitations:['above-water camera only','off-screen or hidden geometry falls back to environment / undistorted receiver','ripples perturb normals only']};},dispose(){
  if(this.disposed)return;this.disposed=true;let failure;
  const cleanup=fn=>{try{fn();}catch(error){failure??=error;}};
  cleanup(()=>unlinkWaterHook(viewer.sceneRenderer,hook,hook.base));cleanup(()=>viewer.components.delete(system));
  for(const {mesh,original,material,layers,castShadow} of meshes){
   cleanup(()=>{mesh.material=original;mesh.layers.mask=layers;mesh.castShadow=castShadow;});
   cleanup(()=>material.dispose());cleanup(()=>material.uniformBlock?.buffer?.destroy());
  }
  cleanup(()=>reflection.dispose());cleanup(()=>params.buffer?.destroy());if(failure)throw failure;
 }};
 hook=()=>{hook.base?.();if(system.disposed)return;for(let root=asset.root;root;root=root.parent)if(!root.visible)return;reflection.render();};hook.base=previous;hook.apsPoolOwner=system;viewer.sceneRenderer.onBeforeWater=hook;viewer.components.add(system);return system;
 } catch(error) {
  if(hook)try{unlinkWaterHook(viewer.sceneRenderer,hook,hook.base);}catch(_){}
  if(system)try{viewer.components.delete(system);}catch(_){}
  for(const {mesh,original,material,layers,castShadow} of meshes){
   try{mesh.material=original;mesh.layers.mask=layers;mesh.castShadow=castShadow;}catch(_){}
   try{material.dispose();}catch(_){}try{material.uniformBlock?.buffer?.destroy();}catch(_){}
  }
  try{reflection.dispose();}catch(_){}try{params?.buffer?.destroy();}catch(_){}
  throw error;
 }
}
