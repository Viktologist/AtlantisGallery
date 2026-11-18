                                                                     
                                                                               
                                                                        
const pair = value => Array.isArray(value) && value.length === 2 && value.every(v => Number.isFinite(v));
const positivePair = value => Array.isArray(value) && value.length === 2 && value.every(v => Number.isFinite(v) && v > 0);
const tile = value => positivePair(value) ? [...value] : [1, 1];
function normalizeDetailMaterials(value) {
  const roles = ['brown_mud_dry', 'sparse_grass', 'grass_ground'];
  const rows = Array.isArray(value) ? value.slice(0, 3) : [];
  const materials = rows.map((row, i) => ({...row, id: row?.id ?? roles[i], tile_size_m: tile(row?.tile_size_m)}));
  while (materials.length < 3) { const i = materials.length; materials.push({id: roles[i], tile_size_m: [1, 1]}); }
  return materials;
}
export async function loadGroundcoverInputs(reference,scene,base,{get,digest,landscape,limit=8192}){
 if(!reference)return null;
 const maxBytes=reference.max_bytes??256*1024**2;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024**3)throw Error('Invalid explicit groundcover texture budget');
 const local=(path,dir)=>{if(typeof path!=='string'||!path||/^[a-z]+:|^[/\\]/i.test(path)||path.includes('\\')||path.split('/').includes('..'))throw Error('Groundcover path escapes package');const baseURL=new URL(dir),resolved=new URL(path,baseURL);if(resolved.origin!==baseURL.origin||!resolved.pathname.startsWith(baseURL.pathname))throw Error('Groundcover path escapes package');return resolved.href;};
 const url=local(reference.file,base),bytes=await get(url);
 const manifest=JSON.parse(new TextDecoder().decode(bytes));
 manifest.origin_xz_m??=scene.origin_xz_m;manifest.extent_xz_m??=scene.extent_xz_m;manifest.spacing_xz_m??=scene.spacing_xz_m;manifest.shape??=scene.shape;
 if(!Number.isFinite(manifest.start_m))manifest.start_m=4;
 if(!Number.isFinite(manifest.end_m)||manifest.end_m<=manifest.start_m)manifest.end_m=Math.max(manifest.start_m+1,24);
 if(manifest.transition_pixel_height&&(!positivePair(manifest.transition_pixel_height)||manifest.transition_pixel_height[0]>=manifest.transition_pixel_height[1]||!Number.isFinite(manifest.source_height_m)||manifest.source_height_m<=0))delete manifest.transition_pixel_height;
 if(manifest.terrain_elevation_range_m&&(!pair(manifest.terrain_elevation_range_m)||manifest.terrain_elevation_range_m[0]>manifest.terrain_elevation_range_m[1]))delete manifest.terrain_elevation_range_m;
 const dir=new URL('.',url);
 manifest.foliage_assets=Array.isArray(manifest.foliage_assets)?manifest.foliage_assets.map(a=>({...a,sourceUrl:local(a?.file,dir)})):[];
 if(new Set(manifest.foliage_assets.map(a=>a.sourceUrl)).size!==manifest.foliage_assets.length)throw Error('Duplicate groundcover foliage reference');
 let [height,width]=Array.isArray(manifest.coverage_shape)&&manifest.coverage_shape.length===2&&manifest.coverage_shape.every(n=>Number.isInteger(n)&&n>0)?manifest.coverage_shape:scene.shape.map(n=>n-1);
 if(![height,width].every(n=>Number.isInteger(n)&&n>0)){height=1;width=1;}
 if(Math.max(width,height)>limit)throw Error('Groundcover coverage exceeds GPU limit');
 const stack=manifest.texture??{},layers=Number.isInteger(stack.layers)&&stack.layers>0?stack.layers:2,levels=[];let total=0;
 for(const row of Array.isArray(stack.levels)?stack.levels:[]){
  const b=await get(local(row.file,dir));total+=b.byteLength;if(total>maxBytes)throw Error('Groundcover resident budget exceeded');levels.push(new Uint16Array(b));
 }
 manifest.texture={...stack,layers,levels:Array.isArray(stack.levels)?stack.levels:[]};
 let detail=null;
 if(manifest.detail){
  const detailUrl=local(manifest.detail.file,dir),b=await get(detailUrl);
  const d=JSON.parse(new TextDecoder().decode(b));
  d.origin_xz_m??=scene.origin_xz_m;d.extent_xz_m??=scene.extent_xz_m;d.spacing_xz_m??=scene.spacing_xz_m;d.shape??=scene.shape;
  d.materials=normalizeDetailMaterials(d.materials);
  d.world_shape=Array.isArray(d.world_shape)&&d.world_shape.length===2&&d.world_shape.every(n=>Number.isInteger(n)&&n>0)?d.world_shape:scene.shape.map(n=>n-1);
  detail={manifest:d};
  for(const [key,defaultLayers] of [['texture',9],['fields',1],['world',3]]){
   const s=d[key]??{},count=Number.isInteger(s.layers)&&s.layers>0?s.layers:defaultLayers,list=[],pageDir=new URL('.',detailUrl);
   for(const row of Array.isArray(s.levels)?s.levels:[]){const bytes=await get(local(row.file,pageDir));total+=bytes.byteLength;if(total>maxBytes)throw Error('Ground detail resident budget exceeded');list.push(new Uint16Array(bytes));}
   d[key]={...s,layers:count,levels:Array.isArray(s.levels)?s.levels:[]};detail[key]=list;
  }
 }
 return {manifest,levels,detail,residentBytes:total};
}
