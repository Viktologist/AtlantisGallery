                                                                                
  
                                                         
  
                              
                                                                           
                                                                               
                                                                               
                        
                                                                          
                                                                               
                                                         
                                                                               
                                                                             
                                                                           
                                                                              
                         
                                                                               
                                                                        
                                                                          
                                                                              
                                                                            
                                                                            
                                                                               
                                              

import {GPU, G} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {setFrameCamera} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {setShadowMap} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {LightCullCoordinator} from './light_cull_coordinator.js';
import {lightDepthPad} from './light_cull_wgsl.js';
import {ShadowCascadeReuse} from './shadow_cascade_reuse.js?solar-repair=3';
import {activeVegetationSystems} from './vegetation_visibility.js';

export const SHADOW_GLOBAL_HIZ_SCHEMA = 'aps-shadow-global-hiz/2';
export const SHADOW_GLOBAL_HIZ_REVISION = 'shadow-global-hiz-r4-shared-cascade-sources';
export const SHADOW_GLOBAL_HIZ_OCCLUSION_BIAS_M = 0.05;
export const SHADOW_GLOBAL_HIZ_DEMAND_PAD_TEXELS = 2;

function pageParam(name) {
  try {
    if (typeof location === 'undefined') return null;
    return new URL(location.href).searchParams.get(name);
  } catch {
    return null;
  }
}

function messageOf(error) {
  return String(error?.message ?? error ?? 'unknown error');
}

                                                               
                                                                            
                                                                              
                                                                             
const PAGE_SHADOW_REUSE = pageParam('shadow_reuse');

                                                                               
                                                                             
                                                              
export function shadowCascadeReuseRequested(options = {}) {
  if (options.shadowReuse === false) return false;
  const value = PAGE_SHADOW_REUSE;
  if (value == null || value === '') return options.shadowReuse !== false;
  const normalized = String(value).toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'off');
}

                                                                              
export function shadowGlobalHiZRequested(options = {}) {
  if (options.shadowHiZ === false) return false;
  const value = pageParam('shadow_hiz');
  if (value == null || value === '') return options.shadowHiZ !== false;
  const normalized = String(value).toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'off');
}

                                                                              
                                                                            
export function selectGlobalCascade(cascades = []) {
  let best = 0;
  let bestRadius = -Infinity;
  for (let i = 0; i < cascades.length; i++) {
    const radius = Number(cascades[i]?.radius);
    const value = Number.isFinite(radius) ? radius : -Infinity;
    if (value > bestRadius || (value === bestRadius && i > best)) {
      best = i;
      bestRadius = value;
    }
  }
  return best;
}

function vpArray(cascade) {
  const elements = cascade?.viewProj?.elements;
  return Array.isArray(elements) && elements.length >= 16 ? elements.slice(0, 16) : null;
}

function sunArray() {
  const value = G?.sunDir?.value;
  const array = typeof value?.toArray === 'function' ? value.toArray() : value;
  return Array.isArray(array) && array.slice(0, 3).every(Number.isFinite) ? array.slice(0, 3) : null;
}

                                                                               
                                                               
export function shadowGlobalKey({
  globalVP, size, sun, staticRevision, shadowRevision, geometryRevision,
  restoreState, qualityKey, projectionKey, clipKey,
} = {}) {
  return JSON.stringify([
    size | 0,
    globalVP ? globalVP.map(value => Math.fround(value)) : null,
    sun ? sun.map(value => Math.fround(value)) : null,
    staticRevision ?? null,
    shadowRevision ?? null,
    geometryRevision ?? null,
    restoreState ?? null,
    qualityKey ?? null,
    projectionKey ?? null,
    clipKey ?? null,
  ]);
}

                                                                              
                                                          
export function planShadowBatch({indices = [], globalLevel = 0, snapshotValid = false, snapshotKey = null, nextKey = null, count = 1} = {}) {
  const dirty = [...new Set(indices)].filter(level => Number.isInteger(level) && level >= 0 && level < count).sort((a, b) => a - b);
  const globalRedraw = !snapshotValid || snapshotKey !== nextKey || dirty.includes(globalLevel);
  const forcedGlobal = globalRedraw && !dirty.includes(globalLevel) ? globalLevel : null;
  const levels = [...new Set([...dirty, ...(forcedGlobal == null ? [] : [forcedGlobal])])].sort((a, b) => a - b);
  return {
    globalLevel,
    globalRedraw,
    forcedGlobal,
    computeLevels: levels,
    drawLevels: levels,
  };
}

                                                                            
                                                                               
                                                                            
                                                                               
                                                                              
                                                                 
export function planCascadeReuse({indices = [], count = 1, reuseActive = false, valid = []} = {}) {
  const dirty = [...new Set(indices)]
    .filter(level => Number.isInteger(level) && level >= 0 && level < count)
    .sort((a, b) => a - b);
  if (!dirty.length) {
    return {drawLevels: [], order: [], parentInvalidations: [], levels: [], reuseActive: !!reuseActive, source: []};
  }
  const draw = [...dirty];
  const parentInvalidations = [];
  const levels = draw.map(level => {
    const finer = reuseActive
      ? [...draw].filter(other => other < level).sort((a, b) => b - a)[0] ?? null
      : null;
    const parentValid = finer != null && (finer < level);
    return {
      level,
      sourceLevel: parentValid ? finer : null,
      draw: parentValid ? `ring-${level}` : `full-${level}`,
      valid: parentValid ? valid[finer] !== false : false,
      reason: parentValid ? (valid[finer] === false ? 'source-invalid' : 'reuse') : 'no-finer-source',
    };
  });
  return {
    drawLevels: draw,
    order: draw.slice(),
    fineToCoarse: draw.slice(),
    parentInvalidations,
    levels,
    reuseActive: !!reuseActive,
    source: levels.map(({level, sourceLevel}) => ({level, sourceLevel})),
  };
}

function normalBiasFor(shadows, level) {
  const source = shadows?.normalBias;
  if (Array.isArray(source)) return Number.isFinite(source[level]) ? source[level] : (Number.isFinite(source[0]) ? source[0] : 0.1);
  return Number.isFinite(source) ? source : 0.1;
}

function cascadeDepthPad(shadows, level) {
  const cascade = shadows?.cascades?.[level];
  const near = Number.isFinite(cascade?.camera?.near) ? cascade.camera.near : 0.1;
  const far = Number.isFinite(cascade?.camera?.far) ? cascade.camera.far : near + 1;
  const texel = Number.isFinite(cascade?.texel) ? cascade.texel : (2 * (cascade?.radius ?? 1) / Math.max(shadows?.size ?? 1, 1));
  try {
    return lightDepthPad({near, far, texelWorld: texel, normalBias: normalBiasFor(shadows, level), occlusionBias: SHADOW_GLOBAL_HIZ_OCCLUSION_BIAS_M});
  } catch {
    return LightCullCoordinator.rasterPad();
  }
}

function globalDepthPad(shadows, level) {
  return cascadeDepthPad(shadows, level);
}

function readGpuBuffer(device, source, byteLength) {
  const staging = device.createBuffer({label: 'shadow global Hi-Z audit readback', size: Math.max(4, byteLength), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  const encoder = device.createCommandEncoder({label: 'shadow global Hi-Z audit copy'});
  encoder.copyBufferToBuffer(source, 0, staging, 0, Math.max(4, byteLength));
  device.queue.submit([encoder.finish()]);
  return staging.mapAsync(GPUMapMode.READ).then(() => {
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  });
}

export class ShadowGlobalHiZ {
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.options = options;
    this.schema = SHADOW_GLOBAL_HIZ_SCHEMA;
    this.revision = SHADOW_GLOBAL_HIZ_REVISION;
    this.requested = shadowGlobalHiZRequested(options);
    this.reuseRequested = shadowCascadeReuseRequested(options);
                                                                                   
                                                                                
                                                                                 
                                                                              
                                                                              
                                                                             
                                          
    const injected = options.shadowCascadeReuse ?? null;
    this.reuseOwned = injected == null;
    this.reuseModule = injected;
    this.reuseModuleError = null;
    if (!injected && this.reuseRequested) {
      try {
        this.reuseModule = new ShadowCascadeReuse({GPU});
      } catch (error) {
        this.reuseModule = null;
        this.reuseModuleError = messageOf(error);
      }
    }
    this.reuseEnabled = this.reuseRequested
      && typeof this.reuseModule?.prepareReuse === 'function'
      && typeof this.reuseModule?.seed === 'function';
    this.reuseDisabledReason = !this.reuseRequested
      ? 'requested-off'
      : (this.reuseEnabled ? null : (this.reuseModuleError ? 'cascade-reuse-module-error' : 'cascade-reuse-module-unavailable'));
    this.lastReuse = null;
    this.ready = false;
    this.enabled = false;
    this.disposed = false;
    this.disabledReason = this.requested ? null : 'requested-off';
    this.lastError = null;
    this.failures = 0;
    this.coordinator = null;
    this.demandBuffer = null;
    this.snapshot = null;
    this.snapshotView = null;
    this.snapshotSize = 0;
    this.snapshotValid = false;
    this.snapshotKey = null;
    this.snapshotFrame = -1;
    this.snapshotSourceLevel = null;
    this.capturedVP = null;
    this.lastBatch = null;
    this.lastAudit = null;
    this.framePasses = null;
    this.stats = {
      frames: 0, rendered: 0, fallbacks: 0, global_redraws: 0, snapshots: 0,
      compute_passes: 0, compute_dispatches: 0, selections: 0, compaction_dispatches: 0,
      errors: 0, parent_invalidations: 0, reuse_frames: 0, reuse_seeds: 0,
    };
  }

                                                                               
                                                                   
  ensureReady(viewer = this.viewer) {
    if (this.disposed) return false;
    this.viewer = viewer ?? this.viewer;
    if (!this.requested) {
      this.enabled = false;
      this.disabledReason = 'requested-off';
      return false;
    }
    const shadows = this.viewer?.shadows;
    const meshRenderer = this.viewer?.meshRenderer;
    if (!shadows || !meshRenderer) {
      this.enabled = false;
      this.disabledReason = 'missing-shadows-or-renderer';
      return false;
    }
    if (shadows.receiverActive || this.viewer.receiverShadows?.enabled) {
      this.enabled = false;
      this.disabledReason = 'receiver-driven-mode';
      return false;
    }
    const systems = [...(meshRenderer.vegetationSystems ?? [])];
    if (!systems.length) {
      this.enabled = false;
      this.disabledReason = 'no-vegetation';
      return false;
    }
    const supported = systems.every(system => system && !system.disposed
      && system.lightCullSupported === true
      && typeof system.selectLight === 'function'
      && typeof system.finishSelectionBatched === 'function'
      && typeof system.restoreDrawContext === 'function'
      && system.dispatchCopyPipeline);
    if (!supported) {
      this.enabled = false;
      this.disabledReason = 'unsupported-vegetation-layout';
      return false;
    }
    try {
      if (!this.coordinator) this.coordinator = new LightCullCoordinator(this.viewer.gpu ?? GPU, {depthPad: LightCullCoordinator.rasterPad()});
      this.coordinator.ensurePipelines();
      if (!this.demandBuffer) {
        this.demandBuffer = GPU.device.createBuffer({label: 'APS shadow global legacyFull demand', size: 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
        GPU.queue.writeBuffer(this.demandBuffer, 0, new Uint32Array(32));
      }
      this.ensureSnapshot(4);
    } catch (error) {
      this.enabled = false;
      this.disabledReason = 'allocation-failed';
      this.lastError = {stage: 'ensureReady', message: messageOf(error), frame: GPU.frame ?? null};
      return false;
    }
    this.ready = true;
    this.enabled = true;
    this.disabledReason = null;
    return true;
  }

  ensureSnapshot(size) {
    const mapSize = Math.max(1, Number(size) | 0);
    if (this.snapshot && this.snapshotSize === mapSize) return this.snapshot;
    this.snapshot?.destroy?.();
    this.snapshot = new Texture({
      label: 'APS global static-only shadow snapshot',
      width: mapSize,
      height: mapSize,
      depth: 1,
      dimension: '2d',
      format: 'depth32float',
      usage: ['sample', 'copyDst'],
    });
    this.snapshotSize = mapSize;
    this.snapshotView = this.snapshot.view({dimension: '2d'});
    this.snapshotValid = false;
    return this.snapshot;
  }

                                                                             
                                                               
  invalidate(reason = 'explicit') {
    const had = this.snapshotValid;
    this.snapshotValid = false;
    this.snapshotKey = null;
    this.snapshotSourceLevel = null;
    this.lastBatch = null;
    this._clearReuse(reason);
    if (had) this.stats.fallbacks++;
    this.lastInvalidation = {reason, frame: GPU.frame ?? null};
    return had;
  }

  _key(shadows, globalLevel) {
    const cascade = shadows.cascades[globalLevel];
    const viewer = this.viewer;
    return shadowGlobalKey({
      globalVP: vpArray(cascade),
      size: shadows.size,
      sun: sunArray(),
      staticRevision: shadows.sceneRevision ?? null,
      shadowRevision: viewer?.shadowRevision ?? null,
      geometryRevision: viewer?.shadowCacheRevision ?? null,
      restoreState: shadows.pendingRestore ?? null,
      qualityKey: shadows.budgetKey ?? null,
      projectionKey: cascade?.projectionKey ?? null,
      clipKey: cascade?.clipKey ?? null,
    });
  }

  _staticPass(shadows, scene, level, groundcoverShadow) {
    const cascade = shadows.cascades[level];
    setFrameCamera(cascade.camera, shadows.size, shadows.size, {block: cascade.block});
    return {
      label: `solar global static ${level}`,
      kind: 'depth',
      camera: cascade.camera,
      frameBlock: cascade.block,
      depthView: shadows.texture.view({dimension: '2d', baseArrayLayer: level, arrayLayerCount: 1}),
      depthFormat: 'depth32float',
      clearDepth: 1,
      depthCompare: 'less-equal',
      layerMask: shadows.layerMask,
      depthBias: 2,
      depthBiasSlopeScale: 0,
      groundcoverShadow,
      vegetationShadowBudget: shadows.vegetationBudget,
      vegetationShadowEye: shadows.mainEye,
      vegetationShadowLevel: level,
      apsStaticLightSeed: true,
      apsShadowUnified: true,
      apsShadowUnifiedOnlyStatic: true,
      filter: object => object?.userData?.apsVegetationManaged !== true,
      apsShadowLevel: level,
      viewProj: cascade.viewProj,
      shadowSize: shadows.size,
      renderer: this.viewer?.meshRenderer ?? null,
    };
  }

  _vegetationPass(shadows, level, groundcoverShadow, reuseInfo = null) {
    const cascade = shadows.cascades[level];
    setFrameCamera(cascade.camera, shadows.size, shadows.size, {block: cascade.block});
    return {
      label: `solar global vegetation ${level}`,
      kind: 'depth',
      camera: cascade.camera,
      frameBlock: cascade.block,
      depthView: shadows.texture.view({dimension: '2d', baseArrayLayer: level, arrayLayerCount: 1}),
      depthFormat: 'depth32float',
      clearDepth: null,
      depthCompare: 'less-equal',
      layerMask: shadows.layerMask,
      depthBias: 2,
      depthBiasSlopeScale: 0,
      groundcoverShadow,
      vegetationShadowBudget: shadows.vegetationBudget,
      vegetationShadowEye: shadows.mainEye,
      vegetationShadowLevel: level,
      filter: object => object?.userData?.apsVegetationManaged === true,
      apsShadowUnified: false,
      vegetationViewKey: `solar-light-${level}`,
      apsVegetationLightDraw: true,
                                                                              
                                                                                
      apsShadowReuseCoverage: reuseInfo?.coverage ?? null,
    };
  }

  _sharedShadowPass(scene,meshRenderer,shadows,level,groundcoverShadow,sources,pass){
    if(this.options.shadowSharedSources===false)return pass;
    let lists=sources.get(level);
    if(!lists){
                                                                           
                                                                         
                                                                                
      lists=meshRenderer.collect(scene,{...this._staticPass(shadows,scene,level,groundcoverShadow),
        label:'solar shared sources '+level,filter:null,apsStaticSourceOnly:true});
      sources.set(level,lists);
    }
    return {...pass,apsStaticSourceLists:lists,apsShadowSourcePrepared:true};
  }

                                                                            
                                                                              
                             
  _prepareReuse(levels, shadows) {
    if (!this.reuseEnabled || !levels.length) return null;
    try {
      const prepared = this.reuseModule.prepareReuse({
        levels: levels.slice(),
        mapSize: shadows.size,
        cascades: shadows.cascades,
        reuseRequested: this.reuseRequested,
        vegetationBudget: shadows.vegetationBudget,
      });
      if (!prepared || prepared.supported === false) {
        this.reuseDisabledReason = prepared?.reason ?? 'reuse-unsupported';
        return null;
      }
      const map = new Map();
      for (const level of levels) {
        const info = prepared.levels?.[level] ?? prepared.levels?.get?.(level) ?? null;
        if (info) map.set(level, info);
      }
      return {levels: map, prepared};
    } catch (error) {
      this.stats.errors++;
      this.reuseDisabledReason = 'prepare-reuse-failed';
      this.lastError = {stage: 'prepareReuse', message: messageOf(error), frame: GPU.frame ?? null};
      return null;
    }
  }

                                                                          
                                                                                
  _clearReuse(reason) {
    this.lastReuse = null;
    this.lastReuseInvalidation = {reason: reason ?? 'explicit', frame: GPU.frame ?? null};
  }

  _copySnapshot(shadows, globalLevel) {
    const size = shadows.size;
    this.ensureSnapshot(size);
    GPU.getEncoder().copyTextureToTexture(
      {texture: shadows.texture.getGPU(), origin: {x: 0, y: 0, z: globalLevel}, aspect: 'depth-only'},
      {texture: this.snapshot.getGPU(), origin: {x: 0, y: 0, z: 0}, aspect: 'depth-only'},
      {width: size, height: size, depthOrArrayLayers: 1},
    );
    this.snapshotValid = true;
    this.snapshotKey = this._key(shadows, globalLevel);
    this.snapshotFrame = GPU.frame ?? 0;
    this.snapshotSourceLevel = globalLevel;
    this.capturedVP = vpArray(shadows.cascades[globalLevel]);
    this.stats.snapshots++;
  }

                                                                          
                                                                           
                                                          
  render(scene, meshRenderer, indices, terrain = null, shadows = this.viewer?.shadows) {
    if (this.disposed || !this.requested) return {rendered: false, fallbackIndices: indices};
    this.stats.frames++;
    if (!this.ready && !this.ensureReady(this.viewer)) {
      this.stats.fallbacks++;
      return {rendered: false, fallbackIndices: indices};
    }
    if (shadows.receiverActive) {
      this.invalidate('receiver-mode');
      this.stats.fallbacks++;
      return {rendered: false, fallbackIndices: indices};
    }
                                                                                
    if (meshRenderer.precompiling) {
      this.invalidate('precompile');
      return {rendered: false, fallbackIndices: indices};
    }
                                                                           
    if (shadows.pendingRestore || shadows.pendingCapture
      || (shadows.lastStateCache?.frame === shadows.frame && ['hit', 'captured', 'fallback'].includes(shadows.lastStateCache.result))) {
      this.invalidate('state-cache');
      return {rendered: false, fallbackIndices: indices};
    }
    if (!Array.isArray(indices) || !indices.length) return {rendered: false, fallbackIndices: indices};
    const systems = activeVegetationSystems(meshRenderer.vegetationSystems ?? []);
    if (!systems.length) {
      this.invalidate('no-vegetation');
      this.stats.fallbacks++;
      return {rendered: false, fallbackIndices: indices};
    }
    if (!systems.every(system => system.lightCullSupported === true && system.dispatchCopyPipeline
      && typeof system.finishSelectionBatched === 'function' && typeof system.restoreDrawContext === 'function')) {
      this.invalidate('unsupported-layout');
      this.stats.fallbacks++;
      return {rendered: false, fallbackIndices: indices};
    }
    const globalLevel = selectGlobalCascade(shadows.cascades);
    if (!vpArray(shadows.cascades[globalLevel])) {
      this.invalidate('missing-global-vp');
      this.enabled = false;
      this.disabledReason = 'missing-global-vp';
      this.stats.fallbacks++;
      return {rendered: false, fallbackIndices: indices};
    }
    const nextKey = this._key(shadows, globalLevel);
                                                                        
                                                                               
                                                                                
    let levelIndices = indices;
    if (this.snapshotValid && this.snapshotKey !== nextKey && this.reuseEnabled) {
      levelIndices = shadows.cascades.map((_, index) => index);
      this._clearReuse('global-key-changed');
    }
                                                                            
                                                              
    const reuseOrder = planCascadeReuse({
      indices: levelIndices, count: shadows.cascades.length, reuseActive: this.reuseEnabled,
    });
    const reuseLevels = reuseOrder.drawLevels;
    if (reuseOrder.parentInvalidations.length) this.stats.parent_invalidations += reuseOrder.parentInvalidations.length;
    const plan = planShadowBatch({
      indices: reuseLevels.length ? reuseLevels : indices, globalLevel,
      snapshotValid: this.snapshotValid,
      snapshotKey: this.snapshotKey,
      nextKey,
      count: shadows.cascades.length,
    });
    if (!plan.computeLevels.length) return {rendered: false, fallbackIndices: indices};
    const reuse = this._prepareReuse(plan.computeLevels, shadows);
                                                                             
    const texture = shadows.texture?.getGPU?.();
    const usageList = shadows.texture?.usageList ?? [];
    if (!texture || !this.snapshot || !usageList.includes('copySrc')) {
      this.invalidate('missing-copy-source');
      this.disabledReason = 'shadow-attachment-not-copyable';
      this.enabled = false;
      this.stats.fallbacks++;
      return {rendered: false, fallbackIndices: indices};
    }

    const sync = meshRenderer.syncPipelines;
    meshRenderer.syncPipelines = true;
    setShadowMap(shadows.neutral);
    const previousUpdated = Array.isArray(shadows.lastUpdated) ? [...shadows.lastUpdated] : null;
    const previousReused = Array.isArray(shadows.lastReused) ? [...shadows.lastReused] : null;
    const drawn = new Set();
    const cascadeSources = new Map();
    let forcedRegistered = false;
    try {
                                                                               
                                                                             
      if (plan.globalRedraw) {
        const groundcoverShadow = terrain?.groundcover?.captureShadow?.(globalLevel, shadows.vegetationBudget) ?? null;
        const restore = terrain?.beginShadowCascade?.(globalLevel, shadows.cascades[globalLevel], {shadowSize: shadows.size, demandUvMode: 'shadow'}) ?? null;
        try {
          meshRenderer.render(scene, this._sharedShadowPass(scene,meshRenderer,shadows,globalLevel,groundcoverShadow,cascadeSources,this._staticPass(shadows, scene, globalLevel, groundcoverShadow)));
        } finally {
          restore?.();
        }
                                                                          
        this._copySnapshot(shadows, globalLevel);
        this.stats.global_redraws++;
        this.lastGroundcover = this.lastGroundcover ?? new Map();
        this.lastGroundcover.set(globalLevel, groundcoverShadow);
                                                                    
        if (plan.forcedGlobal != null) {
          if (shadows.lastUpdated) shadows.lastUpdated = [...new Set([...(shadows.lastUpdated ?? []), globalLevel])].sort((a, b) => a - b);
          if (shadows.lastReused) shadows.lastReused = (shadows.lastReused ?? []).filter(level => level !== globalLevel);
          forcedRegistered = true;
        }
      }

                                                                          
                                                                                  
                                                  
      const encoder = GPU.getEncoder();
      const compute = encoder.beginComputePass({label: 'solar global static Hi-Z + batched cascade selection'});
      this.stats.compute_passes++;
      const selections = [];
      const selectedViews = new Map();
      try {
        const entry = this.coordinator.recordGlobalHiz(compute, shadows.size, this.snapshotView);
        this.stats.compute_dispatches += 1 + Math.max(0, entry.levels - 1);
        const globalCascade = shadows.cascades[globalLevel];
        const globalVP = vpArray(globalCascade);
        const globalBias = globalDepthPad(shadows, globalLevel);
        const globalNear = Number(globalCascade?.camera?.near);
        const globalFar = Number(globalCascade?.camera?.far);
        for (const level of plan.computeLevels) {
          const cascade = shadows.cascades[level];
                                                                               
                                                                               
                                                                                
                                                                              
                                                                  
          setFrameCamera(cascade.camera, shadows.size, shadows.size, {block: cascade.block});
          const view = this.coordinator.globalViewFor(level, globalLevel, entry);
          for (const system of systems) system.views?.set(view.key, view);
          const light = {
            level,
            demandBuffer: this.demandBuffer,
            hiz: entry.hiz,
            padTexels: SHADOW_GLOBAL_HIZ_DEMAND_PAD_TEXELS,
            depthPad: cascadeDepthPad(shadows, level),
                                                                                 
                                                                               
                                    
            legacyFull: true,
            global: {
              enabled: true,
              vp: globalVP,
              width: shadows.size,
              height: shadows.size,
              depthBias: globalBias,
              near: Number.isFinite(globalNear) ? globalNear : 0,
              far: Number.isFinite(globalFar) ? globalFar : 1,
              sourceLevel: globalLevel,
            },
          };
          const reuseInfo = reuse?.levels.get(level) ?? null;
          const lightPass = {
            label: `solar light ${level}`,
            kind: 'depth',
            camera: cascade.camera,
            frameBlock: cascade.block,
            vegetationShadowBudget: shadows.vegetationBudget,
            vegetationShadowEye: shadows.mainEye,
            vegetationShadowLevel: level,
            apsLightCull: true,
            apsShadowReuseCoverage: reuseInfo?.coverage ?? null,
          };
          light.reuse = reuseInfo?.cull ?? null;
          this.stats.selections += this.coordinator.selectShared(systems, view, lightPass, light, compute);
          selectedViews.set(level, view);
          selections.push({level, view, systems});
        }
        for (const selection of selections) {
          this.stats.compaction_dispatches += this.coordinator.finishShared(selection.systems, selection.view, compute);
        }
      } finally {
                                                                              
                                                                        
        compute.end();
      }

                                                                              
                                                                               
                                                                            
                    
      for (const level of plan.drawLevels) {
        const cascade = shadows.cascades[level];
        const view = selectedViews.get(level);
        const groundcoverShadow = this.lastGroundcover?.get(level)
          ?? terrain?.groundcover?.captureShadow?.(level, shadows.vegetationBudget)
          ?? null;
        if (level !== globalLevel || !plan.globalRedraw) {
          const restore = terrain?.beginShadowCascade?.(level, cascade, {shadowSize: shadows.size, demandUvMode: 'shadow'}) ?? null;
          try {
            meshRenderer.render(scene, this._sharedShadowPass(scene,meshRenderer,shadows,level,groundcoverShadow,cascadeSources,this._staticPass(shadows, scene, level, groundcoverShadow)));
          } finally {
            restore?.();
          }
        }
        const reuseInfo = reuse?.levels.get(level) ?? null;
                                                                          
                                                                     
                                                                                  
        if (reuseInfo?.cull?.enabled && this.reuseModule?.seed && reuseInfo?.seed !== false) {
          this.reuseModule.seed({
            encoder: GPU.getEncoder(),
            shadows,
            level,
            size: shadows.size,
            sourceLevel: reuseInfo.cull.sourceLevel,
            fineView: shadows.texture.view({dimension: '2d', baseArrayLayer: reuseInfo.cull.sourceLevel, arrayLayerCount: 1}),
            coarseView: shadows.texture.view({dimension: '2d', baseArrayLayer: level, arrayLayerCount: 1}),
            plan: reuseInfo,
                                                                              
                                                                            
            depthBias: 0,
          });
          this.stats.reuse_seeds++;
        }
        for (const system of systems) system.restoreDrawContext(view);
        meshRenderer.render(scene, this._sharedShadowPass(scene,meshRenderer,shadows,level,groundcoverShadow,cascadeSources,this._vegetationPass(shadows, level, groundcoverShadow, reuseInfo)));
        const hasGrass = groundcoverShadow || systems.some(system => system.isGrass);
        cascade.grassEye = hasGrass && shadows.mainEye ? shadows.mainEye.slice() : null;
        drawn.add(level);
      }
      if (reuseOrder.parentInvalidations.length && Array.isArray(shadows.lastUpdated)) {
        shadows.lastUpdated = [...new Set([...shadows.lastUpdated, ...reuseOrder.drawLevels])].sort((a, b) => a - b);
        if (Array.isArray(shadows.lastReused)) shadows.lastReused = shadows.lastReused.filter(level => !reuseOrder.drawLevels.includes(level));
      }
      const invalidations = new Map(reuseOrder.parentInvalidations.map(entry => [entry.level, entry]));
      const reuseMetadata = reuseOrder.levels.map(entry => {
        const info = reuse?.levels.get(entry.level) ?? null;
        return {
          level: entry.level,
          order: entry.level,
          source_level: info?.cull?.sourceLevel ?? entry.sourceLevel,
          rect: info?.cull ? [info.cull.minU, info.cull.minV, info.cull.maxU, info.cull.maxV] : null,
          valid: !!info?.cull?.enabled,
          reason: info?.cull?.enabled ? (info.reason ?? 'reuse') : (info?.reason ?? (this.reuseEnabled ? entry.reason : this.reuseDisabledReason)),
                                                                            
                                                                         
          draw: info?.cull?.enabled ? entry.draw : `full-${entry.level}`,
          reused_pixels: info?.reusedPixels ?? 0,
          reuse_rejected: info?.rejected ?? null,
          parent_invalidation: invalidations.get(entry.level) ?? null,
          seed: info?.seed !== false && !!info?.cull?.enabled,
        };
      });
      this.lastReuse = {
        frame: GPU.frame ?? 0,
        enabled: !!reuse && reuseOrder.drawLevels.length > 0,
        requested: this.reuseRequested,
        disabled_reason: this.reuseEnabled ? (reuse ? null : this.reuseDisabledReason) : this.reuseDisabledReason,
        fine_to_coarse: reuseOrder.drawLevels.slice(),
        levels: reuseMetadata,
        parent_invalidations: reuseOrder.parentInvalidations,
        conservative_cost: reuseOrder.parentInvalidations.length
          ? `${reuseOrder.parentInvalidations.length} coarser level(s) fully redrawn because a finer source changed`
          : null,
      };
      if (reuse) this.stats.reuse_frames++;
      this.lastGroundcover?.clear?.();
      this.lastBatch = {
        frame: GPU.frame ?? 0,
        globalLevel,
        globalKey: this.snapshotKey,
        forcedGlobal: plan.forcedGlobal,
        source_collections:cascadeSources.size,
        levels: selections.map(({level, view}) => ({level, view: view.key, systems: systems.map(system => system.systemKey ?? null)})),
      };
      this.lastSelectionLevels = selections.map(selection => ({level: selection.level, view: selection.view, systems: selection.systems}));
      this.stats.rendered++;
      this.failures = 0;
      return {rendered: true, levels: [...drawn], globalLevel};
    } catch (error) {
                                                                                
                                                                             
      this.stats.errors++;
      this.failures++;
      this.lastError = {stage: 'render', message: messageOf(error), frame: GPU.frame ?? null};
      this.invalidate('render-error');
      if (!forcedRegistered) {
        if (Array.isArray(previousUpdated)) shadows.lastUpdated = previousUpdated;
        if (Array.isArray(previousReused)) shadows.lastReused = previousReused;
      }
      if (this.failures >= 3) {
        this.enabled = false;
        this.disabledReason = 'repeated-errors';
      }
      return {rendered: false, fallbackIndices: plan.computeLevels, error: messageOf(error)};
    } finally {
      this.lastGroundcover?.clear?.();
      meshRenderer.syncPipelines = sync;
      setShadowMap(shadows.texture);
    }
  }

                                                                             
                                                                           
                                               
  async audit() {
    if (!this.lastSelectionLevels?.length || !GPU.device) return null;
    try {
      await GPU.queue.onSubmittedWorkDone();
      const rows = [];
      for (const {level, systems} of this.lastSelectionLevels) {
        for (const system of systems) {
          for (const model of system.models ?? []) {
            const context = model.contexts?.get(`solar-light-${level}`);
            if (!context) continue;
            const bytes = 14 + (model.blockCount ?? 0);
            const data = new Uint32Array(await readGpuBuffer(GPU.device, context.stats.getGPU(), bytes * 4).then(buffer => buffer));
            rows.push({
              level,
              model: model.name,
              total: model.n,
              frustum_rejected: data[0],
              occlusion_rejected: data[1],
              reuse_rejected: data[13] ?? 0,
              lod_counts: [data[2], data[3], data[4]],
              surviving_blocks: context.blockDispatch ? data[7] : null,
              indirect_args: Array.from(new Uint32Array(await readGpuBuffer(GPU.device, context.args.getGPU(), 15 * 4).then(buffer => buffer))),
            });
          }
        }
      }
      this.lastAudit = {frame: GPU.frame ?? null, rows};
      return this.lastAudit;
    } catch (error) {
      this.lastError = {stage: 'audit', message: messageOf(error), frame: GPU.frame ?? null};
      return null;
    }
  }

  metadata() {
    const levels = this.coordinator?.metadata?.().levels ?? [];
    const last = this.lastBatch;
    const perCascade = (last?.levels ?? []).map(entry => ({
      level: entry.level,
      view: entry.view,
      context: `vegetation context solar-light-${entry.level}`,
      indirect: `per-context args buffer, offsets 0/20/40`,
      actual_rejected: this.lastAudit?.rows?.filter(row => row.level === entry.level).map(row => ({
        model: row.model, occlusion_rejected: row.occlusion_rejected, reuse_rejected: row.reuse_rejected,
        frustum_rejected: row.frustum_rejected,
      })) ?? null,
      actual_rejected_source: this.lastAudit ? 'diagnostic audit after submit' : 'not read in frame loop',
    }));
    return {
      schema: this.schema,
      revision: this.revision,
      requested: this.requested,
      ready: this.ready,
      enabled: this.enabled,
      disposed: this.disposed,
      disabled_reason: this.disabledReason,
      last_error: this.lastError,
      global_source_level: this.snapshotSourceLevel,
      global_captured_vp: this.capturedVP,
      global_key: this.snapshotKey,
      global_redraw: this.stats.global_redraws,
      snapshot_valid: this.snapshotValid,
      snapshot_frame: this.snapshotFrame,
      hiz_builds: this.coordinator?.metadata?.().statistics?.global_builds ?? 0,
      compute_passes: this.stats.compute_passes,
      compute_dispatches: this.stats.compute_dispatches,
      single_compute_pass_per_frame: true,
      one_global_pyramid: true,
      occlusion_projection: 'global captured VP; global map size and depth bias; all eight AABB corners',
      cascade_light_vp: 'cascade-local VP retained for frustum/LOD/grass and final shadow raster',
      snapshot_policy: 'static-only largest-coverage cascade depth, copied before vegetation; never from final vegetation depth',
                                                                         
      cascade_reuse: {
        requested: this.reuseRequested,
        enabled: this.reuseEnabled,
        disabled_reason: this.reuseDisabledReason,
        module: this.reuseModule ? {
          schema: this.reuseModule.schema ?? null,
          revision: this.reuseModule.revision ?? null,
          owned: this.reuseOwned === true,
          error: this.reuseModuleError ?? null,
        } : null,
        last: this.lastReuse,
        last_invalidation: this.lastReuseInvalidation ?? null,
        statistics: {
          frames: this.stats.reuse_frames,
          seeds: this.stats.reuse_seeds,
          parent_invalidations: this.stats.parent_invalidations,
          reuse_rejected: this.lastAudit?.rows?.reduce((sum, row) => sum + (row.reuse_rejected ?? 0), 0) ?? null,
        },
        invariant: 'camera-only fine updates preserve independent coarse depth; scene/light/quality changes invalidate; grass policy must match before seeding',
        audit_accounting: 'audit rows expose occlusion_rejected and reuse_rejected separately; reuse skips are never folded into the occlusion counter',
      },
      fallbacks: this.stats.fallbacks,
      statistics: {...this.stats},
      per_cascade: perCascade,
      light_cull: this.coordinator?.metadata?.() ?? null,
      levels,
      no_frame_loop_readback: true,
      last_audit: this.lastAudit,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.ready = false;
    this.snapshot?.destroy?.();
    this.snapshot = null;
    this.snapshotView = null;
    this.demandBuffer?.destroy?.();
    this.demandBuffer = null;
    this.coordinator?.dispose?.();
    this.coordinator = null;
                                                                              
                                                                             
    if (this.reuseOwned) {
      try {
        this.reuseModule?.dispose?.();
      } catch (error) {
        this.lastError = {stage: 'dispose-reuse', message: messageOf(error), frame: GPU.frame ?? null};
      }
    }
    this.reuseModule = null;
    this.lastBatch = null;
    this.lastSelectionLevels = null;
  }
}

export default ShadowGlobalHiZ;
