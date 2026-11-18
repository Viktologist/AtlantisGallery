import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {createLandscapeStream} from './landscape_stream.js';

                                                                               
                                                                          
                                                                      
export function landscapeWGSL(manifest) {
  const vec = a => `vec2f(${a.map(v => Number(v).toPrecision(10)).join(',')})`;
  const world=manifest.world_shape??manifest.shape?.map(n=>n-1);
  const ratio=world&&manifest.shape?[world[1]/(manifest.shape[1]-1),world[0]/(manifest.shape[0]-1)]:[1,1];
  return           `
struct LandscapeSample { color:vec4f, normal:vec4f };
struct LandscapeState { color:vec3f, perturb:vec3f, moment:f32, alpha4:f32, ao:f32, sand:f32 };
fn lpReadMacro(uv:vec2f,channel:i32,lod:f32)->vec4f{return ${manifest.streaming?'lpVirtualSample(0,uv,channel,lod)':'textureSampleLevel(lpMacro,smpLinearClamp,uv,channel,lod)'};}
fn lpReadWorld(uv:vec2f,channel:i32,lod:f32)->vec4f{return ${manifest.streaming?'lpVirtualSample(1,uv,channel,lod)':'textureSampleLevel(lpWorld,smpLinearClamp,uv,channel,lod)'};}
fn lpRotate(q:vec2f,t:i32)->vec2f {
 if(t==1){return vec2f(-q.y,q.x);}if(t==2){return -q;}if(t==3){return vec2f(q.y,-q.x);}return q;
}
fn lpTile(q:vec2f,dx:vec2f,dy:vec2f,index:i32,seed:i32)->LandscapeSample {
 let grid=vec2i(floor(q*.5));let f0=fract(q*.5);let f=f0*f0*(3.-2.*f0);
 var result:LandscapeSample;result.color=vec4f(0);result.normal=vec4f(0);
 for(var oy=0;oy<2;oy++){for(var ox=0;ox<2;ox++){
  let raw=(grid.x+ox)*73+(grid.y+oy)*151+seed*19;
  let h=((raw%4093)+4093)%4093;let turn=h%4;
  let uv=lpRotate(q,turn)+vec2f(f32(h%113)/113.,f32(h%127)/127.);
  let sx=lpRotate(dx,turn);let sy=lpRotate(dy,turn);
  let weight=select(1.-f.x,f.x,ox==1)*select(1.-f.y,f.y,oy==1);
  let color=textureSampleGrad(lpSource,smpAnisoRepeat,uv,index*2,sx,sy);
  var normal=textureSampleGrad(lpSource,smpAnisoRepeat,uv,index*2+1,sx,sy);
  normal=vec4f(lpRotate(normal.xy,(4-turn)%4),normal.zw);
  result.color+=weight*color;result.normal+=weight*normal;
 }}return result;
}
fn lpLandscape(P:vec3f,N:vec3f,dx:vec3f,dy:vec3f)->LandscapeState {
 let grid=(P.xz-terrainParams.origin)/terrainParams.spacing;
 let uv=(grid+.5)/terrainParams.shape;
 let footprint=max(length(dx.xz/terrainParams.spacing),length(dy.xz/terrainParams.spacing));
 let lod=max(0.,log2(max(footprint,1e-5)));
 let C=lpReadMacro(uv,0,${manifest.streaming?'lod':'0.'}).rgb;
 let w0=lpReadMacro(uv,1,${manifest.streaming?'lod':'0.'});
 let w1=lpReadMacro(uv,2,${manifest.streaming?'lod':'0.'});
 let ws=max(dot(w0,vec4f(1))+dot(w1,vec4f(1)),1e-8);
 let tri0=pow(abs(N),vec3f(4));let tri=tri0/max(dot(tri0,vec3f(1)),1e-8);
 let localP=P-vec3f(terrainParams.origin.x,0.,terrainParams.origin.y);
 var residual=vec3f(0);var g=vec3f(0);var moment=0.;var alpha4=0.;var ao=0.;
 var weights=array<f32,8>(w0.x/ws,w0.y/ws,w0.z/ws,w0.w/ws,w1.x/ws,w1.y/ws,w1.z/ws,w1.w/ws);
 let worldUv=grid/(terrainParams.shape-1.);
 let worldFootprint=max(length(dx.xz/terrainParams.spacing*${vec(ratio)}),length(dy.xz/terrainParams.spacing*${vec(ratio)}));
 let worldLod=max(0.,log2(max(worldFootprint,1e-5)));
 let farC=lpReadWorld(worldUv,0,worldLod);let farN=lpReadWorld(worldUv,1,worldLod);let farM=lpReadWorld(worldUv,2,worldLod);
 let detail=clamp(terrainParams.detail,0.,1.);
 // Source tiles are fully resident. Missing virtual macro/world pages may
 // coarsen the priors, but must never disable resolved repeating PBR detail.
 let blend=smoothstep(.5,1.5,worldFootprint);
 if(blend>=.99999){return LandscapeState(farC.rgb,farN.xyz*detail,farN.w*detail*detail,farM.a,farC.a,${manifest.materials.some(m=>m.role==='sand')?'weights['+manifest.materials.findIndex(m=>m.role==='sand')+']':'0.'});}
 let scales=array<vec2f,${manifest.materials.length}>(${manifest.materials.map(m => vec(m.tile_size_m)).join(',')});
 for(var i=0;i<${manifest.materials.length};i++){
  if(weights[i]<=0.){continue;}
  for(var axis=0;axis<3;axis++){
   if(tri[axis]<=1e-8){continue;}
   let signN=select(1.,-1.,N[axis]<0.);var T=vec3f(0);var B=vec3f(0);
   if(axis==0){T=vec3f(0,0,-signN);B=vec3f(0,1,0);}
   if(axis==1){T=vec3f(1,0,0);B=vec3f(0,0,-signN);}
   if(axis==2){T=vec3f(signN,0,0);B=vec3f(0,1,0);}
   let q=vec2f(dot(localP,T),dot(localP,B))/scales[i];
   let qx=vec2f(dot(dx,T),dot(dx,B))/scales[i];let qy=vec2f(dot(dy,T),dot(dy,B))/scales[i];
   let a=lpTile(q,qx,qy,i,${manifest.seed}+i*31+axis*101);let weight=weights[i]*tri[axis];
   residual+=weight*a.color.rgb;
   var v=a.normal.x*T+a.normal.y*B;v-=N*dot(N,v);g+=weight*v;
   moment+=weight*a.normal.z*(1.-.5*(pow(dot(T,N),2.)+pow(dot(B,N),2.)));
   alpha4+=weight*a.color.a;ao+=weight*a.normal.a;
  }
 }
 let correction=lpReadWorld(worldUv,2,0.).rgb;
 let normalScale=${manifest.normal_strength.toPrecision(10)}*detail;
 let nearColor=clamp(C+${manifest.detail_strength.toPrecision(10)}*detail*(C*residual-correction),vec3f(0),vec3f(1));
 return LandscapeState(mix(nearColor,farC.rgb,blend),mix(g*normalScale,farN.xyz*detail,blend),
  mix(moment*normalScale*normalScale,farN.w*detail*detail,blend),mix(alpha4,farM.a,blend),mix(ao,farC.a,blend),
  ${manifest.materials.some(m=>m.role==='sand') ? 'weights['+manifest.materials.findIndex(m=>m.role==='sand')+']' : '0.'});
}
`;
}

export async function createLandscapeMaterial(input, texture, terrainModule) {
  if (!input) return null;
  const textures = {};
  for (const [key, name] of [['source_textures','lpSource'],['macro_fields','lpMacro'],['world_mips','lpWorld']]) {
    if(input.virtual&&key!=='source_textures')continue;
    const {stack, levels} = input[key], first = stack.levels[0];
    const map = texture({label:'verified landscape '+key,width:first.width,height:first.height,depth:stack.layers,
      dimension:'2d-array',format:'rgba16float',mips:levels.length});
    map.getGPU();levels.forEach((data,mip)=>map.upload(data,{mip,layers:stack.layers}));
    map.apsPrefilteredLandscape=true;textures[name]={texture:map};
  }
  const stream=input.virtual?await createLandscapeStream(input,texture,terrainModule):null;
  return {module:new ShaderModule({name:'aps-compiled-landscape-pbr',deps:[terrainModule,stream?.module].filter(Boolean),bindings:textures,code:landscapeWGSL(input.manifest)}),
    surface:(stream?`lpRecordFeedback=(i32(in.pixel.x)%${input.virtual.layout.config.feedback_stride}==0)&&(i32(in.pixel.y)%${input.virtual.layout.config.feedback_stride}==0);\n`:'')+landscapeSurfaceWGSL,
    update:stream?.update,dispose:stream?.dispose,
    metadata:()=>({manifest:input.manifest,resident_bytes:input.residentBytes,source_mips:'verified prefiltered float16',world_mips:'verified mixed appearance',streaming:stream?.metadata()??null})};
}

export const landscapeSurfaceWGSL =           `
let lpP=apsTerrainNativePosition(in.P);let lpN=apsTerrainNativeNormal(in.N);
let lp=lpLandscape(lpP,lpN,dpdx(lpP),dpdy(lpP));
apsTerrainCurrent.baseColor=lp.color;apsTerrainCurrent.normal=apsTerrainWorldNormal(normalize(lpN+lp.perturb));
apsTerrainCurrent.roughness=clamp(pow(max(lp.alpha4+max(0.,lp.moment-dot(lp.perturb,lp.perturb)),.00000256),.25),.04,1.);
apsTerrainCurrent.occlusion=lp.ao;apsTerrainCurrent.metallic=0.;apsTerrainSandCoverage=lp.sand;
if(terrainParams.mode==17){apsTerrainCurrent.emission=lp.color;}
if(terrainParams.mode==14){apsTerrainCurrent.emission=apsTerrainCurrent.normal*.5+.5;}
if(terrainParams.mode==15){apsTerrainCurrent.emission=vec3f(apsTerrainCurrent.roughness);}
if(terrainParams.mode==23){apsTerrainCurrent.emission=vec3f(0.,apsTerrainCurrent.roughness,lp.ao);}
if(terrainParams.mode==24){apsTerrainCurrent.emission=vec3f(0);}
if(terrainParams.mode==25){apsTerrainCurrent.emission=vec3f(lp.ao);}
if(terrainParams.mode==35){apsTerrainCurrent.emission=vec3f(max(0.,lp.moment-dot(lp.perturb,lp.perturb)));}
`;
