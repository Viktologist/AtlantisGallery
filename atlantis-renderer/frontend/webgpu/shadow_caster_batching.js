                                                     
  
                                                                           
                                                                               
                                                                              
                                                                              
                                                                               
                                                       
  
                                                        

export const SHADOW_UNIFIED_SCHEMA = 'aps-shadow-unified-depth/1';
export const SHADOW_UNIFIED_VERSION = 'shadow-unified-depth-r1.4-shared-cascade-sources';
export const SHADOW_BATCH_LIMITS = Object.freeze({
  tileSize: 128,
  maxBatchInstances: 65536,
  maxAtlasVertices: 1500000,
  maxAtlasIndices: 4500000,
  maxRegistryAtlasVertices: 6000000,
});

const SKIP = Symbol('aps-shadow-skip');
const DEFAULTS = SHADOW_BATCH_LIMITS;

                                                                           
                                                                           
                                                                                 
                                                           
  
                                                                           
                                                                           
                                                                               
                                      
export function isShadowDepthPass(pass) {
  if (!pass || pass.kind !== 'depth') return false;
  if (pass.apsVegetationSeed || pass.apsGrassTerrainSample || pass.apsGrassEarlyZDepth) return false;
  if (pass.apsShadowUnified === true) return true;
  return typeof pass.label === 'string' && /^native solar clipmap \d+$/.test(pass.label);
}

                                                                         
                                                                          
export function boxInClipVolume(box, viewProj) {
  if (!box || !viewProj) return true;
  const e = viewProj.elements ?? viewProj;
  if (!e || e.length < 16 || ![...e].every(Number.isFinite)) return true;
  if (!box.min || !box.max || ![...box.min, ...box.max].every(Number.isFinite)) return true;
  const row = (i) => [e[i], e[4 + i], e[8 + i], e[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  const planes = [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), r2.slice(), sub(r3, r2)];
  for (const [a, b, c, d] of planes) {
    if (Math.abs(a) + Math.abs(b) + Math.abs(c) < 1e-12) continue;
    const px = a >= 0 ? box.max[0] : box.min[0];
    const py = b >= 0 ? box.max[1] : box.min[1];
    const pz = c >= 0 ? box.max[2] : box.min[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

export function installShadowCasterBatching(renderer, options = {}) {
  if (!renderer || typeof renderer.collect !== 'function') throw Error('Shadow caster batching needs a mesh renderer with collect()');
  for (const name of ['Mesh', 'InstancedMesh', 'BufferGeometry', 'Float32BufferAttribute', 'Uint32BufferAttribute', 'Material']) {
    if (typeof options[name] !== 'function') throw Error(`Shadow caster batching is missing the ${name} constructor`);
  }
  const existing = renderer.__apsShadowUnified;
  if (existing && existing.version === SHADOW_UNIFIED_VERSION && !existing.disposed) {
    existing.updateOptions(options);
    return existing;
  }
  if (existing?.dispose) existing.dispose();
  const instance = new ShadowUnifiedDepth(renderer, options);
  renderer.__apsShadowUnified = instance;
  if (options.global !== false) globalThis.__APS_SHADOW_UNIFIED__ = instance;
  return instance;
}

class ShadowUnifiedDepth {
  constructor(renderer, options) {
    this.version = SHADOW_UNIFIED_VERSION;
    this.renderer = renderer;
    this.options = options;
    this.viewer = options.viewer ?? null;
    this.Mesh = options.Mesh;
    this.InstancedMesh = options.InstancedMesh;
    this.BufferGeometry = options.BufferGeometry;
    this.Float32BufferAttribute = options.Float32BufferAttribute;
    this.Uint32BufferAttribute = options.Uint32BufferAttribute;
    this.Material = options.Material;
    this.GPU = options.GPU ?? null;
    this.config = { ...DEFAULTS, ...(options.config ?? {}) };
    for (const key of Object.keys(this.config)) {
      if (!Number.isFinite(this.config[key]) || this.config[key] < 1) throw RangeError(`Invalid shadow batch limit ${key}`);
    }
    this.disposed = false;
    this.enabled = options.enabled !== false;
    this.broken = false;
    this.lastError = null;
    this.errorCount = 0;
    this.localFrame = 0;
    this.preparedFrame = -1;
    this.rebuildCount = 0;
    this.rebuildReason = 'install';
    this.built = false;
    this.scene = null;
    this.revision = null;
    this.sceneChildCount = -1;
    this.tracked = [];
    this.candidates = [];
    this.batches = [];
    this.consumed = new WeakSet();
    this.batchesByObject = new WeakMap();
    this.dynamic = new WeakSet();
    this.maskMaterials = new WeakMap();
    this.maskMaterialList = [];
    this.maskRejections = new WeakMap();
    this.itemFallbackReasons = Object.create(null);
    this.itemFallbackTriangles = Object.create(null);
    this.itemFallbackCount = 0;
    this.itemFallbackTriangleCount = 0;
    this.lastItemFallbacks = { frame: null, label: null, items: 0, triangles: 0, reasons: {}, reason_triangles: {} };
    this.coverageIds = new WeakMap();
    this.coverageSerial = 0;
    this.opaqueMaterials = new Map();
    this.fallbackReasons = Object.create(null);
    this.fallbackTriangles = Object.create(null);
    this.managedReasons = Object.create(null);
    this.unassignedReason = new WeakMap();
    this.counts = emptyCounts();
    this.passStats = [];
    this.aggregate = {
      passes: 0, before: 0, after: 0, removed: 0, appended_batches: 0, culled_batches: 0,
      glass_skipped: 0, transparent_skipped: 0, opaque_replaced: 0, mask_replaced: 0,
      mask_skipped: 0, skipped_no_material: 0,
      unified_items: 0, mask_items: 0,
      fallback_original_items: 0, fallback_original_triangles: 0, missing_material_items: 0,
      fast_path_passes: 0, fast_skipped_items: 0, fast_culled_source_items: 0, fast_activated_batches: 0,
      tainted_batches: 0, native_batch_items: 0,
    };
    this.hadOwnCollect = Object.prototype.hasOwnProperty.call(renderer, 'collect');
    this.previousOwnCollect = renderer.collect;
    this.originalCollect = renderer.collect.bind(renderer);
    this.collect = this.collect.bind(this);
    renderer.collect = this.collect;
    this.breakdown = null;
                                                                           
                                                                            
                                                                             
                                                                                
                                               
    this.fastPathEnabled = options.fastPath !== false;
    this.fastPathActive = false;
    this.fastPathDisabledReason = null;
    this.fastRecoveryCount = 0;
    this.fastSkippedTotal = 0;
    this.lastFast = null;
  }

  updateOptions(options = {}) {
    if (options.viewer) this.viewer = options.viewer;
    if (options.GPU) this.GPU = options.GPU;
    if (options.config) this.config = { ...this.config, ...options.config };
    return this;
  }

  isShadowPass(pass) {
    return isShadowDepthPass(pass);
  }

  collect(scene, pass) {
                                                                              
                                                                              
                                                                            
    if(pass?.apsShadowSourcePrepared)return this.originalCollect(scene,pass);
    if (this.disposed || this.broken || !this.enabled || !this.isShadowPass(pass)) return this.originalCollect(scene, pass);
    if (!this.fastPathEnabled) return this.collectStable(scene, pass);
                                                                               
                                                                               
                                                                          
                                                                                
                                                                             
                                                              
    try {
      this.prepare(scene, pass);
    } catch (error) {
      this.noteCollectFailure(error);
                                                                            
                                                              
      try {
        return this.originalCollect(scene, pass);
      } catch (collectError) {
        this.noteCollectFailure(collectError);
        throw collectError;
      }
    }
    let skip = null;
    try {
      skip = this.beginFastSkip(scene, pass);
    } catch (error) {
      this.noteCollectFailure(error);
      this.setFastPath(false, 'skip-prepare-failed');
    }
    if (!skip) return this.collectAfterPrepare(scene, pass);
    let lists;
    try {
      lists = this.originalCollect(scene, { ...pass, filter: skip.filter });
    } catch (error) {
      this.noteCollectFailure(error);
      throw error;
    }
    try {
      return this.transform(lists, pass, skip);
    } catch (error) {
      this.noteCollectFailure(error);
      this.setFastPath(false, 'transform-failed');
      return this.recoverFastLists(lists, skip);
    }
  }

  collectAfterPrepare(scene, pass) {
    let lists;
    try {
      lists = this.originalCollect(scene, pass);
    } catch (error) {
      this.noteCollectFailure(error);
      throw error;
    }
    try {
      return this.transform(lists, pass);
    } catch (error) {
      this.noteCollectFailure(error);
      return lists;
    }
  }

                                                                              
                                                                         
  collectStable(scene, pass) {
    let lists;
    try {
      lists = this.originalCollect(scene, pass);
    } catch (error) {
      this.noteCollectFailure(error);
      throw error;
    }
    try {
      this.prepare(scene, pass);
      return this.transform(lists, pass);
    } catch (error) {
      this.noteCollectFailure(error);
      return lists;
    }
  }

  noteCollectFailure(error) {
    this.lastError = String(error?.stack ?? error?.message ?? error);
    this.errorCount++;
    if (this.errorCount >= 3) this.broken = true;
  }

  setFastPath(enabled = true, reason = null) {
    this.fastPathEnabled = enabled !== false;
    this.fastPathActive = false;
    this.fastPathDisabledReason = this.fastPathEnabled ? null : (reason ?? 'disabled');
    return this.fastPathEnabled;
  }

                                                                                
                                                                           
  invalidate(reason = 'manual') {
    if (this.disposed) return false;
    this.built = false;
    this.revision = null;
    this.rebuildReason = reason;
    return true;
  }

                                                                             
                                                                           
                                                                        
                                                                                
                                                                               
                                                                             
  sourceEligible(source, pass, { precompiling = false, layerMask = 0xffffffff } = {}) {
    if (!source?.isMesh || !source.geometry) return false;
    if (!source.castShadow) return false;
    const material = source.material;
    if (!material || Array.isArray(material)) return false;
    if (material.transparent === true) return false;
                                                                           
                                                                            
    if (material.alphaTest > 0 || material.shadow) return false;
    if (material.depthWrite === false || material.depthTest === false) return false;
                                                                             
                                                                             
    if (!precompiling && material.visible === false) return false;
    if (((source.layers?.mask ?? 1) & layerMask) === 0) return false;
    for (let node = source; node; node = node.parent) {
      if (node.visible === false) return false;
    }
                                                                              
                                                                              
                                                                              
    const data = source.userData ?? {};
    if (data.apsDiagnosticOverlay || data.apsVegetationSource) return false;
    if (data.apsGrassViewCamera && data.apsGrassViewCamera !== pass?.camera) return false;
    return true;
  }

                                                                             
                                                                           
                                                                              
  beginFastSkip(scene, pass) {
    if (!this.built || this.scene !== scene || this.revision !== this.sourceRevision(scene)) return null;
    if (this.renderer.precompiling !== true && !this.batches.length) {
                                                                               
                                 
      return null;
    }
    const renderer = this.renderer;
    const consumed = this.consumed;
    const active = new Set();
    const items = new Map();
    for (const batch of this.batches) items.set(batch, this.itemForBatch(batch, pass));
    const camera = pass.camera;
    const cull = pass.cull !== false && !!camera;
    const precompiling = renderer.precompiling === true;
    const priorFilter = pass.filter;
    const layerMask = pass.layerMask ?? 0xffffffff;
                                                                              
                                                                            
                                                                              
                                                                          
                                                                               
                                                     
    const keep = new Set();
    const tainted = new Set();
                                                                            
                                                               
    const priorResults = priorFilter ? new Map() : null;
    const eligible = new Map();
    const stats = { skipped: 0, culled: 0, filtered: 0, activated: 0, tainted: 0 };
                                                                               
                                                                               
                                                                               
                                      
    const filterReachable = (source) => {
      if (!precompiling) {
        for (let node = source; node; node = node.parent) if (node.visible === false) return false;
      }
      return ((source.layers?.mask ?? 1) & layerMask) !== 0;
    };
    for (const batch of this.batches) {
      let taintedBatch = false;
      for (const source of batch.sourceObjects) {
        if (priorFilter) {
          const selected = filterReachable(source) ? !!priorFilter(source) : true;
          priorResults.set(source, selected);
          if (!selected) taintedBatch = true;
        }
        const ok = this.sourceEligible(source, pass, { precompiling, layerMask });
        eligible.set(source, ok);
        if (!ok) taintedBatch = true;
      }
      if (taintedBatch) {
        tainted.add(batch);
        stats.tainted++;
        for (const source of batch.sourceObjects) keep.add(source);
      }
    }
    const inFrustum = typeof renderer._inFrustum === 'function' ? renderer._inFrustum.bind(renderer) : null;
    const filter = (object) => {
      if (!consumed.has(object)) return priorFilter ? priorFilter(object) : true;
      if (keep.has(object)) {
        const selected = priorFilter ? priorResults.get(object) ?? true : true;
        if (!selected) stats.filtered++;
        if (!eligible.get(object)) { stats.culled++; return false; }
                                                                              
                                                                              
        return selected;
      }
                                                                               
                                                                              
                                                                               
                                                         
      if (precompiling) { stats.skipped++; return false; }
                                                                             
                                                                              
                                                                               
      if (!object.castShadow || !object.material || !object.material.visible) { stats.culled++; return false; }
      let visible = true;
      if (cull && object.frustumCulled !== false) {
        try { visible = inFrustum ? inFrustum(object) : true; }
        catch { visible = true; }
      }
      if (!visible) { stats.culled++; return false; }
      const batches = this.batchesByObject.get(object);
      if (!batches?.length) {
                                                                               
                                                                          
        return true;
      }
      stats.skipped++;
      for (const batch of batches) {
        if (!active.has(batch)) { active.add(batch); stats.activated++; }
      }
      return false;
    };
    this.fastPathActive = true;
    return { filter, active, items, stats, keep, tainted, eligible };
  }

                                                                              
                                                                              
                                                                               
                                                                             
                                                  
  taintedBatches(lists, pass) {
    const present = new Set();
    for (const item of [...lists.opaque, ...lists.transparent]) if (item?.object) present.add(item.object);
    const precompiling = this.renderer.precompiling === true;
    const layerMask = pass.layerMask ?? 0xffffffff;
    const tainted = new Set();
    for (const batch of this.batches) {
      let incomplete = false;
      for (const source of batch.sourceObjects) {
        if (!present.has(source) || !this.sourceEligible(source, pass, { precompiling, layerMask })) {
          incomplete = true;
          break;
        }
      }
      if (incomplete) tainted.add(batch);
    }
    return tainted;
  }

                                                                             
                                                                            
                                  
  recoverFastLists(lists, skip) {
    const precompiling = this.renderer.precompiling === true;
    const present = new Set(lists.opaque);
    for (const [batch, item] of skip.items) {
      if (!precompiling && !skip.active.has(batch)) continue;
      if (present.has(item)) continue;
      lists.opaque.push(item);
      present.add(item);
    }
    lists.opaque.sort((a, b) => (a.renderOrder - b.renderOrder) || (a.pipeKey - b.pipeKey) || (a.z - b.z));
    this.fastRecoveryCount++;
    return lists;
  }

  sourceRevision(scene = this.scene) {
    const v = this.viewer;
    return [
      v?.shadowRevision ?? 0,
      v?.loadId ?? 0,
      v?.sceneEpoch ?? 0,
      v?.sceneDocumentURL ?? '',
      scene?.children?.length ?? 0,
      this.renderer.vegetationSystems?.size ?? 0,
      v?.meshCompanions?.size ?? 0,
    ].join('|');
  }

  prepare(scene, pass) {
    if (this.disposed) return;
    const frame = Number.isFinite(this.viewer?.frame) ? this.viewer.frame : this.localFrame++;
    if (this.preparedFrame === frame) return;
    this.preparedFrame = frame;
    if (!this.built || this.scene !== scene || this.revision !== this.sourceRevision(scene)) {
      this.rebuild('scene');
      return;
    }
    if (this.visibilityChanged()) {
      this.rebuild('visibility');
      return;
    }
    this.updateTransforms();
    if (this.needsRebuild) this.rebuild('transform');
  }

  visibilityChanged() {
    for (const record of this.tracked) {
      const object = record.object;
      if (object.parent !== record.parent || rootOf(object) !== this.scene) return true;
      for (let i = 0; i < record.chain.length; i++) {
        const visible = record.chain[i].visible !== false;
        if (visible !== record.visibility[i]) return true;
      }
    }
    return false;
  }

  updateTransforms() {
                                                                                
                                                                              
                                                                           
                                                                          
                                                            
    let localChanged = false;
    for (const record of this.tracked) {
      if (localChainChanged(record)) { localChanged = true; break; }
    }
    if (localChanged && typeof this.scene?.updateMatrixWorld === 'function') this.scene.updateMatrixWorld(true);
    let needsRebuild = false;
    for (const batch of this.batches) {
      if (batch.positionVersion !== (batch.geometry.attributes?.position?.version ?? 0)) {
        needsRebuild = true;
        break;
      }
      if (batch.kind === 'merged') {
        for (const entry of batch.entries) {
          if (matrixChanged(entry.object.matrixWorld?.elements, entry.world)) {
            this.dynamic.add(entry.object);
            needsRebuild = true;
            break;
          }
          if (entry.positionVersion !== (entry.geometry.attributes?.position?.version ?? 0)) {
            this.dynamic.add(entry.object);
            needsRebuild = true;
            break;
          }
          if (entry.materialVersion !== (entry.object.material?.version ?? 0)) {
            needsRebuild = true;
            break;
          }
        }
        if (needsRebuild) break;
        continue;
      }
      let touched = false;
      for (const entry of batch.entries) {
        const source = entry.object;
        if (entry.materialVersion !== (source.material?.version ?? 0)) { needsRebuild = true; break; }
        if (entry.instanceCount !== (source.isInstancedMesh ? source.count : 1)) { needsRebuild = true; break; }
        const sourceWorld = source.matrixWorld?.elements;
        const instanceChanged = entry.instanceVersion !== (source.instanceMatrix?.version ?? 0);
        if (!instanceChanged && !matrixChanged(sourceWorld, entry.objectWorld)) continue;
        const current = matrixWorldFor(source, entry.instanceIndex);
        if (!current) { this.dynamic.add(source); needsRebuild = true; break; }
        entry.world = current.slice ? current.slice() : Array.from(current);
        entry.objectWorld = sourceWorld ? Array.from(sourceWorld) : null;
        entry.instanceVersion = source.instanceMatrix?.version ?? 0;
        writeLocalMatrix(batch, entry, current);
        touched = true;
      }
      if (needsRebuild) break;
      if (touched) {
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.worldBox = instancedWorldBox(batch.geometry, batch.entries, batch.pivot);
      }
    }
    if (!needsRebuild && localChanged) {
                                                                               
                                                                      
      for (const record of this.tracked) record.local = captureLocalChain(record.chain, record.local);
    }
    this.needsRebuild = needsRebuild;
  }

  rebuild(reason = 'manual') {
    if (this.disposed) throw Error('Shadow caster batch is disposed');
    const scene = this.viewer?.scene ?? this.scene;
    if (!scene || typeof scene.traverse !== 'function') throw Error('Shadow caster batching has no scene');
    this.scene = scene;
    scene.updateMatrixWorld(true);
    this.disposeBatches();
    this.tracked.length = 0;
    this.candidates.length = 0;
    this.unassignedReason = new WeakMap();
    this.fallbackReasons = Object.create(null);
    this.fallbackTriangles = Object.create(null);
    this.managedReasons = Object.create(null);
    this.counts = emptyCounts();
    const bounds = new Map();
    const meshes = [];
    scene.traverse((object) => {
      if (object?.isMesh && object.material && object.geometry && object.castShadow) meshes.push(object);
    });
    this.counts.cast_shadow_meshes = meshes.length;
    for (const object of meshes) {
      if (object.userData?.apsShadowBatch) continue;
      const info = classifyObject(object);
      if (info.kind === 'opaque') {
        const chain = chainOf(object);
        const visible = chain.every((node) => node.visible !== false);
        const record = {
          object,
          parent: object.parent,
          chain,
          visibility: chain.map((node) => node.visible !== false),
          local: captureLocalChain(chain),
          geometry: object.geometry,
          source: object.material,
          side: object.material?.side ?? 'front',
          positionVersion: object.geometry.attributes?.position?.version ?? 0,
          materialVersion: object.material?.version ?? 0,
        };
        this.tracked.push(record);
        if (!visible) {
          this.counts.hidden_batchable++;
          continue;
        }
        if (this.dynamic.has(object)) {
          this.noteFallback('dynamic_evicted', object);
          this.counts.dynamic_evicted++;
          continue;
        }
        this.candidates.push(record);
      } else if (info.kind === 'mask') {
        this.counts.mask_objects++;
        this.noteFallback('mask_unified', object);
      } else if (info.kind === 'glass') {
        this.counts.glass_objects++;
        this.noteFallback(info.reason ?? 'glass', object);
      } else if (info.kind === 'transparent') {
        this.noteFallback('transparent', object);
      } else if (info.kind === 'managed') {
        this.counts.managed_objects++;
        this.noteManaged(info.reason ?? 'managed', object);
      } else if (info.kind === 'dynamic') {
        if (info.reason === 'joint') this.noteFallback('dynamic_joint', object);
        else this.noteFallback(info.reason ?? 'dynamic', object);
      } else {
        this.noteFallback(info.reason ?? info.kind ?? 'unsupported', object);
      }
    }
    this.counts.batchable_candidates = this.candidates.length;
    this.buildBatches(bounds);
    for (const record of this.candidates) {
      if (!this.consumed.has(record.object)) {
        const why = this.unassignedReason.get(record.object) ?? 'unbatched';
        this.noteFallback(why, record.object);
      }
    }
    this.counts.opaque_materials = this.opaqueMaterials.size;
    this.counts.mask_materials = this.maskMaterialList.length;
    this.built = true;
    this.needsRebuild = false;
    this.revision = this.sourceRevision(scene);
    this.sceneChildCount = scene.children.length;
    this.rebuildReason = reason;
    this.rebuildCount++;
    return this.metadata();
  }

  buildBatches(bounds) {
    const meshGroups = new Map();
    const instancedGroups = new Map();
    const expected = new Map();
    for (const record of this.candidates) {
      const object = record.object;
      expected.set(object, object.isInstancedMesh ? object.count : 1);
      if (!object.isInstancedMesh) {
        const world = object.matrixWorld?.elements;
        if (!world || !finiteMatrix(world)) { this.markUnassigned(object, 'nonfinite_matrix'); continue; }
        const tile = tileKey(world, this.config.tileSize);
        const key = `${object.geometry.uuid}|${record.side}|${tile}`;
        if (!meshGroups.has(key)) meshGroups.set(key, { side: record.side, geometry: object.geometry, tile, entries: [] });
        meshGroups.get(key).entries.push({ object, instanceIndex: null, world: Array.from(world), side: record.side });
        continue;
      }
      if (!Number.isInteger(object.count) || object.count <= 0) { this.markUnassigned(object, 'invalid_instance_count'); continue; }
      if (object.count > this.config.maxBatchInstances) { this.markUnassigned(object, 'instance_cap'); continue; }
      const matrix = object.instanceMatrix?.array;
      if (!matrix || matrix.length < object.count * 16) { this.markUnassigned(object, 'invalid_instance_matrix'); continue; }
      const key = `${object.geometry.uuid}|${record.side}|instanced`;
      if (!instancedGroups.has(key)) instancedGroups.set(key, { side: record.side, geometry: object.geometry, entries: [] });
      const group = instancedGroups.get(key);
      for (let i = 0; i < object.count; i++) {
        const world = multiplyMatrix(object.matrixWorld.elements, matrix, i * 16);
        if (!world || !finiteMatrix(world)) { group.bad = true; break; }
        group.entries.push({ object, instanceIndex: i, instanceVersion: object.instanceMatrix?.version ?? 0, world: Array.from(world), side: record.side });
      }
    }
    for (const group of meshGroups.values()) {
      const sources = new Set(group.entries.map((entry) => entry.object));
      if (sources.size < 2) {
        for (const object of sources) this.markUnassigned(object, 'atlas_single');
        continue;
      }
      if (group.entries.length > this.config.maxBatchInstances) {
        for (const object of sources) this.markUnassigned(object, 'instance_cap');
        continue;
      }
      const batch = this.buildInstancedBatch(group, bounds);
      if (!batch) for (const object of sources) this.markUnassigned(object, 'instanced_build_failed');
    }
    for (const group of instancedGroups.values()) {
      const sources = new Set(group.entries.map((entry) => entry.object));
      if (group.bad) { for (const object of sources) this.markUnassigned(object, 'nonfinite_instance_matrix'); continue; }
      if (sources.size < 2) {
        for (const object of sources) this.markUnassigned(object, 'instanced_single');
        continue;
      }
      if (group.entries.length > this.config.maxBatchInstances) {
        for (const object of sources) this.markUnassigned(object, 'instance_cap');
        continue;
      }
      const batch = this.buildInstancedBatch(group, bounds);
      if (!batch) for (const object of sources) this.markUnassigned(object, 'instanced_build_failed');
    }
    const atlasGroups = new Map();
    for (const group of meshGroups.values()) {
      if (group.entries.length === 1) {
        const key = `${group.side}|${group.tile}`;
        if (!atlasGroups.has(key)) atlasGroups.set(key, { side: group.side, tile: group.tile, entries: [] });
        atlasGroups.get(key).entries.push(group.entries[0]);
      }
    }
    for (const group of atlasGroups.values()) this.buildAtlasChunks(group, bounds);
                                                                                
                                               
    for (const batch of this.batches) {
      for (const object of batch.sourceObjects) {
        const assigned = batch.entries.filter((entry) => entry.object === object).length;
        if (assigned !== expected.get(object)) {
          batch.invalid = true;
          for (const source of batch.sourceObjects) this.markUnassigned(source, 'batch_reconciliation_failed');
          break;
        }
      }
    }
    this.batches = this.batches.filter((batch) => !batch.invalid);
    this.consumed = new WeakSet();
    this.batchesByObject = new WeakMap();
    for (const batch of this.batches) {
      for (const object of batch.sourceObjects) {
        this.consumed.add(object);
        let list = this.batchesByObject.get(object);
        if (!list) this.batchesByObject.set(object, list = []);
        list.push(batch);
      }
      this.counts.batched_source_objects += batch.sourceObjects.size;
      this.counts.batched_source_instances += batch.entries.length;
      this.counts.batched_triangles += batch.triangles;
      if (batch.kind === 'instanced') this.counts.instanced_batches++;
      else {
        this.counts.atlas_batches++;
        this.counts.atlas_vertices += batch.vertices;
        this.counts.atlas_indices += batch.indices;
      }
    }
    this.counts.batch_draws = this.batches.length;
    this.counts.expected_draw_reduction = this.counts.batched_source_objects - this.batches.length;
  }

  buildInstancedBatch(group, bounds) {
    const sources = new Set(group.entries.map((entry) => entry.object));
    if (sources.size < 2) return null;
    const geometry = group.geometry;
    const box = geometryBounds(geometry, bounds);
    if (!box) return null;
    let worldBox = null;
    for (const entry of group.entries) {
      const transformed = transformAabb(box, entry.world);
      worldBox = worldBox ? unionBox(worldBox, transformed) : transformed;
    }
    if (!worldBox) return null;
    const pivot = boxCenter(worldBox);
    const material = this.opaqueMaterial(group.side, 'triangle-list');
    const batch = {
      kind: 'instanced', geometry, material, pivot, worldBox,
      sourceObjects: sources, entries: [], triangles: 0, vertices: 0,
      positionVersion: geometry.attributes?.position?.version ?? 0,
    };
    const mesh = new this.InstancedMesh(geometry, material, group.entries.length);
    mesh.name = `APS shadow caster instanced batch ${this.batches.length}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers.mask = 1;
    mesh.userData = { apsShadowBatch: true, schema: SHADOW_UNIFIED_SCHEMA, kind: 'instanced' };
    const localTranslate = translateMatrix(-pivot[0], -pivot[1], -pivot[2]);
    for (let i = 0; i < group.entries.length; i++) {
      const entry = group.entries[i];
      const localWorld = multiplyMatrix(localTranslate, entry.world);
      mesh.instanceMatrix.array.set(localWorld, i * 16);
      batch.entries.push({
        ...entry, index: i, local: localWorld,
        positionVersion: geometry.attributes?.position?.version ?? 0,
        materialVersion: entry.object.material?.version ?? 0,
        instanceCount: entry.object.isInstancedMesh ? entry.object.count : 1,
        objectWorld: Array.from(entry.object.matrixWorld.elements),
      });
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.matrix.fromArray(translateMatrix(pivot[0], pivot[1], pivot[2]));
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.matrixWorldNeedsUpdate = false;
    batch.mesh = mesh;
    batch.triangles = triangleCount(geometry) * group.entries.length;
    batch.vertices = (geometry.attributes?.position?.count ?? 0) * group.entries.length;
    batch.worldBox = instancedWorldBox(geometry, batch.entries, pivot);
    this.batches.push(batch);
    return batch;
  }

  buildAtlasChunks(group, bounds) {
    const entries = group.entries;
    const good = [];
    let registryVerts = 0;
    for (const entry of entries) {
      const pos = entry.object.geometry?.attributes?.position;
      if (!pos || pos.itemSize !== 3) { this.markUnassigned(entry.object, 'no_position'); continue; }
      const indexCount = entry.object.geometry.index?.count ?? pos.count;
      if (indexCount % 3 !== 0) { this.markUnassigned(entry.object, 'non_triangle_topology'); continue; }
      if (pos.count > this.config.maxRegistryAtlasVertices) { this.markUnassigned(entry.object, 'atlas_vertex_cap'); continue; }
      if (registryVerts + pos.count > this.config.maxRegistryAtlasVertices) { this.markUnassigned(entry.object, 'atlas_budget'); continue; }
      registryVerts += pos.count;
      good.push({ ...entry, vertexCount: pos.count, indexCount });
    }
    let current = [], currentSources = new Set(), verts = 0, inds = 0;
    const flush = () => {
      if (!current.length) return;
      if (currentSources.size < 2) {
        for (const source of currentSources) this.markUnassigned(source, 'atlas_single');
      } else {
        const batch = this.buildAtlasBatch(current, bounds);
        if (!batch) for (const source of currentSources) this.markUnassigned(source, 'atlas_build_failed');
      }
      current = []; currentSources = new Set(); verts = 0; inds = 0;
    };
    for (const entry of good) {
      const over = current.length && (verts + entry.vertexCount > this.config.maxAtlasVertices || inds + entry.indexCount > this.config.maxAtlasIndices);
      if (over && currentSources.size >= 2) flush();
      current.push(entry);
      currentSources.add(entry.object);
      verts += entry.vertexCount;
      inds += entry.indexCount;
      if (currentSources.size >= 2 && (verts > this.config.maxAtlasVertices || inds > this.config.maxAtlasIndices)) flush();
    }
    flush();
  }

  buildAtlasBatch(entries, bounds) {
    const sources = new Set(entries.map((entry) => entry.object));
    if (sources.size < 2) return null;
    let totalVertices = 0, totalIndices = 0;
    for (const entry of entries) {
      totalVertices += entry.vertexCount;
      totalIndices += entry.indexCount;
    }
    if (totalVertices > this.config.maxAtlasVertices || totalIndices > this.config.maxAtlasIndices) return null;
    let worldBox = null;
    for (const entry of entries) {
      const box = geometryBounds(entry.object.geometry, bounds);
      if (!box) return null;
      const transformed = transformAabb(box, entry.world);
      worldBox = worldBox ? unionBox(worldBox, transformed) : transformed;
    }
    if (!worldBox) return null;
    const pivot = boxCenter(worldBox);
    const positions = new Float32Array(totalVertices * 3);
    const indices = new Uint32Array(totalIndices);
    let vertexOffset = 0, indexOffset = 0;
    let localMin = [Infinity, Infinity, Infinity], localMax = [-Infinity, -Infinity, -Infinity];
    const localTranslate = translateMatrix(-pivot[0], -pivot[1], -pivot[2]);
    for (const entry of entries) {
      const geometry = entry.object.geometry;
      const pos = geometry.attributes.position;
      const matrix = multiplyMatrix(localTranslate, entry.world);
      const base = vertexOffset;
      for (let i = 0; i < pos.count; i++) {
        const p = transformPoint(matrix, pos.getX(i), pos.getY(i), pos.getZ(i));
        positions[vertexOffset * 3] = p[0];
        positions[vertexOffset * 3 + 1] = p[1];
        positions[vertexOffset * 3 + 2] = p[2];
        if (p[0] < localMin[0]) localMin[0] = p[0];
        if (p[1] < localMin[1]) localMin[1] = p[1];
        if (p[2] < localMin[2]) localMin[2] = p[2];
        if (p[0] > localMax[0]) localMax[0] = p[0];
        if (p[1] > localMax[1]) localMax[1] = p[1];
        if (p[2] > localMax[2]) localMax[2] = p[2];
        vertexOffset++;
      }
      const index = geometry.index;
      if (index) {
        for (let i = 0; i < index.count; i++) indices[indexOffset++] = base + index.getX(i);
      } else {
        for (let i = 0; i < pos.count; i++) indices[indexOffset++] = base + i;
      }
    }
    const geometry = new this.BufferGeometry();
    geometry.setAttribute('position', new this.Float32BufferAttribute(positions, 3));
    geometry.setIndex(new this.Uint32BufferAttribute(indices, 1));
    geometry.userData = { apsShadowBatch: true, schema: SHADOW_UNIFIED_SCHEMA, kind: 'merged_atlas' };
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = this.opaqueMaterial(entries[0].side, 'triangle-list');
    const mesh = new this.Mesh(geometry, material);
    mesh.name = `APS shadow caster merged atlas ${this.batches.length}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers.mask = 1;
    mesh.userData = { apsShadowBatch: true, schema: SHADOW_UNIFIED_SCHEMA, kind: 'merged_atlas' };
    mesh.matrix.fromArray(translateMatrix(pivot[0], pivot[1], pivot[2]));
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.matrixWorldNeedsUpdate = false;
    const batch = {
      kind: 'merged', geometry, material, mesh, pivot,
      worldBox: { min: [localMin[0] + pivot[0], localMin[1] + pivot[1], localMin[2] + pivot[2]], max: [localMax[0] + pivot[0], localMax[1] + pivot[1], localMax[2] + pivot[2]] },
      sourceObjects: sources,
      positionVersion: geometry.attributes?.position?.version ?? 0,
      entries: entries.map((entry) => ({
        object: entry.object,
        world: entry.world.slice(),
        geometry: entry.object.geometry,
        positionVersion: entry.object.geometry.attributes?.position?.version ?? 0,
        materialVersion: entry.object.material?.version ?? 0,
      })),
      triangles: totalIndices / 3,
      vertices: totalVertices,
      indices: totalIndices,
    };
    this.batches.push(batch);
    return batch;
  }

  opaqueMaterial(side = 'front', topology = 'triangle-list') {
    const key = `${side}|${topology}`;
    let material = this.opaqueMaterials.get(key);
    if (!material) {
      const safeSide = ['front', 'back', 'double'].includes(side) ? side : 'front';
      material = new this.Material({
        name: 'APS unified shadow depth (opaque, implicit alpha 1)',
        lit: false, side: safeSide, topology, transparent: false,
        depthWrite: true, depthTest: true, shadow: '',
        userData: { apsShadowUnifiedDepth: true, opacityMode: 'opaque' },
      });
      this.opaqueMaterials.set(key, material);
    }
    return material;
  }

  maskMaterial(source) {
    if (!source) return null;
    const reject = (reason) => {
      this.maskRejections.set(source, reason);
      this.lastMaskError = reason;
      return null;
    };
    const hook = typeof source.shadow === 'string' ? source.shadow : '';
    if (/surfaceOf\s*\(|apsEvaluateMaterial\s*\(|apsShadePrincipled\s*\(/.test(hook)) return reject('mask_surface_hook');
    const coverage = source.userData?.apsCoverageDepth ?? null;
    if (!coverage && /apsMeshUv_|textureSample|textureSampleLevel|textureGather/.test(hook)) return reject('mask_texture_without_coverage');
    if (coverage && !hook) return reject('mask_coverage_without_hook');
    let coverageKey = 0;
    if (coverage) {
      if (!coverage.module) return reject('mask_coverage_without_module');
      coverageKey = this.coverageIds.get(coverage) ?? 0;
      if (!coverageKey) {
        coverageKey = ++this.coverageSerial;
        this.coverageIds.set(coverage, coverageKey);
      }
    }
    const signature = [
      source.version ?? 0, source.alphaTest ?? 0, source.opacity ?? 1, source.side ?? 'front',
      source.topology ?? 'triangle-list', source.vertexColors === true ? 1 : 0,
      source.depthWrite === false ? 0 : 1, source.depthTest === false ? 0 : 1,
      coverageKey, hook,
    ].join('|');
    const cached = this.maskMaterials.get(source);
    if (cached?.signature === signature) return cached.material;
    let material = null;
    try {
      const params = {
        name: 'APS unified shadow depth (opacity mask)',
        lit: false,
        side: source.side ?? 'front',
        topology: source.topology ?? 'triangle-list',
        transparent: false,
        alphaTest: source.alphaTest > 0 ? source.alphaTest : 0.5,
        depthWrite: true,
        depthTest: true,
        opacity: source.opacity ?? 1,
        vertexColors: source.vertexColors === true,
        userData: { apsShadowUnifiedDepth: true, opacityMode: 'mask', sourceMaterialId: source.id ?? null },
      };
      if (hook) params.shadow = hook;
      if (coverage) {
        params.vertex = coverage.vertex ?? '';
        params.attributes = coverage.attributes ?? {};
        params.varyings = coverage.varyings ?? {};
        params.bindings = coverage.bindings ?? {};
        params.uniforms = coverage.uniforms ?? {};
        params.modules = [coverage.module];
      }
      material = new this.Material(params);
      for (const name of ['opacity', 'alphaTest', ...Object.keys(coverage?.uniforms ?? {})]) {
        if (source.uniforms?.[name] && material.uniformBlock?.fields?.[name]) material.uniforms[name] = material.uniformBlock.fields[name] = source.uniforms[name];
      }
      this.maskRejections.delete(source);
      this.maskMaterials.set(source, { signature, material });
      this.maskMaterialList.push(material);
    } catch (error) {
      this.lastMaskError = String(error?.message ?? error);
      material = null;
      this.maskRejections.set(source, 'mask_material_error');
      this.maskMaterials.set(source, { signature, material: null });
    }
    return material;
  }

  maskRejection(source) {
    return this.maskRejections.get(source) ?? null;
  }

                                                                               
                                                                           
                                                                            
                                                                           
  depthMaterialFor(object, itemMaterial, item = null, info = null) {
    if (itemMaterial?.userData?.apsShadowUnifiedDepth) return { material: itemMaterial, mode: 'already', reason: null };
    const classification = info ?? classifyObject(object);
    const source = itemMaterial ?? (Array.isArray(object?.material) ? null : object?.material);
    if (!source) return { material: null, mode: 'unavailable', reason: 'missing_material' };
    const fallback = (reason) => ({ material: itemMaterial ?? source, mode: 'fallback', reason });
    if (classification.kind === 'managed') return { material: itemMaterial ?? source, mode: 'managed', reason: classification.reason ?? 'managed' };
    const glass = glassInfo(source);
    if (glass.glass || source.transparent === true || classification.kind === 'glass' || classification.kind === 'transparent') return SKIP;
    if (source.visible === false) return fallback('material_hidden');
    const multi = Array.isArray(object.material);
    const resolved = itemSourceMaterial(object, item);
    if (multi) {
      if (isDeformed(object)) return fallback('deformed_multi_material_group');
      if (hasCustomBeforeRender(object)) return fallback('custom_before_render_group');
      if (!resolved.resolved) return fallback('group_unresolved');
    }
    let mode = multi ? 'multi_material_group' : 'opaque';
    if (!multi) {
      if (classification.kind === 'dynamic') {
        if (classification.reason !== 'joint') return fallback(classification.reason ?? 'dynamic');
        mode = 'joint_common_opaque';
      } else if (classification.kind === 'mask') {
        mode = 'mask';
      } else if (classification.kind === 'unsupported') {
        return fallback(classification.reason ?? 'unsupported');
      } else if (classification.kind !== 'opaque') {
        return fallback(classification.reason ?? classification.kind ?? 'unsupported');
      }
    } else if (classification.kind !== 'unsupported' || classification.reason !== 'multi_material') {
      return fallback(classification.reason ?? classification.kind ?? 'unsupported');
    }
    if (classification.kind === 'mask' || source.alphaTest > 0 || source.userData?.sourceMaterial?.alphaMode === 'MASK') {
      if (source.depthWrite === false || source.depthTest === false) return fallback('depth_state');
      const mask = this.maskMaterial(source);
      if (mask) return { material: mask, mode: multi ? 'mask_multi_material_group' : 'mask', reason: null };
      return fallback(this.maskRejection(source) ?? 'mask_unavailable');
    }
    if (source.shadow) return fallback('custom_shadow_hook');
    if (!isStandardStaticVertex(source)) return fallback('custom_vertex');
    if (source.depthWrite === false || source.depthTest === false) return fallback('depth_state');
    if ((source.topology ?? 'triangle-list') !== 'triangle-list') return fallback('non_triangle_topology');
    if (!object?.geometry?.attributes?.position) return fallback('no_position');
    if (object.geometry.attributes.position.itemSize !== 3) return fallback('position_item_size');
    return { material: this.opaqueMaterial(source.side ?? 'front', 'triangle-list'), mode, reason: null };
  }

  transform(lists, pass, fast = null) {
    const beforeOpaque = lists.opaque.length, beforeTransparent = lists.transparent.length;
    const fastSkipped = fast?.stats.skipped ?? 0;
                                                                             
                                                                              
    const before = beforeOpaque + beforeTransparent + fastSkipped;
    const outOpaque = [], outTransparent = [];
    const active = fast ? fast.active : new Set();
                                                                             
                                                                               
                                                                               
    const tainted = fast?.tainted ?? this.taintedBatches(lists, pass);
    let nativeBatchItems = 0;
    let removedSources = fastSkipped, glassSkipped = 0, transparentSkipped = 0, replaced = 0, maskReplaced = 0, skipped = 0;
    let unifiedItems = 0, maskItems = 0, fallbackItems = 0, fallbackTriangles = 0;
    const fallbackReasons = Object.create(null);
    const fallbackReasonTriangles = Object.create(null);
    const noteFallbackItem = (reason, item) => {
      const triangles = itemTriangleCount(item);
      fallbackItems++;
      fallbackTriangles += triangles;
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      fallbackReasonTriangles[reason] = (fallbackReasonTriangles[reason] ?? 0) + triangles;
    };
    for (const item of [...lists.opaque, ...lists.transparent]) {
      const object = item.object;
      if (!object?.isMesh) { outOpaque.push(item); continue; }
      const batches = this.batchesByObject.get(object);
                                                                              
                                                                               
                                                                             
                                                                               
                                                       
      if (fast?.keep?.has(object) || batches?.some((batch) => tainted.has(batch))) {
        (item.material?.transparent ? outTransparent : outOpaque).push(item);
        nativeBatchItems++;
        continue;
      }
      if (this.consumed.has(object)) {
        if (batches?.length) {
          for (const batch of batches) active.add(batch);
          if (!fast) removedSources++;
          continue;
        }
                                                                              
                                                                 
      }
      if (item.material?.userData?.apsShadowUnifiedDepth) { outOpaque.push(item); continue; }
      const info = classifyObject(object);
      if (info.kind === 'managed') {
        (item.material?.transparent ? outTransparent : outOpaque).push(item);
        continue;
      }
      const resolved = itemSourceMaterial(object, item);
      const material = item.material ?? resolved.material;
      const glass = glassInfo(material);
      if (glass.glass || material?.transparent === true) {
        if (material?.transparent === true || glass.reason === 'transparent' || glass.reason === 'blend') transparentSkipped++;
        else glassSkipped++;
        continue;
      }
      const decision = this.depthMaterialFor(object, material, item, info);
      if (decision === SKIP) {
                                                                                
                                                                     
        if (glassInfo(material).glass || material?.transparent === true) {
          if (material?.transparent === true) transparentSkipped++;
          else glassSkipped++;
        } else {
          noteFallbackItem('unexpected_skip', item);
          if (material) (material.transparent ? outTransparent : outOpaque).push(item);
        }
        continue;
      }
      if (!decision?.material) { skipped++; continue; }
      if (decision.mode === 'managed' || decision.mode === 'already') {
        (decision.material.transparent ? outTransparent : outOpaque).push(item);
        continue;
      }
      if (decision.mode === 'fallback') noteFallbackItem(decision.reason ?? 'fallback', item);
      else if (decision.material.userData?.opacityMode === 'mask') maskItems++;
      else unifiedItems++;
      const replacement = decision.material;
      if (replacement !== item.material) {
        item.material = replacement;
        item.pipeKey = replacement.id;
        replaced++;
        if (replacement.userData?.opacityMode === 'mask') maskReplaced++;
      }
      (replacement.transparent ? outTransparent : outOpaque).push(item);
    }
    let culled = 0, appended = 0;
    const viewProj = viewProjection(pass.camera);
    const append = this.renderer.precompiling ? this.batches.slice() : [...active];
    for (const batch of append) {
      if (tainted.has(batch)) continue;
      if (!this.renderer.precompiling && !active.has(batch)) continue;
      if (!this.renderer.precompiling && !boxInClipVolume(batch.worldBox, viewProj)) { culled++; continue; }
      outOpaque.push(fast?.items.get(batch) ?? this.itemForBatch(batch, pass));
      appended++;
    }
                                                                            
    outOpaque.sort((a, b) => (a.renderOrder - b.renderOrder) || (a.pipeKey - b.pipeKey) || (a.z - b.z));
    lists.opaque = outOpaque;
    lists.transparent = outTransparent;
    const after = outOpaque.length + outTransparent.length;
    const stat = {
      frame: this.viewer?.frame ?? this.localFrame,
      label: pass.label ?? 'shadow',
      precompile: this.renderer.precompiling === true,
      before, after, removed: before - after,
      source_before_opaque: beforeOpaque, source_before_transparent: beforeTransparent,
      removed_sources: removedSources, appended_batches: appended, culled_batches: culled,
      glass_skipped: glassSkipped, transparent_skipped: transparentSkipped,
      opaque_replaced: replaced - maskReplaced, mask_replaced: maskReplaced, mask_skipped: 0,
      unified_items: unifiedItems, mask_items: maskItems,
      fallback_original_items: fallbackItems, fallback_original_triangles: fallbackTriangles,
      fallback_original_reasons: fallbackReasons,
      missing_material_items: skipped, skipped_no_material: skipped,
      fast_path: !!fast,
      fast_skipped_items: fastSkipped, fast_culled_source_items: fast?.stats.culled ?? 0,
      fast_filtered_source_items: fast?.stats.filtered ?? 0,
      fast_kept_source_items: fast?.keep?.size ?? 0,
      fast_activated_batches: fast ? active.size : 0,
      tainted_batches: tainted.size,
      native_batch_items: nativeBatchItems,
    };
    this.passStats.push(stat);
    if (this.passStats.length > 24) this.passStats.shift();
    if (fast) this.lastFast = {
      frame: stat.frame, label: stat.label,
      skipped: fast.stats.skipped, culled: fast.stats.culled, filtered: fast.stats.filtered,
      activated: fast.stats.activated, tainted: fast.stats.tainted, appended, after,
    };
    this.lastItemFallbacks = {
      frame: stat.frame, label: stat.label, precompile: stat.precompile,
      items: fallbackItems, triangles: fallbackTriangles,
      reasons: { ...fallbackReasons }, reason_triangles: { ...fallbackReasonTriangles },
    };
    if (!this.renderer.precompiling) {
      this.aggregate.passes++;
      this.aggregate.before += before;
      this.aggregate.after += after;
      this.aggregate.removed += stat.removed;
      this.aggregate.appended_batches += appended;
      this.aggregate.culled_batches += culled;
      this.aggregate.glass_skipped += glassSkipped;
      this.aggregate.transparent_skipped += transparentSkipped;
      this.aggregate.opaque_replaced += stat.opaque_replaced;
      this.aggregate.mask_replaced += maskReplaced;
      this.aggregate.skipped_no_material += skipped;
      this.aggregate.unified_items += unifiedItems;
      this.aggregate.mask_items += maskItems;
      this.aggregate.fallback_original_items += fallbackItems;
      this.aggregate.fallback_original_triangles += fallbackTriangles;
      this.aggregate.missing_material_items += skipped;
      this.aggregate.tainted_batches += tainted.size;
      this.aggregate.native_batch_items += nativeBatchItems;
      if (fast) {
        this.aggregate.fast_path_passes++;
        this.aggregate.fast_skipped_items += fastSkipped;
        this.aggregate.fast_culled_source_items += fast.stats.culled;
        this.aggregate.fast_activated_batches += active.size;
        this.fastSkippedTotal += fastSkipped;
      }
      this.itemFallbackCount += fallbackItems;
      this.itemFallbackTriangleCount += fallbackTriangles;
      for (const reason of Object.keys(fallbackReasons)) {
        this.itemFallbackReasons[reason] = (this.itemFallbackReasons[reason] ?? 0) + fallbackReasons[reason];
        this.itemFallbackTriangles[reason] = (this.itemFallbackTriangles[reason] ?? 0) + fallbackReasonTriangles[reason];
      }
    }
    return lists;
  }

  itemForBatch(batch, pass) {
    const center = boxCenter(batch.worldBox);
    const eye = pass.camera?.position;
    const z = eye && Number.isFinite(eye.x) ? (eye.x - center[0]) ** 2 + (eye.y - center[1]) ** 2 + (eye.z - center[2]) ** 2 : 0;
    return { object: batch.mesh, geometry: batch.mesh.geometry, material: batch.material, start: 0, count: Infinity, z, renderOrder: 0, pipeKey: batch.material.id };
  }

  markUnassigned(object, reason) {
    if (!this.unassignedReason.has(object)) this.unassignedReason.set(object, reason);
  }

  noteFallback(reason, object) {
    this.fallbackReasons[reason] = (this.fallbackReasons[reason] ?? 0) + 1;
    this.fallbackTriangles[reason] = (this.fallbackTriangles[reason] ?? 0) + triangleCount(object);
  }

  noteManaged(reason, object) {
    this.managedReasons[reason] = (this.managedReasons[reason] ?? 0) + 1;
    this.fallbackTriangles[`managed:${reason}`] = (this.fallbackTriangles[`managed:${reason}`] ?? 0) + triangleCount(object);
  }

  disposeBatches() {
    for (const batch of this.batches) {
      if (batch.kind === 'merged') {
        try { batch.geometry.dispose(); } catch {                        }
      } else if (batch.mesh?.instanceMatrix) {
        this.releaseInstanceBuffer(batch);
      }
      try { batch.mesh?.dispose?.(); } catch {                        }
    }
    this.batches = [];
    this.batchesByObject = new WeakMap();
    this.consumed = new WeakSet();
    this.needsRebuild = false;
  }

  releaseInstanceBuffer(batch) {
    const record = this.renderer.geometries?.get?.(batch.geometry);
    if (!record?.buffers?.has?.(batch.mesh.instanceMatrix)) return;
    const cached = record.buffers.get(batch.mesh.instanceMatrix);
    record.buffers.delete(batch.mesh.instanceMatrix);
    const destroy = () => { try { cached?.buffer?.destroy?.(); } catch {                         } };
    const queue = this.GPU?.queue ?? this.renderer?.GPU?.queue;
    if (queue?.onSubmittedWorkDone) queue.onSubmittedWorkDone().then(destroy, destroy);
    else destroy();
  }

  dispose() {
    if (this.disposed) return this;
    this.disposed = true;
    this.disposeBatches();
    for (const material of this.opaqueMaterials.values()) {
      try { material.dispose(); material.uniformBlock?.buffer?.destroy?.(); } catch {                        }
    }
    this.opaqueMaterials.clear();
    for (const material of this.maskMaterialList) {
      try { material.dispose(); material.uniformBlock?.buffer?.destroy?.(); } catch {                        }
    }
    this.maskMaterialList.length = 0;
    this.maskMaterials = new WeakMap();
    this.coverageIds = new WeakMap();
    this.coverageSerial = 0;
    if (this.hadOwnCollect) this.renderer.collect = this.previousOwnCollect;
    else delete this.renderer.collect;
    if (this.renderer.__apsShadowUnified === this) delete this.renderer.__apsShadowUnified;
    if (globalThis.__APS_SHADOW_UNIFIED__ === this) delete globalThis.__APS_SHADOW_UNIFIED__;
    this.tracked.length = 0;
    this.candidates.length = 0;
    this.scene = null;
    this.viewer = null;
    return this;
  }

  metadata() {
    const fallbackObjects = Object.values(this.fallbackReasons).reduce((sum, value) => sum + value, 0);
    const managedObjects = Object.values(this.managedReasons).reduce((sum, value) => sum + value, 0);
    return {
      schema: SHADOW_UNIFIED_SCHEMA,
      version: this.version,
      enabled: this.enabled,
      disposed: this.disposed,
      broken: this.broken,
      error_count: this.errorCount,
      last_error: this.lastError,
      last_mask_error: this.lastMaskError ?? null,
      fast_path: {
        enabled: this.fastPathEnabled,
        active: this.fastPathActive,
        disabled_reason: this.fastPathDisabledReason,
        recovery_count: this.fastRecoveryCount,
        skipped_items_since_install: this.fastSkippedTotal,
        last_pass: this.lastFast ? { ...this.lastFast } : null,
        policy: 'prepare registry before collect; skip only current consumed sources after mirroring visible/parent/layer/filter/castShadow/cull/material.visible/precompile/onBeforeRender checks; if any batch member is filtered or ineligible, the whole batch reverts to per-source native items in both fast and legacy paths; any error falls back to the exact original collect + transform',
      },
      rebuild: { count: this.rebuildCount, reason: this.rebuildReason, revision: this.revision, frame: this.preparedFrame, scene_children: this.sceneChildCount },
      policy: {
        opaque: 'depth-only implicit alpha 1; no fragment, no source PBR modules/bindings',
        opacity_mask: 'only source coverage texture/sampler/UV module + authored shadow opacity hook; discard below source cutoff',
        glass: 'KHR transmission/volume, authoring transmission, transparent/BLEND or water: the current item is skipped from shadow only',
        multi_material: 'geometry.groups + item.start/count select the current source material; only that glass/transparent group is skipped, never the whole object',
        managed: 'DEM solar cells, vegetation LOD/wind/alphaUV and grass keep their own depth programs',
        fallbacks: 'only glass/transparent current items are skipped; deformed/skinned/custom vertex or shadow hook, unavailable mask, layer_not_opaque, unresolved group and depthWrite/depthTest=false keep the exact renderer.collect item.material and are counted, never claimed unified',
        depth_state: 'depthWrite=false/depthTest=false are never forced to true; the original item material and depth state are retained',
        joint: 'rigid joint items may use the common opaque depth material; otherwise the original item material keeps their dynamic shadow',
        main_pass: 'not touched; batch nodes are not in the scene',
      },
      fallback_policy: {
        skip_only: ['glass', 'transparent'],
        ununified: 'keep renderer.collect item.material unchanged, mode=fallback, counted in depth_fallbacks',
        unified_claim: 'only items counted in aggregate.unified_items/mask_items use a unified depth material',
        multi_material: 'per-group decision; one glass group cannot remove opaque sibling groups',
      },
      counts: {
        ...this.counts,
        fallback_objects: fallbackObjects,
        managed_objects: managedObjects,
        batch_draws: this.batches.length,
        expected_draw_reduction: this.counts.batched_source_objects - this.batches.length,
      },
      fallback_reasons: { ...this.fallbackReasons },
      fallback_triangles: { ...this.fallbackTriangles },
      managed_reasons: { ...this.managedReasons },
      depth_fallbacks: {
        cumulative_items: this.itemFallbackCount,
        cumulative_triangles: this.itemFallbackTriangleCount,
        reasons: { ...this.itemFallbackReasons },
        triangles: { ...this.itemFallbackTriangles },
        last_pass: { ...this.lastItemFallbacks, reasons: { ...this.lastItemFallbacks.reasons }, reason_triangles: { ...this.lastItemFallbacks.reason_triangles } },
      },
      limits: { ...this.config },
      batches: this.batches.slice(0, 64).map((batch) => ({
        kind: batch.kind,
        name: batch.mesh?.name ?? null,
        sources: batch.sourceObjects.size,
        instances: batch.entries.length,
        vertices: batch.vertices,
        triangles: batch.triangles,
        side: batch.material?.side ?? null,
        pivot: batch.pivot.map((value) => Number(value.toFixed(3))),
        world_box: { min: batch.worldBox.min.map((value) => Number(value.toFixed(3))), max: batch.worldBox.max.map((value) => Number(value.toFixed(3))) },
      })),
      batches_truncated: Math.max(0, this.batches.length - 64),
      passes: this.passStats.slice(-12),
      aggregate: { ...this.aggregate },
    };
  }

                                                                           
                                                                           
  summary() {
    return {
      schema: SHADOW_UNIFIED_SCHEMA,
      version: this.version,
      enabled: this.enabled,
      disposed: this.disposed,
      broken: this.broken,
      error_count: this.errorCount,
      last_error: this.lastError,
      fast_path: {
        enabled: this.fastPathEnabled,
        active: this.fastPathActive,
        disabled_reason: this.fastPathDisabledReason,
        recovery_count: this.fastRecoveryCount,
        skipped_items: this.fastSkippedTotal,
      },
      rebuild: { count: this.rebuildCount, reason: this.rebuildReason, revision: this.revision, frame: this.preparedFrame },
      counts: {
        cast_shadow_meshes: this.counts.cast_shadow_meshes,
        batchable_candidates: this.counts.batchable_candidates,
        batched_source_objects: this.counts.batched_source_objects,
        batched_source_instances: this.counts.batched_source_instances,
        batch_draws: this.batches.length,
        expected_draw_reduction: this.counts.batched_source_objects - this.batches.length,
        fallback_objects: Object.values(this.fallbackReasons).reduce((sum, value) => sum + value, 0),
        managed_objects: Object.values(this.managedReasons).reduce((sum, value) => sum + value, 0),
      },
      fallback_reasons: { ...this.fallbackReasons },
      managed_reasons: { ...this.managedReasons },
      depth_fallbacks: {
        cumulative_items: this.itemFallbackCount,
        last_pass_items: this.lastItemFallbacks.items,
        last_pass_reasons: { ...this.lastItemFallbacks.reasons },
      },
      aggregate: { ...this.aggregate },
    };
  }
}

                                                                              
                         

export function classifyObject(object) {
  if (!object?.isMesh || !object.geometry) return { kind: 'unsupported', reason: 'not_mesh' };
  const material = object.material;
  if (!material) return { kind: 'unsupported', reason: 'no_material' };
  const userData = object.userData ?? {};
  if (userData.apsShadowOnly === true) return { kind: 'managed', reason: 'terrain_solar_cells' };
  if (userData.apsTerrainOccluder === true) return { kind: 'managed', reason: 'terrain_occluder' };
  if (isVegetation(object, material)) return { kind: 'managed', reason: 'vegetation' };
  if (Array.isArray(material)) return { kind: 'unsupported', reason: 'multi_material' };
  if (object.layers && ((object.layers.mask ?? 1) & 1) === 0) return { kind: 'unsupported', reason: 'layer_not_opaque' };
  const glass = glassInfo(material);
  if (glass.glass) return { kind: 'glass', reason: glass.reason };
  if (material.transparent === true) return { kind: 'transparent', reason: 'transparent' };
  if (isDeformed(object)) return { kind: 'dynamic', reason: 'deformed' };
  if (hasCustomBeforeRender(object)) return { kind: 'dynamic', reason: 'custom_before_render' };
  if (material.alphaTest > 0 || material.userData?.sourceMaterial?.alphaMode === 'MASK') return { kind: 'mask', reason: 'opacity_mask' };
  if (isJointSubtree(object)) return { kind: 'dynamic', reason: 'joint' };
  if (material.shadow) return { kind: 'unsupported', reason: 'custom_shadow_hook' };
  if (!isStandardStaticVertex(material)) return { kind: 'unsupported', reason: 'custom_vertex' };
  if (material.depthWrite === false || material.depthTest === false) return { kind: 'unsupported', reason: 'depth_state' };
  if (material.visible === false) return { kind: 'unsupported', reason: 'material_hidden' };
  const geometry = object.geometry;
  if (!geometry.attributes?.position) return { kind: 'unsupported', reason: 'no_position' };
  if (geometry.attributes.position.itemSize !== 3) return { kind: 'unsupported', reason: 'position_item_size' };
  if ((material.topology ?? 'triangle-list') !== 'triangle-list') return { kind: 'unsupported', reason: 'non_triangle_topology' };
  if (geometry.groups?.length) return { kind: 'unsupported', reason: 'geometry_groups' };
  const range = geometry.drawRange;
  if (range && (range.start !== 0 || range.count !== Infinity)) return { kind: 'unsupported', reason: 'draw_range' };
  if (geometry.indirect) return { kind: 'unsupported', reason: 'indirect_draw' };
  if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length) return { kind: 'dynamic', reason: 'morph' };
  if (geometry.instanceCount > 1 && !object.isInstancedMesh) return { kind: 'unsupported', reason: 'geometry_instances' };
  const indexCount = geometry.index?.count ?? geometry.attributes.position.count;
  if (!Number.isFinite(indexCount) || indexCount < 3 || indexCount % 3 !== 0) return { kind: 'unsupported', reason: 'non_triangle_topology' };
  if (object.isInstancedMesh) {
    if (!Number.isInteger(object.count) || object.count <= 0) return { kind: 'unsupported', reason: 'invalid_instance_count' };
    if (!object.instanceMatrix?.array) return { kind: 'unsupported', reason: 'invalid_instance_matrix' };
  }
  return { kind: 'opaque', reason: 'opaque' };
}

export function glassInfo(material) {
  if (!material) return { glass: false };
  if (material.isWaterMaterial) return { glass: true, reason: 'water' };
  const userData = material.userData ?? {};
  const defs = Array.isArray(userData.sourceMaterials) ? userData.sourceMaterials : [userData.sourceMaterial ?? material];
  for (const definition of defs) {
    if (!definition) continue;
    const extensions = definition.extensions ?? {};
    const principled = definition.extras?.principled ?? {};
    const transmission = Number(extensions.KHR_materials_transmission?.transmissionFactor ?? principled.transmission ?? userData.transmission ?? 0);
    if (Number.isFinite(transmission) && transmission > 1e-6) return { glass: true, reason: 'transmission' };
    if (extensions.KHR_materials_volume) return { glass: true, reason: 'volume' };
  }
  for (const value of [userData.transmission, userData.apsTransmission]) {
    if (value === true) return { glass: true, reason: 'transmission' };
    if (Number.isFinite(Number(value)) && Number(value) > 1e-6) return { glass: true, reason: 'transmission' };
  }
  if (material.transparent === true) return { glass: true, reason: 'transparent' };
  const definition = userData.sourceMaterial ?? defs[0];
  if (definition?.alphaMode === 'BLEND') return { glass: true, reason: 'blend' };
  return { glass: false };
}

                                                                                
                                                                                
                                                                                
                                                                               
                                                                          
export function itemSourceMaterial(object, item = null) {
  const current = item?.material ?? null;
  const materials = object?.material;
  if (!Array.isArray(materials)) {
    return { material: current ?? materials ?? null, multi: false, resolved: true, group_index: -1, group_start: null, group_count: null };
  }
  const geometry = object?.geometry;
  const groups = geometry?.groups;
  const range = geometry?.drawRange ?? { start: 0, count: Infinity };
  const rangeStart = Number.isFinite(range.start) ? range.start : 0;
  const rangeEnd = Number.isFinite(range.count) ? rangeStart + range.count : Infinity;
  if (Array.isArray(groups) && item && Number.isFinite(item.start) && Number.isFinite(item.count)) {
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (!group) continue;
      const start = Math.max(group.start, rangeStart);
      const end = Math.min(group.start + group.count, rangeEnd);
      if (end <= start || item.start !== start || item.count !== end - start) continue;
      const groupMaterial = materials[group.materialIndex] ?? null;
      return {
        material: current ?? groupMaterial,
        group_material: groupMaterial,
        multi: true,
        resolved: groupMaterial != null && (current == null || current === groupMaterial),
        group_index: index,
        group_start: start,
        group_count: end - start,
      };
    }
  }
  return { material: current ?? materials[0] ?? null, multi: true, resolved: false, group_index: -1, group_start: null, group_count: null };
}

function itemTriangleCount(item) {
  const geometry = item?.geometry ?? item?.object?.geometry;
  const total = geometry?.index?.count ?? geometry?.attributes?.position?.count ?? 0;
  const start = Number.isFinite(item?.start) ? item.start : 0;
  const available = Math.max(0, total - start);
  const count = Number.isFinite(item?.count) ? Math.min(item.count, available) : total;
  const instances = item?.object?.isInstancedMesh ? Math.max(1, item.object.count ?? 1) : 1;
  return Math.max(0, count) / 3 * instances;
}

function isVegetation(object, material) {
  if (material?.userData?.apsVegetationManaged) return true;
  for (let node = object; node; node = node.parent) {
    const data = node.userData ?? {};
    if (data.apsVegetationManaged || data.aps_vegetation_lods || data.aps_vegetation_source || data.apsGrassGenerated || data.apsGrassViewCamera) return true;
  }
  return false;
}

function isJointSubtree(object) {
  for (let node = object; node; node = node.parent) {
    const data = node.userData ?? {};
    if (data.aps_joint === true || data.joint === true || data.aps_dynamic_joint === true || data.aps_articulation_joint === true) return true;
    if (typeof node.name === 'string' && node.name.startsWith('joint__')) return true;
  }
  return false;
}

function isDeformed(object) {
  if (object.isSkinnedMesh || object.userData?.aps_deformed || object.userData?.aps_skinned) return true;
  const morphs = object.geometry?.morphAttributes;
  return !!(morphs && Object.keys(morphs).length);
}

function isStandardStaticVertex(material) {
  if (!material) return false;
  if (typeof material.vertex !== 'string' || material.vertex.length === 0) return true;
  if (material.userData?.materialAdapter !== 'aps-native-webgpu/1') return false;
  return !/frame\s*\.\s*(?:time|dt)|apsWind|sway|wind|morph|skin/i.test(material.vertex);
}

function hasCustomBeforeRender(object) {
  const own = object.onBeforeRender;
  if (typeof own !== 'function') return false;
  let proto = Object.getPrototypeOf(object);
  while (proto) {
    if (Object.prototype.hasOwnProperty.call(proto, 'onBeforeRender')) return own !== proto.onBeforeRender;
    proto = Object.getPrototypeOf(proto);
  }
  return true;
}

                                                                              
                          

function chainOf(object) {
  const chain = [];
  for (let node = object; node; node = node.parent) {
    chain.push(node);
    if (node.parent === node) break;
  }
  return chain;
}

const LOCAL_VALUES_PER_NODE = 27;

                                                                               
                                                                             
                                                                   
function captureLocalChain(chain, target = null) {
  const size = chain.length * LOCAL_VALUES_PER_NODE;
  const out = target && target.length === size ? target : new Array(size);
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const o = i * LOCAL_VALUES_PER_NODE;
    out[o] = node.position.x; out[o + 1] = node.position.y; out[o + 2] = node.position.z;
    out[o + 3] = node.quaternion.x; out[o + 4] = node.quaternion.y;
    out[o + 5] = node.quaternion.z; out[o + 6] = node.quaternion.w;
    out[o + 7] = node.scale.x; out[o + 8] = node.scale.y; out[o + 9] = node.scale.z;
    out[o + 10] = node.matrixAutoUpdate === false ? 0 : 1;
    if (node.matrixAutoUpdate === false) {
      const m = node.matrix?.elements;
      for (let k = 0; k < 16; k++) out[o + 11 + k] = m ? m[k] : 0;
    }
  }
  return out;
}

function localChainChanged(record) {
  const chain = record.chain, snapshot = record.local;
  if (!snapshot || snapshot.length !== chain.length * LOCAL_VALUES_PER_NODE) return true;
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const o = i * LOCAL_VALUES_PER_NODE;
    if (node.position.x !== snapshot[o] || node.position.y !== snapshot[o + 1] || node.position.z !== snapshot[o + 2]) return true;
    if (node.quaternion.x !== snapshot[o + 3] || node.quaternion.y !== snapshot[o + 4]
      || node.quaternion.z !== snapshot[o + 5] || node.quaternion.w !== snapshot[o + 6]) return true;
    if (node.scale.x !== snapshot[o + 7] || node.scale.y !== snapshot[o + 8] || node.scale.z !== snapshot[o + 9]) return true;
    const auto = node.matrixAutoUpdate === false ? 0 : 1;
    if (auto !== snapshot[o + 10]) return true;
    if (auto === 0) {
      const m = node.matrix?.elements;
      for (let k = 0; k < 16; k++) if ((m ? m[k] : 0) !== snapshot[o + 11 + k]) return true;
    }
  }
  return false;
}

function rootOf(object) {
  let node = object;
  while (node?.parent && node.parent !== node) node = node.parent;
  return node;
}

function finiteMatrix(elements) {
  if (!elements || elements.length < 16) return false;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(elements[i])) return false;
  return true;
}

function matrixChanged(a, b) {
  if (!a || !b || a.length < 16 || b.length < 16) return true;
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return true;
  return false;
}

function matrixWorldFor(object, instanceIndex) {
  const world = object?.matrixWorld?.elements;
  if (!world || instanceIndex === null) return world ?? null;
  const matrices = object.instanceMatrix?.array;
  if (!matrices || matrices.length < (instanceIndex + 1) * 16) return null;
  return multiplyMatrix(world, matrices, instanceIndex * 16);
}

function multiplyMatrix(a, b, offset = 0) {
  if (!a || !b || a.length < 16 || b.length < offset + 16) return null;
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value += a[k * 4 + row] * b[offset + col * 4 + k];
      out[col * 4 + row] = value;
    }
  }
  return out;
}

function translateMatrix(x, y, z) {
  const out = new Float32Array(16);
  out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function tileKey(matrix, size) {
  return `${Math.floor(matrix[12] / size)}:${Math.floor(matrix[14] / size)}`;
}

function geometryBounds(geometry, cache) {
  if (!geometry) return null;
  if (cache?.has(geometry)) return cache.get(geometry);
  if (typeof geometry.computeBoundingBox === 'function') geometry.computeBoundingBox();
  if (geometry.boundingBox) {
    const box = { min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray() };
    if (box.min.every(Number.isFinite) && box.max.every(Number.isFinite)) {
      cache?.set(geometry, box);
      return box;
    }
  }
  const pos = geometry.attributes?.position;
  if (!pos?.count) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  const box = { min, max };
  cache?.set(geometry, box);
  return box;
}

function transformAabb(box, matrix) {
  if (!box) return null;
  const corners = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push(transformPoint(matrix, x, y, z));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of corners) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, max };
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { min: a.min.map((value, i) => Math.min(value, b.min[i])), max: a.max.map((value, i) => Math.max(value, b.max[i])) };
}

function boxCenter(box) {
  return [(box.min[0] + box.max[0]) * 0.5, (box.min[1] + box.max[1]) * 0.5, (box.min[2] + box.max[2]) * 0.5];
}

function instancedWorldBox(geometry, entries, pivot) {
  const cache = new Map();
  const box = geometryBounds(geometry, cache);
  if (!box) return { min: pivot.slice(), max: pivot.slice() };
  let world = null;
  for (const entry of entries) {
    const local = multiplyMatrix(translateMatrix(-pivot[0], -pivot[1], -pivot[2]), entry.world);
    const transformed = transformAabb(box, local);
    world = world ? unionBox(world, transformed) : transformed;
  }
  if (!world) return { min: pivot.slice(), max: pivot.slice() };
  return { min: world.min.map((value, i) => value + pivot[i]), max: world.max.map((value, i) => value + pivot[i]) };
}

function writeLocalMatrix(batch, entry, world) {
  const local = multiplyMatrix(translateMatrix(-batch.pivot[0], -batch.pivot[1], -batch.pivot[2]), world);
  batch.mesh.instanceMatrix.array.set(local, entry.index * 16);
}

function emptyCounts() {
  return {
    cast_shadow_meshes: 0,
    batchable_candidates: 0,
    hidden_batchable: 0,
    batched_source_objects: 0,
    batched_source_instances: 0,
    batched_triangles: 0,
    batch_draws: 0,
    atlas_batches: 0,
    instanced_batches: 0,
    atlas_vertices: 0,
    atlas_indices: 0,
    expected_draw_reduction: 0,
    dynamic_evicted: 0,
    mask_objects: 0,
    glass_objects: 0,
    managed_objects: 0,
    opaque_materials: 0,
    mask_materials: 0,
  };
}

function triangleCount(object) {
  const geometry = object?.geometry;
  if (!geometry) return 0;
  const count = geometry.index?.count ?? geometry.attributes?.position?.count ?? 0;
  const base = count / 3;
  const instances = object.isInstancedMesh ? Math.max(1, object.count ?? 1) : 1;
  return base * instances;
}

function viewProjection(camera) {
  const projection = camera?.projectionMatrix?.elements;
  const inverse = camera?.matrixWorldInverse?.elements;
  if (!finiteMatrix(projection) || !finiteMatrix(inverse)) return null;
  return multiplyMatrix(projection, inverse);
}
