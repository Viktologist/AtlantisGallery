                                                   
  
                                                                          
                                                                         
                                                                              
                                                                             
                                                                             
  
                                                                         
                                                                         
                                                                          
                                                                              
                                                                                
                                                           

import {Object3D} from '../../vendor/tidewater/src/engine/scene/Object3D.js';

export const SHADOW_STATE_CACHE_SCHEMA = 'aps-shadow-state-cache/1';
export const SHADOW_CACHE_STATES = Object.freeze(['before', 'after']);

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function mix(hash, value) {
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
                                                             
  hash ^= 0x1f;
  hash = Math.imul(hash, FNV_PRIME);
  return hash >>> 0;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function matrixElements(value) {
  const elements = value?.elements;
  return Array.isArray(elements) || elements?.length === 16 ? elements : null;
}

                                                                           
export function shadowCacheQualityKey(source = {}) {
  return JSON.stringify([
    source.size ?? null,
    source.count ?? null,
    source.splits ?? null,
    source.lightMargin ?? null,
    source.normalBias ?? null,
    source.vegetationBudget ?? null,
    source.cacheGuardFraction ?? null,
    source.grassDensityRetention ?? null,
    source.vegetationLOD ?? null,
    source.shadowDistance ?? null,
    source.shadowMapSize ?? null,
    source.enabled === undefined ? null : !!source.enabled,
    source.groundcover ?? null,
  ]);
}

                                                                           
                                                                           
                                                                            
                                                                                
                                                                              
export function casterSourceDigest(scene, { layerMask = 0xffffffff } = {}) {
  let hash = FNV_OFFSET >>> 0;
  let casters = 0;
  let dynamic = false;
  const visit = (object, parentVisible) => {
    if (!object) return;
    const visible = parentVisible && object.visible !== false;
    if (object.isMesh && object.castShadow && ((object.layers?.mask ?? 0xffffffff) & layerMask) !== 0) {
      const terrainCaster = object.userData?.apsShadowOnly === true;
      if (!terrainCaster) {
        casters++;
        const geometry = object.geometry ?? {};
        const position = geometry.attributes?.position;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        const matrix = matrixElements(object.matrixWorld);
        hash = mix(hash, object.name ?? object.id ?? 'mesh');
        hash = mix(hash, visible ? 1 : 0);
        hash = mix(hash, object.layers?.mask ?? 0xffffffff);
        if (matrix) for (const value of matrix) hash = mix(hash, value);
        hash = mix(hash, position?.count ?? geometry.vertexCount ?? 0);
        hash = mix(hash, position?.version ?? 0);
        hash = mix(hash, position?.array?.length ?? 0);
        hash = mix(hash, geometry.index?.count ?? 0);
        hash = mix(hash, geometry.index?.version ?? 0);
        hash = mix(hash, geometry.instanceCount ?? 1);
        hash = mix(hash, geometry.drawRange?.start ?? 0);
        hash = mix(hash, geometry.drawRange?.count ?? null);
        hash = mix(hash, object.isInstancedMesh ? (object.count ?? 0) : 1);
        hash = mix(hash, object.isInstancedMesh ? (object.instanceMatrix?.version ?? 0) : 0);
        hash = mix(hash, object.isInstancedMesh ? (object.instanceMatrix?.count ?? 0) : 0);
        hash = mix(hash, material?.id ?? 0);
        hash = mix(hash, material?.version ?? 0);
        hash = mix(hash, material?.visible === false ? 0 : 1);
        hash = mix(hash, material?.depthWrite === false ? 0 : 1);
        const morph = geometry.morphAttributes ? Object.keys(geometry.morphAttributes).length : 0;
        hash = mix(hash, morph);
        if (object.isSkinnedMesh || morph > 0) dynamic = true;
        if (typeof object.onBeforeRender === 'function' && object.onBeforeRender !== Object3D.prototype.onBeforeRender && object.userData?.apsStaticShadow !== true) {
                                                                          
          hash = mix(hash, 'onBeforeRender');
          dynamic = true;
        }
      }
    }
    for (const child of object.children ?? []) visit(child, visible);
  };
  visit(scene, true);
  return { key: `${hash >>> 0}:${casters}:${dynamic ? 1 : 0}`, casters, dynamic };
}

                                                                               
                                                                          
                                                                              
export function shadowStateSignature(input = {}) {
  const { state, qualityKey, domainKey, fits, light, mainEye, externalRevision, casterKey, interventionKey } = input;
  if (!SHADOW_CACHE_STATES.includes(state)) throw Error('Shadow cache state must be before or after');
  if (typeof qualityKey !== 'string' || typeof domainKey !== 'string') throw Error('Shadow cache needs quality and domain keys');
  if (!Array.isArray(fits) || !fits.length) throw Error('Shadow cache needs fitted cascades');
  if (!Array.isArray(light) || light.length !== 3 || !light.every(finite)) throw Error('Shadow cache needs a finite light direction');
  if (!Array.isArray(mainEye) || mainEye.length !== 3 || !mainEye.every(finite)) throw Error('Shadow cache needs a finite camera eye');
  if (!Number.isInteger(externalRevision) || externalRevision < 0) throw Error('Shadow cache needs an external revision');
  if (typeof casterKey !== 'string') throw Error('Shadow cache needs a caster digest');
  const fitKey = fits.map(fit => [fit.key, fit.projectionKey, fit.radius, fit.near, fit.far, ...(fit.lightCenter ?? [])]);
  return JSON.stringify([state, qualityKey, domainKey, fitKey, light, mainEye, externalRevision, casterKey, interventionKey ?? null]);
}

export class ShadowStateCache {
  constructor({ size, layers, states = SHADOW_CACHE_STATES, textureFactory = null } = {}) {
    if (!Number.isInteger(size) || size < 1) throw Error('Shadow cache size must be a positive integer');
    if (!Number.isInteger(layers) || layers < 1) throw Error('Shadow cache layers must be a positive integer');
    if (!Array.isArray(states) || !states.length || states.some(state => !SHADOW_CACHE_STATES.includes(state))) throw Error('Shadow cache states must be before/after');
    if (textureFactory !== null && typeof textureFactory !== 'function') throw Error('Shadow cache textureFactory must be a function');
    this.size = size;
    this.layers = layers;
    this.states = [...states];
    this.textureFactory = textureFactory;
    this.texture = null;
    this.entries = new Map();
    this.disposed = false;
    this.lastReason = null;
    this.stats = { schema: SHADOW_STATE_CACHE_SCHEMA, hits: 0, misses: 0, captures: 0, invalidations: 0, copies: 0, restore_frames: 0 };
  }

  get layerCount() {
    return this.layers * this.states.length;
  }

  ensureTexture() {
    if (this.disposed) throw Error('Shadow state cache has been disposed');
    if (!this.texture) {
      if (!this.textureFactory) throw Error('Shadow state cache has no GPU texture factory');
      this.texture = this.textureFactory({ size: this.size, layers: this.layerCount, format: 'depth32float' });
    }
    return this.texture;
  }

  layerFor(state, level) {
    const stateIndex = this.states.indexOf(state);
    if (stateIndex < 0) throw Error('Unknown shadow cache state ' + state);
    if (!Number.isInteger(level) || level < 0 || level >= this.layers) throw Error('Unknown shadow cache level ' + level);
    return stateIndex * this.layers + level;
  }

  record(state, { signature, payload } = {}) {
    if (this.disposed) throw Error('Shadow state cache has been disposed');
    if (typeof signature !== 'string' || !signature) throw Error('Shadow cache entry needs a signature');
    this.ensureTexture();
    this.entries.set(state, { signature, payload: payload ?? null });
    this.stats.captures++;
    this.lastReason = 'captured:' + state;
    return this.entries.get(state);
  }

  lookup(state, signature) {
    if (this.disposed) { this.stats.misses++; return null; }
    const entry = this.entries.get(state);
    if (!entry) { this.stats.misses++; this.lastReason = 'missing:' + state; return null; }
    if (entry.signature !== signature) { this.stats.misses++; this.lastReason = 'signature-mismatch:' + state; return null; }
    this.stats.hits++;
    this.lastReason = 'hit:' + state;
    return entry;
  }

  invalidate(state = null, reason = 'external') {
    if (this.disposed) return false;
    let changed = false;
    if (state === null) {
      changed = this.entries.size > 0;
      this.entries.clear();
    } else if (this.entries.delete(state)) changed = true;
    if (changed) {
      this.stats.invalidations++;
      this.lastReason = 'invalidated:' + reason;
    }
    return changed;
  }

  metadata() {
    return {
      schema: SHADOW_STATE_CACHE_SCHEMA,
      size: this.size,
      layers_per_state: this.layers,
      layers_total: this.layerCount,
      states: [...this.states],
      cached_states: [...this.entries.keys()],
      owned_texture: !!this.texture,
      format: 'depth32float',
      usage: ['copySrc', 'copyDst'],
      last_reason: this.lastReason,
      stats: { ...this.stats },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.texture?.destroy();
    this.texture = null;
  }
}
