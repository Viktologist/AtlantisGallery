                                                               
                                                                             
                                                           
import { Mesh, InstancedMesh, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from '../../vendor/tidewater/src/engine/index.js';
import { Material, GPU } from '../../vendor/tidewater/src/engine/webgpu.js';
import { installShadowCasterBatching, SHADOW_UNIFIED_VERSION } from './shadow_caster_batching.js';

export { SHADOW_UNIFIED_VERSION };

export function installShadowUnified(viewer, options = {}) {
  if (!viewer?.meshRenderer) throw Error('Shadow unified depth requires the existing viewer.meshRenderer');
  const renderer = viewer.meshRenderer;
  const instance = installShadowCasterBatching(renderer, {
    viewer,
    Mesh,
    InstancedMesh,
    BufferGeometry,
    Float32BufferAttribute,
    Uint32BufferAttribute,
    Material,
    GPU,
    ...options,
  });
  viewer.shadowUnified = instance;
  return instance;
}

export function uninstallShadowUnified(viewer = globalThis.__APS_SHADOW_UNIFIED__?.viewer) {
  const instance = viewer?.shadowUnified ?? globalThis.__APS_SHADOW_UNIFIED__;
  if (instance?.dispose) instance.dispose();
  if (viewer && viewer.shadowUnified === instance) viewer.shadowUnified = null;
  if (globalThis.__APS_SHADOW_UNIFIED__ === instance) delete globalThis.__APS_SHADOW_UNIFIED__;
  return !!instance;
}


