                                                                           
                                                                               
import {GPU,Texture,StorageBuffer,UniformBlock,ShaderModule,ComputeKernel,commonModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {assertNativeBed,createTidewaterShoreField,tidewaterShoreSettings,fitShoreTiles} from './ocean_numeric.js';
import {OCEAN_FOAM_WGSL} from './ocean_foam.js';
import {shoreReviewLayout} from './ocean_shore_review.js';
import {ShorePages} from './ocean_shore_pages.js';
import {createSwashCoupling,SWASH_COUPLING_WGSL} from './ocean_swash_coupling.js';

export const SHORE_WGSL =           `
struct OceanShoreWave { disp:vec3f, density:f32, progress:f32, weight:f32, swash:vec4f };
fn oceanBedKnown(p:vec2f)->bool {let uv=(p-shoreP.domain.xy)/shoreP.domain.zw;return shoreP.hasBed>0u&&all(uv>=vec2f(0.0))&&all(uv<=vec2f(1.0));}
fn oceanBed(p:vec2f)->f32 {if(!oceanBedKnown(p)){return frame.seaLevel-1000.0;}return terrainHeightAt(p);}
fn oceanFieldAt(p:vec2f,layer:i32)->vec4f {
 let q=clamp((p-shoreP.domain.xy)/shoreP.domain.zw*vec2f(textureDimensions(oceanShoreField))-0.5,vec2f(0.0),vec2f(textureDimensions(oceanShoreField))-1.0);
 let i=vec2i(floor(q));let j=min(i+vec2i(1),vec2i(textureDimensions(oceanShoreField))-1);let f=fract(q);
 return mix(mix(textureLoad(oceanShoreField,i,layer,0),textureLoad(oceanShoreField,vec2i(j.x,i.y),layer,0),f.x),mix(textureLoad(oceanShoreField,vec2i(i.x,j.y),layer,0),textureLoad(oceanShoreField,j,layer,0),f.x),f.y);
}
fn oceanWaveAmp(m:f32,along:f32)->f32 {
 let waveSet=0.55+0.6*(0.5-0.5*cos(m*6.283185307179586/7.0));let rnd=sin(m*2.399963+0.71);let warp=sin(along*0.016+m*0.9)*1.6;
 let a1=sin(along*0.062+m*1.7+warp);let a2=sin(along*0.13+m*4.1+1.3-warp*0.7);
 let a3=0.6*sin(along*0.29+m*2.3+warp*0.5)+0.4*sin(along*0.47+m*5.9+0.8);
 return 0.24*shoreP.hs*waveSet*max(0.2,1.0+rnd*0.16+(0.6*a1+0.4*a2+0.28*a3)*0.3);
}
struct OceanBreak { b:f32,ash:f32,p:f32,meanP:f32,crestPeak:f32,H:f32,ycB:f32,ytB:f32,bore:f32,Xi:f32,Hb:f32,Xc:f32,Wt:f32 };
fn oceanBreak(A:f32,depth:f32)->OceanBreak {
 var P:OceanBreak;let hs=shoreP.hs;let db=max(1e-6,pow(max(0.0,A)*3.556/0.78,0.8));P.b=(db-depth)/(db*0.55);
 let rawAsh=A*pow(10.0/clamp(depth,max(1e-5,hs*0.12),10.0),0.25);
 P.ash=rawAsh/pow(1.0+pow(rawAsh/max(1e-6,hs*0.65),4.0),0.25);P.p=mix(1.0,3.0,smoothstep(-2.5,0.0,P.b));P.meanP=inverseSqrt((P.p+0.25)*3.141592653589793);
 P.crestPeak=1.0+smoothstep(-1.0,0.3,P.b)*0.22;P.H=P.ash*2.0*P.crestPeak;
 let yc=P.H*(1.0-P.meanP);let yt=-P.H*P.meanP;P.bore=smoothstep(0.85,1.35,P.b);P.Xi=P.H*0.8;
 P.Hb=min(P.H*0.6,max(0.0,depth)*0.75)*(0.3+0.7*smoothstep(0.0,max(1e-5,hs*0.3),depth));
 P.ycB=mix(yc,yt*0.6+P.Hb,P.bore);P.ytB=mix(yt,yt*0.6,P.bore);P.Xc=(P.Xi-P.Hb*0.55)*P.bore*smoothstep(hs*0.03,max(1e-5,hs*0.3),P.Hb);
 P.Wt=mix(P.H*mix(0.25,0.55,smoothstep(0.1,0.9,P.b)),P.Hb*0.6+hs*0.04,P.bore);return P;
}
fn oceanShoreShape(u:f32,A:f32,depth:f32,wavelength:f32,footprint:f32)->vec4f {
 let P=oceanBreak(A,depth);let lam=max(1e-5,wavelength);let hs=shoreP.hs;let tau=6.283185307179586;
 let phi=u-smoothstep(-3.0,0.0,P.b)*0.55*(1.0-cos(u*tau))/tau;
 let yPre=P.ash*2.0*(pow(max(0.0,(cos(phi*tau)+1.0)*0.5),P.p)-P.meanP)*P.crestPeak;
 let xPre=sin(u*tau)*P.ash*(0.1+smoothstep(-3.0,0.0,P.b)*0.25);
 let uf=max(1e-6,min(0.09,P.H*1.4/lam));let th=clamp(-u/uf,0.0,1.0)*1.570796326794897;
 let fx=mix(1.0-cos(th),sin(th),P.bore);let fy=mix(1.0-sin(th),cos(th),P.bore);let xToe=P.Xc+P.Wt-uf*lam;
 let xFront=mix(P.Xc+P.Wt*fx+u*lam,xToe*exp(-max(0.0,-u-uf)*lam/max(1e-5,P.H*1.5)),smoothstep(uf*0.94,uf*1.06,-u));
 let yFront=P.ytB+(P.ycB-P.ytB)*fy;let cb=pow(max(0.0,(cos(u*tau*0.85)+1.0)*0.5),P.p);
 let yBack=P.ytB+(P.ycB-P.ytB)*mix(cb,exp(-max(0.0,u)*7.0),P.bore);
 let xBack=P.Xc*exp(-max(0.0,u)*6.0)*(1.0-smoothstep(0.35,0.5,u))+xPre*(1.0-P.bore);
 let support=max(1e-6,footprint);let curlSupport=smoothstep(2.0,5.0,uf*lam/support);let lipSupport=smoothstep(2.0,4.0,0.027*lam/support);
 // Filter unresolved overturning, not the physical collapse into a bore.
 // Falling back to yPre for a collapsed wave resurrects a tall offshore crest
 // as the projected mesh footprint grows (especially at grazing views).
 let profileSupport=mix(curlSupport,1.0,P.bore);
 let curl=smoothstep(-0.35,0.25,P.b)*(1.0-smoothstep(0.28,0.48,abs(u)))*profileSupport;
 let lip=smoothstep(0.0,0.18,P.b)*(1.0-smoothstep(0.7,1.02,P.b))*exp(-pow((u+0.012)/0.027,2.0))*lipSupport;
 let joinWidth=max(uf*0.09,1.5*support/lam);let front=1.0-smoothstep(-joinWidth,joinWidth,u);
 let x=mix(xPre,mix(xBack,xFront,front),curl)+P.H*0.42*lip;
 let y=mix(yPre,mix(yBack,yFront,front),curl)-P.H*0.14*lip*smoothstep(0.25,0.85,P.b);
 let xi=x-u*lam;let reach=max(1e-5,P.Xi*0.25+clamp((P.b-0.9)/0.45,0.0,1.0)*(P.Xi*0.9+hs*0.5));
 let impact=smoothstep(0.86,0.99,P.b)*(1.0-smoothstep(reach*0.6,reach,abs(xi-P.Xi)))*(1.0-smoothstep(1.4,1.9,P.b));
 let fill=smoothstep(0.9+(1.0-fx)*0.45,1.08+(1.0-fx)*0.45,P.b);var roller=max(fill,P.bore);
 if(xi>P.Xc+P.Wt){roller=exp(-(xi-P.Xc-P.Wt)/max(1e-5,hs*0.22))*P.bore;}else if(xi<P.Xc){roller=exp((xi-P.Xc)/lam*16.0)*P.bore;}
 let foam=max(impact,roller)*(1.0-smoothstep(0.25,0.48,abs(u)))*smoothstep(0.12,0.45,hs);
 return vec4f(x,y,clamp(foam,0.0,1.0),P.b);
}
fn oceanShoreWave(phase:f32,along:f32,p:vec2f,direction:vec2f,depth:f32,lam:f32,footprint:f32)->vec4f {
 let m=floor(phase+0.5);let u=phase-m;let A=mix(oceanWaveAmp(m,along),oceanWaveAmp(m+select(1.0,-1.0,u<0.0),along),0.5*smoothstep(0.32,0.5,abs(u)));
 let crest=p+direction*(u*lam);var d=depth;if(oceanBedKnown(crest)){d=frame.seaLevel-oceanBed(crest);}
 return oceanShoreShape(u,A,mix(d,depth,smoothstep(0.3,0.5,abs(u))),lam,footprint);
}
${SWASH_COUPLING_WGSL}
fn oceanAnalyticShore(p:vec2f,footprint:f32)->OceanShoreWave {
 var o:OceanShoreWave;if(!oceanBedKnown(p)||shoreP.hs<=1e-6){return o;}
 let coast=oceanFieldAt(p,1);let field=oceanFieldAt(p,0);let confidence=smoothstep(0.02,0.8,coast.a);var exposure=length(field.yz);
 if(confidence<=0.0||exposure<1e-5||length(coast.yz)<0.1){return o;}
 let direction=field.yz/exposure;exposure*=smoothstep(-0.15,0.6,-dot(direction,normalize(coast.yz)));
 let bed=oceanBed(p);let depth=frame.seaLevel-bed;let ground=-depth;let hs=shoreP.hs;let period=shoreP.period;
 let lam=sqrt(9.81*clamp(depth,max(0.015,hs*0.12),25.0))*period;let coupling=oceanFieldAt(p,2);
 let along=coupling.x;let phase=(shoreP.time-field.x)/period;let width=min(0.32,max(0.0,footprint)/max(1e-5,lam));
 var wave=oceanShoreWave(phase,along,p,direction,depth,lam,footprint)*0.5;
 wave+=oceanShoreWave(phase-width*0.58,along,p,direction,depth,lam,footprint)*0.25;
 wave+=oceanShoreWave(phase+width*0.58,along,p,direction,depth,lam,footprint)*0.25;
 let waveFilter=1.0-smoothstep(0.2,0.65,max(0.0,footprint)/max(1e-5,lam));wave=vec4f(wave.xyz*waveFilter,wave.w);
 let event=oceanSwashEvent(field.x,field.a,coupling,ground,exposure);let swash=event.surface;let wash=oceanSwashBlend(ground);
 var y=mix(wave.y,ground+swash.z,wash);let wet=mix(1.0,swash.y,smoothstep(-hs*0.02,0.0,ground));let column=smoothstep(0.0,max(1e-6,hs*0.03),frame.seaLevel+y-bed);
 let horizontal=wave.x*(1.0-wash)*column;let displaced=p+direction*horizontal;if(!oceanBedKnown(displaced)){return o;}
 if(ground<=0.0){y=max(y,oceanBed(displaced)-frame.seaLevel+hs*0.001);}
 let m=floor(phase+0.5);let u=phase-m;let age=max(0.0,u)*period;let lace=0.55+0.25*sin(along*0.43+m*1.7+u*5.0)+0.2*sin(along*0.83-m*0.91+u*7.0);
 // Geometry handoff must not switch off the continuing roller's foam source.
 let density=max(wave.z*(0.4+0.6*clamp(lace,0.0,1.0))*exp(-age/4.5),swash.w*0.5);
 let uv=(p-shoreP.domain.xy)/shoreP.domain.zw;let muv=(displaced-shoreP.domain.xy)/shoreP.domain.zw;let edge=min(uv,1.0-uv)*shoreP.domain.zw;let me=min(muv,1.0-muv)*shoreP.domain.zw;
 let fade=max(shoreP.fieldCell.x,shoreP.fieldCell.y)*3.0;let domainFade=smoothstep(0.0,fade,min(edge.x,edge.y))*smoothstep(0.0,fade,min(me.x,me.y));
 let offshore=1.0-smoothstep(max(4.0,hs*12.0),max(8.0,hs*24.0),max(0.0,depth));let range=1.0-smoothstep(48.0*0.72,48.0,max(0.0,coast.x));
 o.weight=clamp(confidence*mix(exposure,1.0,smoothstep(-hs*0.22,0.0,ground))*domainFade*offshore*range*wet,0.0,1.0);
 o.disp=vec3f(direction.x*horizontal,y,direction.y*horizontal);o.density=clamp(density,0.0,1.0)*wet*column;o.progress=smoothstep(-0.4,1.35,wave.w)*wet;o.swash=swash;return o;
}
struct ShoreMedium { scatter:vec3f,absorb:vec3f };
fn shoreSurfMedium(p:vec2f,depth:f32)->ShoreMedium {let profile=oceanAnalyticShore(p,0.25);let surf=(1.0-smoothstep(0.3,4.5,depth))*smoothstep(0.0,0.15,depth)*profile.weight*profile.density;return ShoreMedium(vec3f(0.9,1.0,0.85)*surf*0.24,vec3f(0.1,0.2,0.62)*surf*0.18);}
fn shoreSwashEdge(p:vec2f,thickness:f32)->vec4f {
 let field=oceanFieldAt(p,0);let coupling=oceanFieldAt(p,2);let ground=oceanBed(p)-frame.seaLevel;
 let event=oceanSwashEvent(field.x,field.a,coupling,ground,length(field.yz));let sw=event.surface;let front=sw.x-max(0.0,ground);
 let margin=max(1e-6,shoreP.hs*0.045);return vec4f(min(thickness,front*0.08),front/max(0.08,margin),event.phase,sw.x);
}
fn oceanDryShoreFront(p:vec2f)->vec2f {
 // A positive mesh/bed gap alone cannot declare dry sand covered by water.
 // Evaluate the same swash event at the fragment's actual world position.
 if(shoreP.enabled==0u||!oceanBedKnown(p)){return vec2f(0.0);}
 let ground=oceanBed(p)-frame.seaLevel;if(ground<=0.0){return vec2f(0.0);}
 let coast=oceanFieldAt(p,1);let field=oceanFieldAt(p,0);
 if(coast.a<=0.02||coast.x>=48.0||length(field.yz)<1e-5||length(coast.yz)<0.1){return vec2f(0.0);}
 let event=oceanSwashEvent(field.x,field.a,oceanFieldAt(p,2),ground,length(field.yz));
 return vec2f(event.surface.x-ground,1.0);
}
fn oceanDryFrontCoverage(front:vec2f,width:f32)->f32 {
 return select(1.0,smoothstep(0.0,max(1e-6,width),front.x),front.y>0.0);
}
fn shoreCrestPath(p:vec2f,depth:f32,T:vec3f)->f32 {
 // Ray leaves the SAME attached corrected primary surface; bounded 12-tap
 // local march, not a separately rendered detached lip or assumed depth.
 let s=oceanAnalyticShore(p,0.25);if(s.weight<0.05||depth>6.0||s.disp.y<=shoreP.hs*0.05){return 1e4;}
 let y=frame.seaLevel+s.disp.y*s.weight;var prior=0.0;var gap0=0.0;
 for(var i=1;i<=12;i++){let t=f32(i)*max(0.1,shoreP.hs*0.18);let q=p+T.xz*t;let v=oceanAnalyticShore(q,0.25);let gap=y+T.y*t-(frame.seaLevel+v.disp.y*v.weight);
  if(gap>0.0){return mix(prior,t,clamp(-gap0/max(1e-5,gap-gap0),0.0,1.0));}prior=t;gap0=gap;
 }return 1e4;
}
`;

export class NativeShore {
  constructor(config,terrainApi,review=null,fineOptions={}) {
    this.fineOptions=fineOptions;
    this.native=assertNativeBed(terrainApi?.native);this.config=config;this.terrainApi=terrainApi;
    const n=this.native,extent=n?[(n.shape[1]-1)*n.spacing[0],(n.shape[0]-1)*n.spacing[1]]:[1,1];
    this.settings=tidewaterShoreSettings(config.significantHeight,config.winddirection);
    this.field=n?createTidewaterShoreField(n,config.sealevel,512,{hs:this.settings.hs,direction:this.settings.direction}):null;
    this.swashCoupling=createSwashCoupling(n,this.field,this.settings);
    if(this.field)delete this.field.native;
    const fieldLength=this.field?.data.length??4,data=new Float32Array(fieldLength*3);
    if(this.field){data.set(this.field.data);data.set(this.field.coast.data,fieldLength);}data.set(this.swashCoupling.data,fieldLength*2);
    this.fieldTexture=new Texture({label:'native travel, coastline and automatic swash coupling',width:this.field?.size??1,height:this.field?.size??1,depth:3,dimension:'2d-array',format:'rgba32float',data});
    this.params=new UniformBlock('NativeOceanShoreParams',{
      domain:['vec4f',[...(n?.origin??[0,0]),...extent]],fieldCell:['vec2f',this.field?.stats.texelSpacing??[1,1]],incident:['vec2f',this.settings.direction],
      swashDepth:['vec2f',this.swashCoupling.depths],
      hs:['f32',config.significantHeight],period:['f32',this.settings.period],time:['f32',0],dt:['f32',0],hasBed:['u32',n?1:0],wetness:['u32',config.wetness?1:0],caustics:['u32',config.caustics?1:0],enabled:['u32',config.enabled?1:0],
    });
                                                                               
                                                                         
    const bed=terrainApi?.terrainModule??new ShaderModule({name:'oceanOpenSeaBed',code:'fn terrainHeightAt(p:vec2f)->f32{return frame.seaLevel-1000.0;}'});
    if(n&&!terrainApi?.terrainModule)throw Error('Ocean native DEM requires terrainApi.terrainModule');
    this.module=new ShaderModule({name:'oceanShore',deps:[commonModule,bed],uniforms:this.params,uniformName:'shoreP',bindings:{oceanShoreField:{texture:this.fieldTexture,sampleType:'unfilterable-float'}},code:SHORE_WGSL});
                                                                               
                                                                               
                                                                
    this.layout=shoreReviewLayout(fitShoreTiles(n,config.sealevel,config.significantHeight,GPU.limits.maxTextureArrayLayers,this.field?.coast),review);
    this.steps=0;
  }
  attach(surface){this.pages=new ShorePages(this,surface,this.fineOptions);}
  update(dt,time,camera=null,height=900){return this.pages.update(dt,time,camera,height);}
  metadata(){return {native_sha256:this.native?.sha256??null,native_dem_mutated:false,field:this.field?.stats,coast:this.field?.coast.stats,settings:this.settings,swash_coupling:this.swashCoupling.stats,world_fixed:true,page_metres:this.layout.tileMetres,cell_metres:this.layout.tileMetres/this.layout.cells,resolution_adapted:this.layout.resolutionAdapted,pages:this.layout.tiles.length,review:this.layout.review??null,adaptive_foam:this.pages?.metadata(),halo_cells:this.layout.halo,state:'persistent foam, wetness, residue, signed speed; ping-pong synchronous commit',activity:'all resident pages integrate, independent of camera',wet_decay_seconds:28,life_seconds:this.pageParams?.fields.life.value,steps:this.steps,limitations:['first-order depth-capped eikonal; no diffraction or 3D liquid solve','explicit regional paging required beyond GPU array capacity']};}
  dispose(){this.pages?.dispose();for(const x of [this.fieldTexture,this.index,this.origins,this.profile,this.support,...(this.states??[])])x?.destroy();this.params.buffer?.destroy();this.pageParams?.buffer?.destroy();}
}


