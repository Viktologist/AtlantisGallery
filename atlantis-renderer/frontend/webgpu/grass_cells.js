                                                                          
                                                                               
export async function loadGrassCells(reference,scene,base,{get,digest,limit=8192}){
 if(!reference)return null;
 const manifestBytes=await get(new URL(reference.file,base).href);
 const m=JSON.parse(new TextDecoder().decode(manifestBytes));
 if(typeof m.field?.file!=='string'||/[:\\/]/.test(m.field.file)||m.field.file.includes('..'))throw Error('Grass CELL field escapes package');
 const shape=Array.isArray(m.shape)&&m.shape.length===2&&m.shape.every(n=>Number.isInteger(n)&&n>0)?m.shape:scene.shape.map(n=>n-1);
 if(Math.max(...shape)>limit)throw Error('Grass CELL texture exceeds GPU limit');
 const bytes=await get(new URL(m.field.file,new URL('.',new URL(reference.file,base))).href);
 const data=new Uint8Array(bytes);
 return {manifest:{...m,shape,origin_xz_m:m.origin_xz_m??scene.origin_xz_m,extent_xz_m:m.extent_xz_m??scene.extent_xz_m,spacing_xz_m:m.spacing_xz_m??scene.spacing_xz_m,field:m.field??{}},data,shape,origin:m.origin_xz_m??scene.origin_xz_m,extent:m.extent_xz_m??scene.extent_xz_m,spacing:m.spacing_xz_m??scene.spacing_xz_m};
}
