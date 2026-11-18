import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';

export function createGroundDetail(input,texture){
 if(!input)return null;
 const m=input.manifest,bindings={};
 for(const [key,name] of [['texture','gdSource'],['fields','gdBiome'],['world','gdWorld']]){
  const stack=m[key],first=stack.levels[0],map=texture({label:'verified basal '+key,width:first.width,height:first.height,depth:stack.layers,dimension:'2d-array',format:'rgba16float',mips:stack.levels.length});
  map.getGPU();input[key].forEach((v,mip)=>map.upload(v,{mip,layers:stack.layers}));map.apsPrefilteredLandscape=true;bindings[name]={texture:map};
 }
 const sizes=m.materials.map(x=>`vec2f(${x.tile_size_m.join(',')})`).join(',');
 return new ShaderModule({name:'aps-real-soil-sparse-dense-PBR',bindings,code:`
struct GDScan{color:vec4f,normal:vec4f,height:f32};
struct GDState{color:vec3f,normal:vec3f,rough:f32,ao:f32};
fn gdTurn(q:vec2f,t:i32)->vec2f{if(t==1){return vec2f(-q.y,q.x);}if(t==2){return -q;}if(t==3){return vec2f(q.y,-q.x);}return q;}
fn gdTile(q:vec2f,dx:vec2f,dy:vec2f,index:i32)->GDScan{
 let cell=vec2i(floor(q*.5));let f0=fract(q*.5);let f=f0*f0*(3.-2.*f0);
 var a=GDScan(vec4f(0),vec4f(0),0.);var sum=0.;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let raw=(cell.x+x)*73+(cell.y+y)*151+index*431+817;
  let h=((raw%4093)+4093)%4093;let turn=h%4;
  let uv=gdTurn(q,turn)+vec2f(f32(h%113)/113.,f32(h%127)/127.);
  let u=gdTurn(dx,turn);let v=gdTurn(dy,turn);
  let base=select(1.-f.x,f.x,x==1)*select(1.-f.y,f.y,y==1);
  let c=textureSampleGrad(gdSource,smpAnisoRepeat,uv,index*3,u,v);
  let n=textureSampleGrad(gdSource,smpAnisoRepeat,uv,index*3+1,u,v);
  let z=textureSampleGrad(gdSource,smpAnisoRepeat,uv,index*3+2,u,v).r;
  let w=base*exp(8.*(z-.5));sum+=w;
  a.color+=w*c;a.normal+=w*vec4f(gdTurn(n.xy,(4-turn)%4),n.zw);a.height+=w*z;
 }}a.color/=sum;a.normal/=sum;a.height/=sum;return a;
}
fn gdGround(P:vec3f,N:vec3f,base:vec3f,baseN:vec3f,baseR:f32,baseAO:f32,dx:vec3f,dy:vec3f)->GDState{
 let local=P.xz-vec2f(${m.origin_xz_m.join(',')});let extent=vec2f(${m.extent_xz_m.join(',')});let uv=local/extent;
 let dims=vec2i(textureDimensions(gdBiome));let pixel=clamp(vec2i(floor(uv*vec2f(dims))),vec2i(0),dims-vec2i(1));
 let hard=textureLoad(gdBiome,pixel,0,0).r;
 if(hard<.5){return GDState(base,baseN,baseR,baseAO);}
 let field=textureSampleGrad(gdBiome,smpLinearClamp,uv,0,dx.xz/extent,dy.xz/extent);
 let support=clamp(field.g,0.,1.)*select(0.,1.,hard>.5);
 let density=clamp(field.b,0.,1.);
 let axis=select(vec3f(1,0,0),vec3f(0,0,1),abs(N.x)>.95);let T=normalize(axis-N*dot(N,axis));let B=normalize(cross(T,N));
 let dxUV=dx.xz/extent;let dyUV=dy.xz/extent;
 let permit=select(0.,1.,hard>.5);
 let worldC=textureSampleGrad(gdWorld,smpLinearClamp,uv,0,dxUV,dyUV)*permit;
 let worldN=textureSampleGrad(gdWorld,smpLinearClamp,uv,1,dxUV,dyUV)*permit;
 let worldAO=textureSampleGrad(gdWorld,smpLinearClamp,uv,2,dxUV,dyUV).r*permit;
 let S=clamp(worldC.a,0.,1.);let denominator=max(S,1e-8);let mean=worldN.xy/denominator;
 let farNormal=normalize(mix(baseN,normalize(N+T*mean.x+B*mean.y),S));
 let farA4=clamp(worldN.a/denominator+max(0.,worldN.z/denominator-dot(mean,mean)),.00000256,1.);
 let farState=GDState(base*(1.-S)+worldC.rgb,farNormal,pow(mix(pow(baseR,4.),farA4,S),.25),baseAO*(1.-S)+worldAO);
 let worldDims=vec2f(${m.world_shape[1]},${m.world_shape[0]});
 let footprint=max(length(dxUV*worldDims),length(dyUV*worldDims));let farBlend=smoothstep(.5,1.5,footprint);
 if(farBlend>=.99999){return farState;}
 var ws=array<f32,3>(1.-support,support*(1.-density),support*density);
 let scales=array<vec2f,3>(${sizes});var scans:array<GDScan,3>;
 var total=0.;
 for(var i=0;i<3;i++){
  scans[i]=gdTile(local/scales[i],dx.xz/scales[i],dy.xz/scales[i],i);
  // Normalized scan height only biases overlap; this is not DEM displacement.
  ws[i]=max(0.,ws[i]+.35*(scans[i].height-.5)*ws[i]*(1.-ws[i]));total+=ws[i];
 }
 var c=vec3f(0);var slope=vec2f(0);var moment=0.;var a4=0.;var ao=0.;
 for(var i=0;i<3;i++){let w=ws[i]/max(total,1e-8);c+=scans[i].color.rgb*w;slope+=scans[i].normal.xy*w;moment+=scans[i].normal.z*w;a4+=scans[i].color.a*w;ao+=scans[i].normal.a*w;}
 let variance=max(0.,moment-dot(slope,slope));let rough=clamp(pow(max(a4+variance,.00000256),.25),.04,1.);
 let normal=normalize(N+T*slope.x+B*slope.y);
 return GDState(mix(mix(base,c,support),farState.color,farBlend),normalize(mix(normalize(mix(baseN,normal,support)),farState.normal,farBlend)),mix(pow(mix(pow(baseR,4.),pow(rough,4.),support),.25),farState.rough,farBlend),mix(mix(baseAO,ao,support),farState.ao,farBlend));
}
`});
}

export const groundDetailSurfaceWGSL=`
let gdNativeP=apsTerrainNativePosition(in.P);
let gd=gdGround(gdNativeP,apsTerrainNativeNormal(in.N),apsTerrainCurrent.baseColor,apsTerrainNativeNormal(apsTerrainCurrent.normal),apsTerrainCurrent.roughness,apsTerrainCurrent.occlusion,dpdx(gdNativeP),dpdy(gdNativeP));
apsTerrainCurrent.baseColor=gd.color;apsTerrainCurrent.normal=apsTerrainWorldNormal(gd.normal);apsTerrainCurrent.roughness=gd.rough;apsTerrainCurrent.occlusion=gd.ao;
if(terrainParams.mode==17){apsTerrainCurrent.emission=gd.color;}
if(terrainParams.mode==14){apsTerrainCurrent.emission=apsTerrainCurrent.normal*.5+.5;}
if(terrainParams.mode==15){apsTerrainCurrent.emission=vec3f(gd.rough);}
if(terrainParams.mode==25){apsTerrainCurrent.emission=vec3f(gd.ao);}
`;
