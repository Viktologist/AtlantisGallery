import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
const clamp=(v,a,b,d)=>Number.isFinite(v)?Math.min(b,Math.max(a,v)):d;
const triple=value=>Array.isArray(value)&&value.length===3&&value.every(v=>Number.isFinite(v)&&v>0)?[...value]:null;
const roles=['rock','moss','lichen'];
function materials(value){
 const rows=Array.isArray(value)?value.slice(0,3):[];
 const result=rows.map((row,i)=>({...row,role:row?.role??roles[i],tile_size_m:Array.isArray(row?.tile_size_m)&&row.tile_size_m.length===2&&row.tile_size_m.every(v=>Number.isFinite(v)&&v>0)?[...row.tile_size_m]:[1,1],mean_linear:Array.isArray(row?.mean_linear)&&row.mean_linear.length===3&&row.mean_linear.every(v=>Number.isFinite(v))?[...row.mean_linear]:[.5,.5,.5]}));
 while(result.length<3){const i=result.length;result.push({role:roles[i],tile_size_m:[1,1],mean_linear:[.5,.5,.5]});}
 return result;
}
export function rockLayerOptions(input){
 const value=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
 const mode=['mixed','rock','moss','lichen'].includes(value.mode)?value.mode:'mixed';
 const tileSizeM=triple(value.tileSizeM),detailTileM=triple(value.detailTileM);
 return {...value,mode,tileSizeM:tileSizeM??undefined,detailTileM:detailTileM??undefined,detailStrength:clamp(value.detailStrength,0,1,0)};
}
export async function loadRockLayerPBR(input,baseURL,{Texture,digest,fetcher=fetch}={}){
 const options=rockLayerOptions(input),url=new URL(options.file,baseURL),r=await fetcher(url.href);
 if(!r.ok)throw Error('Rock layer PBR manifest unavailable');const raw=await r.arrayBuffer();
 const m=JSON.parse(new TextDecoder().decode(raw)),s=m.textures??{};
 m.materials=materials(m.materials);
 const levels=Array.isArray(s.levels)?s.levels:[],first=levels[0];
 if(first&&Number.isInteger(first.width)&&Number.isInteger(first.height)&&Math.max(first.width,first.height)>8192)throw Error('Rock PBR bank exceeds GPU limit');
 const decoded=[];let total=0;
 for(const v of levels){
  const r=await fetcher(new URL(v.file,url).href);if(!r.ok)throw Error('Rock PBR mip unavailable');const bytes=await r.arrayBuffer();total+=bytes.byteLength;if(total>192*1024**2)throw Error('Rock PBR resident budget exceeded');decoded.push(new Uint16Array(bytes));
 }
 const layers=Number.isInteger(s.layers)&&s.layers>0?s.layers:9;
 const texture=new Texture({label:'rock / moss / extracted lichen PBR',width:first?.width??1,height:first?.height??1,depth:layers,dimension:'2d-array',format:'rgba16float',mips:decoded.length});
 texture.getGPU();decoded.forEach((data,mip)=>texture.upload(data,{mip,layers}));
 return {texture,manifest:m,options,module:new ShaderModule({name:'aps-rock-layer-pbr',bindings:{apsRockPBRSource:{texture}},code:rockLayerWGSL(m,options)})};
}
const v3=a=>'vec3f('+a.map(n=>Number(n).toPrecision(10)).join(',')+')';
export function rockLayerWGSL(m,options){
 const sizes=options.tileSizeM??m.materials.map(a=>a.tile_size_m[0]);
 return           `
struct APSRockPBRRead{color:vec4f,normal:vec4f,data:vec4f};
struct APSRockPBRState{color:vec3f,normal:vec3f,roughness:f32,ao:f32,height:f32,weights:vec3f};
fn apsRockPBRTurn(p:vec2f,t:i32)->vec2f{if(t==1){return vec2f(-p.y,p.x);}if(t==2){return -p;}if(t==3){return vec2f(p.y,-p.x);}return p;}
// Existing landscape strategy: four continuous lattice blends, not abrupt tile
// rotations. All PBR maps share coordinates; tangent slopes inverse-rotate.
fn apsRockPBRTile(q:vec2f,dx:vec2f,dy:vec2f,index:i32,seed:i32)->APSRockPBRRead{
 let grid=vec2i(floor(q*.5));let f0=fract(q*.5);let f=f0*f0*(3.-2.*f0);var a=APSRockPBRRead(vec4f(0),vec4f(0),vec4f(0));
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let raw=(grid.x+x)*73+(grid.y+y)*151+seed*19;let h=((raw%4093)+4093)%4093;let turn=h%4;
  let uv=apsRockPBRTurn(fract(q),turn)+vec2f(f32(h%113)/113.,f32(h%127)/127.);let sx=apsRockPBRTurn(dx,turn);let sy=apsRockPBRTurn(dy,turn);
  let weight=select(1.-f.x,f.x,x==1)*select(1.-f.y,f.y,y==1);
  let c=textureSampleGrad(apsRockPBRSource,smpAnisoRepeat,uv,index*3,sx,sy);
  var n=textureSampleGrad(apsRockPBRSource,smpAnisoRepeat,uv,index*3+1,sx,sy);n=vec4f(apsRockPBRTurn(n.xy,(4-turn)%4),n.zw);
  let d=textureSampleGrad(apsRockPBRSource,smpAnisoRepeat,uv,index*3+2,sx,sy);a.color+=c*weight;a.normal+=n*weight;a.data+=d*weight;
 }}return a;
}
fn apsRockPBR(P:vec3f,N:vec3f,dx:vec3f,dy:vec3f,masks:vec3f,rockTint:vec3f)->APSRockPBRState{
 // Footprint fallback avoids all 108 fine texture reads at landscape distance.
 // It preserves unresolved normal variance in the roughness approximation.
 if(max(length(dx),length(dy))>.85){
  var w=masks;${options.mode==='rock'?'w=vec3f(1,0,0);':options.mode==='moss'?'w=vec3f(0,1,0);':options.mode==='lichen'?'w=vec3f(0,0,1);':''}
  w.z*=${Number(m.materials[2].coverage??1).toPrecision(10)};w.x=max(0.,1.-w.y-w.z);
  let color=w.x*rockTint+w.y*${v3(m.materials[1].mean_linear)}+w.z*${v3(m.materials[2].mean_linear)};
  let rough=pow(max(.00000256,dot(w,${v3(m.materials.map(a=>(a.mean_roughness4??.5)+.1225*(a.mean_slope_moment??0)))})),.25);
  return APSRockPBRState(color,N,clamp(rough,.04,1.),dot(w,${v3(m.materials.map(a=>a.mean_ao??1))}),0.,w);
 }
 let tri0=pow(abs(N),vec3f(4));let tri=tri0/max(dot(tri0,vec3f(1)),1e-8);let scales=array<f32,3>(${sizes.map(x=>Number(x).toPrecision(10)).join(',')});
 var reads:array<APSRockPBRRead,3>;var slopes:array<vec3f,3>;
 for(var i=0;i<3;i++){reads[i]=APSRockPBRRead(vec4f(0),vec4f(0),vec4f(0));slopes[i]=vec3f(0);
  for(var axis=0;axis<3;axis++){if(tri[axis]<=.001){continue;}let sn=select(1.,-1.,N[axis]<0.);var T=vec3f(0);var B=vec3f(0);
   if(axis==0){T=vec3f(0,0,-sn);B=vec3f(0,1,0);}if(axis==1){T=vec3f(1,0,0);B=vec3f(0,0,-sn);}if(axis==2){T=vec3f(sn,0,0);B=vec3f(0,1,0);}
   let q=vec2f(dot(P,T),dot(P,B))/scales[i];let qx=vec2f(dot(dx,T),dot(dx,B))/scales[i];let qy=vec2f(dot(dy,T),dot(dy,B))/scales[i];
   var r=apsRockPBRTile(q,qx,qy,i,17+i*31+axis*101);
   ${options.detailStrength>0&&options.detailTileM?`let microScale=array<f32,3>(${options.detailTileM.map(x=>Number(x).toPrecision(10)).join(',')})[i];
   let detailFade=(1.-smoothstep(.0007,.0035,max(length(dx),length(dy))))*${Number(options.detailStrength).toPrecision(10)};
   if(detailFade>0.){
    let mq=vec2f(dot(P,T),dot(P,B))/microScale;let mx=vec2f(dot(dx,T),dot(dx,B))/microScale;let my=vec2f(dot(dy,T),dot(dy,B))/microScale;
    let fine=apsRockPBRTile(mq,mx,my,i,137+i*41+axis*59);let fineSlope=fine.normal.xy*detailFade*.4;
    let moment=r.normal.z+fine.normal.z*pow(detailFade*.4,2.)+2.*dot(r.normal.xy,fineSlope);
    r.color=vec4f(r.color.rgb*(1.+detailFade*(fine.color.rgb-1.)),mix(r.color.a,fine.color.a,detailFade*.15));
    r.normal=vec4f(r.normal.xy+fineSlope,moment,r.normal.a);r.data.x+=fine.data.x*detailFade*.25;
   }`:''}
   reads[i].color+=r.color*tri[axis];reads[i].normal+=r.normal*tri[axis];reads[i].data+=r.data*tri[axis];
   var slope=r.normal.x*T+r.normal.y*B;slope-=N*dot(N,slope);slopes[i]+=slope*tri[axis];
  }
 }
 var w=masks;
 ${options.mode==='rock'?'w=vec3f(1,0,0);':options.mode==='moss'?'w=vec3f(0,1,0);':options.mode==='lichen'?'w=vec3f(0,0,1);':''}
 w.z*=reads[2].data.y;w.x=max(0.,1.-w.y-w.z);
 // Height refines only overlaps already admitted by the global masks.
 w*=exp(vec3f(reads[0].data.x,reads[1].data.x,reads[2].data.x)*1.5);w/=max(dot(w,vec3f(1)),1e-8);
 let tint=array<vec3f,3>(rockTint,${v3(m.materials[1].mean_linear)},${v3(m.materials[2].mean_linear)});
 var color=vec3f(0);var slope=vec3f(0);var moment=0.;var alpha4=0.;var ao=0.;var height=0.;
 for(var i=0;i<3;i++){color+=w[i]*reads[i].color.rgb*tint[i];slope+=w[i]*slopes[i]*.35;moment+=w[i]*reads[i].normal.z*.1225;alpha4+=w[i]*reads[i].color.a;ao+=w[i]*reads[i].normal.a;height+=w[i]*reads[i].data.x*.001;}
 let rough=pow(max(.00000256,alpha4+max(0.,moment-dot(slope,slope))),.25);
 return APSRockPBRState(clamp(color,vec3f(0),vec3f(1)),normalize(N+slope),clamp(rough,.04,1.),clamp(ao,0.,1.),height,w);
}
`;
}
