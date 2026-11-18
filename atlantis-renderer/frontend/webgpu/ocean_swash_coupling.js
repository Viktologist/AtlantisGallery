import {tidewaterCrossSection} from '../src/ocean_tidewater_shore_math.js';

const G=9.81;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

                                                                               
                                                                                
export function calibrateSwashShape(settings){
 const {hs,period,amplitude,breakDepth}=settings;
 if(!(hs>0))return {depths:[.015,0],impactDelaySeconds:0,runupGain:0,launchSpeed:0,crestHeight:0,crestPhase:0};
                                                                             
                                                                             
 const referenceDepth=Math.max(hs*.18,breakDepth*.5);
 const joinDepth=breakDepth*(1-.55*1.1),fullDepth=breakDepth*(1-.55*1.35);
 const c=Math.sqrt(G*referenceDepth),wavelength=c*period;
 let crest=null;
 for(let i=0;i<=512;i++){
  const u=-.5+i/512,value=tidewaterCrossSection(u,amplitude,referenceDepth,wavelength,hs);
  if(!crest||value.y>crest.y)crest={...value,u};
 }
 const head=Math.max(0,crest.y),launch=c*head/Math.max(1e-6,referenceDepth+head);
 const runup=head+launch*launch/(2*G);
 const collapsed=tidewaterCrossSection(0,amplitude,fullDepth,Math.sqrt(G*fullDepth)*period,hs);
                                                                           
                                                                                  
 const fallTime=Math.sqrt(2*Math.max(0,head-collapsed.y)/G);
 const delay=clamp(Math.max(0,crest.u)*period+fallTime,period*.01,period*.22);
 return {depths:[joinDepth,fullDepth],impactDelaySeconds:delay,runupGain:runup/Math.max(1e-6,amplitude),launchSpeed:Math.sqrt(2*G*runup),crestHeight:head,crestPhase:crest.u};
}

function nativeHeight(native,x,z){
 const [nz,nx]=native.shape,[dx,dz]=native.spacing;
 const qx=clamp(x/dx,0,nx-1),qz=clamp(z/dz,0,nz-1);
 const ix=Math.min(nx-2,Math.floor(qx)),iz=Math.min(nz-2,Math.floor(qz)),fx=qx-ix,fz=qz-iz,k=iz*nx+ix,a=native.data;
 return (a[k]*(1-fx)+a[k+1]*fx)*(1-fz)+(a[k+nx]*(1-fx)+a[k+nx+1]*fx)*fz;
}

                                                                       
                                                                             
export function createSwashCoupling(native,field,settings){
 const shape=calibrateSwashShape(settings),size=field?.size??1,data=new Float32Array(size*size*4);
 let supported=0,minRise=Infinity,maxRise=0,minSlope=Infinity,maxSlope=0,minDistance=Infinity,maxDistance=0;
 const [sx,sz]=settings.direction,tangent=[-sz,sx];
 if(native&&field){
  const [width,height]=field.extent,spacing=Math.max(...native.spacing);
  for(let z=0;z<size;z++)for(let x=0;x<size;x++){
   const k=(z*size+x)*4,coast=field.coast.data,p=[(x+.5)/size*width,(z+.5)/size*height];
   const foot=[clamp(p[0]-coast[k]*coast[k+1],0,width),clamp(p[1]-coast[k]*coast[k+2],0,height)];
   const along=foot[0]*tangent[0]+foot[1]*tangent[1];
   data[k]=along;
   if(coast[k+3]<=.02||Math.hypot(field.data[k+1],field.data[k+2])<1e-5||!(settings.hs>0))continue;
                                                                            
                                                                             
                                                                      
   const probe=Math.max(4*spacing,settings.hs*2),base=nativeHeight(native,...foot);
   const inland=nativeHeight(native,foot[0]-coast[k+1]*probe,foot[1]-coast[k+2]*probe);
   const slope=Math.max(.02,Math.abs(inland-base)/probe);
                                                                        
                                                                            
   const rise=clamp(shape.launchSpeed/(G*slope),settings.period*.04,settings.period*.5-shape.impactDelaySeconds-settings.period*.04);
   data[k+1]=shape.impactDelaySeconds;data[k+2]=rise/settings.period;data[k+3]=shape.runupGain;
   supported++;minRise=Math.min(minRise,rise);maxRise=Math.max(maxRise,rise);minSlope=Math.min(minSlope,slope);maxSlope=Math.max(maxSlope,slope);
   const distance=shape.depths[0]/slope;minDistance=Math.min(minDistance,distance);maxDistance=Math.max(maxDistance,distance);
  }
 }
 return {data,depths:shape.depths,stats:{automatic:true,initialized:true,supported_texels:supported,period_seconds:settings.period,handoff_depth_m:shape.depths,
  post_impact_delay_seconds:shape.impactDelaySeconds,uprush_seconds:supported?[minRise,maxRise]:[],measured_slope_range:supported?[minSlope,maxSlope]:[],estimated_handoff_distance_m:supported?[minDistance,maxDistance]:[],
  runup_gain:shape.runupGain,reference_crest_height_m:shape.crestHeight,reference_crest_phase:shape.crestPhase,
  source:'incoming crest energy; existing half/full bore collapse depths; estimated crest fall time; native shoreline foot and beach slope',
  timing:'local underwater travel time, coastal arrival on land, then positive impact delay; prior swash returns during next local crest approach',
  limits:'single pulse per period; uprush ends before next local crest approach; nominal ballistic collapse estimate, no FFT phase lock or conserved SWE momentum'}};
}

export const SWASH_COUPLING_WGSL=        `
struct OceanSwashEvent {surface:vec4f,rate:f32,phase:f32,peak:f32,waveID:f32};
fn oceanSwashPulse(tau:f32,peak:f32)->vec2f {
 let up=tau<peak;let span=select(1.0-peak,peak,up);let s=clamp(select(tau-peak,tau,up)/span,0.0,1.0);
 let shape=s*s*(3.0-2.0*s);let value=select(1.0-shape,shape,up);let rate=select(-1.0,1.0,up)*6.0*s*(1.0-s)/span;
 return vec2f(value,rate);
}
fn oceanSwashBlend(ground:f32)->f32 {return 1.0-smoothstep(shoreP.swashDepth.y,shoreP.swashDepth.x,max(0.0,-ground));}
fn oceanSwashArrival(localTime:f32,shoreTime:f32,ground:f32)->f32 {
 // Wet points retain the incoming crest's spatial propagation. Dry beach
 // points share the coastal clock; runup height itself moves the inland edge.
 return mix(localTime,shoreTime,smoothstep(-shoreP.hs*0.02,0.0,ground));
}
fn oceanSwashClock(arrival:f32,delay:f32)->vec2f {
 let phase=(shoreP.time-arrival-delay)/shoreP.period;let m=floor(phase);return vec2f(m,phase-m);
}
fn oceanSwashEvent(localTime:f32,shoreTime:f32,coupling:vec4f,ground:f32,exposure:f32)->OceanSwashEvent {
 let clock=oceanSwashClock(oceanSwashArrival(localTime,shoreTime,ground),coupling.y);let m=clock.x;let tau=clock.y;let peak=clamp(coupling.z,0.01,0.99);let pulse=oceanSwashPulse(tau,peak);
 let maximum=oceanWaveAmp(m,coupling.x)*coupling.w*clamp(exposure,0.0,1.0);let runup=maximum*pulse.x;
 let margin=max(1e-6,shoreP.hs*0.045);let inland=max(0.0,ground);let coverage=smoothstep(0.0,margin,runup-inland);
 let sheet=min(0.03,shoreP.hs*0.045)*pulse.x*coverage*clamp((runup-inland)/max(1e-6,shoreP.hs*0.2),0.0,1.0);
 var thick=sheet*smoothstep(0.0,0.03,ground);
 // Runup is the reachable BEACH elevation, not a second offshore wave head.
 // Keep the submerged mean column; the existing breaker supplies its height
 // through oceanSwashBlend. The sheet is at most 3 cm ON THE BEACH, and
 // starts smoothly on dry mean-bed; no submerged point receives this pulse.
 let depth=max(0.0,-ground);thick+=depth;
 // Backwash carries prior foam; it must not act as another uprush emitter.
 let edge=(1.0-smoothstep(margin,margin*3.0,abs(runup-inland)))*coverage*pulse.x*smoothstep(0.12,0.45,shoreP.hs)*smoothstep(0.0,0.2,pulse.y);
 return OceanSwashEvent(vec4f(runup,coverage,thick,edge),maximum*pulse.y/shoreP.period,tau,peak,m);
}
`;
