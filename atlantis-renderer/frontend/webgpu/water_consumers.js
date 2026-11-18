import {ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';

                                                                               
                                                                             
                                                                              
                                                                   
function renamed(module, entry, target) {
  if (!new RegExp(`\\bfn\\s+${entry}\\s*\\(`).test(module.code)) throw new Error(`Water hook module is missing ${entry}`);
  const code = module.code.replace(new RegExp(`\\b${entry}\\b`, 'g'), target);
  return new ShaderModule({name: `${module.name}-${target}`, deps: module.deps, bindings: module.bindings, code});
}
                                                                                
                                                     
                                                                              
                                                                                
                                                                               
                                                                               
                                                                         
                                                           
export function composeWaterHook(oceanModule, inlandModule, entry, name, predicate = null) {
  if (!oceanModule) return inlandModule ?? null;
  if (!inlandModule) return oceanModule;
  const oceanName = `apsOcean${entry[0].toUpperCase()}${entry.slice(1)}`;
  const inlandName = `apsInland${entry[0].toUpperCase()}${entry.slice(1)}`;
  const ocean = renamed(oceanModule, entry, oceanName);
  const inland = renamed(inlandModule, entry, inlandName);
  const call = predicate
    ? `select(${oceanName}(P,N),${inlandName}(P,N),${predicate}(P))`
    : `${oceanName}(P,N)*${inlandName}(P,N)`;
  return new ShaderModule({
    name,
    deps: [...(ocean.deps ?? []), inland],
    bindings: ocean.bindings,
    code: `${ocean.code}\nfn ${entry}(P:vec3f,N:vec3f)->vec3f{return ${call};}`,
  });
}
export function composeWaterBinding(ocean, inland) {
  if (!ocean && !inland) return null;
  if (!ocean) return inland;
  if (!inland) return ocean;
                                                                               
                                                              
  if (typeof inland.composeWithOcean === 'function') return inland.composeWithOcean(ocean);
  return Object.assign(Object.create(ocean), {
    receiverSurfaceModule: ocean.receiverSurfaceModule ? inland.composeReceiver(ocean.receiverSurfaceModule) : inland.receiverSurfaceModule,
    terrainWetnessModule: ocean.terrainWetnessModule ? inland.composeReceiver(ocean.terrainWetnessModule) : inland.terrainWetnessModule,
    directModulationModule: composeWaterHook(ocean.directModulationModule, inland.directModulationModule, 'hookDirectModulation', 'aps-ocean-inland-direct', 'apsInlandReceiverActive'),
    ambientModulationModule: composeWaterHook(ocean.ambientModulationModule, inland.ambientModulationModule, 'hookAmbientModulation', 'aps-ocean-inland-ambient', 'apsInlandReceiverActive'),
  });
}

