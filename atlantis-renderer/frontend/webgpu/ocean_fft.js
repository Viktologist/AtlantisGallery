                                                                              
                                                                                   
                                                                              
                                                                           
import {GPU, UniformBlock, Texture, StorageBuffer, ShaderModule, ComputeKernel, commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {FFT_SIZE, createWaveBand, spectralWaveData} from './ocean_numeric.js';

const N=FFT_SIZE,C=4,P=3,total=N*N*C;
const THREADS=N/2,LEVELS=Math.log2(N),GROUPS=Math.ceil(N/8);
const ro=b=>({storage:b,access:'read'}),rw=b=>({storage:b,access:'read_write'});
const write=(texture,mip=0)=>({storageTexture:texture,access:'write',view:{dimension:'2d-array',baseMipLevel:mip,mipLevelCount:1}});
const shared=`var<workgroup> fftShared: array<vec4f, ${N}>;
fn fftReverse(v:u32)->u32 {return reverseBits(v)>>${32-LEVELS}u;}
fn fftCmul2(v:vec4f,w:vec2f)->vec4f{return vec4f(v.x*w.x-v.y*w.y,v.x*w.y+v.y*w.x,v.z*w.x-v.w*w.y,v.z*w.y+v.w*w.x);}
`;
export function fftStages(n=N) {
  if(n<2||(n&(n-1)))throw Error('Power-of-two FFT required');
  return Array.from({length:Math.log2(n)},(_,s)=>{const h=1<<s;return `{
    let pos=t & ${h-1}u; let i=((t >> ${s}u)<<${s+1}u)|pos; let j=i+${h}u;
    let angle=f32(pos)*${(Math.PI/h).toFixed(14)};
    let a=fftShared[i]; let b=fftCmul2(fftShared[j],vec2f(cos(angle),sin(angle)));
    fftShared[i]=a+b; fftShared[j]=a-b; workgroupBarrier();
  }`;}).join('\n');
}

export class NativeOceanFFT512 {
  constructor(config) {
    this.config=config;this.cascades=C;this.sizes=config.bands.map(b=>b.length);this.time=0;this.dispatches=0;
    this.bands=config.bands.map(createWaveBand);
    const h0=new Float32Array(total*4),wave=new Float32Array(total*4);
    this.bands.forEach((b,c)=>{h0.set(b.h0,c*N*N*4);wave.set(spectralWaveData(b),c*N*N*4);});
    this.h0=new StorageBuffer({label:'ocean512 H0 accepted seed',count:total,data:h0});
    this.wave=new StorageBuffer({label:'ocean512 k and dispersion',count:total,data:wave});
    this.tmp=new StorageBuffer({label:'ocean512 row complex packs',count:total*P});
    this.spatial=new StorageBuffer({label:'ocean512 SI spatial packs',count:total*P});
    this.params=new UniformBlock('NativeOceanFFT512Params',{
      sizes:['vec4f[4]',this.sizes.map((x,c)=>[x,config.bands[c].minWavelength,config.bands[c].maxWavelength,config.bands[c].significantHeight/4])],
      time:['f32',0],dt:['f32',0],choppiness:['f32',config.choppiness],life:['f32',config.foamLifetime*2],
      wind:['vec2f',config.winddirection.map(x=>x*config.windSpeed*.04)],strength:['f32',config.foamStrength],pad:['f32',0],
    });
                                                                             
                                                                       
    this.fieldFormat='rgba16float';
    const tex=name=>new Texture({label:name,width:N,height:N,depth:C,dimension:'2d-array',format:this.fieldFormat,mips:true,usage:['sample','storage','copyDst','copySrc']});
    this.displacementTexture=tex('oceanDisplacement');this.derivativeTexture=tex('oceanDerivatives');
    this.crossTexture=tex('oceanCrossDerivatives');this.velocityTexture=tex('oceanAnalyticVelocity');
    this.textures=[this.displacementTexture,this.derivativeTexture,this.crossTexture,this.velocityTexture];
    this.history=[0,1].map(i=>new StorageBuffer({label:`ocean512 foam ${i}`,type:'f32',count:total}));this.front=0;
    this.module=new ShaderModule({name:'ocean',deps:[commonModule],uniforms:this.params,uniformName:'ocean',bindings:{
      oceanDisplacement:{texture:this.displacementTexture},oceanDerivatives:{texture:this.derivativeTexture},
      oceanCross:{texture:this.crossTexture},oceanVelocity:{texture:this.velocityTexture},
    },code:`const OCEAN_CASCADES:i32=4; const OCEAN_FFT_SIZE:f32=${N}.0;
fn oceanUv(p:vec2f,c:i32)->vec2f{return p/ocean.sizes[c].x+vec2f(0.5/${N}.0);}
fn oceanLod(p:f32,c:i32)->f32{return clamp(log2(max(1.0,2.0*p*${N}.0/ocean.sizes[c].x)),0.0,${LEVELS}.0);}
fn oceanSampleDisplacement(xz:vec2f,level:f32)->vec3f{var d=vec3f(0.0);for(var c=0;c<4;c++){d+=textureSampleLevel(oceanDisplacement,smpLinearRepeat,oceanUv(xz,c),c,level).xyz;}return d;}
fn oceanSampleDisplacementWeighted(xz:vec2f,level:f32,w:vec4f)->vec3f{var d=vec3f(0.0);for(var c=0;c<4;c++){d+=textureSampleLevel(oceanDisplacement,smpLinearRepeat,oceanUv(xz,c),c,level).xyz*w[c];}return d;}`});
    this.rows=new ComputeKernel({label:'Ocean512 native workgroup rows',bindings:{ocean:{uniform:this.params},h0:ro(this.h0),waveData:ro(this.wave),tmp:rw(this.tmp)},workgroupSize:[THREADS,1,1],code:shared+`
@compute @workgroup_size(WG_X,WG_Y,WG_Z)
fn main(@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){
 let t=lid.x;let row=wid.x;let c=wid.y;let pack=wid.z;
 for(var e=0u;e<2u;e++){let x=t+e*${THREADS}u;let idx=c*${N*N}u+row*${N}u+x;
  let w=waveData[idx];let h=h0[idx];let cs=cos(w.w*ocean.time);let sn=sin(w.w*ocean.time);
  let ar=h.x*cs-h.y*sn;let ai=h.x*sn+h.y*cs;
  let br=h.z*cs+h.w*sn;let bi=-h.z*sn+h.w*cs;
  let hr=ar+br;let hi=ai+bi;let tr=w.w*(bi-ai);let ti=w.w*(ar-br);
  let kx=w.x;let kz=w.y;let ik=w.z;let fx=kx*ik;let fz=kz*ik;
  var v:vec4f;
  if(pack==0u){let q=-kx*kz*ik;v=vec4f(-fx*hi-fz*hr,fx*hr-fz*hi,hr-q*hi,hi+q*hr);}
  else if(pack==1u){let a=-kx*kx*ik;let b=-kz*kz*ik;v=vec4f(-kx*hi-kz*hr,kx*hr-kz*hi,a*hr-b*hi,a*hi+b*hr);}
  else {v=vec4f(-fx*ti-ti,fx*tr+tr,-fz*ti,fz*tr);}
  fftShared[fftReverse(x)]=v;
 }
 workgroupBarrier();${fftStages()}
 for(var e=0u;e<2u;e++){let x=t+e*${THREADS}u;tmp[(c*${N*N}u+row*${N}u+x)*3u+pack]=fftShared[x];}
}`});
    this.columns=new ComputeKernel({label:'Ocean512 native workgroup columns',bindings:{tmp:ro(this.tmp),spatial:rw(this.spatial)},workgroupSize:[THREADS,1,1],code:shared+`
@compute @workgroup_size(WG_X,WG_Y,WG_Z)
fn main(@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){
 let t=lid.x;let col=wid.x;let c=wid.y;let pack=wid.z;
 for(var e=0u;e<2u;e++){let y=t+e*${THREADS}u;fftShared[fftReverse(y)]=tmp[(c*${N*N}u+y*${N}u+col)*3u+pack];}
 workgroupBarrier();${fftStages()}
 for(var e=0u;e<2u;e++){let y=t+e*${THREADS}u;spatial[(c*${N*N}u+y*${N}u+col)*3u+pack]=fftShared[y]*(1.0/${N*N}.0);}
}`});
    this.pack=[0,1].map(front=>new ComputeKernel({label:`Ocean512 foam transport and pack ${front}`,bindings:{
      ocean:{uniform:this.params},spatial:ro(this.spatial),prev:ro(this.history[front]),next:rw(this.history[1-front]),
      dispOut:write(this.displacementTexture),derivOut:write(this.derivativeTexture),crossOut:write(this.crossTexture),velocityOut:write(this.velocityTexture),
    },workgroupSize:[8,8,1],code:`
fn historyAt(p:vec2f,c:u32)->f32 {
 let q=fract(p/${N}.0)*${N}.0;let i=vec2u(floor(q));let f=fract(q);let j=(i+vec2u(1u))%${N}u;
 let b=c*${N*N}u;return mix(mix(prev[b+i.y*${N}u+i.x],prev[b+i.y*${N}u+j.x],f.x),mix(prev[b+j.y*${N}u+i.x],prev[b+j.y*${N}u+j.x],f.x),f.y);
}
fn noiseCorner(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn sourceNoise(p:vec2f,period:f32)->f32 {
 let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
 return 0.55+0.45*mix(mix(noiseCorner(i%period),noiseCorner((i+vec2f(1.0,0.0))%period),u.x),mix(noiseCorner((i+vec2f(0.0,1.0))%period),noiseCorner((i+vec2f(1.0))%period),u.x),u.y);
}
@compute @workgroup_size(WG_X,WG_Y,WG_Z)
fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.z*${N*N}u+id.y*${N}u+id.x;let a=spatial[i*3u];let b=spatial[i*3u+1u];let v=spatial[i*3u+2u];
 let lambda=ocean.choppiness;let J=(1.0+lambda*b.z)*(1.0+lambda*b.w)-pow(lambda*a.w,2.0);
 var source=0.0;if(J>0.0&&J<0.5){let noiseUv=vec2f(id.xy)*(16.0/${N}.0)+vec2f(0.021,-0.017)*ocean.time;source=(1.0-smoothstep(0.0,0.5,J))*ocean.strength*sourceNoise(noiseUv,16.0);}
 let gen=2.5*source;let rate=gen+1.0/ocean.life;
 let old=historyAt(vec2f(id.xy)-ocean.wind*ocean.dt*${N}.0/ocean.sizes[id.z].x,id.z);
 let f=clamp(mix(old,gen/rate,1.0-exp(-rate*ocean.dt)),0.0,1.0);next[i]=f;
 textureStore(dispOut,id.xy,id.z,vec4f(a.x,a.z,a.y,f));textureStore(derivOut,id.xy,id.z,b);
 textureStore(crossOut,id.xy,id.z,vec4f(a.w,source,J,0.0));textureStore(velocityOut,id.xy,id.z,vec4f(v.x,v.y,v.z,0.0));
}` }));
    this.mips=[];
    for(let l=1;l<=LEVELS;l++){
      const bindings={};this.textures.forEach((texture,t)=>{bindings[`src${t}`]={texture,view:{dimension:'2d-array',baseMipLevel:l-1,mipLevelCount:1}};bindings[`out${t}`]=write(texture,l);});
      this.mips.push(new ComputeKernel({label:`Ocean512 independent band mips ${l}`,bindings,workgroupSize:[8,8,1],code:`
@compute @workgroup_size(WG_X,WG_Y,WG_Z)
fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(${N>>l}u))){return;} let p=vec2i(id.xy*2u);let c=i32(id.z);
 ${this.textures.map((_,t)=>`textureStore(out${t},id.xy,c,(textureLoad(src${t},p,c,0)+textureLoad(src${t},p+vec2i(1,0),c,0)+textureLoad(src${t},p+vec2i(0,1),c,0)+textureLoad(src${t},p+vec2i(1),c,0))*0.25);`).join('\n')}
}`}));
    }
  }
  update(dt,time) {
    this.time=time;this.params.set('time',time);this.params.set('dt',dt);
    GPU.computePass('Ocean512 FFT and history',pass=>{this.rows.dispatch([N,C,P],{pass});this.columns.dispatch([N,C,P],{pass});this.pack[this.front].dispatch([GROUPS,GROUPS,C],{pass});
      this.mips.forEach((k,l)=>k.dispatch([Math.ceil((N>>(l+1))/8),Math.ceil((N>>(l+1))/8),C],{pass}));});
    this.front=1-this.front;this.dispatches+=3+LEVELS;
  }
  metadata(){return {backend:'native WGSL workgroup-memory radix-2 compute IFFT',size:N,cascades:C,fft_dispatches_per_update:2,history_pack_dispatches:1,mip_dispatches:LEVELS,workgroup_bytes:N*16,threads:THREADS,normalization:'1/N², natural frequency indices; no checkerboard',choppiness_stage:'unit fields, lambda applied by mesh/tangent/foam consumers',analytic_velocity:true,storage_format:this.fieldFormat,intermediates:'float32 storage including foam history',bands:this.bands.map(b=>({length_m:b.length,Hs_m:b.significantHeight,seed:b.seed,wavelength_m:[b.minWavelength,b.maxWavelength],support:b.support})),dispatches:this.dispatches};}
  dispose(){for(const b of [this.h0,this.wave,this.tmp,this.spatial,...this.history,...this.textures])b.destroy();this.params.buffer?.destroy();}
}
