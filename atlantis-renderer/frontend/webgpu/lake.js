                                                                              
                                                                               
import {GPU,UniformBlock,Texture,StorageBuffer,ShaderModule,ComputeKernel,commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Mesh,BufferGeometry,BufferAttribute,Float32BufferAttribute} from '../../vendor/tidewater/src/engine/index.js';
import {LAYERS} from '../../vendor/tidewater/src/engine/render/SceneRenderer.js';
import {generateMipmaps} from '../../vendor/tidewater/src/engine/gpu/Mipmaps.js';
import {createSavedWaterMaterial} from './mesh_material.js';
import {inferLakeBasins,lakeSurfaceGeometry,lakeWaterQuery,excludeLakeGrassCells,basinsFromLakeMask} from './lake_basin_source.js';
import {lakeWaveBand} from './lake_spectrum.js';
import {makeLakeBody} from './inland_water_math.js';

                                                                                 
                                                                                   
                                                                  
export class LakeFFT {
  constructor(band,{atlas=null,layer=0}={}){
    this.band=band;this.lastTime=null;this.layer=layer;this.atlas=atlas??null;this.ownsTexture=!atlas;
    const n=band.size,levels=Math.log2(n),count=n*n;
    this.h0=new StorageBuffer({label:'lake seeded H0',count,data:band.h0});
    const wave=new Float32Array(count*4),dk=2*Math.PI/band.length;
    for(let z=0;z<n;z++)for(let x=0;x<n;x++){const kx=(x<n/2?x:x-n)*dk,kz=(z<n/2?z:z-n)*dk,k=Math.hypot(kx,kz);wave.set([kx,kz,k?Math.sqrt(9.81*k*Math.tanh(k*band.depth)):0,0],(z*n+x)*4);}
    this.wave=new StorageBuffer({label:'lake finite depth dispersion',count,data:wave});
    this.tmp=new StorageBuffer({label:'lake FFT rows',count});
    this.params=new UniformBlock('APSLakeFFT',{time:['f32',0]});
    if(atlas){
      if(!Number.isInteger(layer)||layer<0||layer>=atlas.depth)throw Error('Invalid inland lake atlas layer');
      this.texture=atlas;
      this.storageView={dimension:'2d',baseArrayLayer:layer,arrayLayerCount:1,baseMipLevel:0,mipLevelCount:1};
    }else{
      this.texture=new Texture({label:'lake SI height and slope',width:n,height:n,format:'rgba16float',mips:true,usage:['sample','storage','render','copyDst','copySrc']});
      this.storageView={baseMipLevel:0,mipLevelCount:1};
    }
    const ro=storage=>({storage,access:'read'}),rw=storage=>({storage,access:'read_write'});
    const shared=`var<workgroup> a:array<vec4f,${n}>;
      fn cm(v:vec4f,w:vec2f)->vec4f{return vec4f(v.x*w.x-v.y*w.y,v.x*w.y+v.y*w.x,v.z*w.x-v.w*w.y,v.z*w.y+v.w*w.x);}`;
    const stages=Array.from({length:levels},(_,s)=>{const h=1<<s;return `{let p=t&${h-1}u;let i=((t>>${s}u)<<${s+1}u)|p;let j=i+${h}u;let ang=f32(p)*${Math.PI/h};let b=cm(a[j],vec2f(cos(ang),sin(ang)));let v=a[i];a[i]=v+b;a[j]=v-b;workgroupBarrier();}`;}).join('\n');
    this.rows=new ComputeKernel({label:'Lake128 IFFT rows',bindings:{lakeTime:{uniform:this.params},h0:ro(this.h0),waves:ro(this.wave),tmp:rw(this.tmp)},workgroupSize:[n/2,1,1],code:shared+`
      @compute @workgroup_size(WG_X,1,1) fn main(@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){let t=lid.x;
      for(var e=0u;e<2u;e++){let x=t+e*${n/2}u;let i=wid.x*${n}u+x;let h=h0[i];let w=waves[i];let phase=w.z*lakeTime.time;let cs=cos(phase);let sn=sin(phase);
        let hr=h.x*cs-h.y*sn+h.z*cs+h.w*sn;let hi=h.x*sn+h.y*cs-h.z*sn+h.w*cs;
        a[reverseBits(x)>>${32-levels}u]=vec4f(hr,hi,-w.x*hi-w.y*hr,w.x*hr-w.y*hi);}
      workgroupBarrier();${stages}
      for(var e=0u;e<2u;e++){let x=t+e*${n/2}u;tmp[wid.x*${n}u+x]=a[x];}}`});
    this.columns=new ComputeKernel({label:'Lake128 IFFT columns',bindings:{tmp:ro(this.tmp),outField:{storageTexture:this.texture,access:'write',view:this.storageView}},workgroupSize:[n/2,1,1],code:shared+`
      @compute @workgroup_size(WG_X,1,1) fn main(@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){let t=lid.x;
      for(var e=0u;e<2u;e++){let y=t+e*${n/2}u;a[reverseBits(y)>>${32-levels}u]=tmp[y*${n}u+wid.x];}
      workgroupBarrier();${stages}
      for(var e=0u;e<2u;e++){let y=t+e*${n/2}u;let v=a[y]/${count}.0;textureStore(outField,vec2u(wid.x,y),vec4f(v.x,v.z,v.w,0));}}`});
  }
  update(time){if(time===this.lastTime)return false;this.lastTime=time;this.params.set('time',time);
    GPU.computePass('Lake finite-fetch IFFT',pass=>{this.rows.dispatch([128,1,1],{pass});this.columns.dispatch([128,1,1],{pass});});
    if(this.ownsTexture)generateMipmaps(this.texture);
    return true;
  }
  dispose(){for(const b of [this.h0,this.wave,this.tmp])b.destroy();if(this.ownsTexture)this.texture.destroy();this.params.buffer?.destroy();}
}

export function createLakes(native,options,{savedWater=[],lakeMask,optics=null,terrainSampling=null}={}) {
                                                                                  
  if(lakeMask===undefined&&savedWater.some(w=>w.kind==='lake'))return {objects:[],optics,update(){},dispose(){},metadata(){return {method:'explicit saved lake geometry takes precedence in unmasked legacy scene',bodies:[],optics:optics?optics.metadata():null};}};
  const result=lakeMask===undefined?inferLakeBasins(native,options):basinsFromLakeMask(native,lakeMask,options),bodies=[],waterAt=lakeWaterQuery(native,result.basins);
                                                                         
                                                                                
  let maskModule=null,maskTexture=null,maskParams=null;
  if(lakeMask!==undefined){
    maskTexture=new Texture({label:'authoritative inland lake categories',width:native.shape[1],height:native.shape[0],format:'r8unorm',data:lakeMask.data.map(v=>v?255:0)});
    maskParams=new UniformBlock('APSInlandLakeMask',{origin:['vec2f',native.origin],spacing:['vec2f',native.spacing],shape:['vec2f',[native.shape[1],native.shape[0]]]});
    maskModule=new ShaderModule({name:'aps-inland-lake-mask',uniforms:maskParams,uniformName:'inlandLake',bindings:{inlandLakeMask:{texture:maskTexture}},code:`
      fn apsInlandLake(p:vec2f)->bool {
        let g=(p-inlandLake.origin)/inlandLake.spacing;if(any(g<vec2f(0))||any(g>inlandLake.shape-1.)){return false;}
        let q=min(vec2i(floor(g)),vec2i(inlandLake.shape)-2);let f=g-vec2f(q);
        let a=textureLoad(inlandLakeMask,q,0).r;let b=textureLoad(inlandLakeMask,q+vec2i(1,0),0).r;
        let c=textureLoad(inlandLakeMask,q+vec2i(0,1),0).r;let d=textureLoad(inlandLakeMask,q+vec2i(1),0).r;
        return select(d*(f.x+f.y-1.)+b*(1.-f.y)+c*(1.-f.x),a*(1.-f.x-f.y)+b*f.x+c*f.y,f.x+f.y<=1.)>=.5;
      }`});
  }
  try{for(const b of result.basins){
    b.wind_direction=result.config.wind_direction;
    const surface=lakeSurfaceGeometry(native,b),band=lakeWaveBand(b,surface.fetch_m,{...result.config,seed:(result.config.seed+b.cells[0])>>>0});
    const layer=optics?optics.allocateLakeLayer():-1;
    const fft=new LakeFFT(band,optics?{atlas:optics.atlas,layer}:undefined);let geometry,material,object,bodyIndex=null;
    try{
    geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(surface.positions,3));geometry.setAttribute('lakeDepth',new Float32BufferAttribute(surface.depths,1));geometry.setIndex(new BufferAttribute(surface.indices,1));geometry.computeVertexNormals();
    material=createSavedWaterMaterial({file:b.id,color:[.12,.32,.29]});material.isWaterMaterial=true;
    const params=new UniformBlock('APSLakeSurface',{length:['f32',band.length],fade:['f32',Math.max(.3,band.significantHeight*4)],origin:['vec2f',native.origin]});
    if(optics){
      bodyIndex=optics.addBody(makeLakeBody({native,basin:b,band,fetch:surface.fetch_m,layer,originXZ:native.origin}));
      optics.attachMaterial(material,bodyIndex,{kind:'lake'});
                                                                               
                                                                                  
      material.modules.push(new ShaderModule({name:'aps-lake-domain',deps:[commonModule],uniforms:params,uniformName:'lakeParams',code:`
        fn apsLakeShoreFade(depth:f32)->f32{return smoothstep(0.,lakeParams.fade,depth);}`}));
      material.attributes.lakeDepth='f32';material.varyings.lakeDepth='f32';
      material.vertex+=`\no.lakeDepth=v.lakeDepth;let lakeP=v.worldPos;let lakeFade=apsLakeShoreFade(v.lakeDepth);let lakeD=apsInlandWaterSample(lakeP,0.).x*lakeFade;let lakeOffset=apsInlandWorldDirection(vec3f(0.,lakeD,0.));v.worldPos+=lakeOffset;v.prevWorldPos+=lakeOffset;`;
      material.surface+=`\nlet lakeNative=apsInlandNativePosition(in.P);let lakeFoot=max(length(dpdx(lakeNative.xz)),length(dpdy(lakeNative.xz)));let lakeD=apsInlandWaterSample(in.P,lakeFoot);let lakeF=apsLakeShoreFade(in.vs.lakeDepth);
        let lakeN=apsInlandWorldNormal(vec3f(-lakeD.y*lakeF,1.,-lakeD.z*lakeF));s.normal=lakeN;apsMeshMaterial.normal=lakeN;apsMeshMaterial.geometricNormal=in.N;apsMeshMaterial.specular=.25;`;
    }else{
    const module=new ShaderModule({name:'aps-lake-spectrum',deps:[commonModule,...(terrainSampling?[terrainSampling]:[])],uniforms:params,uniformName:'lakeParams',bindings:{lakeField:{texture:fft.texture}},code:`
      fn lakeSample(p:vec2f,lod:f32)->vec3f{return textureSampleLevel(lakeField,smpLinearRepeat,(p-lakeParams.origin)/lakeParams.length+vec2f(.5/128.),lod).xyz;}`});
    material.modules.push(module);material.attributes.lakeDepth='f32';material.varyings.lakeDepth='f32';
                                                                                
    const nativePosition=terrainSampling?'apsTerrainNativePosition':'lakeIdentityPosition';
    const worldNormal=terrainSampling?'apsTerrainWorldNormal':'lakeIdentityNormal';
    if(!terrainSampling)module.code+='\nfn lakeIdentityPosition(p:vec3f)->vec3f{return p;}\nfn lakeIdentityNormal(n:vec3f)->vec3f{return normalize(n);}\nfn lakeWorldOffset(h:f32)->vec3f{return vec3f(0.,h,0.);}';
    else module.code+='\nfn lakeWorldOffset(h:f32)->vec3f{return (terrainParams.worldFromNative*vec4f(0.,h,0.,0.)).xyz;}';
    material.vertex+=`\no.lakeDepth=v.lakeDepth;let lakeP=${nativePosition}(v.worldPos);let lakeFade=smoothstep(0.,lakeParams.fade,v.lakeDepth);let lakeD=lakeSample(lakeP.xz,0.).x*lakeFade;let lakeOffset=lakeWorldOffset(lakeD);v.worldPos+=lakeOffset;v.prevWorldPos+=lakeOffset;`;
    material.surface+=`\nlet lakeP=${nativePosition}(in.P);let lakeFoot=max(length(dpdx(lakeP.xz)),length(dpdy(lakeP.xz)));let lakeLod=clamp(log2(max(1.,lakeFoot*128./lakeParams.length)),0.,7.);let lakeD=lakeSample(lakeP.xz,lakeLod);let lakeF=smoothstep(0.,lakeParams.fade,in.vs.lakeDepth);
      let lakeN=${worldNormal}(vec3f(-lakeD.y*lakeF,1.,-lakeD.z*lakeF));s.normal=lakeN;apsMeshMaterial.normal=lakeN;apsMeshMaterial.geometricNormal=in.N;apsMeshMaterial.specular=.25;`;
    }
    object=new Mesh(geometry,material);object.name=b.id;object.layers.set(LAYERS.TRANSPARENT);object.receiveShadow=true;object.frustumCulled=false;
    object.userData={waterKind:'lake',generated:true,height_sha256:native.sha256,inland_atlas_layer:layer,inland_body_index:bodyIndex};
    bodies.push({b,band,fft,params,geometry,material,object,fetch:surface.fetch_m,layer,bodyIndex});
    }catch(e){fft.dispose();geometry?.dispose();material?.dispose();throw e;}
  }}catch(e){for(const b of bodies){b.fft.dispose();b.geometry.dispose();b.material.dispose();b.params.buffer?.destroy();}maskTexture?.destroy();maskParams?.buffer?.destroy();throw e;}
  let released=false;
  return {maskModule,optics,objects:bodies.map(b=>b.object),submerged(x,y,z){const level=waterAt(x,z);return level!==null&&y<level;},excludeGrass(field){return excludeLakeGrassCells(field,native,result.basins,waterAt);},update(time){if(released)return;let changed=false;for(const b of bodies)if(b.fft.update(time))changed=true;if(changed&&optics)optics.markAtlasDirty();},dispose(){if(released)return;released=true;for(const b of bodies){b.object.removeFromParent();b.object.dispose();b.geometry.dispose();b.material.dispose();b.material.uniformBlock.buffer?.destroy();b.params.buffer?.destroy();b.fft.dispose();}maskTexture?.destroy();maskParams?.buffer?.destroy();},
    metadata(){return {method:result.method,mask:result.mask??null,config:result.config,height_sha256:native.sha256,bed_mutated:false,water_level_assumption:result.mask?'declared mask level, or lowest unmasked boundary; no rainfall/groundwater solver':'saturated to native lowest spill; no rainfall/groundwater solver',optics:optics?optics.metadata().bodies:null,bodies:bodies.map(({b,band,object,fetch,layer,bodyIndex})=>({id:b.id,level_m:b.level_m,area_m2:b.area_m2,max_depth_m:b.max_depth_m,mean_depth_m:b.mean_depth_m,bounds_rc:b.bounds_rc,fetch_m:fetch,vertices:object.geometry.attributes.position.count,indices:object.geometry.index.count,Hs_m:band.significantHeight,spectrum:band.support.spectrum,size:band.size,length_m:band.length,atlas_layer:layer,inland_body_index:bodyIndex}))};}};
}
