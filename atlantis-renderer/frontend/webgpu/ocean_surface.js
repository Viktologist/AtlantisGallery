import {UniformBlock,ShaderModule,commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {OCEAN_FOAM_SURFACE_WGSL} from './ocean_foam.js';
import {OCEAN_SURFACE_BLEND_WGSL} from './ocean_surface_blend.js';
import {OCEAN_SHORE_FILM_WGSL} from './ocean_shore_film.js';
import {OCEAN_NORMAL_FILTER_WGSL} from './ocean_normal_filter.js';

export class NativeWaterSurface {
  constructor(fft,shore,terrainApi,config) {
    this.fft=fft;this.nativeShore=shore;
                                                                               
    this.filmModule=new ShaderModule({name:'oceanShoreFilm',deps:[fft.module],code:OCEAN_SHORE_FILM_WGSL});
                                                                            
                                                                              
                                                                               
    this.shoreModule=shore.native?new ShaderModule({name:'oceanMaterialShore',deps:[...shore.module.deps,...(terrainApi?.inlandLakeModule?[terrainApi.inlandLakeModule]:[])],
      uniforms:shore.params,uniformName:'shoreP',bindings:shore.module.bindings,code:shore.module.code+`
fn shoreShoreClip(P:vec3f)->f32 {${terrainApi?.inlandLakeModule?'if(apsInlandLake(P.xz)){return -1.;}':''}return P.y-oceanBed(P.xz);}
`}):shore.module;
    this.shore=shore.native?{module:this.shoreModule}:null;
    this.terrain=terrainApi?.terrainModule?{module:terrainApi.terrainModule}:null;
    this.config=config;this.shoreSim=null;this.surfFoam=null;
    this.params=new UniformBlock('NativeOceanSurfaceParams',{
      amplitude:['f32',1],slopeScale:['f32',1],foamCoverage:['f32',1],maxDistance:['f32',config.maxDistance],hs:['f32',config.significantHeight],normalFilter:['f32',1],
    });
    this.attenuationModule=new ShaderModule({name:'waterSurfaceAttenuation',deps:[fft.module],code:`
fn waterSurfaceCascadeAttenuation(c:i32,depth:f32)->f32 {
 let wavelength=sqrt(ocean.sizes[c].y*ocean.sizes[c].z);let rate=6.0/max(0.25,wavelength);
 return smoothstep(0.0,0.08,depth)*(1.0-exp(-rate*max(0.0,depth)));
}
`});
  }
  bindPages(shore){
    this.shoreSim=shore.native?{module:shore.pageModule}:null;
                                                                              
                                                                                
    const cacheCode=shore.pageModule.code.split('fn shoreSimSample')[0];
    const cacheBindings={...shore.pageModule.bindings};for(const name of ['shoreState','fineState','shoreFlow','fineFlow'])delete cacheBindings[name];
    this.cacheModule=new ShaderModule({name:'oceanSurfaceCache',deps:shore.pageModule.deps.map(m=>m===shore.module?this.shoreModule:m),bindings:cacheBindings,code:cacheCode});
    this.displacementModule=new ShaderModule({name:'oceanMetricDisplacement',deps:[this.attenuationModule,this.cacheModule,this.filmModule],uniforms:this.params,uniformName:'waterSurface',code:`
${OCEAN_SURFACE_BLEND_WGSL}
fn oceanFarDisplacementMask(p:vec2f,footprint:f32,mask:u32)->vec4f {
 let depth=frame.seaLevel-oceanBed(p);var d=vec3f(0.0);var foam=0.0;
 for(var c=0;c<4;c++){if((mask&(1u<<u32(c)))==0u){continue;}let att=waterSurfaceCascadeAttenuation(c,depth);let sample=textureSampleLevel(oceanDisplacement,smpLinearRepeat,oceanUv(p,c),c,oceanLod(footprint,c));
 d+=sample.xyz*vec3f(ocean.choppiness,1.0,ocean.choppiness)*att;foam=max(foam,sample.a*smoothstep(0.25,0.75,att));}return vec4f(d,foam);
}
fn oceanFarDisplacement(p:vec2f,footprint:f32)->vec4f {return oceanFarDisplacementMask(p,footprint,15u);}
fn oceanCachedShore(p:vec2f,footprint:f32)->vec4f {
 // Metric binomial taps cross immutable page IDs and borders. No edge fade
 // into a different analytic wave, and no unresolved curl geometry.
 let cell=pageP.pageGrid.z/pageP.pageGrid.w;let r=max(0.0,footprint-cell);let ex=vec2f(r,0.0);let ez=vec2f(0.0,r);
 return oceanPageProfile(p)*0.5+(oceanPageProfile(p+ex)+oceanPageProfile(p-ex)+oceanPageProfile(p+ez)+oceanPageProfile(p-ez))*0.125;
}
struct OceanSurfaceBlend {shoreContribution:vec3f,fftWeight:f32,shoreWeight:f32};
fn oceanSurfaceBlendAt(p:vec2f,footprint:f32)->OceanSurfaceBlend {
 let support=oceanPageSupport(p).x;let bed=oceanBed(p);
 let w=oceanShoreBlendWeight(support,frame.seaLevel-bed,waterSurface.hs);
 if(w==0.0){return OceanSurfaceBlend(vec3f(0.0),1.0,0.0);}
 let shore=oceanCachedShore(p,footprint).xyz/max(support,1e-6);
 let column=max(0.0,frame.seaLevel+shore.y-bed);
 // Accepted metric film equation: residual motion vanishes with the ACTUAL
 // column, including a backwash sheet exposed by a trough below mean sea.
 return OceanSurfaceBlend(shore*w,oceanFftBlendWeight(w,column),w);
}
fn oceanCompositeDisplacementMask(p:vec2f,footprint:f32,mask:u32)->vec4f {
 var far=oceanFarDisplacementMask(p,footprint,mask);let blend=oceanSurfaceBlendAt(p,footprint);
 far=vec4f(far.xyz*blend.fftWeight+blend.shoreContribution,far.a);
 if(blend.shoreWeight>0.0){
 // Constrain the final parcel after XZ displacement and residual blending.
 // This is the accepted 0.3 mm numeric separation, never extra run-up depth.
 let moved=p+far.xz;if(oceanBedKnown(moved)){
  let separated=max(far.y,oceanBed(moved)-frame.seaLevel+0.0003);
  far.y=mix(far.y,separated,oceanContactBlendWeight(blend.shoreWeight));
 }}
 return far;
}
fn oceanCompositeDisplacement(p:vec2f,footprint:f32)->vec4f {return oceanCompositeDisplacementMask(p,footprint,15u);}
fn oceanSurfaceJacobian(p:vec2f,footprint:f32)->f32 {
 let t=oceanCompositeTangents(p,footprint);
 return t[0].x*t[1].z-t[0].z*t[1].x;
}
fn oceanUnresolvedVariance(p:vec2f,footprint:f32)->f32 {
 var v=0.0;let depth=frame.seaLevel-oceanBed(p);
 for(var c=0;c<4;c++){let wave=sqrt(ocean.sizes[c].y*ocean.sizes[c].z);let sigma=ocean.sizes[c].w*waterSurfaceCascadeAttenuation(c,depth);v+=pow(6.28318530718*sigma/max(0.01,wave),2.0)*smoothstep(wave*0.15,wave*0.6,footprint);}return v;
}
fn oceanSurfaceTangentsMask(p:vec2f,footprint:f32,mask:u32)->mat2x3f {
 let depth=frame.seaLevel-oceanBed(p);var dx=vec3f(0.0);var dz=vec3f(0.0);let cell=0.5;
 let bd=vec2f(oceanBed(p+vec2f(cell,0.0))-oceanBed(p-vec2f(cell,0.0)),oceanBed(p+vec2f(0.0,cell))-oceanBed(p-vec2f(0.0,cell)))/(2.0*cell);
 for(var c=0;c<4;c++){
  if((mask&(1u<<u32(c)))==0u){continue;}
  let lod=oceanLod(footprint,c);let uv=oceanUv(p,c);let d=textureSampleLevel(oceanDerivatives,smpLinearRepeat,uv,c,lod);let crossD=textureSampleLevel(oceanCross,smpLinearRepeat,uv,c,lod).x;
  let disp=textureSampleLevel(oceanDisplacement,smpLinearRepeat,uv,c,lod).xyz*vec3f(ocean.choppiness,1.0,ocean.choppiness);
  let wave=sqrt(ocean.sizes[c].y*ocean.sizes[c].z);let rate=6.0/max(0.25,wave);let t=clamp(depth/0.08,0.0,1.0);let wet=t*t*(3.0-2.0*t);var wetSlope=0.0;if(depth>0.0&&depth<0.08){wetSlope=6.0*t*(1.0-t)/0.08;}
  let decay=exp(-rate*max(0.0,depth));let slope=wetSlope*(1.0-decay)+wet*rate*decay;let att=waterSurfaceCascadeAttenuation(c,depth);
  dx+=vec3f(ocean.choppiness*d.z,d.x,ocean.choppiness*crossD)*att-disp*slope*bd.x;
  dz+=vec3f(ocean.choppiness*crossD,d.y,ocean.choppiness*d.w)*att-disp*slope*bd.y;
 }
 return mat2x3f(vec3f(1.0,0.0,0.0)+dx,vec3f(0.0,0.0,1.0)+dz);
}
fn oceanSurfaceTangents(p:vec2f,footprint:f32)->mat2x3f {return oceanSurfaceTangentsMask(p,footprint,15u);}
fn oceanCompositeTangentsMask(p:vec2f,footprint:f32,mask:u32)->mat2x3f {
 let fftT=oceanSurfaceTangentsMask(p,footprint,mask);let b=oceanSurfaceBlendAt(p,footprint);
 let minimumStep=max(0.035,0.5*oceanPageCell(p));
 let e=max(minimumStep,min(1.0,max(footprint,minimumStep)));let ex=vec2f(e,0);let ez=vec2f(0,e);
 let xp=oceanSurfaceBlendAt(p+ex,footprint);let xm=oceanSurfaceBlendAt(p-ex,footprint);
 let zp=oceanSurfaceBlendAt(p+ez,footprint);let zm=oceanSurfaceBlendAt(p-ez,footprint);
 // A cache page alone never selects a different FFT derivative or normal.
 if(b.shoreWeight==0.0&&xp.shoreWeight==0.0&&xm.shoreWeight==0.0&&zp.shoreWeight==0.0&&zm.shoreWeight==0.0){return fftT;}
 let fft=oceanFarDisplacementMask(p,footprint,mask).xyz;
 let da=vec2f(xp.fftWeight-xm.fftWeight,zp.fftWeight-zm.fftWeight)/(2.0*e);
 var tx=oceanBlendTangent(vec3f(1,0,0),fftT[0],fft,b.fftWeight,da.x,(xp.shoreContribution-xm.shoreContribution)/(2.0*e));
 var tz=oceanBlendTangent(vec3f(0,0,1),fftT[1],fft,b.fftWeight,da.y,(zp.shoreContribution-zm.shoreContribution)/(2.0*e));
 // Differentiate the same final 0.3mm bed constraint, including moved XZ.
 let raw=fft*b.fftWeight+b.shoreContribution;let moved=p+raw.xz;
 if(b.shoreWeight>0.0&&oceanBedKnown(moved)){
  let penetration=oceanBed(moved)-frame.seaLevel+0.0003-raw.y;
  if(penetration>0.0){
   let h=max(0.01,min(0.25,footprint));let hx=vec2f(h,0);let hz=vec2f(0,h);
   let bedGrad=vec2f(oceanBed(moved+hx)-oceanBed(moved-hx),oceanBed(moved+hz)-oceanBed(moved-hz))/(2.0*h);
   let dw=vec2f(xp.shoreWeight-xm.shoreWeight,zp.shoreWeight-zm.shoreWeight)/(2.0*e);
   let k=oceanContactBlendWeight(b.shoreWeight);let dk=oceanWeightSlope(0.0,0.001,b.shoreWeight);
   tx.y+=k*(dot(bedGrad,tx.xz)-tx.y)+penetration*dk*dw.x;
   tz.y+=k*(dot(bedGrad,tz.xz)-tz.y)+penetration*dk*dw.y;
  }
 }
 return mat2x3f(tx,tz);
}
fn oceanCompositeTangents(p:vec2f,footprint:f32)->mat2x3f {return oceanCompositeTangentsMask(p,footprint,15u);}
// Optical high-frequency detail is independent of mean-bed depth as well as
// shore/film takeover. A wave covering dry mean-bed still carries fine waves.
// The accepted attenuated FFT derivative above stays physical (including spray).
fn oceanFftOpticalTangents(p:vec2f,footprint:f32)->mat2x3f {
 var dx=vec3f(0.0);var dz=vec3f(0.0);
 for(var c=0;c<4;c++){
  let lod=oceanLod(footprint,c);let uv=oceanUv(p,c);
  let d=textureSampleLevel(oceanDerivatives,smpLinearRepeat,uv,c,lod);
  let crossD=textureSampleLevel(oceanCross,smpLinearRepeat,uv,c,lod).x;
  dx+=vec3f(ocean.choppiness*d.z,d.x,ocean.choppiness*crossD);
  dz+=vec3f(ocean.choppiness*crossD,d.y,ocean.choppiness*d.w);
 }
 return mat2x3f(vec3f(1.0,0.0,0.0)+dx,vec3f(0.0,0.0,1.0)+dz);
}
fn oceanNormalFromTangents(t:mat2x3f)->vec3f {
 let n=cross(t[1],t[0]);return n/max(1e-6,length(n));
}
fn oceanSurfaceNormal(p:vec2f,footprint:f32)->vec3f {
 return oceanNormalFromTangents(oceanCompositeTangents(p,footprint));
}
fn waterSurfaceSeaDepth(p:vec2f)->f32{return frame.seaLevel-oceanBed(p);}
fn oceanFilmBedNormal(p:vec2f,footprint:f32)->vec3f {
 let e=max(0.01,min(0.25,footprint));let x=vec2f(e,0.0);let z=vec2f(0.0,e);
 let slope=vec2f(oceanBed(p+x)-oceanBed(p-x),oceanBed(p+z)-oceanBed(p-z))/(2.0*e);
 return normalize(vec3f(-slope.x,1.0,-slope.y));
}
`});
    this.module=new ShaderModule({name:'waterSurface',deps:[this.displacementModule,shore.pageModule],bindings:{oceanFoamPores:{texture:()=>this.foamTexture}},code:OCEAN_FOAM_SURFACE_WGSL+`
struct WaterSurfaceVertex {position:vec3f,lagXZ:vec2f,height:f32,depth:f32,foam:f32,shoreN:vec3f,shoreFoam:f32,swash:f32,surfMask:vec2f};
fn oceanProjectedPoint(grid:vec2f)->vec2f {
 let scale=1.12+min(0.65,waterSurface.hs/max(0.5,abs(frame.cameraPos.y-frame.seaLevel))*0.6);
 let qa=frame.invProj*vec4f(grid.x*scale,0.0,1.0,1.0);let qb=frame.invProj*vec4f(0.0,scale,0.0,0.0);
 let a=(frame.invView*vec4f(qa.xyz,0.0)).y;let b=(frame.invView*vec4f(qb.xyz,0.0)).y;
 var ndc=grid*scale;if(abs(b)>1e-7){let horizon=-a/b;let below=(frame.seaLevel-frame.cameraPos.y)*b>0.0;let lo=select(-1.0,clamp(horizon-0.04,-1.0,1.0),below);let hi=select(clamp(horizon+0.04,-1.0,1.0),1.0,below);ndc=vec2f(grid.x*scale,(lo+(hi-lo)*(grid.y*0.5+0.5))*scale);}
 // Reversed-Z far endpoint is 0. A direction uses xyz before division; this
 // also works with infinite-far projections whose homogeneous w is zero.
 let q=frame.invProj*vec4f(ndc,0.0,1.0);let ray=normalize((frame.invView*vec4f(q.xyz,0.0)).xyz);
 var distance=waterSurface.maxDistance;if(abs(ray.y)>1e-7){let t=(frame.seaLevel-frame.cameraPos.y)/ray.y;if(t>0.0){distance=min(t,distance);}}
 return frame.cameraPos.xz+ray.xz*distance;
}
fn waterSurfaceVertex(node:vec4f,grid:vec2f)->WaterSurfaceVertex {
 let p=oceanProjectedPoint(grid);let px=oceanProjectedPoint(grid+vec2f(2.0/256.0,0.0));let pz=oceanProjectedPoint(grid+vec2f(0.0,2.0/128.0));
 let footprint=max(0.01,max(length(px-p),length(pz-p))*0.5);let d=oceanCompositeDisplacement(p,footprint);let blend=oceanSurfaceBlendAt(p,footprint);
 var o:WaterSurfaceVertex;o.position=vec3f(p.x+d.x,frame.seaLevel+d.y,p.y+d.z);o.lagXZ=p;o.height=d.y;o.depth=waterSurfaceSeaDepth(p);o.foam=d.a;
 // The covered thin sheet follows the immutable bed, including its normal.
 // No smooth-max height bump or arbitrary centimetres of water are added.
 let gap=max(0.0,o.position.y-oceanBed(o.position.xz));let bedN=oceanFilmBedNormal(o.position.xz,footprint);
 let gentle=1.0-smoothstep(0.25,0.45,length(bedN.xz)/max(1e-6,bedN.y));
 let film=blend.shoreWeight*(1.0-smoothstep(0.02,0.35,gap))*gentle;
 var vertexT=oceanCompositeTangents(p,footprint);let bedSlope=-bedN.xz/max(1e-6,bedN.y);
 vertexT[0].y=mix(vertexT[0].y,dot(bedSlope,vertexT[0].xz),film);
 vertexT[1].y=mix(vertexT[1].y,dot(bedSlope,vertexT[1].xz),film);
 o.shoreN=oceanNormalFromTangents(vertexT);
 o.shoreFoam=0.0;o.swash=film;o.surfMask=vec2f(footprint,film);return o;
}
// Optics consumes these separately: clear normal for Snell/Fresnel/GGX,
// foam normal + material for its own Principled direct and environment blend.
struct OceanFoamMaterial {normal:vec3f,baseColor:vec3f,roughness:f32,specular:f32};
struct OceanSurfaceMedium {absorb:vec3f,scatter:vec3f,surf:f32,phaseG:f32,phaseWeight:f32,backscatter:f32};
fn oceanSurfaceMedium(depth:f32,aeration:f32)->OceanSurfaceMedium {
 let surf=(1.0-smoothstep(0.3,4.5,depth))*smoothstep(0.0,0.15,depth)*aeration;
 return OceanSurfaceMedium(frame.waterAbsorption+vec3f(0.10,0.20,0.62)*surf*0.18,frame.waterScattering+vec3f(0.9,1.0,0.85)*surf*0.24,surf,0.86,0.7,mix(0.035,0.06,clamp(surf*2.0,0.0,1.0)));
}
struct WaterSurfaceFrag {normal:vec3f,foamNormal:vec3f,foamMaterial:OceanFoamMaterial,medium:OceanSurfaceMedium,foam:f32,coverage:f32,slopes:vec2f,jacobian:f32,rough:f32,aeration:f32,gust:f32,slick:f32};
${OCEAN_NORMAL_FILTER_WGSL}
fn waterSurfaceFragment(p:vec2f,footprint:f32,depth:f32,vertexFoam:f32,shoreN:vec3f,shoreFoam:f32,extraFoam:f32,state:vec4f,surfMask:vec2f,P:vec3f)->WaterSurfaceFrag {
 let pixelDx=dpdx(p);let pixelDy=dpdy(p);
 let t=oceanCompositeTangents(p,footprint);
 let support=oceanPageSupport(p);
 // Macro surface follows the same blended displacement. Restore all pixel
 // FFT fine derivatives AFTER film conformance; do not subtract them back to
 // the interpolated mesh normal or attenuate them by shore/cache membership.
 let macroFootprint=max(surfMask.x,footprint);var baseT=oceanCompositeTangents(p,macroFootprint);
 let bedN=oceanFilmBedNormal(P.xz,footprint);let bedSlope=-bedN.xz/max(1e-6,bedN.y);let filmWeight=clamp(surfMask.y,0.0,1.0);
 baseT[0].y=mix(baseT[0].y,dot(bedSlope,baseT[0].xz),filmWeight);
 baseT[1].y=mix(baseT[1].y,dot(bedSlope,baseT[1].xz),filmWeight);
 var fftPixel=oceanFftOpticalTangents(p,footprint);
 if(waterSurface.normalFilter>0.5){fftPixel=oceanFftOpticalTangentsGrad(p,pixelDx,pixelDy);}
 let fftMacro=oceanFftOpticalTangents(p,macroFootprint);
 let optical=mat2x3f(oceanFullFftDetailTangent(baseT[0],fftPixel[0],fftMacro[0]),oceanFullFftDetailTangent(baseT[1],fftPixel[1],fftMacro[1]));
 let normal=oceanNormalFromTangents(optical);
 let j=t[0].x*t[1].z-t[0].z*t[1].x;
 let shoreDensity=state.x*0.72*support.x;let coverage=1.0-exp(-5.0*shoreDensity);let fftDensity=oceanFarDisplacement(p,footprint).a*(1.0-support.x*0.75);
 let film=oceanFoamFilm(P.xz,p,fftDensity,shoreDensity,footprint,j,P.y);
 // Only foam has the accepted 1.75 mm differentiated pore relief.
 var foamNormal=oceanSurfaceNormal(p,max(0.75,footprint));
 foamNormal=oceanFoamNormalGuard(foamNormal);
 let pdx=dpdx(P);let pdy=dpdy(P);let r1=cross(pdy,foamNormal);let r2=cross(foamNormal,pdx);let determinant=dot(pdx,r1);
 if(abs(determinant)>1e-6){foamNormal=normalize(foamNormal-(dpdx(film.relief)*r1+dpdy(film.relief)*r2)/determinant);}
 var o:WaterSurfaceFrag;o.normal=normal;o.foamNormal=foamNormal;o.foamMaterial=OceanFoamMaterial(foamNormal,vec3f(0.98),0.78,0.5);
 o.foam=film.coverage;o.coverage=coverage;o.slopes=-normal.xz/max(0.05,abs(normal.y));o.jacobian=j;
 // Fresh accepted profile impact/roller source, never transported density.
 o.aeration=clamp(oceanCachedShore(p,footprint).a,0.0,1.0);
 o.medium=oceanSurfaceMedium(max(0.0,frame.seaLevel-oceanBed(P.xz)),o.aeration);
 o.rough=1.0;o.gust=0.5;o.slick=0.0;return o;
}`});
  }
  dispose(){this.params.buffer?.destroy();}
}
