                                                                                 
import {ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {LYGIA_COMMIT,lygiaNoiseWGSL} from './lygia_noise.js';

export const artificialLygiaModule=new ShaderModule({name:'aps-artificial-lygia-noise',code:lygiaNoiseWGSL});
export function usesArtificialLygia(definition={}) {
  const recipe=definition.extras?.procedural_surface;
  if(!recipe||recipe.schema==='aps-procedural-surface/1')return false;
  if(recipe.schema!=='aps-procedural-surface/2'||recipe.library?.name!=='LYGIA'||recipe.library?.commit!==LYGIA_COMMIT||recipe.library?.adapter!=='aps-lygia-noise/1')throw Error('Unsupported artificial surface LYGIA provenance');
  return true;
}
