import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';

                                                                             
                                                                              
                                                                          
const roles=['rock','soil','sand','mud','gravel','litter'];
function materials(value){
 const rows=Array.isArray(value)?value.slice(0,6):[];
 return rows.map((row,i)=>({...row,role:row?.role??roles[i],tile_size_m:Array.isArray(row?.tile_size_m)&&row.tile_size_m.length===2&&row.tile_size_m.every(v=>Number.isFinite(v)&&v>0)?[...row.tile_size_m]:[1,1]}))
  .concat(Array.from({length:Math.max(0,6-rows.length)},(_,i)=>({role:roles[rows.length+i],tile_size_m:[1,1]})));
}
export async function loadTerrainPBR({fetcher=fetch,digest,limit=8192}={}){
 const url=new URL('../../assets/terrain_pbr/library.json',import.meta.url);
 const response=await fetcher(url.href);if(!response.ok)throw Error('Renderer terrain PBR library unavailable');
 const manifest=JSON.parse(new TextDecoder().decode(await response.arrayBuffer())),stack=manifest.textures??{};
 manifest.materials=materials(manifest.materials);
 const levels=Array.isArray(stack.levels)?stack.levels:[];
 const first=levels[0];
 if(first&&Number.isInteger(first.width)&&Number.isInteger(first.height)&&Math.max(first.width,first.height)>limit)throw Error('Renderer terrain PBR texture exceeds GPU limit');
 const decoded=[];
 for(const level of levels){
  const r=await fetcher(new URL(level.file,url).href);if(!r.ok)throw Error('Renderer PBR mip unavailable');const bytes=await r.arrayBuffer();
  decoded.push(new Uint16Array(bytes));
 }
 return {manifest,levels:decoded};
}

export function terrainPBRCode(m){
 const scales=m.materials.map(a=>'vec2f('+a.tile_size_m.join(',')+')').join(',');
 return           `
struct TerrainTile {color:vec4f,normal:vec4f};
fn tpTurn(q:vec2f,t:i32)->vec2f{if(t==1){return vec2f(-q.y,q.x);}if(t==2){return -q;}if(t==3){return vec2f(q.y,-q.x);}return q;}
fn tpTile(q:vec2f,dx:vec2f,dy:vec2f,index:i32)->TerrainTile{
 // A standard repeating source needs one colour/data and one normal sample.
 // The expensive four-neighbour stochastic tile blend belongs to the explicit
 // compiled landscape route, rather than every default terrain fragment.
 let t=(index*3)%4;let uv=tpTurn(q,t);
 let a=textureSampleGrad(tpSource,smpAnisoRepeat,uv,index*2,tpTurn(dx,t),tpTurn(dy,t));
 let n=textureSampleGrad(tpSource,smpAnisoRepeat,uv,index*2+1,tpTurn(dx,t),tpTurn(dy,t));
 return TerrainTile(a,vec4f(tpTurn(n.xy,(4-t)%4),n.zw));
}
fn tpSurface(P:vec3f,N:vec3f,dx:vec3f,dy:vec3f,base:vec3f,w:vec4f,litter:f32,gravel:f32)->TerrainTile{
 let scales=array<vec2f,6>(${scales});let l=clamp(litter,0.,1.)*w.y;let gravelWeight=clamp(gravel,0.,max(0.,w.y-l));
 let weights=array<f32,6>(w.x,max(0.,w.y-l-gravelWeight),w.z,w.w,gravelWeight,l);
 let tri0=pow(abs(N),vec3f(4));let tri=tri0/max(dot(tri0,vec3f(1)),1e-8);
 var residual=vec3f(0);var g=vec3f(0);var moment=0.;var alpha=0.;var ao=0.;
 let local=P-vec3f(terrainParams.origin.x,0,terrainParams.origin.y);
 for(var i=0;i<6;i++){
  if(weights[i]<=.001){continue;}
  for(var axis=0;axis<3;axis++){
   if(tri[axis]<=.001){continue;}
   let sn=select(1.,-1.,N[axis]<0.);var T=vec3f(0);var B=vec3f(0);
   if(axis==0){T=vec3f(0,0,-sn);B=vec3f(0,1,0);}if(axis==1){T=vec3f(1,0,0);B=vec3f(0,0,-sn);}if(axis==2){T=vec3f(sn,0,0);B=vec3f(0,1,0);}
   let q=vec2f(dot(local,T),dot(local,B))/scales[i];let qx=vec2f(dot(dx,T),dot(dx,B))/scales[i];let qy=vec2f(dot(dy,T),dot(dy,B))/scales[i];
   let a=tpTile(q,qx,qy,i);let k=weights[i]*tri[axis];residual+=k*a.color.rgb;
   var v=a.normal.x*T+a.normal.y*B;v-=N*dot(N,v);g+=k*v;moment+=k*a.normal.z;alpha+=k*a.color.a;ao+=k*a.normal.a;
  }
 }
 g*=.35*terrainParams.detail;moment*=pow(.35*terrainParams.detail,2.);
 let rough=clamp(pow(max(alpha+max(0.,moment-dot(g,g)),.00000256),.25),.04,1.);
 return TerrainTile(vec4f(clamp(base*(1.+.45*terrainParams.detail*residual),vec3f(0),vec3f(1)),rough),vec4f(normalize(N+g),ao));
}`;
}
export function createTerrainPBR(input,texture,terrainModule){
 if(!input)return null;const first=input.manifest.textures.levels[0],layers=Number.isInteger(input.manifest.textures.layers)&&input.manifest.textures.layers>0?input.manifest.textures.layers:12;
 const map=texture({label:'renderer default repeating terrain PBR',width:first.width,height:first.height,depth:layers,dimension:'2d-array',format:'rgba16float',mips:input.levels.length});
 map.getGPU();input.levels.forEach((data,mip)=>map.upload(data,{mip,layers}));map.apsPrefilteredLandscape=true;
 return {module:new ShaderModule({name:'aps-default-terrain-pbr',deps:[terrainModule],bindings:{tpSource:{texture:map}},code:terrainPBRCode(input.manifest)}),surface:`
let tpP=apsTerrainNativePosition(in.P);let tpN=apsTerrainNativeNormal(in.N);
let tp=tpSurface(tpP,tpN,dpdx(tpP),dpdy(tpP),apsTerrainCurrent.baseColor,apsTerrainTileWeights,apsTerrainLitter,apsTerrainGravel);
apsTerrainCurrent.baseColor=tp.color.rgb;apsTerrainCurrent.roughness=tp.color.a;apsTerrainCurrent.normal=apsTerrainWorldNormal(tp.normal.xyz);apsTerrainCurrent.occlusion=tp.normal.a;
if(terrainParams.mode==17){apsTerrainCurrent.emission=tp.color.rgb;}if(terrainParams.mode==14){apsTerrainCurrent.emission=apsTerrainCurrent.normal*.5+.5;}if(terrainParams.mode==15){apsTerrainCurrent.emission=vec3f(tp.color.a);}if(terrainParams.mode==23){apsTerrainCurrent.emission=vec3f(0,tp.color.a,tp.normal.a);}if(terrainParams.mode==25){apsTerrainCurrent.emission=vec3f(tp.normal.a);}
`,metadata:()=>({route:'renderer default repeating PBR from terrain classification',roles:input.manifest.materials.map(x=>x.role),source_textures:'decoded linear residual / roughness / tangent normal moments / AO',source_resolution:[first.width,first.height]})};
}
