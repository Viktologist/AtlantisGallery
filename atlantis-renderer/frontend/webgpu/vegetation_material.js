import {Material,ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {preprocess,collectModules,SAMPLERS,reachableIdentifiers} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {buildMeshShader} from '../../vendor/tidewater/src/engine/render/MeshShader.js';

                                                                             
                                                                            
export function vegetationBindingBudget(rows,limits,plannedModules=[],adaptModules=modules=>modules){
 const materials=rows.map(r=>r.mesh.material),own=new Set(materials.flatMap(m=>Object.keys(m.bindings))),specs={};
 const src=buildMeshShader(materials[0],[],{kind:'main'});
 for(const module of collectModules(adaptModules([...src.modules,...materials.flatMap(m=>m.modules),...plannedModules])))Object.assign(specs,module.bindings);
                                                                              
                                                                          
 const global=Object.entries(specs).filter(([name])=>!own.has(name));
 return {textures:limits.maxSampledTexturesPerShaderStage-global.filter(([,s])=>s.texture).length,
  samplers:limits.maxSamplersPerShaderStage-SAMPLERS.length-global.filter(([,s])=>s.sampler).length,
  globalTextures:global.filter(([,s])=>s.texture).map(([name])=>name)};
}
                                                                             
                                                                                 
export function auditVegetationMaterialResources(material,layout,pass,limits,preparedSource=null){
 const src=preparedSource??buildMeshShader(material,layout,pass),modules=collectModules(src.modules),specs={};
 for(const module of modules)Object.assign(specs,module.bindings);Object.assign(specs,src.bindings);
 const names=Object.entries(specs).filter(([,s])=>s.texture||s.sampler);
 const totals={textures:names.filter(([,s])=>s.texture).length,samplers:SAMPLERS.length+names.filter(([,s])=>s.sampler).length};
 if(totals.textures<=limits.maxSampledTexturesPerShaderStage&&totals.samplers<=limits.maxSamplersPerShaderStage)return {failed:false,totals};
 const full=preprocess(modules.map(m=>m.code).join('\n')+'\n'+src.code,src.defines),v=reachableIdentifiers(full,'vs'),f=src.hasFragment?reachableIdentifiers(full,'fs'):null;
 const result={vertex:{textures:[],samplers:SAMPLERS.map(s=>s[0])},fragment:{textures:[],samplers:SAMPLERS.map(s=>s[0])}};
 for(const [name,spec]of names){
  const stage=!v.has(name)&&(!f||f.has(name))?'fragment':f&&!f.has(name)&&v.has(name)?'vertex':null;
  for(const st of ['vertex','fragment'])if(!stage||stage===st)result[st][spec.texture?'textures':'samplers'].push(name);
 }
 const failed=Object.values(result).some(r=>r.textures.length>limits.maxSampledTexturesPerShaderStage||r.samplers.length>limits.maxSamplersPerShaderStage);
 return {failed,totals,...result,entryNames:Object.keys(specs),planned:material.userData.aps_binding_budget,origin:material.userData.aps_binding_origin,limits:{textures:limits.maxSampledTexturesPerShaderStage,samplers:limits.maxSamplersPerShaderStage}};
}
export function partitionVegetationFacesets(rows,textureBudget=12){
 const budget=typeof textureBudget==='number'?{textures:textureBudget,samplers:Infinity}:textureBudget;
 const result=[];let part=[],names=new Set(),samplers=new Set();
 for(const row of rows){const entries=Object.entries(row.mesh.material.bindings),keys=entries.filter(([,value])=>value?.texture).map(([key])=>key),sk=entries.filter(([,value])=>value?.sampler).map(([key])=>key);
  if(new Set(keys).size>budget.textures)throw Error('One vegetation faceset exceeds the native texture budget');
  if(new Set(sk).size>budget.samplers)throw Error('One vegetation faceset exceeds the native sampler budget');
  const combined=new Set([...names,...keys]),combinedSamplers=new Set([...samplers,...sk]);if(part.length&&(combined.size>budget.textures||combinedSamplers.size>budget.samplers)){result.push(part);part=[];names=new Set();samplers=new Set();}
  part.push(row);for(const key of keys)names.add(key);for(const key of sk)samplers.add(key);
 }
 if(part.length)result.push(part);return result;
}

                                                                                   
                                                                                     
                                                                                  
                                                                                    
const VEGETATION_NATIVE_OUTPUT='r.color=vec4f(apsShadePrincipled(apsMeshMaterial,s,in.P,in.V,in.pixel,apsMeshTangent),s.alpha);';
const VEGETATION_SHARED_PRINCIPLED='apsVegetationSharedPrincipled';
const VEGETATION_SHARED_TANGENT='apsVegetationSharedTangent';
const VEGETATION_SHARED_OUTPUT=`r.color=vec4f(apsShadePrincipled(${VEGETATION_SHARED_PRINCIPLED},s,in.P,in.V,in.pixel,${VEGETATION_SHARED_TANGENT}),s.alpha);`;

                                                                                
                                                                            
                                   
const isNativeStandardMaterial=m=>{
  if(m.modules.length!==1)return false;
  const source=m.modules[0],code=preprocess(source.code,m.allDefines());
  const names=new Set([...code.matchAll(/(?:\bfn\s+|\bstruct\s+|\bvar\s*<[^>]+>\s*|\bconst\s+)([A-Za-z_]\w*)/g)].map(x=>x[1]));
  return source?.name==='aps-mesh-material'
    &&names.has('apsMeshMaterial')&&names.has('apsMeshTangent')
    &&/fn\s+apsEvaluateMaterial\s*\(\s*ctx\s*:\s*APSContext\s*\)\s*->\s*APSPrincipled\s*\{/.test(source.code)
    &&m.output===VEGETATION_NATIVE_OUTPUT;
};

                                                                                   
                                                                                
export function createVegetationMaterial(materials,{sharedShading=undefined}={}){
  if(!materials.length)throw Error('Missing vegetation facesets');
                                                                                   
                                                                          
  const userAllowed=sharedShading!==false
    &&materials.every(m=>(m.userData?.apsSharedShading??m.userData?.sharedShading??true)!==false);
  const shareEnabled=userAllowed&&materials.every(isNativeStandardMaterial);
  const bindings={},modules=[],surfaces=[],outputCases=[],shadows=[],uniforms={},uniformHandles={};
  const attributes={apsFaceset:'u32'},varyings={apsFaceset:'u32'},vertices=new Set();
  const coverageBindings={},coverageAttributes={apsFaceset:'u32'},coverageVaryings={apsFaceset:'u32'},coverageVertices=new Set(['o.apsFaceset=v.apsFaceset;']),coverageCodes=[];
  let coverageOnly=true,sharedDeclared=false;
  materials.forEach((m,i)=>{
    const source=m.modules[0],code=preprocess(source.code,m.allDefines());
    const names=new Set([...code.matchAll(/(?:\bfn\s+|\bstruct\s+|\bvar\s*<[^>]+>\s*|\bconst\s+)([A-Za-z_]\w*)/g)].map(x=>x[1]));
    const rename=text=>text.replace(/\b[A-Za-z_]\w*\b/g,t=>names.has(t)?t+'_fs'+i:t);
    const literal=v=>typeof v==='number'?(Number.isInteger(v)?v+'.0':String(v)):`vec3f(${(v.toArray?v.toArray():[v.r,v.g,v.b]).map(x=>Number.isInteger(x)?x+'.0':String(x)).join(',')})`;
    const builtin=new Set(['color','opacity','metalness','roughness','emissive','alphaTest']);
    for(const key of m.uniformBlock.order)if(!builtin.has(key)){
      const field=`apsFace${i}_${key}`;uniforms[field]=[m.uniformBlock.layout[key].typeStr,m.uniforms[key].value];uniformHandles[field]=m.uniforms[key];
    }
    const bake=text=>rename(text.replace(/\bmat\.([A-Za-z_]\w*)\b/g,(_,key)=>builtin.has(key)?literal(m.uniforms[key].value):`mat.apsFace${i}_${key}`));
                                                                               
                                                                             
    const nativeStandard=shareEnabled;
    Object.assign(bindings,m.bindings);Object.assign(attributes,m.attributes);Object.assign(varyings,m.varyings);
                                                                               
                                                                               
    for(const line of m.vertex.split('\n'))vertices.add(line);
    const renamed=bake(code);
    modules.push(new ShaderModule({name:'vegetation-faceset-'+i,deps:source.deps,
      code:renamed+(nativeStandard&&!sharedDeclared?`\nvar<private> ${VEGETATION_SHARED_PRINCIPLED}: APSPrincipled;\nvar<private> ${VEGETATION_SHARED_TANGENT}: vec3f;`:``)}));
    if(nativeStandard)sharedDeclared=true;
    const front=m.side==='front'?'in.front':m.side==='back'?'!in.front':'true';
    const mode=m.userData.sourceMaterial?.alphaMode??'OPAQUE',cutoff=mode==='OPAQUE'?0:(m.userData.sourceMaterial?.alphaCutoff??.5);
    if(nativeStandard){
      surfaces.push(`case ${i}u: { if(!(${front})){discard;} ${bake(m.surface)} ${VEGETATION_SHARED_PRINCIPLED}=${rename('apsMeshMaterial')};${VEGETATION_SHARED_TANGENT}=${rename('apsMeshTangent')}; if((*s).alpha<${literal(cutoff)}){discard;} }`);
      outputCases.push({index:i});
    }else{
      surfaces.push(`case ${i}u: { if(!(${front})){discard;} ${bake(m.surface)} if((*s).alpha<${literal(cutoff)}){discard;} }`);
      outputCases.push({index:i,body:bake(m.output)});
    }
    const shadow=mode==='OPAQUE'?'return true;':(m.shadow||`let s=surfaceOf(in);return s.alpha>=${literal(cutoff)};`);
    shadows.push(`case ${i}u: { if(!(${front})){return false;} ${bake(shadow)} }`);
    const c=m.userData.apsCoverageDepth;
    if(mode!=='OPAQUE'&&!c)coverageOnly=false;
    if(c){Object.assign(coverageBindings,c.bindings);Object.assign(coverageAttributes,c.attributes);Object.assign(coverageVaryings,c.varyings);for(const line of c.vertex.split('\n'))coverageVertices.add(line);coverageCodes.push(bake(c.module.code));}
  });
  const select=cases=>`switch(in.vs.apsFaceset){${cases.join('\n')} default:{discard;}}`;
                                                                                
                                                                             
  const output=shareEnabled?VEGETATION_SHARED_OUTPUT:select(outputCases.map(c=>`case ${c.index}u: { ${c.body} }`));
  const result=new Material({name:'Vegetation faceset PBR mask',lit:false,side:'double',transparent:false,depthWrite:true,vertexColors:true,
    attributes,varyings,vertex:[...vertices,'o.apsFaceset=v.apsFaceset;'].join('\n'),modules,bindings,uniforms,
    surface:select(surfaces),output,shadow:`switch(in.vs.apsFaceset){${shadows.join('\n')} default:{return false;}}`,
    userData:{apsFacesetCount:materials.length,alphaMode:'MASK',materialAdapter:'aps-vegetation-facesets/1',sharedShading:shareEnabled,sharedFacesets:shareEnabled?materials.length:0}});
  result.allDefines=function(){return {...Material.prototype.allDefines.call(this),DOUBLE_SIDED:0,BACK_SIDE:0,ALPHA_TEST:0};};
  for(const [name,handle] of Object.entries(uniformHandles))result.uniforms[name]=result.uniformBlock.fields[name]=handle;
  if(coverageOnly)result.userData.apsCoverageDepth={uniforms,bindings:coverageBindings,attributes:coverageAttributes,varyings:coverageVaryings,vertex:[...coverageVertices].join('\n'),module:new ShaderModule({name:'vegetation-faceset-alpha',code:coverageCodes.join('\n')})};
  return result;
}
