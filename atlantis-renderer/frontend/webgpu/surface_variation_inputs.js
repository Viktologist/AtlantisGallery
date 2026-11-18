                                                                               
                                                                         
const clamp=(v,a,b,d)=>Number.isFinite(v)?Math.min(b,Math.max(a,v)):d;
const integer=(v,a,b,d)=>Number.isInteger(v)?Math.min(b,Math.max(a,v)):d;
const pair=(v,positive=false)=>Array.isArray(v)&&v.length===2&&v.every(n=>Number.isFinite(n)&&(!positive||n>0));
export function validateVariationRecipe(r){
 const value=r&&typeof r==='object'?r:{};
 const transition=pair(value.transition_footprint_cells)&&value.transition_footprint_cells[0]<value.transition_footprint_cells[1]
  ?value.transition_footprint_cells.map(v=>clamp(v,.05,2,.5)):[.5,1];
 const layers=(Array.isArray(value.layers)?value.layers.slice(0,4):[]).map((row,i)=>({...row,
  name:typeof row?.name==='string'&&row.name?row.name:'layer'+i,
  wavelength_m:clamp(row?.wavelength_m,.005,10000,1),
  octaves:integer(row?.octaves,1,10,3),
  edge:clamp(row?.edge,.006,.4,.05),
  color_delta_linear:Array.isArray(row?.color_delta_linear)&&row.color_delta_linear.length===3?row.color_delta_linear.map(v=>clamp(v,-.5,.5,0)):[0,0,0],
  roughness_delta:clamp(row?.roughness_delta,-.3,.3,0)
 }));
 while(!layers.length)layers.push({name:'layer0',wavelength_m:1,octaves:3,edge:.05,color_delta_linear:[0,0,0],roughness_delta:0});
 return {...value,seed:integer(value.seed,0,1000000,0),warp_amplitude_cells:clamp(value.warp_amplitude_cells,0,.45,.2),
  warp_wavelength_cells:clamp(value.warp_wavelength_cells,.5,16,4),transition_footprint_cells:transition,layers,fractal:variationFractal(value)};
}
export function variationFractal(r){
 const value=r?.fractal&&typeof r.fractal==='object'?r.fractal:{};
 const limits={warp_octaves:[1,10,true],warp_passes:[1,3,true],warp_gain:[.2,.75,false],layer_warp:[0,1.5,false],gain:[.2,.8,false],lacunarity:[1.8,2.5,false]};
 const defaults={warp_octaves:6,warp_passes:2,warp_gain:.60,layer_warp:1.15,gain:.68,lacunarity:2.03};
 const result={};
 for(const [key,[lo,hi,isInt]] of Object.entries(limits))result[key]=isInt?integer(value[key],lo,hi,defaults[key]):clamp(value[key],lo,hi,defaults[key]);
 return result;
}
export async function loadSurfaceVariation(reference,scene,base,{get,digest,limit=8192,maxBytes=128*1024**2}){
 if(!reference)return null;
 maxBytes=reference.max_bytes??maxBytes;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024**3)throw Error('Invalid explicit variation texture budget');
 function local(path,dir){
  if(typeof path!=='string'||!path||/^[a-z]+:|^[/\\]/i.test(path)||path.includes('\\')||path.split('/').includes('..'))throw Error('Variation path escapes package');
  const u=new URL(path,dir);if(!u.href.startsWith(dir.href))throw Error('Variation path escapes package');return u.href;
 }
 const url=local(reference.file,base),bytes=await get(url);
 const m=JSON.parse(new TextDecoder().decode(bytes));
 m.origin_xz_m??=scene.origin_xz_m;m.extent_xz_m??=scene.extent_xz_m;m.spacing_xz_m??=scene.spacing_xz_m;m.shape??=scene.shape.map(v=>v-1);
 m.recipe=validateVariationRecipe(m.recipe);
 const s=m.texture??{},dir=new URL('.',url),levels=[];let [h,w]=Array.isArray(m.shape)&&m.shape.length===2&&m.shape.every(v=>Number.isInteger(v)&&v>0)?m.shape:scene.shape.map(v=>v-1);
 if(![h,w].every(v=>Number.isInteger(v)&&v>0)){h=1;w=1;}
 if(Math.max(h,w)>limit)throw Error('Variation cell texture exceeds GPU limit');
 let total=0;
 for(const row of Array.isArray(s.levels)?s.levels:[]){
  const b=await get(local(row.file,dir));total+=b.byteLength;if(total>maxBytes)throw Error('Variation resident budget exceeded');levels.push(new Uint16Array(b));
 }
 m.texture={...s,layers:Number.isInteger(s.layers)&&s.layers>0?s.layers:3,levels:Array.isArray(s.levels)?s.levels:[]};
 return {manifest:m,levels,residentBytes:total};
}
