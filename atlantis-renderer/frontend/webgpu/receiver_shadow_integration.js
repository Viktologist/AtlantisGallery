                                                           
  
                                                                             
  
                                                                     
                                                                              
                                                                                 
                                                                                
                                                                              
                                                                            
                                                                                
                                                                             
                 
  
                                                                               
                                                                              
                                                                      
  
                                          
                                     
                                                                           
                                                        
                                  
                                                                           
                                                    
                                                
  
                                                                               
                                                    

import {GPU, FrameUniforms, G, LAYERS} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Vector3} from '../../vendor/tidewater/src/engine/index.js';
import {setFrameCamera} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {setShadowMap} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {
  computeFiniteReceiverDomains,
  describeFiniteDomainLevels,
  encodeExternalRect,
  EXTERNAL_DOMAIN_FULL_FRACTION,
  EXTERNAL_DOMAIN_UV_PADDING,
  externalDomainCacheKey,
  RECEIVER_EXTERNAL_DOMAIN_REVISION,
  RECEIVER_EXTERNAL_DOMAIN_SCHEMA,
} from './receiver_external_domains.js';

export const RECEIVER_SHADOW_INTEGRATION_SCHEMA = 'aps-receiver-driven-shadows/integration/1';
export const RECEIVER_SHADOW_INTEGRATION_REVISION = 'rds-integration-r4';

const DEMAND_LEVELS = 4;
const DEMAND_WORDS = DEMAND_LEVELS * 8;
const OCCLUSION_BIAS_M = 0.05;
const MAX_DEMAND_FRACTION = 0.85;
const DEMAND_PAD_TEXELS = 2;

function messageOf(error) {
  return String(error?.message ?? error ?? 'unknown error');
}

function pageParam(name) {
  try {
    if (typeof location === 'undefined') return null;
    return new URL(location.href).searchParams.get(name);
  } catch {
    return null;
  }
}

function optionFlag(options, name, queryName) {
  if (options?.[name] === true) return true;
  const value = pageParam(queryName);
  return value === '1' || value === 'true';
}

function readVec3(value, fallback = [0, 1, 0]) {
  if (!value) return fallback.slice();
  if (Array.isArray(value)) return value.length >= 3 && value.slice(0, 3).every(Number.isFinite) ? value.slice(0, 3) : fallback.slice();
  if (typeof value.toArray === 'function') return readVec3(value.toArray(), fallback);
  const out = [value.x, value.y, value.z];
  return out.every(Number.isFinite) ? out : fallback.slice();
}

function finiteBox(box) {
  return !!box && Array.isArray(box.min) && Array.isArray(box.max)
    && box.min.length >= 3 && box.max.length >= 3
    && [...box.min.slice(0, 3), ...box.max.slice(0, 3)].every(Number.isFinite);
}

function mergeBox(a, b) {
  if (!finiteBox(a)) return b;
  if (!finiteBox(b)) return a;
  return {
    min: a.min.map((value, index) => Math.min(value, b.min[index])),
    max: a.max.map((value, index) => Math.max(value, b.max[index])),
  };
}

                                                                            
                                                                           
function visibleInHierarchy(object) {
  for (let node = object; node; node = node.parent) if (node.visible === false) return false;
  return true;
}

function componentMetadata(component) {
  try {
    return typeof component?.metadata === 'function' ? component.metadata() : null;
  } catch {
    return null;
  }
}

const SSR_SCOPE_SAME_CAMERA = 'same_camera_current_opaque_ssr';
const SSR_SCOPE_DIFFERENT_CAMERA = 'different_camera';

                                                                         
                                                                         
                                                                          
                                                                             
function isSameCameraScreenSpaceReflection(metadata) {
  const auxiliary = metadata?.auxiliary_cameras;
  const method = typeof metadata?.method === 'string' ? metadata.method : '';
  return auxiliary === 0 && /screen[- ]space/i.test(method);
}

                                                                            
                                                                      
                                                                               
                                                                         
                                                            
export function clipFrustumSlab(corners, lowY, highY) {
  if (!Array.isArray(corners) || corners.length !== 8 || !Number.isFinite(lowY) || !Number.isFinite(highY) || lowY > highY) return null;
  for (const corner of corners) {
    if (!Array.isArray(corner) || corner.length < 3 || !corner.slice(0, 3).every(Number.isFinite)) return null;
  }
  const points = [];
  for (const corner of corners) if (corner[1] >= lowY && corner[1] <= highY) points.push([corner[0], corner[1], corner[2]]);
  const edges = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
  for (const [ia, ib] of edges) {
    const a = corners[ia], b = corners[ib];
    for (const y of [lowY, highY]) {
      const ya = a[1], yb = b[1];
      if ((ya < y && yb < y) || (ya > y && yb > y)) continue;
      const dy = yb - ya;
      if (Math.abs(dy) < 1e-12) continue;
      const t = (y - ya) / dy;
      if (!(t >= 0 && t <= 1)) continue;
      points.push([a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t]);
    }
  }
  if (!points.length) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
    minZ = Math.min(minZ, point[2]); maxZ = Math.max(maxZ, point[2]);
  }
  if (![minX, minZ, maxX, maxZ].every(Number.isFinite)) return null;
  return {min: [minX, lowY, minZ], max: [maxX, highY, maxZ], vertices: points.length};
}

                                                                           
                                                                               
                                                            
export function verifiedOceanHardAmplitude(ocean, options = null) {
  for (const value of [
    options?.oceanHardMaxAmplitudeM,
    ocean?.hardMaxAmplitudeM,
    ocean?.config?.hardMaxAmplitudeM,
    ocean?.config?.maxAmplitudeM,
    ocean?.config?.maxDisplacementM,
    ocean?.config?.maxWaveAmplitudeM,
  ]) {
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function completeDomain(value) {
  if (!value || value.complete !== true || !Array.isArray(value.boxes)) return null;
  const boxes = value.boxes.filter(finiteBox).map(box => ({min: box.min.slice(0, 3), max: box.max.slice(0, 3)}));
  return boxes.length === value.boxes.length && boxes.length ? boxes : null;
}

                                                                              
                                                                             
                                               
function meshWorldBox(mesh) {
  if (!mesh?.isMesh || !visibleInHierarchy(mesh)) return null;
  const geometry = mesh.geometry;
  if (!geometry) return null;
  if (typeof mesh.updateWorldMatrix === 'function') mesh.updateWorldMatrix(true, false);
  if (!geometry.boundingBox && typeof geometry.computeBoundingBox === 'function') geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || !box.min || !box.max) return null;
  const elements = mesh.matrixWorld?.elements;
  if (!elements || elements.length < 16 || ![...elements].every(Number.isFinite)) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max.x : box.min.x;
    const y = i & 2 ? box.max.y : box.min.y;
    const z = i & 4 ? box.max.z : box.min.z;
    const px = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
    const py = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
    const pz = elements[2] * x + elements[6] * y + elements[10] * z + elements[14];
    if (![px, py, pz].every(Number.isFinite)) return null;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  return {min: [minX, minY, minZ], max: [maxX, maxY, maxZ]};
}

export class ReceiverShadowIntegration {
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.options = options;
    this.schema = RECEIVER_SHADOW_INTEGRATION_SCHEMA;
    this.revision = RECEIVER_SHADOW_INTEGRATION_REVISION;
    this.requested = optionFlag(options, 'receiverDrivenShadows', 'receiver_shadows');
    this.mode = options.receiverDemandMode === 'level' || pageParam('receiver_demand') === 'level' ? 'level' : 'pixel';
    this.ready = false;
    this.enabled = false;
    this.disposed = false;
    this.failed = false;
    this.lastError = null;
    this.disabledReason = null;
    this.pipeline = null;
    this.coordinator = null;
    this.casterDemand = null;
    this.prepareReceiverXYZView = null;
    this.activeFrame = false;
    this.suspended = false;
    this.snapshotFallback = false;
    this._pixelKey = null;
    this._lastPixelKey = null;
    this._collectHook = null;
    this._lastDemand = null;
    this._lastShadows = null;
    this._external = null;
    this._stages = null;
    this._profile = null;
    this._casterClearQueued = false;
    this._externalDomainCache = null;
    this._externalDomainCounters = {computes: 0, hits: 0};
    this._counters = {demand_frames: 0, shadow_frames: 0, fallback_frames: 0, cull_levels: 0, full_vegetation_levels: 0};
  }

  get active() {
    return this.ready && this.enabled && !this.failed && !this.disposed && this.activeFrame === true;
  }

  get demandBuffer() {
    return this.pipeline?.demandBuffer ?? null;
  }

  async ensureReady(viewer = this.viewer, {force = false} = {}) {
    if (this.disposed) throw Error('ReceiverShadowIntegration is disposed');
    if (this.ready) return this;
    if (this.failed && !force) return this;
    if (!this.requested && !force) return this;
    const device = GPU.device;
    if (!device) throw Error('Receiver-driven shadows require an initialized WebGPU device before frames');
    if (!viewer?.meshRenderer || !viewer?.shadows) throw Error('ReceiverShadowIntegration requires viewer.meshRenderer and viewer.shadows');
    await this._probeRgba32Float(device);
    const [pipelineModule, cullModule, casterModule, visibilityModule] = await Promise.all([
      import('./receiver_shadow_pipeline.js'),
      import('./light_cull_coordinator.js'),
      import('./caster_demand_gpu.js'),
      import('./vegetation_visibility.js'),
    ]);
    this.pipeline = new pipelineModule.ReceiverShadowPipeline({
      label: 'aps receiver shadow',
      normalBias: viewer.shadows.normalBias ?? null,
      occlusionBias_m: OCCLUSION_BIAS_M,
      maxDemandFraction: MAX_DEMAND_FRACTION,
      layerMask: 1 << LAYERS.OPAQUE,
    });
    this.coordinator = new cullModule.LightCullCoordinator(GPU, {
      depthPad: cullModule.LightCullCoordinator.rasterPad(),
      padTexels: 0,
      timestampWrites: label => this._timestamp(label),
    });
    this.casterDemand = new casterModule.CasterDemandGPU({renderer: viewer.meshRenderer, label: 'aps static caster demand'});
                                                                                
                                                     
    viewer.meshRenderer.casterDemandGPU = this.casterDemand;
    this.prepareReceiverXYZView = typeof visibilityModule.prepareReceiverXYZView === 'function'
      ? visibilityModule.prepareReceiverXYZView
      : null;
    this._installCollectHook(viewer.meshRenderer);
    this.ready = true;
    this.failed = false;
    if (this.requested) this.enabled = true;
    return this;
  }

  async _probeRgba32Float(device) {
    device.pushErrorScope('validation');
    let texture = null;
    let encoder = null;
    try {
      texture = device.createTexture({
        label: 'aps receiver xyz attachment probe',
        size: {width: 1, height: 1},
        format: 'rgba32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      encoder = device.createCommandEncoder({label: 'aps receiver xyz attachment probe'});
      const pass = encoder.beginRenderPass({
        colorAttachments: [{view: texture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store'}],
      });
      pass.end();
      device.queue.submit([encoder.finish()]);
    } catch (error) {
                                                                         
      const scoped = await device.popErrorScope().catch(() => null);
      throw Error(`rgba32float render attachment probe failed: ${messageOf(scoped ?? error)}`);
    }
    const scoped = await device.popErrorScope().catch(error => error);
    try { texture?.destroy(); } catch {}
    if (scoped) throw Error(`rgba32float render attachment is not supported: ${messageOf(scoped)}`);
  }

  _installCollectHook(renderer) {
    if (!renderer || typeof renderer.collect !== 'function') throw Error('ReceiverShadowIntegration requires GeometryMeshRenderer.collect');
    if (this._collectHook) return;
    const original = renderer.collect;
    const integration = this;
    const wrapped = function receiverShadowCollect(scene, pass) {
      const lists = original.call(this, scene, pass);
      if (pass?.apsCasterDemandGPU) {
        try {
          pass.apsCasterDemandGPUResult = pass.apsCasterDemandGPU.apply(lists, pass);
        } catch (error) {
          pass.apsCasterDemandGPUResult = {applied: false, reason: 'dispatch_error', error: messageOf(error)};
          pass.apsCasterDemandGPU.lastError = {stage: 'apply', message: messageOf(error)};
        }
      } else if (pass?.apsCasterDemandTerrain) {
                                                                              
                                                                              
      }
      return lists;
    };
    this._collectHook = {original, wrapped, renderer, integration};
    renderer.collect = wrapped;
  }

  _removeCollectHook() {
    const hook = this._collectHook;
    if (!hook) return;
    if (hook.renderer.collect === hook.wrapped) hook.renderer.collect = hook.original;
    this._collectHook = null;
  }

                                                                        
                                                                            
                                          
  detachRenderer() {
    this._removeCollectHook();
  }

  setEnabled(enabled) {
    if (this.disposed) throw Error('ReceiverShadowIntegration is disposed');
    if (enabled && !this.ready) throw Error('ReceiverShadowIntegration is not ready; await ensureReady() during compile first');
    this.enabled = !!enabled;
    this.failed = false;
    this.disabledReason = null;
    this.activeFrame = false;
    if (this.viewer?.shadows) {
      this.viewer.shadows.receiverActive = false;
      this.viewer.shadows.receiverPixelMode = false;
    }
                                                                           
                                                                             
                                                                      
    this.forceAllCascades(this.enabled ? 'enabled' : 'disabled');
    return this.enabled;
  }

  fail(error) {
    const message = messageOf(error);
    this.lastError = {stage: 'frame', message, frame: GPU.frame};
    this.disabledReason = 'gpu_error';
    this.failed = true;
    this.enabled = false;
    this.activeFrame = false;
    if (this.viewer?.shadows) {
      this.viewer.shadows.receiverActive = false;
      this.viewer.shadows.receiverPixelMode = false;
      for (const cascade of this.viewer.shadows.cascades ?? []) cascade.dirty = true;
    }
    if (this.viewer) {
      this.viewer.lastRecoverableError = {operation: 'receiver_driven_shadows', message, frame: GPU.frame, fallback: 'legacy_four_clipmap'};
    }
    try { console.error('Receiver-driven shadows disabled after an explicit GPU/encode error; legacy four-clipmap path restored:', error); } catch {}
    return this.metadata();
  }

  forceAllCascades(reason = 'external') {
    const cascades = this.viewer?.shadows?.cascades;
    if (!Array.isArray(cascades)) return false;
    for (const cascade of cascades) cascade.dirty = true;
    this._lastPixelKey = null;
    this._lastDemandReason = reason;
    return true;
  }

  invalidate(reason = 'external') {
    this._pixelKey = null;
    this._lastPixelKey = null;
    this._lastDemand = null;
    this._external = null;
    this._externalDomainCache = null;
    this.lastInvalidation = {reason, frame: GPU.frame};
    if (reason === 'clear' || reason === 'scene') {
                                                                          
                                                                              
                                                                              
                                                                             
      if (!this._casterClearQueued) {
        this._casterClearQueued = true;
        const clear = () => {
          this._casterClearQueued = false;
          if (this.disposed) return;
          try { this.casterDemand?.clear?.(); } catch (error) { this.lastError = {stage: 'caster_clear', message: messageOf(error)}; }
        };
        try {
          if (typeof GPU.onSubmit === 'function') GPU.onSubmit(null, clear);
          else clear();
        } catch (error) {
          this._casterClearQueued = false;
          this.lastError = {stage: 'caster_clear_schedule', message: messageOf(error)};
        }
      }
    }
    if (this.enabled) this.forceAllCascades(reason);
  }

                                                                 
                                                                         
                                                                           
                                                              
  beginFrame(viewer = this.viewer, bounds = null, {multipleTerrains = false} = {}) {
    this._lastShadows = viewer?.shadows ?? null;
    if (!viewer?.shadows) throw Error('ReceiverShadowIntegration.beginFrame requires viewer.shadows');
    const shadows = viewer.shadows;
    const snapshot = !!(shadows.pendingRestore || shadows.pendingCapture);
    const suspended = snapshot || multipleTerrains;
    const want = this.ready && this.enabled && !this.failed && !this.disposed && !suspended;
    this.snapshotFallback = snapshot;
    this.suspended = suspended;
    this.activeFrame = want;
    if (snapshot) {
                                                                               
                                                                                 
      for (const cascade of shadows.cascades) cascade.dirty = true;
    }
    this._pixelKey = want && this.mode === 'pixel' ? this._cameraKey(viewer, shadows) : null;
    shadows.receiverIntegration = this;
    shadows.receiverActive = want;
    shadows.receiverPixelMode = want && this.mode === 'pixel';
    shadows.receiverPixelKey = this._pixelKey;
    if (want && this.mode === 'pixel' && this._pixelKey !== this._lastPixelKey) {
      for (const cascade of shadows.cascades) cascade.dirty = true;
    }
    this._lastPixelKey = this._pixelKey;
    this._frameBounds = bounds;
    this._stages = this._profile ? {cpu_ms: {}} : null;
    return {active: want, mode: this.mode, pixel_key: this._pixelKey, snapshot, suspended};
  }

  _cameraKey(viewer, shadows) {
    const camera = viewer.camera;
    const canvas = viewer.canvas;
    const sun = readVec3(G?.sunDir?.value ?? viewer?.lighting?.sunDir?.value, [0, 1, 0]);
    const matrix = camera.matrixWorld?.elements ?? [];
    const projection = camera.projectionMatrix?.elements ?? [];
    const boundedReflections = [...(viewer.boundedWaters ?? [])].map(system => {
      const metadata = componentMetadata(system)?.reflection;
      return Number.isFinite(metadata?.auxiliary_cameras) ? metadata.auxiliary_cameras : -1;
    });
    return JSON.stringify([
      canvas?.width ?? 0, canvas?.height ?? 0,
      Array.from(matrix).map(value => Math.round(value * 1e6) / 1e6),
      Array.from(projection).map(value => Math.round(value * 1e6) / 1e6),
      Array.from(sun).map(value => Math.round(value * 1e6) / 1e6),
      shadows.size, shadows.count, shadows.splits,
      viewer.shadowRevision ?? 0, viewer.sceneEpoch ?? 0,
      viewer.oceanLoadId ?? 0, viewer.boundedWaters?.size ?? 0, viewer.inlandOptics ? 1 : 0,
                                                                             
                                                                             
                                                                             
      viewer.ocean?.reflection ? 1 : 0,
      viewer.ocean?.config?.reflections === true ? 1 : 0,
      viewer.inlandOptics?.reflections === true ? 1 : 0,
      boundedReflections,
      verifiedOceanHardAmplitude(viewer.ocean, this.options),
      Number.isFinite(viewer.ocean?.config?.sealevel) ? viewer.ocean.config.sealevel
        : (Number.isFinite(viewer.ocean?.config?.seaLevel) ? viewer.ocean.config.seaLevel : null),
      viewer.options?.shadowDistance ?? null, viewer.options?.shadowMapSize ?? null,
      viewer.vegetationLOD ?? null, viewer.grassDensityRetention ?? null,
      viewer.heightfield?.groundcover?.params?.fields?.ready?.value ?? null,
      this.mode,
    ]);
  }

                                                                           
                                                                              
                                                  
  renderDemand(viewer = this.viewer, shadows = this._lastShadows, indices = null) {
    if (!this.activeFrame) return null;
                                                                              
                                                                   
    if (Array.isArray(indices) && indices.length === 0) {
      return {reused: true, reason: 'no shadow levels redrawn', no_readback: true};
    }
    if (!this.pipeline) throw Error('ReceiverShadowIntegration.renderDemand requires the receiver pipeline');
    if (!Array.isArray(shadows?.cascades) || shadows.cascades.length !== DEMAND_LEVELS) {
      throw Error(`ReceiverShadowIntegration requires exactly ${DEMAND_LEVELS} cascades`);
    }
    this._counters.demand_frames++;
    const external = this._externalDemand(viewer, shadows);
    this._external = external;
    const options = {
      externalBoxes: external.boxes,
      externalRects: external.externalRects,
      legacyFull: external.legacyFull,
      maxDemandFraction: MAX_DEMAND_FRACTION,
      normalBias: shadows.normalBias ?? this.options.normalBias ?? null,
      shadowMapSize: shadows.size,
      sunDir: readVec3(G?.sunDir?.value ?? viewer?.lighting?.sunDir?.value, [0, 1, 0]),
      prepareReceiver: payload => this._prepareReceiverXYZ(payload),
      label: 'aps receiver xyz',
    };
    const cpuStart = performance.now();
    if (this.mode === 'level') {
      this.pipeline.prepare(viewer, shadows.cascades, options);
      this._writeFullDemand();
      this._lastDemand = {mode: 'level', external: external.metadata, full_levels: DEMAND_LEVELS, no_readback: true};
      this._mark('after_demand');
    } else {
      this.pipeline.renderXYZ(viewer, shadows.cascades, options);
      this._mark('after_xyz');
      this.pipeline.reduce(shadows.cascades, options);
      this._mark('after_demand');
      this._lastDemand = {...(this.pipeline.metadata()?.last_demand ?? {}), mode: 'pixel', external: external.metadata, no_readback: true};
    }
    if (this._stages) this._stages.cpu_ms.receiver_demand = performance.now() - cpuStart;
    return this._lastDemand;
  }

  _prepareReceiverXYZ({viewer, renderer, scene, pass}) {
    const cpuStart = performance.now();
    if (typeof this.prepareReceiverXYZView === 'function') {
      this.prepareReceiverXYZView(renderer.vegetationSystems, scene, pass);
    }
    if (this._stages) this._stages.cpu_ms.receiver_xyz_selection = performance.now() - cpuStart;
    return {timestampWrites: this._timestamp('aps receiver xyz')};
  }

  _writeFullDemand() {
    const buffer = this.pipeline?.demandBuffer;
    if (!buffer) throw Error('ReceiverShadowIntegration level mode has no ReceiverDemand buffer');
    const words = new Uint32Array(DEMAND_WORDS);
    for (let level = 0; level < DEMAND_LEVELS; level++) {
      const base = level * 8;
      words[base + 0] = 0;
      words[base + 1] = 0;
      words[base + 2] = 0;
      words[base + 3] = 1;
      words[base + 4] = 65535;
      words[base + 5] = 65535;
      words[base + 6] = 16777215;
                                                                            
      words[base + 7] = 1 | 2 | 4;
    }
    GPU.queue.writeBuffer(buffer, 0, words);
  }

                                                                             
                                                                             
                                                    
    
                                                                              
                                
                                                                       
                                                                               
                                                                          
                                                                             
                                                              
    
                                                                          
                                                                            
                                           
  _externalDemand(viewer, shadows = this._lastShadows) {
    const boxes = [];
    const reasons = [];
    const reflectionConsumers = [];
    const consumerFlags = {};
    let legacyFull = false;
    const full = reason => {
      legacyFull = true;
      if (reason && !reasons.includes(reason)) reasons.push(reason);
    };
    const ocean = viewer?.ocean;
    const oceanPresent = ocean?.enabled !== false && ocean?.initialized === true
      && visibleInHierarchy(ocean?.mesh ?? viewer?.scene);
    const config = ocean?.config ?? {};
    const seaLevel = Number.isFinite(config.sealevel) ? config.sealevel : (Number.isFinite(config.seaLevel) ? config.seaLevel : null);
    const amplitude = verifiedOceanHardAmplitude(ocean, this.options);
    const oceanSlabAvailable = oceanPresent && Number.isFinite(amplitude) && Number.isFinite(seaLevel);

                                                                              
                                                                               
    const waterMask = 1 << LAYERS.WATER;
    const boundedWaterMeshes = [];
    const unknownTranslucent = [];
    const seen = new Set();
    const visit = object => {
      if (!object || seen.has(object)) return;
      seen.add(object);
      if (object.visible === false) return;
      if (object.isMesh) {
        const isOcean = object === ocean?.mesh;
        const isWater = !isOcean && ((object.layers?.mask ?? 0) & waterMask) !== 0;
        if (isWater) boundedWaterMeshes.push(object);
        else if (!isOcean) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          if (object.receiveShadow === true && materials.some(material => material?.transparent === true)) unknownTranslucent.push(object);
        }
      }
      for (const child of object.children ?? []) visit(child);
    };
    visit(viewer?.scene);

    const boundedWaterSystems = [...(viewer?.boundedWaters ?? [])];
    let needsMainCameraFiniteDomain = false;
    let differentCameraConsumer = false;

                                                                                
                                                                            
                                                                  
    if (oceanPresent) {
      if (oceanSlabAvailable) {
        const slab = this._cameraFrustumSlab(viewer.camera, seaLevel - amplitude, seaLevel + amplitude);
        if (!slab) full('ocean_frustum_unbounded');
        else boxes.push({min: slab.min, max: slab.max, kind: 1, source: 'ocean_visible_frustum_wave_slab'});
      } else {
        needsMainCameraFiniteDomain = true;
        consumerFlags.ocean_unknown_amplitude = 1;
      }
    }

    const classifyReflection = (name, metadata) => {
      if (isSameCameraScreenSpaceReflection(metadata)) {
        reflectionConsumers.push({name, scope: SSR_SCOPE_SAME_CAMERA, auxiliary_cameras: 0});
        needsMainCameraFiniteDomain = true;
      } else {
        reflectionConsumers.push({name, scope: SSR_SCOPE_DIFFERENT_CAMERA, auxiliary_cameras: Number.isFinite(metadata?.auxiliary_cameras) ? metadata.auxiliary_cameras : null});
        differentCameraConsumer = true;
      }
    };

                                                                              
                                                                              
    if (oceanPresent && (ocean?.reflection || ocean?.config?.reflections === true)) {
      const metadata = componentMetadata(ocean?.reflection);
      if (metadata) classifyReflection('ocean_screen_space_reflection', metadata);
      else {
        reflectionConsumers.push({name: 'ocean_screen_space_reflection', scope: SSR_SCOPE_DIFFERENT_CAMERA, auxiliary_cameras: null});
        differentCameraConsumer = true;
      }
    }
    if (viewer?.inlandOptics?.reflections === true) {
      classifyReflection('inland_screen_space_reflection', componentMetadata(viewer.inlandOptics)?.ssr);
    }
    for (const system of boundedWaterSystems) {
      if (system?.disposed === true) continue;
      const metadata = componentMetadata(system)?.reflection;
      if (metadata) classifyReflection('bounded_water_screen_space_reflection', metadata);
      else {
                                                                            
                                                                           
                                                        
        reflectionConsumers.push({name: 'bounded_water_reflection_unresolved', scope: SSR_SCOPE_DIFFERENT_CAMERA, auxiliary_cameras: null});
        differentCameraConsumer = true;
        needsMainCameraFiniteDomain = true;
      }
    }

                                                                     
                                                                           
                                                                      
    const reflectionDomain = completeDomain(this.options?.planarReflectionReceiverDomain ?? viewer?.planarReflectionReceiverDomain);
    if (reflectionDomain) {
      for (const box of reflectionDomain) boxes.push({min: box.min, max: box.max, kind: 3, source: 'caller_certified_reflection_domain'});
    } else if (differentCameraConsumer) {
      full('different_camera_reflection_receiver_domain_unbounded');
    }

    const translucentDomain = completeDomain(this.options?.translucentReceiverDomain ?? viewer?.translucentReceiverDomain);
    if (unknownTranslucent.length) {
      if (translucentDomain) {
        for (const box of translucentDomain) boxes.push({min: box.min, max: box.max, kind: 4, source: 'caller_certified_translucent_receiver_domain'});
      } else {
        needsMainCameraFiniteDomain = true;
        consumerFlags.unknown_translucent = unknownTranslucent.length;
      }
    }

                                                                               
                                                                       
    let boundedCount = 0;
    let boundedBoxesOmitted = 0;
    for (const mesh of boundedWaterMeshes) {
      const box = meshWorldBox(mesh);
      if (!box) {
        if (!needsMainCameraFiniteDomain) full('bounded_water_world_aabb_unknown');
        continue;
      }
      boundedCount++;
      if (!needsMainCameraFiniteDomain) {
                                                                               
                                                                            
        boxes.push({min: box.min, max: box.max, kind: 2, source: 'bounded_water_world_aabb'});
      } else if (boxes.length < 8) {
                                                                             
                                                            
        boxes.push({min: box.min, max: box.max, kind: 2, source: 'bounded_water_world_aabb'});
      } else {
        boundedBoxesOmitted++;
      }
    }
    if (!boundedCount && boundedWaterSystems.length && !needsMainCameraFiniteDomain) full('bounded_water_attached_without_mesh_bounds');
    if (viewer?.inlandOptics && !boundedCount && !needsMainCameraFiniteDomain) full('inland_water_receivers_without_world_aabb');
    if (boxes.length > 8) full('external_box_limit');

    let finite = null;
    let externalRects = null;
    if (needsMainCameraFiniteDomain && !legacyFull) {
      finite = this._finiteReceiverDomains(viewer, shadows, consumerFlags);
      if (!finite.usable) {
        full(finite.reason ?? 'finite_receiver_domain_unresolved');
      } else {
        externalRects = finite.levels.map(encodeExternalRect);
        consumerFlags.finite_domains = 1;
      }
    }
    if (legacyFull) externalRects = null;

    const finiteLevelsNonEmpty = !!externalRects?.some(rect => rect.flag === 1 || rect.flag === 3);
    const metadata = {
      boxes: boxes.slice(0, 8).map(box => ({min: box.min, max: box.max, kind: box.kind, source: box.source})),
      legacy_full: legacyFull,
      reasons,
                                                                            
                                                                           
      domain_mode: legacyFull
        ? 'full'
        : (finite && externalRects
          ? (finiteLevelsNonEmpty ? 'finite_frustum' : 'finite_frustum_empty')
          : (boxes.length ? 'bbox' : 'none')),
      bounded_water_meshes: boundedCount,
      bounded_water_boxes_omitted: boundedBoxesOmitted,
      bounded_water_systems: boundedWaterSystems.length,
      unknown_translucent_receivers: unknownTranslucent.length,
      reflection_consumers: reflectionConsumers.map(consumer => consumer.name),
      reflection_scopes: reflectionConsumers,
      reflection_domain_certified: !!reflectionDomain,
      translucent_domain_certified: !!translucentDomain,
      visible_false_ancestors_ignored: true,
      ocean_amplitude_policy: 'explicit hardMaxAmplitudeM/maxAmplitudeM only; significantHeight is not a displacement bound',
      ocean_hard_amplitude_m: Number.isFinite(amplitude) ? amplitude : null,
      ocean_sea_level_m: Number.isFinite(seaLevel) ? seaLevel : null,
      ocean_slab_available: oceanSlabAvailable,
      finite_receiver_domains: finite ? {
        schema: RECEIVER_EXTERNAL_DOMAIN_SCHEMA,
        revision: RECEIVER_EXTERNAL_DOMAIN_REVISION,
        usable: finite.usable,
        reason: finite.reason,
        source: finite.source,
        applied: this.mode === 'pixel' && !!externalRects,
        cached: finite.cached === true,
        conservative_for_all_water_times: true,
        camera_frustum_vertices: finite.camera_frustum_vertices,
        uv_padding: finite.uv_padding,
        max_demand_fraction: finite.max_demand_fraction,
        levels: describeFiniteDomainLevels(finite),
      } : null,
      external_rects: externalRects ? externalRects.map((rect, level) => ({level, ...rect})) : null,
    };
    return {boxes: boxes.slice(0, 8), legacyFull, externalRects, metadata};
  }

                                                                            
                                                                       
                                                                        
  _finiteReceiverDomains(viewer, shadows, consumerSignature) {
    const camera = viewer?.camera;
    const cascades = shadows?.cascades;
    const key = externalDomainCacheKey({
      camera,
      cascades,
      consumerSignature,
      viewport: viewer?.canvas ?? null,
      uvPadding: EXTERNAL_DOMAIN_UV_PADDING,
      maxDemandFraction: EXTERNAL_DOMAIN_FULL_FRACTION,
    });
    if (this._externalDomainCache?.key === key) {
      this._externalDomainCounters.hits++;
      return {...this._externalDomainCache.value, cached: true};
    }
    this._externalDomainCounters.computes++;
    const value = computeFiniteReceiverDomains({
      camera,
      cascades,
      uvPadding: EXTERNAL_DOMAIN_UV_PADDING,
      maxDemandFraction: EXTERNAL_DOMAIN_FULL_FRACTION,
    });
    this._externalDomainCache = {key, value};
    return {...value, cached: false};
  }

  _cameraFrustumSlab(camera, lowY, highY) {
    if (!camera || !Number.isFinite(lowY) || !Number.isFinite(highY) || lowY > highY) return null;
    camera.updateMatrixWorld();
    const corners = [];
    for (const z of [0, 1]) {
      for (const x of [-1, 1]) {
        for (const y of [-1, 1]) {
          const point = new Vector3(x, y, z).unproject(camera);
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null;
          corners.push([point.x, point.y, point.z]);
        }
      }
    }
    return clipFrustumSlab(corners, lowY, highY);
  }

  _normalBias(shadows, level) {
    const source = shadows?.normalBias ?? this.options.normalBias;
    if (Array.isArray(source)) return Number.isFinite(source[level]) ? source[level] : (Number.isFinite(source[0]) ? source[0] : 0.1);
    return Number.isFinite(source) ? source : 0.1;
  }

  _depthPad(shadows, level) {
    const cascade = shadows.cascades[level];
    const near = Number.isFinite(cascade?.camera?.near) ? cascade.camera.near : 0.1;
    const far = Number.isFinite(cascade?.camera?.far) ? cascade.camera.far : Math.max(near + 1, 1);
    const range = Math.max(far - near, 1e-6);
    const texel = Number.isFinite(cascade?.texel) ? cascade.texel : (2 * (cascade?.radius ?? 1) / Math.max(shadows.size, 1));
    return (OCCLUSION_BIAS_M + this._normalBias(shadows, level) + 2 * texel) / range
      + (this.coordinator?.constructor?.rasterPad?.() ?? 0);
  }

  _canCull(meshRenderer) {
    if (!this.coordinator || !this.demandBuffer) return false;
                                                                              
                                                                              
                                                                                 
    if (typeof this.prepareReceiverXYZView !== 'function') return false;
    const systems = [...(meshRenderer?.vegetationSystems ?? [])];
    if (!systems.length) return false;
    return systems.every(system => !system?.disposed && typeof system?.selectLight === 'function' && system.lightCullSupported !== false);
  }

                                                                      
  renderShadows(scene, meshRenderer, indices, terrain = null, shadows = this._lastShadows) {
    if (!this.activeFrame) throw Error('ReceiverShadowIntegration.renderShadows requires an active frame');
    if (!this.pipeline || !this.demandBuffer) throw Error('ReceiverShadowIntegration.renderShadows has no demand buffer');
    if (!Array.isArray(indices)) throw Error('ReceiverShadowIntegration.renderShadows requires cascade indices');
    this._counters.shadow_frames++;
    setShadowMap(shadows.neutral);
    const sync = meshRenderer.syncPipelines;
    meshRenderer.syncPipelines = true;
    try {
      for (const level of indices) {
        const cascade = shadows.cascades[level];
        if (!cascade) continue;
        const cpuStart = performance.now();
        const restore = terrain?.beginShadowCascade?.(level, cascade, {
          demandBuffer: this.demandBuffer,
          helper: this.casterDemand ?? undefined,
          demandPadTexels: DEMAND_PAD_TEXELS,
          demandDepthPad: this._depthPad(shadows, level),
          shadowSize: shadows.size,
          demandUvMode: 'shadow',
        }) ?? null;
        const groundcoverShadow = terrain?.groundcover?.captureShadow?.(level, shadows.vegetationBudget) ?? null;
        try {
          this._applyStaticCascade({scene, meshRenderer, terrain, shadows, cascade, level, groundcoverShadow});
          let hiz = null;
          let culled = false;
          if (!meshRenderer.precompiling && this._canCull(meshRenderer)) {
            const layerView = shadows.texture.view({dimension: '2d', baseArrayLayer: level, arrayLayerCount: 1});
            hiz = this.coordinator.build(shadows.size, level, layerView);
            const lightPass = {
              label: `solar light ${level}`,
              kind: 'depth',
              camera: cascade.camera,
              frameBlock: cascade.block,
              vegetationShadowBudget: shadows.vegetationBudget,
              vegetationShadowEye: shadows.mainEye ?? this.viewer?.camera?.position?.toArray?.() ?? null,
              vegetationShadowLevel: level,
              groundcoverShadow,
              apsLightCull: true,
            };
            this.coordinator.select([...meshRenderer.vegetationSystems], lightPass, {
              level,
              demandBuffer: this.demandBuffer,
              hiz,
              depthPad: this._depthPad(shadows, level),
            });
            culled = true;
            this._counters.cull_levels++;
          } else {
            this._counters.full_vegetation_levels++;
          }
          this._applyVegetationCascade({scene, meshRenderer, shadows, cascade, level, groundcoverShadow, culled});
          const hasGrass = groundcoverShadow || [...meshRenderer.vegetationSystems].some(system => system.isGrass);
          cascade.grassEye = hasGrass && shadows.mainEye ? shadows.mainEye.slice() : null;
        } catch (error) {
          cascade.dirty = true;
          throw error;
        } finally {
                                                                              
                                                                        
          if (meshRenderer.precompiling) cascade.dirty = true;
          restore?.();
          if (this._stages) this._stages.cpu_ms[`cascade_${level}`] = performance.now() - cpuStart;
        }
      }
    } finally {
      meshRenderer.syncPipelines = sync;
      setShadowMap(shadows.texture);
    }
  }

  _applyStaticCascade({scene, meshRenderer, terrain, shadows, cascade, level, groundcoverShadow}) {
    setFrameCamera(cascade.camera, shadows.size, shadows.size, {block: cascade.block});
    const pass = {
      label: `solar static ${level}`,
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
      apsCasterDemandGPU: this.casterDemand,
      apsCasterDemandTerrain: true,
      apsShadowLevel: level,
      viewProj: cascade.viewProj,
      demandBuffer: this.demandBuffer,
      padTexels: DEMAND_PAD_TEXELS,
      shadowSize: shadows.size,
      depthPad: this._depthPad(shadows, level),
      renderer: meshRenderer,
      timestampWrites: this._timestamp(`static_${level}`),
    };
    meshRenderer.render(scene, pass);
  }

  _applyVegetationCascade({scene, meshRenderer, shadows, cascade, level, groundcoverShadow, culled}) {
    setFrameCamera(cascade.camera, shadows.size, shadows.size, {block: cascade.block});
    const base = {
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
    };
    if (culled) {
                                                                             
      meshRenderer.render(scene, {
        ...base,
        label: `solar vegetation ${level}`,
        vegetationViewKey: `solar-light-${level}`,
        apsVegetationLightDraw: true,
        timestampWrites: this._timestamp(`vegetation_${level}`),
      });
    } else {
                                                                          
                                                           
      meshRenderer.render(scene, {
        ...base,
        label: `solar vegetation fallback ${level}`,
        timestampWrites: this._timestamp(`vegetation_${level}`),
      });
    }
  }

  resize(width, height) {
    if (!this.ready || this.disposed) return null;
    try {
      return this.pipeline.resize(width, height);
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  async afterCompile(viewer = this.viewer) {
    if (!this.ready || this.disposed) return null;
    const result = {caster_demand: false, terrain_demand: false, errors: []};
    try {
      this.coordinator?.ensurePipelines?.();
    } catch (error) {
      result.errors.push({stage: 'light_cull_ready', message: messageOf(error)});
    }
    try {
      this.casterDemand?.ensure?.();
      if (this.casterDemand) this.casterDemand.ready();
      result.caster_demand = this.casterDemand?.prepared === true;
    } catch (error) {
                                                                               
                                                                       
      result.errors.push({stage: 'caster_demand_ready', message: messageOf(error)});
      if (this.casterDemand) this.casterDemand.lastError = {stage: 'ready', message: messageOf(error)};
    }
    try {
                                                                                
                                                                               
      result.terrain_demand = typeof viewer?.heightfield?.beginShadowCascade === 'function' && result.caster_demand;
    } catch (error) {
      result.errors.push({stage: 'terrain_demand_ready', message: messageOf(error)});
    }
    this.lastCompile = result;
                                                                            
                                                                            
                                                                             
                    
    if (this.enabled && !this.disposed && !viewer?.disposed) this.forceAllCascades('after-compile');
    return result;
  }

                                                                            
                                                                         
  setProfile(profile) {
    this._profile = profile ?? null;
    return this;
  }

  clearProfile() {
    const profile = this._profile;
    this._profile = null;
    return profile;
  }

  markFrameStart() { this._mark('frame_start'); }
  markFrameEnd() { this._mark('frame_end'); }
  markStage(label) { this._mark(label); }

  _timestamp(label) {
    const profile = this._profile;
    if (!profile?.querySet || typeof profile.allocate !== 'function') return undefined;
    if (profile.labels.length >= 30) return undefined;
    const index = profile.allocate(label);
    return {querySet: profile.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1};
  }

  _mark(label) {
    const profile = this._profile;
    if (!profile?.querySet || typeof profile.allocate !== 'function') return false;
    if (label === 'frame_start' && profile.labels.length) return false;
    if (profile.labels.length >= 30) return false;
    const index = profile.allocate(label);
    const encoder = GPU.getEncoder();
    const pass = encoder.beginComputePass({
      label: `receiver profile ${label}`,
      timestampWrites: {querySet: profile.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1},
    });
    pass.end();
    return true;
  }

  metadata() {
    return {
      schema: this.schema,
      revision: this.revision,
      requested: this.requested,
      ready: this.ready,
      enabled: this.enabled,
      failed: this.failed,
      disposed: this.disposed,
      mode: this.mode,
      pixel_mode: this.mode === 'pixel',
      cache_policy: this.mode === 'pixel'
        ? 'full main-camera VP + viewport/scene/light/quality key; stationary exact key may reuse maps; state-cache before/after snapshots use the explicit legacy path'
        : 'full-level demand; existing per-level clipmap guard reuse allowed; state-cache snapshots use the explicit legacy path',
      snapshot_policy: 'receiver disabled for before/after snapshot frames (explicit legacy full path)',
      last_active_frame: this.activeFrame,
      suspended: this.suspended,
      snapshot_fallback: this.snapshotFallback,
      last_error: this.lastError,
      disabled_reason: this.disabledReason,
      counters: {...this._counters},
      demand: this._lastDemand,
      external_demand: this._external?.metadata ?? null,
      receiver_pipeline: this.pipeline?.metadata?.() ?? null,
      light_cull: this.coordinator?.metadata?.() ?? null,
      caster_demand: this.casterDemand?.metadata?.() ?? null,
      light_cull_available: this.ready ? this._canCull(this.viewer?.meshRenderer) : false,
      receiver_xyz_selection: typeof this.prepareReceiverXYZView === 'function' ? 'prepareReceiverXYZView' : 'renderer.prepareVegetationView',
      no_frame_loop_readback: true,
      stages: this._stages,
    };
  }

  dispose() {
    if (this.disposed) return;
    this._removeCollectHook();
    if (this.viewer?.meshRenderer?.casterDemandGPU === this.casterDemand) delete this.viewer.meshRenderer.casterDemandGPU;
    try { this.casterDemand?.dispose?.(); } catch {}
    try { this.coordinator?.dispose?.(); } catch {}
    try { this.pipeline?.dispose?.(); } catch {}
    this.casterDemand = null;
    this.coordinator = null;
    this.pipeline = null;
    this.ready = false;
    this.enabled = false;
    this.disposed = true;
    if (this.viewer?.shadows) {
      this.viewer.shadows.receiverActive = false;
      this.viewer.shadows.receiverPixelMode = false;
      this.viewer.shadows.receiverIntegration = null;
    }
  }
}

export default ReceiverShadowIntegration;
