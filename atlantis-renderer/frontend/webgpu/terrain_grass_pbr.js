import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';

                                                                               
                                                                               
export function useDefaultGrassPBR(surface,grassCells,groundcover){
 return !!grassCells&&!groundcover&&!surface.landscape_pbr&&surface.default_pbr!==false&&surface.default_grass_pbr!==false;
}
const roles=['grass_sparse','grass'];
function materials(value){
 const rows=Array.isArray(value)?value.slice(0,2):[];
 return rows.map((row,i)=>({...row,role:row?.role??roles[i],tile_size_m:Array.isArray(row?.tile_size_m)&&row.tile_size_m.length===2&&row.tile_size_m.every(v=>Number.isFinite(v)&&v>0)?[...row.tile_size_m]:[1,1]}))
  .concat(Array.from({length:Math.max(0,2-rows.length)},(_,i)=>({role:roles[rows.length+i],tile_size_m:[1,1]})));
}
export async function loadTerrainGrassPBR({fetcher=fetch,digest,limit=8192}={}){
 const url=new URL('../../assets/terrain_grass_pbr/library.json',import.meta.url);
 const response=await fetcher(url.href);if(!response.ok)throw Error('Renderer grass PBR library unavailable');
 const manifest=JSON.parse(new TextDecoder().decode(await response.arrayBuffer())),stack=manifest.textures??{};
 manifest.materials=materials(manifest.materials);
 const levels=Array.isArray(stack.levels)?stack.levels:[];
 const first=levels[0];
 if(first&&Number.isInteger(first.width)&&Number.isInteger(first.height)&&Math.max(first.width,first.height)>limit)throw Error('Renderer grass PBR texture exceeds GPU limit');
 const decoded=[];
 for(const level of levels){
  const r=await fetcher(new URL(level.file,url).href);if(!r.ok)throw Error('Renderer grass PBR mip unavailable');const bytes=await r.arrayBuffer();
  decoded.push(new Uint16Array(bytes));
 }
 return {manifest,levels:decoded};
}

export function createTerrainGrassPBR(input,cells,texture,terrainModule){
 if(!input||!cells)return null;const first=input.manifest.textures.levels[0],layers=Number.isInteger(input.manifest.textures.layers)&&input.manifest.textures.layers>0?input.manifest.textures.layers:4;
 const source=texture({label:'renderer default sparse/dense turf PBR',width:first.width,height:first.height,depth:layers,dimension:'2d-array',format:'rgba16float',mips:input.levels.length});
 source.getGPU();input.levels.forEach((data,mip)=>source.upload(data,{mip,layers}));source.apsPrefilteredLandscape=true;
 const mask=texture({label:'grass CELL ground material coverage',width:cells.shape[1],height:cells.shape[0],format:'r8unorm',mips:true,data:cells.data});
 const scales=input.manifest.materials.map(m=>'vec2f('+m.tile_size_m.join(',')+')').join(',');
 const module=new ShaderModule({name:'aps-default-terrain-grass-pbr',deps:[terrainModule],bindings:{tgSource:{texture:source},tgCover:{texture:mask}},code:          `
struct TurfSample{color:vec4f,normal:vec4f};
fn tgTile(P:vec3f,dx:vec3f,dy:vec3f,index:i32)->TurfSample{
 let scales=array<vec2f,2>(${scales});
 let q=(P.xz-terrainParams.origin)/scales[index];
 return TurfSample(textureSampleGrad(tgSource,smpAnisoRepeat,q,index*2,dx.xz/scales[index],dy.xz/scales[index]),
  textureSampleGrad(tgSource,smpAnisoRepeat,q,index*2+1,dx.xz/scales[index],dy.xz/scales[index]));
}
fn tgCoverage(P:vec3f,dx:vec3f,dy:vec3f)->f32{
 let uv=terrainUvOf(P.xz);
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return 0.;}
 return textureSampleGrad(tgCover,smpLinearClamp,uv,dx.xz/terrainParams.extent,dy.xz/terrainParams.extent).r;
}
`});
 return {module,surface:          `
let tgP=apsTerrainNativePosition(in.P);let tgDx=dpdx(tgP);let tgDy=dpdy(tgP);let tgCoverWeight=tgCoverage(tgP,tgDx,tgDy);
if(tgCoverWeight>.001){
 var tg=tgTile(tgP,tgDx,tgDy,1);
 if(tgCoverWeight<.999){
  let sparse=tgTile(tgP,tgDx,tgDy,0);let dense=smoothstep(.25,.85,tgCoverWeight);
  tg.color=mix(sparse.color,tg.color,dense);tg.normal=mix(sparse.normal,tg.normal,dense);
 }
 let N=apsTerrainNativeNormal(in.N);let strength=max(0.,terrainParams.detail);
 var slope=vec3f(tg.normal.x,0,tg.normal.y)*strength;slope-=N*dot(N,slope);
 let rough=clamp(pow(max(tg.color.a+max(0.,tg.normal.z*strength*strength-dot(slope,slope)),.00000256),.25),.04,1.);
 apsTerrainCurrent.baseColor=mix(apsTerrainCurrent.baseColor,tg.color.rgb,tgCoverWeight);
 apsTerrainCurrent.normal=apsTerrainWorldNormal(normalize(mix(apsTerrainNativeNormal(apsTerrainCurrent.normal),normalize(N+slope),tgCoverWeight)));
 apsTerrainCurrent.roughness=pow(mix(pow(apsTerrainCurrent.roughness,4.),pow(rough,4.),tgCoverWeight),.25);
 apsTerrainCurrent.occlusion=mix(apsTerrainCurrent.occlusion,tg.normal.a,tgCoverWeight);
 apsTerrainSandCoverage*=1.-tgCoverWeight;
 if(terrainParams.mode==17){apsTerrainCurrent.emission=apsTerrainCurrent.baseColor;}
 if(terrainParams.mode==14){apsTerrainCurrent.emission=apsTerrainCurrent.normal*.5+.5;}
 if(terrainParams.mode==15){apsTerrainCurrent.emission=vec3f(apsTerrainCurrent.roughness);}
 if(terrainParams.mode==23){apsTerrainCurrent.emission=vec3f(0,apsTerrainCurrent.roughness,apsTerrainCurrent.occlusion);}
 if(terrainParams.mode==25){apsTerrainCurrent.emission=vec3f(apsTerrainCurrent.occlusion);}
}
`,metadata:()=>({route:'renderer default turf PBR from native grass CELL eligibility',roles:input.manifest.materials.map(m=>m.role),source_resolution:[first.width,first.height],tile_size_m:input.manifest.materials.map(m=>m.tile_size_m),mask_sha256:cells.manifest.field.sha256,filtering:'linear albedo / roughness and slope moments / AO mips; footprint-filtered CELL occupancy',canopy_coverage_certificate:false})};
}
