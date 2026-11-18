import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {terrainMossMoistureConfig} from './terrain_moss_cover.js';
                                                                               
                                                                               
export async function loadTerrainSatMap(input,baseURL,scene,{Texture,digest,fetcher=fetch}={}){
 if(!input)return null;
 const mossMoisture=terrainMossMoistureConfig(input.mossMoisture);
 const url=new URL(input.file,baseURL),r=await fetcher(url.href);if(!r.ok)throw Error('SatMap manifest unavailable');const raw=await r.arrayBuffer();
 const m=JSON.parse(new TextDecoder().decode(raw)),s=m.textures??{};
 const levels=Array.isArray(s.levels)?s.levels:[],first=levels[0],layers=Number.isInteger(s.layers)&&s.layers>0?s.layers:1;
 const drainage=layers>=2;
 if(first&&Number.isInteger(first.width)&&Number.isInteger(first.height)&&Math.max(first.width,first.height)>8192)throw Error('SatMap texture exceeds GPU limit');
 const decoded=[];
 for(const v of levels){
  const r=await fetcher(new URL(v.file,url).href);if(!r.ok)throw Error('SatMap mip unavailable');const bytes=await r.arrayBuffer();decoded.push(new Uint16Array(bytes));
 }
 const texture=new Texture({label:'native SatMap / TextureBase / registered drainage',width:first?.width??1,height:first?.height??1,...(layers>1?{depth:layers,dimension:'2d-array'}:{}),format:'rgba16float',mips:decoded.length});texture.getGPU();decoded.forEach((v,mip)=>texture.upload(v,{mip,layers}));texture.apsPrefilteredLandscape=true;
 return {texture,manifest:m,mossMoisture:drainage?mossMoisture:null,drainage,module:new ShaderModule({name:'aps-native-satmap-texturebase',bindings:{apsTerrainSatMap:{texture}},code:`
fn apsTerrainAppearance(P:vec3f,dx:vec3f,dy:vec3f)->vec4f{
 let grid=(P.xz-terrainParams.origin)/terrainParams.spacing;
 let uv=(grid+.5)/terrainParams.shape;
 return textureSampleGrad(apsTerrainSatMap,smpLinearClamp,uv,${drainage?'0,':''}dx.xz/terrainParams.spacing/terrainParams.shape,dy.xz/terrainParams.spacing/terrainParams.shape);
}
${drainage?`fn apsTerrainMossGuidance(P:vec3f,dx:vec3f,dy:vec3f)->vec4f{
 let grid=(P.xz-terrainParams.origin)/terrainParams.spacing;let uv=(grid+.5)/terrainParams.shape;
 return textureSampleGrad(apsTerrainSatMap,smpLinearClamp,uv,1,dx.xz/terrainParams.spacing/terrainParams.shape,dy.xz/terrainParams.spacing/terrainParams.shape);
}`:''}`})};
}
