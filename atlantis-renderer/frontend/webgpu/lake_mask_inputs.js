import {lakeMaskFromSeeds} from './lake_basin_source.js';

                                                                             
                                                                      
export async function loadLakeMaskInputs(reference,native,fields,base,{checked,digest}){
  if(reference!==undefined){
    if(!reference||typeof reference.file!=='string')throw Error('Invalid inland lake mask reference');
    const url=new URL(reference.file,base),manifest=JSON.parse(new TextDecoder().decode(await checked(url.href)));
    if(!manifest.field||typeof manifest.field.file!=='string')throw Error('Inland lake mask field missing');
    const bytes=await checked(new URL(manifest.field.file,url).href);
    return {data:new Uint8Array(bytes),regions:manifest.regions,water_level_m:manifest.water_level_m,sha256:manifest.field.sha256,source:url.href};
  }
  const context=fields.geometry_context??{},records=context.permanent_lakes??(context.permanent_lake?[context.permanent_lake]:null);
  if(records!==null){if(!Array.isArray(records))throw Error('Invalid declared inland lake regions');const mask=lakeMaskFromSeeds(native,records);if(digest)mask.sha256=await digest(mask.data);return mask;}
  return undefined;
}
