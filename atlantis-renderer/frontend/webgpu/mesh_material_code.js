import {compileMaterialProgram} from './mesh_glsl.js';
export {compileMaterialProgram} from './mesh_glsl.js';
const scalarFields=['metallic','roughness','occlusion','specular','specularTint','anisotropy','subsurface','sheen','sheenTint','clearcoat','clearcoatGloss','subsurfaceColorWeight','diffuseTransmission','transmissionThickness'];
export const PRINCIPLED_SCALARS=Object.freeze(scalarFields);
export function wgslNumber(value) {
  if(!Number.isFinite(value)) throw Error('Nonfinite mesh material parameter');
  const str=String(value); return /[.eE]/.test(str)?str:str+'.0';
}
export function migrateMaterialCode(source='return ctx.source;',options={}) { return compileMaterialProgram(source,options).body; }

export function materialCodeTable(json) {
  const table=new Map();
  const add=e=>{
    if(!Number.isInteger(e.material_id)||e.material_id<0||e.material_id>2147483647)throw Error('Invalid material_id');
    if(e.mat_code!==undefined) {
      if(typeof e.mat_code!=='string'||!e.mat_code.trim())throw Error('Invalid mat_code');const text=e.mat_code.trim();
      if(table.has(e.material_id)&&table.get(e.material_id)!==text)throw Error(`Conflicting mat_code for material_id ${e.material_id}`);
      table.set(e.material_id,text);
    }
  };
  for(const e of [...(json.extras?.principled_materials??[]),...(json.scenes?.[json.scene??0]?.extras?.principled_materials??[])]) {
    if(e.mat_code===undefined)throw Error('Scene Principled table entry requires mat_code');add(e);
  }
  for(const m of json.materials??[])if(m.extras?.material_id!==undefined)add(m.extras);
  return table;
}
