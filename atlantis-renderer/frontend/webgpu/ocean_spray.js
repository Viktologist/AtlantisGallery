import {StorageBuffer,UniformBlock,ComputeKernel,Material,LAYERS,commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Mesh,PlaneGeometry} from '../../vendor/tidewater/src/engine/index.js';

                                                                                 
export class OceanSpray {
  constructor(ocean) {
    this.ocean=ocean;this.count=ocean.config.particleBudget;
    this.particles=new StorageBuffer({label:'ocean metric spray world state',count:this.count*3});
                                                                             
                                                                               
    this.impacts=new StorageBuffer({label:'ocean fresh spray impacts',count:48});
    this.impactCount=0;this.age=0;this.cursor=0;
    this.params=new UniformBlock('OceanSprayParams',{dt:['f32',0],time:['f32',0],seed:['u32',ocean.config.seed^971],count:['u32',this.count],impactCount:['u32',0],emitCount:['u32',0],emitCursor:['u32',0],pad:['u32',0]});
    this.kernel=new ComputeKernel({label:'Ocean GPU fresh FFT/landing/impact spray',modules:[ocean.surface.displacementModule],bindings:{sprayP:{uniform:this.params},particles:{storage:this.particles,access:'read_write'},origins:{storage:ocean.shore.origins,access:'read'},impacts:{storage:this.impacts,access:'read'}},workgroupSize:[64,1,1],code:`
fn sprayHash(x:u32)->u32 {var s=x*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn sprayUnit(x:u32)->f32{return f32(sprayHash(x)>>8u)/16777216.0;}
fn sprayFreshFFT(q:vec2f)->f32 {
 let t=oceanSurfaceTangents(q,0.5);let jac=t[0].x*t[1].z-t[0].z*t[1].x;
 return clamp(0.55-jac,0.0,1.0)*smoothstep(0.0,0.2,oceanFarDisplacement(q,0.5).y)*(1.0-oceanPageSupport(q).x);
}
@compute @workgroup_size(WG_X,WG_Y,WG_Z)
fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=sprayP.count){return;}var p=particles[i*3u];var v=particles[i*3u+1u];var life=particles[i*3u+2u];let dt=sprayP.dt;
 if(p.w>0.0){
  v.y-=9.81*dt;let relaxation=1.0-exp(-dt*0.5);
  v.x+=(frame.windDir.x*frame.windSpeed*0.15-v.x)*relaxation;v.z+=(frame.windDir.y*frame.windSpeed*0.15-v.z)*relaxation;
  p=vec4f(p.xyz+v.xyz*dt,max(0.0,p.w-dt));
  // Accepted collision envelope: native bed OR water, even offshore.
  if(p.y<=max(oceanBed(p.xz),frame.seaLevel-0.1)){p.w=0.0;}
 }
 let candidate=(i+sprayP.count-sprayP.emitCursor)%sprayP.count<sprayP.emitCount;
 if((candidate||i<sprayP.impactCount)&&dt>0.0){
  let tick=u32(floor(sprayP.time/0.12));let seed=sprayHash(i+tick*1619u+sprayP.seed*7919u);var q:vec2f;
  // Offshore patch stays independent when fixed shore pages exist.
  if(pageP.pages>0u&&(i%2u)==0u){let page=seed%pageP.pages;q=origins[page].xy+vec2f(sprayUnit(seed+1u),sprayUnit(seed+2u))*pageP.pageGrid.z;}
  else {q=frame.cameraPos.xz+(vec2f(sprayUnit(seed+1u),sprayUnit(seed+2u))-0.5)*128.0;}
  let d=oceanCompositeDisplacement(q,0.5).xyz;var y=frame.seaLevel+d.y;
  var source=max(sprayFreshFFT(q),0.3*oceanCachedShore(q,0.5).a);var launchGap=0.05;
  let field=oceanFieldAt(q,0);let dir=field.yz/max(1e-5,length(field.yz));let depth=max(0.0,frame.seaLevel-oceanBed(q));
  let profile=oceanCachedShore(q,0.5);let weight=oceanPageSupport(q).x;let eta=profile.y/max(1e-6,weight);
  let speed=clamp(sqrt(9.81*max(0.015,depth))*eta/(depth+max(eta,-depth*0.8)+0.15),-2.5,4.0);
  var horizontal=dir*speed*0.6;var energy=source*min(2.0,waterSurface.hs);var chance=min(1.0,source*0.8);
  // Explicit events are fresh per update; no foam-history proxy for impacts.
  if(i<sprayP.impactCount){let hit=impacts[i*2u];let velocity=impacts[i*2u+1u];q=hit.xz;y=hit.y;source=hit.w;horizontal=velocity.xz*0.35;energy=min(1.0,source);chance=1.0;launchGap=0.03;}
  if(source>0.08&&oceanBed(q)<y-0.002&&sprayUnit(seed+3u)<chance){
   let up=sqrt(max(0.01,energy)*2.0*9.81)*(1.0+sprayUnit(seed+4u));
   let initialLife=0.5+sprayUnit(seed+5u)*1.6;
   p=vec4f(q.x,y+launchGap,q.y,initialLife);
   v=vec4f(horizontal.x+(sprayUnit(seed+6u)-0.5)*up,up*0.65,horizontal.y+(sprayUnit(seed+7u)-0.5)*up,0.003+sprayUnit(seed+8u)*0.012);
   life=vec4f(initialLife,0.0,0.0,0.0);
  }
 }
 particles[i*3u]=p;particles[i*3u+1u]=v;particles[i*3u+2u]=life;
}`});
    this.material=new Material({name:'Ocean optical spray',lit:false,side:'double',transparent:true,depthWrite:false,modules:[commonModule],
      storage:{oceanSprayParticles:this.particles},textures:{oceanSprayDepth:{texture:()=>ocean.viewer.sceneRenderer.opaqueCopy.depthTexture}},
      uniforms:{rawDiagnostic:['u32',0]},varyings:{vSprayAlpha:'f32',vSpraySubpixel:'f32',vSprayViewDepth:'f32'},vertex:`
 let p=oceanSprayParticles[v.instance*3u];let particle=oceanSprayParticles[v.instance*3u+1u];let initialLife=oceanSprayParticles[v.instance*3u+2u].x;
 let z=max(0.05,-(frame.view*vec4f(p.xyz,1.0)).z);
 // Old point sprite uses height / tan(FOV/2), with a one-pixel minimum.
 let pixels=particle.w*frame.resolution.y*abs(frame.proj[1][1])/z;
 let diameter=clamp(pixels,1.0,32.0)*2.0*z/(frame.resolution.y*abs(frame.proj[1][1]));
 let right=frame.invView[0].xyz;let up=frame.invView[1].xyz;
 v.useWorld=true;v.worldPos=p.xyz+(right*v.position.x+up*v.position.y)*diameter;v.prevWorldPos=v.worldPos;v.worldNormal=normalize(frame.cameraPos-p.xyz);
 o.vSprayAlpha=select(0.0,clamp(p.w/max(1e-6,initialLife)*2.0,0.0,1.0),p.w>0.0);o.vSpraySubpixel=min(1.0,pixels*pixels);o.vSprayViewDepth=z;
`,surface:`
 let q=(in.uv-0.5)*2.0;let r=dot(q,q);if(mat.rawDiagnostic>0u||in.vs.vSprayAlpha<=0.0||r>1.0){discard;}
 let dims=vec2i(textureDimensions(oceanSprayDepth));let uv=in.pixel*frame.invResolution;
 let coord=clamp(vec2i(uv*vec2f(dims)),vec2i(0),dims-1);let depth=textureLoad(oceanSprayDepth,coord,0);
 let obstacle=select(1e20,viewDepth(depth),depth>0.0);let soft=clamp((obstacle-in.vs.vSprayViewDepth)/0.25,0.0,1.0);
 s.alpha=in.vs.vSprayAlpha*in.vs.vSpraySubpixel*soft*exp(-r*3.0)*0.7;if(s.alpha<0.004){discard;}s.albedo=vec3f(0.9,0.94,1.0);
`});
    this.geometry=new PlaneGeometry(1,1);this.geometry.instanceCount=this.count;this.mesh=new Mesh(this.geometry,this.material);this.mesh.frustumCulled=false;this.mesh.layers.set(LAYERS.TRANSPARENT);this.mesh.name='NativeOceanSpray';this.mesh.visible=ocean.enabled;ocean.viewer.scene.add(this.mesh);
  }
  setImpacts(hits=[]) {
    const data=new Float32Array(48*4);let count=0;
    for(const hit of hits.slice(0,24)){
      const velocity=hit.velocity??[0,0,0],y=hit.y;
      if(![hit.x,y,hit.z,hit.strength,...velocity].every(Number.isFinite))throw Error('Spray impact needs finite world x/y/z, strength and velocity');
      if(hit.strength<=0.08)continue;
      data.set([hit.x,y,hit.z,hit.strength,...velocity,0],count*8);count++;
    }
    this.impacts.write(data);this.impactCount=count;
  }
  update(dt,time){
    this.age+=dt;let attempts=0;
    if(this.age>=0.12){attempts=Math.min(160,Math.ceil(this.count*0.018*this.age/0.12));this.age=0;}
    this.params.set('dt',dt);this.params.set('time',time);this.params.set('emitCount',attempts);this.params.set('emitCursor',this.cursor);
    this.params.set('impactCount',dt>0?this.impactCount:0);this.kernel.dispatch(Math.ceil(this.count/64));
    this.cursor=(this.cursor+attempts)%this.count;if(dt>0)this.impactCount=0;
  }
  dispose(){this.ocean.viewer.scene.remove(this.mesh);this.geometry.dispose();this.material.dispose();this.material.uniformBlock.buffer?.destroy();this.particles.destroy();this.impacts.destroy();this.params.buffer?.destroy();}
}



