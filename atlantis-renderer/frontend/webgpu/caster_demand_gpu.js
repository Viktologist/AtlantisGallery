                                                                         
                  
  
                                                                           
                                                                        
                                                                       
  
                    
  
                                                                              
                                                                             
                                                                               
                                                                          
                                                        
                                                                              
                                                                           
                                                                              
                                                                            
                                                                              
  
                         
                                                                                 
                                                                           
                                                                              
                                                                               
                                                                          
                                               
  
                                                        
                                                                           
                                                                                
  
                                                                            
                                                                   

import {GPU, UniformBlock, StorageBuffer, ComputeKernel} from '../../vendor/tidewater/src/engine/webgpu.js';
import {BufferGeometry} from '../../vendor/tidewater/src/engine/index.js';
import {
  CASTER_DEMAND_SCHEMA, CASTER_DEMAND_REVISION, DEMAND_LEVELS, DEMAND_BUFFER_BYTES,
  CASTER_DEMAND_WORKGROUP, CASTER_DEMAND_DEFAULT_DEPTH_PAD,
  CASTER_DEMAND_DEFAULT_PAD_TEXELS, CASTER_DEMAND_DEFAULT_SHADOW_SIZE,
  FALLBACK, UV_MODE_SHADOW,
  buildTerrainDemandBounds, cascadeResourceKey, demandLevelValid,
  padUvFor, staticCasterEligibility, uvModeValue,
} from './caster_demand_gpu_math.js';
import {
  TERRAIN_CASTER_COMPACT_WGSL, TERRAIN_CASTER_FINALIZE_WGSL, STATIC_CASTER_COMMAND_WGSL,
} from './caster_demand_gpu_wgsl.js';

const STATIC_COMMAND_BYTES = 5 * 4;

function storage(label, type, count, data = null, usage = []) {
  return new StorageBuffer({label, type, count, data, usage});
}

function destroyBuffer(buffer) {
  try { buffer?.destroy?.(); } catch {                        }
}

function destroyStorage(buffer) {
  try { buffer?.destroy?.(); } catch {                        }
}

                                                                               
                                                                             
                                                                            
                                                                           
function detachTerrainDemand(geometry) {
  if (!geometry) return false;
  let detached = false;
  if (geometry.indirect?.apsCasterDemand) {
    delete geometry.indirect;
    detached = true;
  }
  const attribute = geometry.attributes?.apsPatch;
  if (attribute?.gpuBuffer) {
    delete attribute.gpuBuffer;
    detached = true;
  }
  return detached;
}

                                                                        
                                                                          
                                                                          
                                                                              
                                        
export function restoreTerrainPatchAttribute(geometry, {rows = null, count = null} = {}) {
  if (!geometry) return false;
  let restored = detachTerrainDemand(geometry) || false;
  const attribute = geometry.attributes?.apsPatch;
  if (attribute && Array.isArray(rows) && attribute.array) {
    let at = 0;
    for (const row of rows) {
      if (at + 4 > attribute.array.length) break;
      attribute.array.set(row, at);
      at += 4;
    }
    attribute.clearUpdateRanges?.();
    attribute.needsUpdate = true;
    restored = true;
  }
  const originalCount = Number.isInteger(count)
    ? count
    : (Array.isArray(rows) ? rows.length : null);
  if (Number.isInteger(originalCount)) {
    geometry.instanceCount = originalCount;
    restored = true;
  }
  return restored;
}

function terrainCapacity(options, geometry) {
  if (Number.isInteger(options.capacity)) return options.capacity;
  return geometry?.attributes?.apsPatch?.count ?? 0;
}

function paramsBlock(label) {
  return new UniformBlock('ApsCasterDemandParams', {
    viewProj: 'mat4x4f',
    count: 'u32',
    level: 'u32',
    indexCount: 'u32',
    capacity: 'u32',
    padUv: 'f32',
    depthPad: 'f32',
    flags: 'u32',
    uvMode: 'u32',
  }, {label});
}

function resolveBuffer(value) {
  if (!value) return {buffer: null, bytes: null};
  if (typeof value.getGPU === 'function') return {buffer: value.getGPU(), bytes: value.byteLength ?? null};
  if (value.buffer && typeof value.buffer.getGPU === 'function') {
    return {buffer: value.buffer.getGPU(), bytes: value.buffer.byteLength ?? value.byteLength ?? null};
  }
  if (value.buffer) return {buffer: value.buffer, bytes: value.byteLength ?? null};
  if (typeof value.size === 'number') return {buffer: value, bytes: value.size};
  return {buffer: value, bytes: null};
}

function matrixOf(cascade, options) {
  const value = options?.viewProj ?? options?.camera?.viewProjection
    ?? cascade?.viewProj ?? cascade?.camera?.viewProjection;
  const m = value?.elements ?? value;
  if (m && m.length >= 16 && [...m].slice(0, 16).every(Number.isFinite)) return m;
                                                                               
                                                                              
                                                                           
  const camera = options?.camera ?? cascade?.camera;
  const projection = camera?.projectionMatrix?.elements ?? camera?.projectionMatrix;
  const inverse = camera?.matrixWorldInverse?.elements ?? camera?.matrixWorldInverse;
  if (!projection || !inverse || projection.length < 16 || inverse.length < 16) return null;
  if (![...projection].slice(0, 16).every(Number.isFinite) || ![...inverse].slice(0, 16).every(Number.isFinite)) return null;
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += projection[k * 4 + r] * inverse[c * 4 + k];
      vp[c * 4 + r] = sum;
    }
  }
  return vp;
}

function cascadeIndex(pass) {
  const value = pass?.apsShadowLevel ?? pass?.casterDemandLevel ?? pass?.apsCasterDemand?.level;
  return Number.isInteger(value) ? value : null;
}

export class CasterDemandGPU {
                                                                                
                                                                               
                                                                           
  static install(renderer, options = {}) {
    const instance = new CasterDemandGPU({renderer, ...options});
    if (renderer) renderer.casterDemandGPU = instance;
    return instance;
  }

  constructor({renderer = null, label = 'aps caster demand GPU'} = {}) {
    this.renderer = renderer;
    this.label = label;
    this.enabled = true;
    this.disposed = false;
    this.prepared = false;
    this.kernels = null;
    this.dummy = null;
    this.terrainViews = new Map();
    this.staticViews = new Map();
    this.lastError = null;
    this.counters = {
      terrain_dispatches: 0,
      terrain_revision_uploads: 0,
      terrain_fallbacks: 0,
      static_dispatches: 0,
      static_items_planned: 0,
      static_fallbacks: 0,
      static_views: 0,
      terrain_views: 0,
      clear_calls: 0,
    };
    this.fallbackReasons = Object.create(null);
  }

  get schema() { return CASTER_DEMAND_SCHEMA; }
  get revision() { return CASTER_DEMAND_REVISION; }

  ensure() {
    if (this.disposed) throw Error('CasterDemandGPU is disposed');
    if (!GPU.device) throw Error('CasterDemandGPU requires an initialized WebGPU device');
    if (!this.kernels) this._createKernels();
    return this;
  }

  init() { return this.ready(); }

                                                                              
                                                                             
                                                                         
  ready() {
    this.ensure();
    for (const kernel of Object.values(this.kernels)) {
      GPU.ready(kernel.handle);
      if (kernel.handle.failed) throw Error(`Caster demand GPU kernel failed: ${kernel.handle.label}`);
    }
    this.prepared = true;
    return this;
  }

  _createKernels() {
    const params = paramsBlock('ApsCasterDemandDummyParams');
    const demand = storage('aps caster demand dummy demand', 'u32', DEMAND_BUFFER_BYTES / 4);
    const bounds = storage('aps caster demand dummy bounds', 'vec4f', 2);
    const patches = storage('aps caster demand dummy patches', 'vec4f', 1);
    const compact = storage('aps caster demand dummy compact', 'vec4f', 1);
    const counter = storage('aps caster demand dummy counter', 'u32', 1);
    const commands = storage('aps caster demand dummy commands', 'u32', 5, null, ['indirect']);
    const itemMeta = storage('aps caster demand dummy item meta', 'vec4u', 1);
    const modes = storage('aps caster demand dummy modes', 'u32', 1);
    this.dummy = {params, demand, bounds, patches, compact, counter, commands, itemMeta, modes};

    const terrainCompact = new ComputeKernel({
      label: 'aps terrain caster demand compact',
      bindings: {
        params: {uniform: params},
        demand: {storage: demand, access: 'read', type: 'u32'},
        sourceBounds: {storage: bounds, access: 'read', type: 'vec4f'},
        sourcePatches: {storage: patches, access: 'read', type: 'vec4f'},
        compactPatches: {storage: compact, access: 'read_write', type: 'vec4f'},
        counter: {storage: counter, access: 'read_write', wgslType: 'atomic<u32>'},
      },
      code: TERRAIN_CASTER_COMPACT_WGSL,
      workgroupSize: [CASTER_DEMAND_WORKGROUP, 1, 1],
    });
    const terrainFinalize = new ComputeKernel({
      label: 'aps terrain caster demand finalize',
      bindings: {
        params: {uniform: params},
        counterFinal: {storage: counter, access: 'read', wgslType: 'u32'},
        commands: {storage: commands, access: 'read_write', type: 'u32'},
      },
      code: TERRAIN_CASTER_FINALIZE_WGSL,
      workgroupSize: [1, 1, 1],
    });
    const staticCommand = new ComputeKernel({
      label: 'aps static caster demand commands',
      bindings: {
        params: {uniform: params},
        demand: {storage: demand, access: 'read', type: 'u32'},
        sourceBounds: {storage: bounds, access: 'read', type: 'vec4f'},
        itemMeta: {storage: itemMeta, access: 'read', type: 'vec4u'},
        modes: {storage: modes, access: 'read', type: 'u32'},
        commands: {storage: commands, access: 'read_write', type: 'u32'},
      },
      code: STATIC_CASTER_COMMAND_WGSL,
      workgroupSize: [CASTER_DEMAND_WORKGROUP, 1, 1],
    });
    this.kernels = {terrainCompact, terrainFinalize, staticCommand};
  }

  _prepare(renderer, pass = null) {
    if (!this.enabled || this.disposed) return {applied: false, reason: 'disabled'};
    if (!GPU.device) return {applied: false, reason: FALLBACK.NO_DEVICE};
    if (pass?.renderer?.precompiling || renderer?.precompiling) return {applied: false, reason: FALLBACK.PRECOMPILING};
    if (!this.prepared) {
      if (GPU.deferUnreadyPipelines) return {applied: false, reason: FALLBACK.PIPELINE_NOT_READY};
      try { this.ready(); } catch (error) {
        this.lastError = {stage: 'ready', message: String(error?.message ?? error)};
        return {applied: false, reason: FALLBACK.PIPELINE_NOT_READY, error: String(error?.message ?? error)};
      }
    }
    return {applied: true};
  }

  _fallback(reason, extra = {}) {
    this.fallbackReasons[reason] = (this.fallbackReasons[reason] ?? 0) + 1;
    this.counters.terrain_fallbacks++;
    return {applied: false, reason, ...extra};
  }

  _terrainView(level) {
    let view = this.terrainViews.get(level);
    if (!view) {
      view = {
        level, resourceKey: cascadeResourceKey(level),
        bounds: null, patches: null, compact: null, counter: null, commands: null, vertex: null,
        vertexCapacity: 0,
        params: paramsBlock(`ApsCasterDemandTerrainParams${level}`),
        compactBindGroup: null, finalizeBindGroup: null, demandToken: null,
        tileCount: 0, revision: null, unknownTiles: 0, expandedTiles: 0,
        dispatches: 0, dispatchedFrame: -1, last: null,
      };
      this.terrainViews.set(level, view);
      this.counters.terrain_views = this.terrainViews.size;
    }
    return view;
  }

  _ensureTerrainBuffers(view, count, capacity = count) {
    const vertexCount = Math.max(1, Number.isInteger(capacity) ? capacity : count);
    if (view.tileCount === count && view.bounds && view.vertex && view.vertexCapacity === vertexCount) return false;
    destroyStorage(view.bounds);
    destroyStorage(view.patches);
    destroyStorage(view.compact);
    destroyStorage(view.counter);
    destroyStorage(view.commands);
    destroyStorage(view.vertex);
    view.bounds = storage(`aps terrain caster demand bounds ${view.level}`, 'vec4f', Math.max(1, count * 2));
    view.patches = storage(`aps terrain caster demand patches ${view.level}`, 'vec4f', Math.max(1, count));
    view.compact = storage(`aps terrain caster demand compact patches ${view.level}`, 'vec4f', Math.max(1, count));
    view.counter = storage(`aps terrain caster demand counter ${view.level}`, 'u32', 1);
    view.commands = storage(`aps terrain caster demand commands ${view.level}`, 'u32', 5, null, ['indirect']);
                                                                         
                                                                              
                                                           
    view.vertex = storage(`aps terrain caster demand vertices ${view.level}`, 'vec4f', vertexCount, null, ['vertex']);
    view.vertexCapacity = vertexCount;
    view.tileCount = count;
    view.revision = null;
    view.dispatchedFrame = -1;
    view.compactBindGroup = null;
    view.finalizeBindGroup = null;
    return true;
  }

  _ensureTerrainBindGroups(view, demandBuffer) {
    if (!view.compactBindGroup || view.demandToken !== demandBuffer) {
      view.compactBindGroup = GPU.device.createBindGroup({
        label: `aps terrain caster demand compact ${view.level}`,
        layout: this.kernels.terrainCompact.bindings.layout,
        entries: [
          {binding: 0, resource: {buffer: view.params.getBuffer()}},
          {binding: 1, resource: {buffer: demandBuffer}},
          {binding: 2, resource: {buffer: view.bounds.getGPU()}},
          {binding: 3, resource: {buffer: view.patches.getGPU()}},
          {binding: 4, resource: {buffer: view.compact.getGPU()}},
          {binding: 5, resource: {buffer: view.counter.getGPU()}},
        ],
      });
      view.finalizeBindGroup = GPU.device.createBindGroup({
        label: `aps terrain caster demand finalize ${view.level}`,
        layout: this.kernels.terrainFinalize.bindings.layout,
        entries: [
          {binding: 0, resource: {buffer: view.params.getBuffer()}},
          {binding: 1, resource: {buffer: view.counter.getGPU()}},
          {binding: 2, resource: {buffer: view.commands.getGPU()}},
        ],
      });
      view.demandToken = demandBuffer;
    }
  }

                                                                              
                                                                              
                                                                             
  applyTerrain(options = {}) {
    const level = options.level;
    if (!demandLevelValid(level)) return this._fallback(FALLBACK.BAD_LEVEL);
    const geometry = options.geometry;
    const renderer = options.renderer ?? this.renderer;
    if (!renderer) return this._fallback(FALLBACK.NO_RENDERER);
    if (!geometry?.attributes?.apsPatch) return this._fallback(FALLBACK.APS_PATCH_MISSING);
                                                                           
                                                                                
                                                                         
    detachTerrainDemand(geometry);
    if (!Array.isArray(options.tiles) || options.tiles.length === 0) return this._fallback(FALLBACK.TERRAIN_BOUNDS);
    const demand = resolveBuffer(options.demandBuffer ?? options.demand ?? options.receiverDemand);
    if (!demand.buffer) return this._fallback(FALLBACK.NO_DEMAND);
    if (demand.bytes != null && demand.bytes < DEMAND_BUFFER_BYTES) return this._fallback(FALLBACK.BAD_DEMAND);
    const matrix = matrixOf(options.cascade, options);
    if (!matrix) return this._fallback(FALLBACK.BAD_DEMAND);
    const prepared = this._prepare(renderer, options);
    if (!prepared.applied) return prepared;

    const view = this._terrainView(level);
    const count = options.tiles.length;
    const capacity = terrainCapacity(options, geometry);
    if (count > capacity) return this._fallback(FALLBACK.TERRAIN_BOUNDS, {count, capacity});
    const frameElements = options.worldFromNative?.elements ?? options.worldFromNative;
    if (frameElements && (frameElements.length !== 16 || !Array.from(frameElements).every(Number.isFinite))) return this._fallback(FALLBACK.TERRAIN_BOUNDS);
    const revision = String(options.revision ?? `${options.native?.sha256 ?? 'native'}:${count}:${options.curved ? 1 : 0}:${options.interventionBound ?? 0}`)
      + ':' + (frameElements ? Array.from(frameElements).join(',') : 'native');
    if (this._ensureTerrainBuffers(view, count, capacity) || view.revision !== revision) {
      const built = buildTerrainDemandBounds({
        native: options.native,
        tiles: options.tiles,
        curved: options.curved === true,
        interventionBound: options.interventionBound ?? 0,
        worldFromNative: options.worldFromNative,
      });
      if (!built) return this._fallback(FALLBACK.TERRAIN_BOUNDS);
      view.bounds.write(built.bounds);
      view.patches.write(built.patches);
      view.revision = revision;
      view.unknownTiles = built.unknown;
      view.expandedTiles = built.expanded;
                                                                          
                                                           
      view.dispatchedFrame = -1;
      this.counters.terrain_revision_uploads++;
    }
    this._ensureTerrainBindGroups(view, demand.buffer);
    if (view.dispatchedFrame === GPU.frame) {
                                                                           
                                                                          
      geometry.attributes.apsPatch.gpuBuffer = view.vertex;
      geometry.indirect = {buffer: view.commands.getGPU(), offset: 0, apsCasterDemand: true};
      return view.last;
    }
    if (!view.bounds || !view.vertex || view.tileCount !== count) return this._fallback(FALLBACK.TERRAIN_BOUNDS);

    const indexCount = Number.isInteger(options.indexCount) ? options.indexCount : geometry.index?.count;
    if (!Number.isInteger(indexCount) || indexCount <= 0) return this._fallback(FALLBACK.APS_PATCH_MISSING);
    const p = view.params;
    p.set('viewProj', matrix);
    p.set('count', count);
    p.set('level', level);
    p.set('indexCount', indexCount);
    p.set('capacity', capacity);
    p.set('padUv', Number.isFinite(options.padUv) ? options.padUv : padUvFor(
      options.padTexels ?? CASTER_DEMAND_DEFAULT_PAD_TEXELS,
      options.shadowSize ?? CASTER_DEMAND_DEFAULT_SHADOW_SIZE,
    ));
    p.set('depthPad', Number.isFinite(options.depthPad) ? options.depthPad : CASTER_DEMAND_DEFAULT_DEPTH_PAD);
    p.set('flags', options.forceFull ? 1 : 0);
    p.set('uvMode', uvModeValue(options.uvMode ?? UV_MODE_SHADOW));
    p.upload();

    try {
      const encoder = GPU.getEncoder();
      encoder.clearBuffer(view.counter.getGPU(), 0, 4);
      const compact = encoder.beginComputePass({label: `aps terrain caster demand compact ${level}`});
      compact.setPipeline(GPU.ready(this.kernels.terrainCompact.handle));
      compact.setBindGroup(0, this.kernels.terrainCompact.group0.getBindGroup());
      compact.setBindGroup(1, view.compactBindGroup);
      compact.dispatchWorkgroups(Math.max(1, Math.ceil(count / CASTER_DEMAND_WORKGROUP)));
      compact.end();
                                                                          
                                                                           
                                                                           
                                                                           
                                                                             
                                                               
      encoder.copyBufferToBuffer(view.compact.getGPU(), 0, view.vertex.getGPU(), 0, count * 16);
      const finalize = encoder.beginComputePass({label: `aps terrain caster demand finalize ${level}`});
      finalize.setPipeline(GPU.ready(this.kernels.terrainFinalize.handle));
      finalize.setBindGroup(0, this.kernels.terrainFinalize.group0.getBindGroup());
      finalize.setBindGroup(1, view.finalizeBindGroup);
      finalize.dispatchWorkgroups(1);
      finalize.end();
    } catch (error) {
      this.lastError = {stage: 'terrain_dispatch', level, message: String(error?.message ?? error)};
      detachTerrainDemand(geometry);
      return this._fallback(FALLBACK.DISPATCH_ERROR, {error: String(error?.message ?? error)});
    }
    geometry.attributes.apsPatch.gpuBuffer = view.vertex;
    geometry.indirect = {buffer: view.commands.getGPU(), offset: 0, apsCasterDemand: true};
    geometry.instanceCount = Math.max(1, Number.isInteger(options.cpuRows) ? options.cpuRows : count);
    view.dispatchedFrame = GPU.frame;
    view.dispatches++;
    this.counters.terrain_dispatches++;
    view.last = {
      applied: true, level, resource_key: view.resourceKey, tile_count: count,
      revision, unknown_tiles: view.unknownTiles, expanded_tiles: view.expandedTiles,
      patch_bytes: count * 16, index_count: indexCount,
      attribute_route: 'dedicated storage-backed VERTEX buffer; persistent CPU attribute untouched',
    };
    return view.last;
  }

                                                                           
                                                                             
  releaseTerrain(geometry) {
    return detachTerrainDemand(geometry);
  }

  _staticView(level) {
    let view = this.staticViews.get(level);
    if (!view) {
      view = {
        level, resourceKey: cascadeResourceKey(level), capacity: 0,
        bounds: null, itemMeta: null, modes: null, commands: null,
        params: paramsBlock(`ApsCasterDemandStaticParams${level}`),
        bindGroup: null, demandToken: null, proxies: new Map(),
        dispatches: 0, dispatchedFrame: -1, last: null,
      };
      this.staticViews.set(level, view);
      this.counters.static_views = this.staticViews.size;
    }
    return view;
  }

  _ensureStaticBuffers(view, count) {
    if (view.capacity >= count && view.bounds) return false;
    const capacity = Math.max(count, view.capacity ? view.capacity * 2 : 64);
    destroyStorage(view.bounds);
    destroyStorage(view.itemMeta);
    destroyStorage(view.modes);
    destroyStorage(view.commands);
    view.bounds = storage(`aps static caster demand bounds ${view.level}`, 'vec4f', capacity * 2);
    view.itemMeta = storage(`aps static caster demand meta ${view.level}`, 'vec4u', capacity);
    view.modes = storage(`aps static caster demand modes ${view.level}`, 'u32', capacity);
    view.commands = storage(`aps static caster demand commands ${view.level}`, 'u32', capacity * 5, null, ['indirect']);
    view.capacity = capacity;
    view.bindGroup = null;
    view.dispatchedFrame = -1;
    return true;
  }

  _ensureStaticBindGroup(view, demandBuffer) {
    if (!view.bindGroup || view.demandToken !== demandBuffer) {
      view.bindGroup = GPU.device.createBindGroup({
        label: `aps static caster demand ${view.level}`,
        layout: this.kernels.staticCommand.bindings.layout,
        entries: [
          {binding: 0, resource: {buffer: view.params.getBuffer()}},
          {binding: 1, resource: {buffer: demandBuffer}},
          {binding: 2, resource: {buffer: view.bounds.getGPU()}},
          {binding: 3, resource: {buffer: view.itemMeta.getGPU()}},
          {binding: 4, resource: {buffer: view.modes.getGPU()}},
          {binding: 5, resource: {buffer: view.commands.getGPU()}},
        ],
      });
      view.demandToken = demandBuffer;
    }
  }

  _proxyFor(view, plan) {
    const source = plan.geometry;
    const key = [
      source.uuid, source.userData?.apsStaticIndexOwner?.uuid ?? '', source.userData?.apsStaticVertexOwner?.uuid ?? '',
      plan.start, plan.primitiveCount, plan.instanceCount, plan.firstInstance, plan.indexed ? 1 : 0,
    ].join('|');
    let cached = view.proxies.get(plan.object);
    if (cached && cached.key !== key) {
      try { cached.proxy.dispose?.(); } catch {                                }
      cached = null;
      view.proxies.delete(plan.object);
    }
    if (!cached) {
      const proxy = new BufferGeometry();
      for (const [name, attribute] of Object.entries(source.attributes ?? {})) proxy.setAttribute(name, attribute);
      if (source.index) proxy.setIndex(source.index);
                                                                              
                                                                                 
                                                                
      proxy.userData = {
        ...(source.userData ?? {}),
        apsStaticVertexOwner: source.userData?.apsStaticVertexOwner ?? source,
        apsStaticIndexOwner: source.userData?.apsStaticIndexOwner ?? source,
        aps_caster_demand_proxy: true,
        aps_caster_demand_level: view.level,
      };
      proxy.instanceCount = Math.max(1, plan.instanceCount);
      proxy.boundingBox = source.boundingBox ?? null;
      proxy.boundingSphere = source.boundingSphere ?? null;
      proxy.indirect = {buffer: view.commands.getGPU(), offset: plan.slot * STATIC_COMMAND_BYTES, apsCasterDemand: true};
      cached = {key, proxy};
      view.proxies.set(plan.object, cached);
    }
    cached.proxy.indirect.buffer = view.commands.getGPU();
    cached.proxy.indirect.offset = plan.slot * STATIC_COMMAND_BYTES;
    cached.proxy.instanceCount = Math.max(1, plan.instanceCount);
    return cached.proxy;
  }

                                                                           
                                                                          
                                                                  
  collect(renderer, scene, pass = {}) {
    const lists = renderer.collect(scene, pass);
    this.apply(lists, {...pass, renderer});
    return lists;
  }

                                                                              
                                                                     
  apply(lists, pass = {}) {
    const frame = {
      schema: CASTER_DEMAND_SCHEMA, enabled: this.enabled, applied: false,
      level: null, items: lists?.opaque?.length ?? 0, planned: 0, commands: 0,
      fallback_objects: 0, fallback_reasons: {}, dispatched: false,
    };
    if (!this.enabled || this.disposed) return this._finishStaticFrame(frame);
    if (pass.kind && pass.kind !== 'depth') {
      frame.fallback_reasons[FALLBACK.NOT_DEPTH] = frame.items;
      return this._finishStaticFrame(frame);
    }
    const level = cascadeIndex(pass);
    if (!demandLevelValid(level)) {
      frame.fallback_reasons[FALLBACK.BAD_LEVEL] = frame.items;
      return this._finishStaticFrame(frame);
    }
    frame.level = level;
    const renderer = pass.renderer ?? this.renderer;
    if (!renderer) {
      frame.fallback_reasons[FALLBACK.NO_RENDERER] = frame.items;
      return this._finishStaticFrame(frame);
    }
    const demand = resolveBuffer(pass.demandBuffer ?? pass.receiverDemand ?? pass.apsCasterDemand?.buffer ?? pass.apsCasterDemand);
    if (!demand.buffer) {
      frame.fallback_reasons[FALLBACK.NO_DEMAND] = frame.items;
      return this._finishStaticFrame(frame);
    }
    if (demand.bytes != null && demand.bytes < DEMAND_BUFFER_BYTES) {
      frame.fallback_reasons[FALLBACK.BAD_DEMAND] = frame.items;
      return this._finishStaticFrame(frame);
    }
    if (!lists?.opaque?.length) return this._finishStaticFrame(frame);
    const prepared = this._prepare(renderer, pass);
    if (!prepared.applied) {
      frame.fallback_reasons[prepared.reason] = frame.items;
      return this._finishStaticFrame(frame);
    }

    const batchBoxes = new Map();
    for (const batch of renderer.__apsShadowUnified?.batches ?? []) {
      if (batch?.mesh && batch.worldBox) batchBoxes.set(batch.mesh, batch.worldBox);
    }
    const plans = [];
    for (let itemIndex = 0; itemIndex < lists.opaque.length; itemIndex++) {
      const item = lists.opaque[itemIndex];
      const object = item.object;
                                                                               
                                                                              
                                                                                
                                 
      const itemGeometry = item.geometry;
      const geometry = itemGeometry?.userData?.aps_caster_demand_proxy
        ? itemGeometry.userData.apsStaticVertexOwner ?? itemGeometry
        : itemGeometry;
      const material = item.material;
      const eligibility = staticCasterEligibility({
        object, geometry, material,
        batchWorldBox: batchBoxes.get(object) ?? null,
        item,
      });
      if (!eligibility.eligible) {
        frame.fallback_objects++;
        frame.fallback_reasons[eligibility.reason] = (frame.fallback_reasons[eligibility.reason] ?? 0) + 1;
        continue;
      }
      plans.push({item, itemIndex, object, geometry, material, slot: plans.length, ...eligibility});
    }
    if (!plans.length) return this._finishStaticFrame(frame);

    const view = this._staticView(level);
    this._ensureStaticBuffers(view, plans.length);
    if (view.dispatchedFrame === GPU.frame) {
      frame.applied = true;
      frame.planned = plans.length;
      frame.commands = plans.length;
      frame.dispatched = true;
      return this._finishStaticFrame(frame);
    }
    const bounds = new Float32Array(plans.length * 8);
    const meta = new Uint32Array(plans.length * 4);
    const modes = new Uint32Array(plans.length);
    for (const plan of plans) {
      const b = plan.bounds;
      bounds.set([b.min[0], b.min[1], b.min[2], 0, b.max[0], b.max[1], b.max[2], 0], plan.slot * 8);
      meta.set([plan.primitiveCount, plan.instanceCount, plan.start, plan.firstInstance], plan.slot * 4);
      modes[plan.slot] = plan.indexed ? 0 : 1;
    }
    view.bounds.write(bounds);
    view.itemMeta.write(meta);
    view.modes.write(modes);
    const lightMatrix = matrixOf({}, pass);
    if (!lightMatrix) {
      frame.fallback_reasons[FALLBACK.BAD_DEMAND] = plans.length;
      return this._finishStaticFrame(frame);
    }
    const p = view.params;
    p.set('viewProj', lightMatrix);
    p.set('count', plans.length);
    p.set('level', level);
    p.set('indexCount', 0);
    p.set('capacity', plans.length);
    p.set('padUv', Number.isFinite(pass.padUv) ? pass.padUv : padUvFor(
      pass.padTexels ?? pass.demandPadTexels ?? CASTER_DEMAND_DEFAULT_PAD_TEXELS,
      pass.shadowSize ?? CASTER_DEMAND_DEFAULT_SHADOW_SIZE,
    ));
    p.set('depthPad', Number.isFinite(pass.depthPad) ? pass.depthPad : Number.isFinite(pass.demandDepthPad) ? pass.demandDepthPad : CASTER_DEMAND_DEFAULT_DEPTH_PAD);
    p.set('flags', pass.forceFull ? 1 : 0);
    p.set('uvMode', uvModeValue(pass.uvMode ?? pass.demandUvMode ?? UV_MODE_SHADOW));
    p.upload();
    this._ensureStaticBindGroup(view, demand.buffer);

    try {
      const encoder = GPU.getEncoder();
      const compute = encoder.beginComputePass({label: `aps static caster demand ${level}`});
      compute.setPipeline(GPU.ready(this.kernels.staticCommand.handle));
      compute.setBindGroup(0, this.kernels.staticCommand.group0.getBindGroup());
      compute.setBindGroup(1, view.bindGroup);
      compute.dispatchWorkgroups(Math.max(1, Math.ceil(plans.length / CASTER_DEMAND_WORKGROUP)));
      compute.end();
    } catch (error) {
      this.lastError = {stage: 'static_dispatch', level, message: String(error?.message ?? error)};
      frame.fallback_reasons[FALLBACK.DISPATCH_ERROR] = plans.length;
      frame.fallback_objects += plans.length;
      return this._finishStaticFrame(frame);
    }

                                                                             
                                                                                
                                                                                
    const replaced = [];
    try {
      for (const plan of plans) {
        const proxy = this._proxyFor(view, plan);
        replaced.push({index: plan.itemIndex, item: plan.item});
        lists.opaque[plan.itemIndex] = {...plan.item, geometry: proxy};
      }
    } catch (error) {
      for (const entry of replaced) lists.opaque[entry.index] = entry.item;
      this.lastError = {stage: 'static_proxy', level, message: String(error?.message ?? error)};
      frame.fallback_reasons[FALLBACK.DISPATCH_ERROR] = plans.length;
      frame.fallback_objects += plans.length;
      return this._finishStaticFrame(frame);
    }
    view.dispatchedFrame = GPU.frame;
    view.dispatches++;
    this.counters.static_dispatches++;
    this.counters.static_items_planned += plans.length;
    frame.applied = true;
    frame.planned = plans.length;
    frame.commands = plans.length;
    frame.dispatched = true;
    view.last = {...frame};
    return this._finishStaticFrame(frame);
  }

  _finishStaticFrame(frame) {
    this.counters.static_fallbacks += frame.fallback_objects;
    for (const [reason, count] of Object.entries(frame.fallback_reasons)) {
      this.fallbackReasons[reason] = (this.fallbackReasons[reason] ?? 0) + count;
    }
    return frame;
  }

  metadata() {
    const terrain = [...this.terrainViews.values()].map((view) => ({
      level: view.level, resource_key: view.resourceKey, tile_count: view.tileCount,
      vertex_capacity: view.vertexCapacity,
      attribute_route: 'dedicated storage-backed VERTEX buffer; persistent CPU apsPatch untouched',
      revision: view.revision, unknown_tiles: view.unknownTiles, expanded_tiles: view.expandedTiles,
      dispatches: view.dispatches, last: view.last,
    }));
    const statics = [...this.staticViews.values()].map((view) => ({
      level: view.level, resource_key: view.resourceKey, capacity: view.capacity,
      dispatches: view.dispatches, proxy_count: view.proxies.size, last: view.last,
    }));
    return {
      schema: CASTER_DEMAND_SCHEMA,
      revision: CASTER_DEMAND_REVISION,
      enabled: this.enabled,
      prepared: this.prepared,
      disposed: this.disposed,
      device: !!GPU.device,
      readback: false,
      demand_layout: {
        bytes: DEMAND_BUFFER_BYTES, levels: DEMAND_LEVELS, stride: 32,
        uv_scale: 65535, z_scale: 16777215, legacy_full_flag: 2,
      },
      counters: {...this.counters},
      fallback_reasons: {...this.fallbackReasons},
      terrain,
      static: statics,
      last_error: this.lastError,
    };
  }

  clear({resetCounters = true} = {}) {
    for (const view of this.terrainViews.values()) {
      destroyStorage(view.bounds); destroyStorage(view.patches); destroyStorage(view.compact);
      destroyStorage(view.counter); destroyStorage(view.commands); destroyStorage(view.vertex);
      try { view.params.buffer?.destroy?.(); } catch {                        }
      view.bounds = view.patches = view.compact = view.counter = view.commands = view.vertex = null;
      view.vertexCapacity = 0;
      view.compactBindGroup = view.finalizeBindGroup = null;
      view.tileCount = 0; view.revision = null; view.dispatchedFrame = -1;
    }
    this.terrainViews.clear();
    for (const view of this.staticViews.values()) {
      destroyStorage(view.bounds); destroyStorage(view.itemMeta); destroyStorage(view.modes); destroyStorage(view.commands);
      try { view.params.buffer?.destroy?.(); } catch {                        }
      for (const cached of view.proxies.values()) {
        try { cached.proxy.dispose?.(); } catch {                                }
      }
      view.proxies.clear();
      view.bounds = view.itemMeta = view.modes = view.commands = null;
      view.bindGroup = null; view.capacity = 0; view.dispatchedFrame = -1;
    }
    this.staticViews.clear();
    this.counters.clear_calls++;
    if (resetCounters) {
      this.counters.terrain_dispatches = 0;
      this.counters.terrain_revision_uploads = 0;
      this.counters.static_dispatches = 0;
      this.counters.static_items_planned = 0;
      this.counters.static_fallbacks = 0;
      this.counters.static_views = 0;
      this.counters.terrain_views = 0;
      this.fallbackReasons = Object.create(null);
    }
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.clear({resetCounters: false});
    this.disposed = true;
    this.prepared = false;
    for (const value of Object.values(this.dummy ?? {})) {
      if (value && typeof value.destroy === 'function') destroyBuffer(value);
    }
    try { this.dummy?.params?.buffer?.destroy?.(); } catch {                        }
    this.dummy = null;
    this.kernels = null;
  }
}
