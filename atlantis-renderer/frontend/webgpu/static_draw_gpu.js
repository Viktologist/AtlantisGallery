                                        
  
                                                                     
                                                                             
                                                                               
                                                                              
                                                                          
                                                                                
  
                                                                                
                                                                             
                                                                                 
                                                                                 
                                 
                                                                            
                                                                       

import { GPU, UniformBlock, StorageBuffer, ComputeKernel, Texture, FrameUniforms, readBuffer } from '../../vendor/tidewater/src/engine/webgpu.js';
import {STATIC_OCCLUSION_WGSL} from './static_occlusion_wgsl.js';
import { BufferGeometry, BufferAttribute, InstancedBufferAttribute } from '../../vendor/tidewater/src/engine/index.js';
import {
  STATIC_DRAW_VIEW_LIMIT, STATIC_DRAW_ID_REGIONS, STATIC_CHUNK_MAX_TRIANGLES,
  frustumPlanes, staticDrawEligibility, buildChunkedIndex, instanceSourceData,
  matrixElements, matrixSnapshot, sameMatrixSnapshot, transformPoint,
} from './static_draw_gpu_plan.js';

const WORKGROUP = 64;

export const INSTANCE_CULL_WGSL = STATIC_OCCLUSION_WGSL+`
fn apsStaticAabbVisible(center: vec3f, extents: vec3f) -> bool {
  var planes = array<vec4f, 6>(view.p0, view.p1, view.p2, view.p3, view.p4, view.p5);
  for (var i = 0u; i < 6u; i = i + 1u) {
    let plane = planes[i];
    if (dot(plane.xyz, center) + plane.w + dot(abs(plane.xyz), extents) < -0.0001) { return false; }
  }
  return true;
}

@compute @workgroup_size(WG_X, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let bmin = sourceBounds[i * 2u].xyz;
  let bmax = sourceBounds[i * 2u + 1u].xyz;
  let center = (bmin + bmax) * 0.5;
  let extents = (bmax - bmin) * 0.5;
  if (!apsStaticAabbVisible(center, extents)) { return; }
  if (apsStaticOccluded(bmin,bmax,terrainHiZ,view.vp,view.screen.xy)) { return; }
  if (apsStaticOccluded(bmin,bmax,solidHiZ,view.vp,view.screen.xy)) { return; }
  let slot = atomicAdd(&counter, 1u);
  if (slot >= params.count) { return; }
  compactMatrices[slot] = sourceMatrices[i];
  instanceIds[params.idBase + slot] = i;
}
`;

export const INSTANCE_FINALIZE_WGSL = `
@compute @workgroup_size(1, 1, 1)
fn main() {
  let count = counter;
  commands[0] = params.indexCount;
  commands[1] = count;
  commands[2] = 0u;
  commands[3] = 0u;
  commands[4] = 0u;
}
`;

export const CHUNK_CULL_WGSL = `
fn apsStaticAabbVisible(center: vec3f, extents: vec3f) -> bool {
  var planes = array<vec4f, 6>(view.p0, view.p1, view.p2, view.p3, view.p4, view.p5);
  for (var i = 0u; i < 6u; i = i + 1u) {
    let plane = planes[i];
    if (dot(plane.xyz, center) + plane.w + dot(abs(plane.xyz), extents) < -0.0001) { return false; }
  }
  return true;
}

var<workgroup> outputBase: u32;
var<workgroup> outputCount: u32;
@compute @workgroup_size(WG_X, 1, 1)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let i = group.x;
  if (i >= params.chunkCount) { return; }
  let bmin = chunkBounds[i * 2u].xyz;
  let bmax = chunkBounds[i * 2u + 1u].xyz;
  let chunkInfo = chunkMeta[i];
  let visible = apsStaticAabbVisible((bmin + bmax) * 0.5, (bmax - bmin) * 0.5);
  if(lane==0u){
    outputCount=select(0u,chunkInfo.y,visible);
    outputBase=0u;
    if(visible){outputBase=atomicAdd(&commands[0],chunkInfo.y);}
  }
  workgroupBarrier();
  for(var j=lane;j<outputCount;j+=WG_X){
    visibleIndices[outputBase+j]=sourceIndices[chunkInfo.x+j];
  }
}
`;

function uniforms(name) {
  return new UniformBlock(name, {
    count: 'u32', indexCount: 'u32', chunkCount: 'u32', idBase: 'u32',
    pad0: 'u32', pad1: 'u32', pad2: 'u32', pad3: 'u32',
    p0: 'vec4f', p1: 'vec4f', p2: 'vec4f', p3: 'vec4f', p4: 'vec4f', p5: 'vec4f',
    vp:'mat4x4f',screen:'vec4f',
  });
}

function destroyBuffer(buffer) {
  try { buffer?.destroy?.(); } catch {                        }
}

function storage(label, type, count, data = null, usage = []) {
  return new StorageBuffer({ label, type, count, data, usage });
}

function sameMatrix(snapshot, matrix) {
  return sameMatrixSnapshot(snapshot, matrix);
}

function makeProxyGeometry(source, { vertexOwner, indexOwner, indirect }) {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes ?? {})) geometry.setAttribute(name, attribute);
  if (indexOwner?.index) geometry.setIndex(indexOwner.index);
  geometry.userData = {
    ...(source.userData ?? {}),
    apsStaticVertexOwner: vertexOwner ?? source,
    apsStaticIndexOwner: indexOwner ?? source,
    aps_static_draw_proxy: true,
  };
  if (indirect) geometry.indirect = indirect;
  geometry.boundingBox = source.boundingBox ?? null;
  geometry.boundingSphere = source.boundingSphere ?? null;
  return geometry;
}

function makeProxyObject(source, geometry, instanceMatrix, count, drawParams) {
  return {
    isMesh: true, type: 'InstancedMesh', isInstancedMesh: true,
    geometry, material: source.material, count, instanceMatrix, instanceColor: null,
    matrixWorld: source.matrixWorld.clone(), matrixAutoUpdate: false,
    visible: true, layers: source.layers, userData: source.userData,
    castShadow: source.castShadow, receiveShadow: source.receiveShadow,
    drawParams, id: source.id,
  };
}

export class StaticDrawGPU {
  constructor(renderer) {
    this.renderer = renderer;
    this.requirePrepared=renderer?.requirePreparedDrawResources===true;
    this.enabled = true;
    this.disposed = false;
    this.prepared = false;
    this.lastFrame = null;
    this.viewStates = new Map();
    this.entries = new Map();
    this.entryList = new Set();
    this.kernels = null;
    this.dummy = null;
    this.budget = null;
    this.maxMergedMaterialStorage = 0;
    this.lastError = null;
    this.retired=[];
  }

  setEnabled(enabled) { this.enabled = !!enabled; return this.enabled; }

  metadata() {
    const views = [...this.viewStates.values()];
    return {
      schema: 'aps-static-draw-gpu/1',
      enabled: this.enabled,
      prepared: this.prepared,
      view_limit: STATIC_DRAW_VIEW_LIMIT,
      views: views.map((view) => ({ slot: view.slot, last_frame: view.lastFrame, camera: view.camera?.name ?? null })),
      entries: this.entryList.size,
      instance_entries: [...this.entryList].filter((entry) => entry.kind === 'instances').length,
      instance_count: [...this.entryList].filter((entry) => entry.kind === 'instances').reduce((n, entry) => n + entry.count, 0),
      chunk_entries: [...this.entryList].filter((entry) => entry.kind === 'chunks').length,
      chunk_count: [...this.entryList].filter((entry) => entry.kind === 'chunks').reduce((n, entry) => n + entry.chunks.length, 0),
      last_frame: this.lastFrame,
      budget: this.budget,
      last_error: this.lastError,
    };
  }

  ensure() {
    if (this.disposed) throw Error('StaticDrawGPU is disposed');
    if (!GPU.device) throw Error('StaticDrawGPU requires an initialized WebGPU device');
    if (!this.kernels) this._createKernels();
    return this;
  }

                                                                             
                                                                             
                                 
  prepare() {
    this.ensure();
    for (const kernel of [this.kernels.instanceCull, this.kernels.instanceFinalize, this.kernels.chunkCull]) {
      GPU.ready(kernel.handle);
      if (kernel.handle.failed) throw Error(`Static draw GPU kernel failed: ${kernel.handle.label}`);
    }
    this.prepared = true;
    this._recordBudget();
    return this;
  }

                                                                                
                                                                             
                                         
  prepareScene(scene,cameras=[]) {
    this.ensure();
    this.preparationErrors=new Map();
    if (!scene?.traverse) return this;
    scene.updateMatrixWorld?.(true);
    scene.traverse((object) => {
      if (!object.isMesh || !object.geometry || !object.material) return;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      const eligibility = staticDrawEligibility({ object, geometry: object.geometry, material });
      try {
        if(eligibility.mode==='fallback'&&this.entries.has(object))this._destroyEntry(this.entries.get(object));
        if(!object.userData?.apsVegetationSource&&!object.userData?.apsVegetationManaged&&!object.userData?.apsGrassGenerated){
          for(const attribute of Object.values(object.geometry.attributes??{}))this.renderer?._attributeBuffer?.(object.geometry,attribute);
          this.renderer?._indexBuffer?.(object.geometry);
          if(object.instanceMatrix)this.renderer?._attributeBuffer?.(object.geometry,object.instanceMatrix);
          if(object.instanceColor)this.renderer?._attributeBuffer?.(object.geometry,object.instanceColor);
        }
        if (eligibility.mode === 'instances') {
          const entry = this._ensureInstanceEntry(object, object.geometry);
          entry.sourceMatrices?.getGPU(); entry.sourceBounds?.getGPU();
          this.renderer?._indexBuffer?.(entry.geometry);
          for(const camera of cameras){const view=this._viewFor(camera);if(view)this._ensureInstanceView(entry,view);}
        } else if (eligibility.mode === 'chunks') {
          const entry = this._ensureChunkEntry(object, object.geometry);
          entry.chunkBounds?.getGPU(); entry.chunkMeta?.getGPU();entry.sourceIndices?.getGPU();
          for(const camera of cameras){const view=this._viewFor(camera);if(view)this._ensureChunkView(entry,view);}
        }
      } catch (error) {
        this.preparationErrors.set(object,String(error?.message??error));
        const partial = this.entries.get(object);
        if (partial && ((partial.kind === 'chunks' && !partial.chunks) || (partial.kind === 'instances' && !partial.sourceMatrices))) this._destroyEntry(partial);
        this.lastError = { message: String(error?.message ?? error), stage: 'prepare_scene', object: object.name ?? null };
      }
    });
    this.flushRetired();return this;
  }

  _createKernels() {
    const dummyUniform = uniforms('ApsStaticDummyCull');
    const dummyView=uniforms('ApsStaticView');
    const bounds = storage('aps static dummy bounds', 'vec4f', 2);
    const matrices = storage('aps static dummy matrices', 'mat4x4f', 1);
    const ids = storage('aps static dummy ids', 'u32', 1);
    const counter = storage('aps static dummy counter', 'u32', 1);
    const commands = storage('aps static dummy commands', 'u32', 5);
    const meta = storage('aps static dummy meta', 'vec4u', 1);
    const hiz=new Texture({width:1,height:1,format:'r32float',usage:['sample']});
    this.dummy = { uniform: dummyUniform, view:dummyView, bounds, matrices, ids, counter, commands, meta, hiz };
    const bindings = {
      params: { uniform: dummyUniform },
      view:{uniform:dummyView},
      sourceBounds: { storage: bounds, access: 'read', type: 'vec4f' },
      sourceMatrices: { storage: matrices, access: 'read', type: 'mat4x4f' },
      compactMatrices: { storage: matrices, access: 'read_write', type: 'mat4x4f' },
      instanceIds: { storage: ids, access: 'read_write', type: 'u32' },
      counter: { storage: counter, access: 'read_write', wgslType: 'atomic<u32>' },
      terrainHiZ:{texture:hiz,sampleType:'unfilterable-float'},
      solidHiZ:{texture:hiz,sampleType:'unfilterable-float'},
    };
    const instanceCull = new ComputeKernel({ label: 'aps static instance cull', bindings, code: INSTANCE_CULL_WGSL, workgroupSize: [WORKGROUP, 1, 1] });
    const finalize = new ComputeKernel({
      label: 'aps static instance finalize', workgroupSize: [1, 1, 1],
      bindings: {
        params: { uniform: dummyUniform },
        counter: { storage: counter, access: 'read', wgslType: 'u32' },
        commands: { storage: commands, access: 'read_write', type: 'u32' },
      },
      code: INSTANCE_FINALIZE_WGSL,
    });
    const chunkCull = new ComputeKernel({
      label: 'aps static chunk cull', workgroupSize: [WORKGROUP, 1, 1],
      bindings: {
        params: { uniform: dummyUniform },
        view: { uniform: dummyView },
        chunkBounds: { storage: bounds, access: 'read', type: 'vec4f' },
        chunkMeta: { storage: meta, access: 'read', type: 'vec4u' },
        sourceIndices: { storage: ids, access: 'read', type: 'u32' },
        visibleIndices: { storage: counter, access: 'read_write', type: 'u32' },
        commands: { storage: commands, access: 'read_write', wgslType: 'array<atomic<u32>>' },
      },
      code: CHUNK_CULL_WGSL,
    });
    this.kernels = { instanceCull, instanceFinalize: finalize, chunkCull };
  }

  _recordBudget() {
    const limits = GPU.limits ?? {};
    this.budget = {
      instance_cull_storage_buffers: this.kernels.instanceCull.bindings.names.length - 4,
      instance_finalize_storage_buffers: this.kernels.instanceFinalize.bindings.names.length - 1,
      chunk_cull_storage_buffers: this.kernels.chunkCull.bindings.names.length - 2,
      max_storage_buffers_per_shader_stage: limits.maxStorageBuffersPerShaderStage ?? null,
      max_storage_buffers_in_vertex_stage: limits.maxStorageBuffersInVertexStage ?? null,
      merged_material_storage_bindings: this.maxMergedMaterialStorage ?? null,
      merged_material_within_limit: this.maxMergedMaterialStorage == null ? null : this.maxMergedMaterialStorage <= (limits.maxStorageBuffersInVertexStage ?? limits.maxStorageBuffersPerShaderStage ?? 8),
    };
  }

  _viewFor(camera) {
    let view = this.viewStates.get(camera);
    if (view) { view.lastFrame = GPU.frame; return view; }
    if (this.viewStates.size >= STATIC_DRAW_VIEW_LIMIT) return null;
    view = { slot: this.viewStates.size, camera, lastFrame: GPU.frame,uniforms:uniforms('ApsStaticView') };
    this.viewStates.set(camera, view);
    return view;
  }

  _entryFor(object) { return this.entries.get(object) ?? null; }

  _remember(entry) {
    this.entries.set(entry.object, entry);
    this.entryList.add(entry);
    return entry;
  }

  _destroyEntry(entry) {
    if (!entry) return;
    for (const view of entry.views.values()) this._destroyView(view);
    entry.views.clear();
    this.retireResources([entry.sourceMatrices,entry.sourceBounds,entry.chunkBounds,entry.chunkMeta,entry.sourceIndices],entry.chunkGeometry);
    this.entries.delete(entry.object);
    this.entryList.delete(entry);
  }

                                                                             
                                                                          
  _invalidateViews(entry) {
    for (const view of entry.views.values()) this._destroyView(view);
    entry.views.clear();
  }

  _destroyView(view) {
    this.retireResources([view.compactMatrices,view.visibleIndices,view.counter,view.commands,view.params?.buffer],view.geometry);
  }
  retireResources(buffers,geometry=null){this.retired.push(()=>{for(const b of buffers)destroyBuffer(b);try{geometry?.dispose?.();}catch{}});}
  flushRetired(){if(!this.retired.length)return;const old=this.retired.splice(0),dispose=()=>{for(const fn of old)fn();};if(GPU.device&&GPU.queue?.onSubmittedWorkDone){GPU.submit();GPU.queue.onSubmittedWorkDone().then(dispose,dispose);}else dispose();}

  _ensureInstanceEntry(object, geometry) {
    let entry = this._entryFor(object);
    const count = object.count;
    if (entry && (entry.kind !== 'instances' || entry.geometry !== geometry || entry.count !== count || entry.material !== object.material)) {
      this._destroyEntry(entry);
      entry = null;
    }
    if (!entry) {
      entry = this._remember({ kind: 'instances', object, geometry, material: object.material, count, views: new Map(), version: null, matrixKey: null, sourceMatrices: null, sourceBounds: null });
    }
    const version = object.instanceMatrix?.version ?? 0;
    const matrixChanged = !entry.matrixKey || !sameMatrix(entry.matrixKey, object.matrixWorld);
    if (!entry.sourceMatrices || entry.version !== version || matrixChanged) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const source = instanceSourceData({ instanceMatrix: object.instanceMatrix, count, geometryBox: geometry.boundingBox, matrixWorld: object.matrixWorld });
      this._invalidateViews(entry);
      this.retireResources([entry.sourceMatrices,entry.sourceBounds]);
      entry.sourceMatrices = storage('aps static source instance matrices', 'mat4x4f', count, source.matrices);
      entry.sourceBounds = storage('aps static source instance bounds', 'vec4f', count * 2, source.bounds);
      entry.version = version;
      entry.matrixKey = matrixSnapshot(object.matrixWorld);
    }
    return entry;
  }

  _ensureChunkEntry(object, geometry) {
    let entry = this._entryFor(object);
    if (entry && (entry.kind !== 'chunks' || entry.geometry !== geometry)) {
      this._destroyEntry(entry);
      entry = null;
    }
    if (!entry) {
      entry = this._remember({ kind: 'chunks', object, geometry, views: new Map(), indexVersion: null, positionVersion: null, matrixKey: null, chunks: null });
    }
    const indexVersion = geometry.index?.version ?? 0;
    const positionVersion = geometry.attributes.position?.version ?? 0;
    if (!entry.chunks || entry.indexVersion !== indexVersion || entry.positionVersion !== positionVersion) {
      const positions = geometry.attributes.position;
      const built = buildChunkedIndex({
        index: geometry.index.array,
        positions: positions.array,
        positionItemSize: positions.itemSize,
        matrixWorld: null,
        maxTrianglesPerChunk: STATIC_CHUNK_MAX_TRIANGLES,
      });
      this._invalidateViews(entry);
      this.retireResources([entry.chunkBounds,entry.chunkMeta,entry.sourceIndices]);
      entry.chunks = built.chunks;
      entry.chunkStats = built.stats;
      entry.localChunks = built.chunks;
      entry.indexVersion = indexVersion;
      entry.positionVersion = positionVersion;
      entry.matrixKey = null;
      const chunkGeometry = new BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) chunkGeometry.setAttribute(name, attribute);
      chunkGeometry.setIndex(new BufferAttribute(built.index, 1));
      chunkGeometry.userData = {
        ...(geometry.userData ?? {}),
        apsStaticVertexOwner: geometry.userData?.apsStaticVertexOwner ?? geometry,
        apsStaticIndexOwner: chunkGeometry,
        aps_static_chunk_geometry: true,
        aps_static_chunk_stats: built.stats,
      };
      chunkGeometry.boundingBox = geometry.boundingBox ?? null;
      chunkGeometry.boundingSphere = geometry.boundingSphere ?? null;
      this.retireResources([],entry.chunkGeometry);
      entry.chunkGeometry = chunkGeometry;
      entry.sourceIndices=storage('aps static chunk source indices','u32',built.index.length,built.index);
      const meta = new Uint32Array(entry.chunks.length * 4);
      entry.chunks.forEach((chunk, i) => meta.set([chunk.firstIndex, chunk.indexCount, 0, 0], i * 4));
      entry.chunkMeta = storage('aps static chunk meta', 'vec4u', entry.chunks.length, meta);
    }
    if (!entry.chunkBounds || !entry.matrixKey || !sameMatrix(entry.matrixKey, object.matrixWorld)) {
      const m = matrixElements(object.matrixWorld);
      const data = new Float32Array(entry.chunks.length * 8);
      entry.chunks.forEach((chunk, i) => {
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let corner = 0; corner < 8; corner++) {
          const x = corner & 1 ? chunk.max[0] : chunk.min[0];
          const y = corner & 2 ? chunk.max[1] : chunk.min[1];
          const z = corner & 4 ? chunk.max[2] : chunk.min[2];
          const p = transformPoint(m, x, y, z);
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
          if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
        }
        data.set([minX, minY, minZ, 0, maxX, maxY, maxZ, 0], i * 8);
      });
      if (entry.chunkBounds) entry.chunkBounds.write(data);
      else entry.chunkBounds = storage('aps static chunk world bounds', 'vec4f', entry.chunks.length * 2, data);
      entry.matrixKey = matrixSnapshot(object.matrixWorld);
    }
    return entry;
  }

  _ensureInstanceView(entry, view) {
    let data = entry.views.get(view.slot);
    if (data && data.sourceToken !== entry.sourceMatrices) {
      this._destroyView(data); entry.views.delete(view.slot); data = null;
    }
    if (data) return data;
    const drawParams = entry.object.drawParams;
    if (!Array.isArray(drawParams) || drawParams.length < 2) return null;
    const region = entry.object.userData?.aps_static_instance_id;
    if (!region || !region.buffer || !Number.isInteger(region.base) || !Number.isInteger(region.region) || region.region <= 0) return null;
    const binding = entry.object.material?.bindings?.apsStaticInstanceIds;
    const bound = binding?.storage;
    if (!bound || bound !== region.buffer) return null;
    const storageBindings = Object.values(entry.object.material?.bindings ?? {}).filter((spec) => spec?.storage).length;
    this.maxMergedMaterialStorage = Math.max(this.maxMergedMaterialStorage ?? 0, storageBindings);
    const idBase = (view.slot + 1) * region.region + region.base;
    if (!Number.isSafeInteger(idBase) || idBase + entry.count > 2 ** 24) return null;
    const count = entry.count;
    const compactMatrices = storage('aps static compact instance matrices', 'mat4x4f', count, null, ['vertex']);
    const counter = storage('aps static instance counter', 'u32', 1);
    const commands = storage('aps static instance indirect command', 'u32', 5, null, ['indirect']);
    const params = uniforms('ApsStaticInstanceCull');
    params.set('count', count); params.set('indexCount', entry.geometry.index.count); params.set('idBase', idBase);
    params.upload();
    const geometry = makeProxyGeometry(entry.geometry, {
      vertexOwner: entry.geometry.userData?.apsStaticVertexOwner ?? entry.geometry,
      indexOwner: entry.geometry,
      indirect: { buffer: commands, offset: 0 },
    });
    const instanceMatrix = new InstancedBufferAttribute(new Float32Array(0), 16);
    instanceMatrix.gpuBuffer = compactMatrices;
    instanceMatrix.count = count;
    const proxy = makeProxyObject(entry.object, geometry, instanceMatrix, count, [entry.object.drawParams[0], entry.object.drawParams[1], idBase]);
    data = {
      slot: view.slot, compactMatrices, counter, commands, params, geometry, proxy,
      sourceToken: entry.sourceMatrices,
      bindGroup: GPU.device.createBindGroup({
        label: 'aps static instance cull', layout: this.kernels.instanceCull.bindings.layout,
        entries: [
          { binding: 0, resource: { buffer: params.getBuffer() } },
          { binding: 1, resource: { buffer: view.uniforms.getBuffer() } },
          { binding: 2, resource: { buffer: entry.sourceBounds.getGPU() } },
          { binding: 3, resource: { buffer: entry.sourceMatrices.getGPU() } },
          { binding: 4, resource: { buffer: compactMatrices.getGPU() } },
          { binding: 5, resource: { buffer: region.buffer.getGPU() } },
          { binding: 6, resource: { buffer: counter.getGPU() } },
          { binding: 7, resource: this.dummy.hiz.view() },
          { binding: 8, resource: this.dummy.hiz.view() },
        ],
      }),
      finalizeBindGroup: GPU.device.createBindGroup({
        label: 'aps static instance finalize', layout: this.kernels.instanceFinalize.bindings.layout,
        entries: [
          { binding: 0, resource: { buffer: params.getBuffer() } },
          { binding: 1, resource: { buffer: counter.getGPU() } },
          { binding: 2, resource: { buffer: commands.getGPU() } },
        ],
      }),
    };
    data.fullSourceBindGroup=data.bindGroup;
    entry.views.set(view.slot, data);
    return data;
  }

  _ensureChunkView(entry, view) {
    let data = entry.views.get(view.slot);
    if (data && data.sourceToken !== entry.chunkGeometry) {
      this._destroyView(data); entry.views.delete(view.slot); data = null;
    }
    if (data) return data;
    const chunks = entry.chunks;
    const commands = storage('aps static compact mesh indirect command', 'u32', 5, new Uint32Array([0,1,0,0,0]), ['indirect']);
    const visibleIndices=storage('aps static compact visible indices','u32',entry.chunkGeometry.index.count,null,['index']);
    const params = uniforms('ApsStaticChunkCull');
    params.set('chunkCount', chunks.length);
    params.upload();
    const geometry = makeProxyGeometry(entry.geometry, {
      vertexOwner: entry.geometry.userData?.apsStaticVertexOwner ?? entry.geometry,
      indexOwner: entry.chunkGeometry,
      indirect: { buffer: commands, offset:0 },
    });
    geometry.userData.apsStaticCompactedIndex=visibleIndices;
    data = {
      slot: view.slot, commands, visibleIndices, params, geometry, sourceToken: entry.chunkGeometry,
      bindGroup: GPU.device.createBindGroup({
        label: 'aps static chunk cull', layout: this.kernels.chunkCull.bindings.layout,
        entries: [
          { binding: 0, resource: { buffer: params.getBuffer() } },
          { binding: 1, resource: { buffer: view.uniforms.getBuffer() } },
          { binding: 2, resource: { buffer: entry.chunkBounds.getGPU() } },
          { binding: 3, resource: { buffer: entry.chunkMeta.getGPU() } },
          { binding: 4, resource: { buffer: entry.sourceIndices.getGPU() } },
          { binding: 5, resource: { buffer: visibleIndices.getGPU() } },
          { binding: 6, resource: { buffer: commands.getGPU() } },
        ],
      }),
    };
    entry.views.set(view.slot, data);
    return data;
  }

  _setPlanes(params, planes) {
    for (let i = 0; i < 6; i++) params.set(`p${i}`, [planes[i * 4], planes[i * 4 + 1], planes[i * 4 + 2], planes[i * 4 + 3]]);
    params.upload();
  }

  _kernelsReady() {
    const kernels = this.kernels;
    return !!kernels && [kernels.instanceCull, kernels.instanceFinalize, kernels.chunkCull]
      .every((kernel) => kernel.handle.pipeline && !kernel.handle.failed);
  }

  apply(lists, pass) {
    const frame = {
      schema: 'aps-static-draw-gpu/1', culling: 'gpu-conservative-frustum', occlusion: !!pass?.apsStaticOcclusion,
      pass: pass?.kind ?? null, enabled: this.enabled, view_slot: null,
      objects: 0, instance_objects: 0, instance_count: 0, chunk_objects: 0, chunk_count: 0,
      indirect_objects: 0, indirect_commands: 0, fallback_objects: 0, fallback_reasons: {}, fallbacks: [],
    };
    this.lastFrame = frame;
    if (!this.enabled || this.disposed || !lists?.opaque?.length) return frame;
    const camera = pass?.camera;
    if (!camera?.projectionMatrix || !camera?.matrixWorldInverse) {
      frame.fallback_objects = lists.opaque.length; frame.fallback_reasons.no_camera = lists.opaque.length;
      return frame;
    }
    this.ensure();
    if (!this.prepared && this._kernelsReady()) this.prepared = true;
    if (!this.prepared || !this._kernelsReady()) {
      frame.fallback_objects = lists.opaque.length; frame.fallback_reasons.pipeline_not_ready = lists.opaque.length;
      return frame;
    }
    const view = this.requirePrepared?this.viewStates.get(camera):this._viewFor(camera);
    if (!view) {
      frame.fallback_objects = lists.opaque.length; frame.fallback_reasons[this.requirePrepared?'view_not_prepared':'view_limit'] = lists.opaque.length;
      return frame;
    }
    frame.view_slot = view.slot;
    const vp = new Float32Array(16);
    const projection = camera.projectionMatrix.elements, inverse = camera.matrixWorldInverse.elements;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let sum = 0; for (let k = 0; k < 4; k++) sum += projection[k * 4 + r] * inverse[c * 4 + k];
      vp[c * 4 + r] = sum;
    }
    const planes = frustumPlanes(vp);
    view.uniforms.set('vp',vp);
    const resolution=FrameUniforms.fields.resolution.value,occlusion=pass.apsStaticOcclusion;
    view.uniforms.set('screen',[occlusion?.width??resolution.x,occlusion?.height??resolution.y,0,0]);
    this._setPlanes(view.uniforms,planes);
    frame.shared_view_uniform_updates=1;
    const instancePlans = [], chunkPlans = [], modifications = [];
    const modify = (item, proxy, geometry) => modifications.push(() => {
      if (proxy) item.object = proxy;
      if (geometry) item.geometry = geometry;
      item.start = 0; item.count = Infinity;
    });
    for (const item of lists.opaque) {
      const object = item.object, geometry = item.geometry, material = item.material;
      const eligibility = staticDrawEligibility({ object, geometry, material });
      frame.objects++;
      if (eligibility.mode === 'fallback') {
        frame.fallback_objects++;
        frame.fallback_reasons[eligibility.reason] = (frame.fallback_reasons[eligibility.reason] ?? 0) + 1;
        if (frame.fallbacks.length < 40) frame.fallbacks.push({ object: object.name ?? null, reason: eligibility.reason });
        continue;
      }
      if(this.requirePrepared){
        const entry=this.entries.get(object),same=entry&&entry.geometry===geometry&&sameMatrix(entry.matrixKey,object.matrixWorld)&&entry.views.has(view.slot)&&
          (eligibility.mode==='instances'?entry.kind==='instances'&&entry.count===object.count&&entry.version===(object.instanceMatrix?.version??0)&&entry.material===object.material:entry.kind==='chunks'&&entry.indexVersion===(geometry.index?.version??0)&&entry.positionVersion===(geometry.attributes.position?.version??0));
        if(!same){frame.fallback_objects++;frame.fallback_reasons.resource_not_prepared=(frame.fallback_reasons.resource_not_prepared??0)+1;continue;}
      }
      try {
        if (eligibility.mode === 'instances') {
          const entry = this._ensureInstanceEntry(object, geometry);
          const data = this._ensureInstanceView(entry, view);
          if (!data) throw Error('instance_id_binding_mismatch');
          if(!occlusion)data.bindGroup=data.fullSourceBindGroup;
          else{
          const terrain=occlusion.terrain,solid=occlusion.solid;
          if(data.boundTerrain!==terrain||data.boundSolid!==solid){
            const region=entry.object.userData.aps_static_instance_id;
            data.occlusionBindGroup=GPU.device.createBindGroup({label:'static instance frustum -> terrain -> Hi-Z',layout:this.kernels.instanceCull.bindings.layout,entries:[
              {binding:0,resource:{buffer:data.params.getBuffer()}},{binding:1,resource:{buffer:view.uniforms.getBuffer()}},
              {binding:2,resource:{buffer:entry.sourceBounds.getGPU()}},{binding:3,resource:{buffer:entry.sourceMatrices.getGPU()}},
              {binding:4,resource:{buffer:data.compactMatrices.getGPU()}},{binding:5,resource:{buffer:region.buffer.getGPU()}},{binding:6,resource:{buffer:data.counter.getGPU()}},
              {binding:7,resource:terrain.createView()},{binding:8,resource:solid.createView()}]});
            data.boundTerrain=terrain;data.boundSolid=solid;
          }
          data.bindGroup=data.occlusionBindGroup;
          }
          data.proxy.matrixWorld.copy(object.matrixWorld);
          data.proxy.drawParams[0] = entry.object.drawParams[0];
          data.proxy.drawParams[1] = entry.object.drawParams[1];
          data.proxy.drawParams[2] = (view.slot + 1) * object.userData.aps_static_instance_id.region + object.userData.aps_static_instance_id.base;
          instancePlans.push({ entry, data });
          modify(item, data.proxy, data.geometry);
          frame.instance_objects++; frame.instance_count += entry.count;
          frame.indirect_objects++; frame.indirect_commands++;
        } else {
          const entry = this._ensureChunkEntry(object, geometry);
          const data = this._ensureChunkView(entry, view);
          chunkPlans.push({ entry, data });
          modify(item, null, data.geometry);
          frame.chunk_objects++; frame.chunk_count += entry.chunks.length;
          frame.indirect_objects++; frame.indirect_commands++;
        }
      } catch (error) {
        frame.fallback_objects++;
        frame.fallback_reasons.planning_error = (frame.fallback_reasons.planning_error ?? 0) + 1;
        if (frame.fallbacks.length < 40) frame.fallbacks.push({ object: object.name ?? null, reason: `error:${error.message}` });
      }
    }
    this.flushRetired();if (!instancePlans.length && !chunkPlans.length) return frame;
    try {
      const encoder = GPU.getEncoder();
      for (const { data } of instancePlans) encoder.clearBuffer(data.counter.getGPU(), 0, 4);
      for (const { data } of chunkPlans) encoder.clearBuffer(data.commands.getGPU(), 0, 4);
      if (instancePlans.length) {
        const compute = encoder.beginComputePass({ label: 'aps static instance cull' });
        compute.setPipeline(GPU.ready(this.kernels.instanceCull.handle));
        compute.setBindGroup(0, this.kernels.instanceCull.group0.getBindGroup());
        for (const { entry, data } of instancePlans) {
          compute.setBindGroup(1, data.bindGroup);
          compute.dispatchWorkgroups(Math.max(1, Math.ceil(entry.count / WORKGROUP)));
        }
        compute.end();
        const finalize = encoder.beginComputePass({ label: 'aps static instance finalize' });
        finalize.setPipeline(GPU.ready(this.kernels.instanceFinalize.handle));
        finalize.setBindGroup(0, this.kernels.instanceFinalize.group0.getBindGroup());
        for (const { data } of instancePlans) {
          finalize.setBindGroup(1, data.finalizeBindGroup);
          finalize.dispatchWorkgroups(1);
        }
        finalize.end();
      }
      if (chunkPlans.length) {
        const compute = encoder.beginComputePass({ label: 'aps static chunk cull' });
        compute.setPipeline(GPU.ready(this.kernels.chunkCull.handle));
        compute.setBindGroup(0, this.kernels.chunkCull.group0.getBindGroup());
        for (const { entry, data } of chunkPlans) {
          compute.setBindGroup(1, data.bindGroup);
          compute.dispatchWorkgroups(Math.max(1,entry.chunks.length));
        }
        compute.end();
      }
    } catch (error) {
      this.lastError = { message: String(error?.message ?? error) };
      frame.fallback_objects += frame.indirect_objects;
      frame.fallback_reasons.dispatch_error = (frame.fallback_reasons.dispatch_error ?? 0) + frame.indirect_objects;
      frame.indirect_objects = 0; frame.indirect_commands = 0; frame.instance_objects = 0; frame.chunk_objects = 0;
      frame.instance_count = 0; frame.chunk_count = 0;
      return frame;
    }
    for (const applyModification of modifications) applyModification();
    if (this.maxMergedMaterialStorage) this._recordBudget();
    return frame;
  }

                                                                                
                                                                               
  async audit(camera, object) {
    const view = this.viewStates.get(camera);
    const entry = this.entries.get(object);
    if (!view || !entry) throw Error('No static draw GPU view/entry for audit');
    const data = entry.views.get(view.slot);
    if (!data) throw Error('Static draw GPU view data is not allocated');
    if (entry.kind === 'instances') {
      const counter = new Uint32Array(await readBuffer(data.counter, 4))[0];
      const ids = new Uint32Array(await readBuffer(entry.object.userData.aps_static_instance_id.buffer, entry.count * 4, ((view.slot + 1) * entry.object.userData.aps_static_instance_id.region + entry.object.userData.aps_static_instance_id.base) * 4));
      const matrices = new Float32Array(await readBuffer(data.compactMatrices, entry.count * 64));
      const commands = new Uint32Array(await readBuffer(data.commands, 20));
      return {
        mode: 'instances', count: counter, commands: [...commands],
        ids: [...ids.subarray(0, counter)], matrices: [...matrices.subarray(0, counter * 16)],
      };
    }
    const commands = new Uint32Array(await readBuffer(data.commands,20));
    const indices=commands[0]?new Uint32Array(await readBuffer(data.visibleIndices,commands[0]*4)):new Uint32Array();
    return { mode: 'chunks', chunks: entry.chunks.length, commands: [...commands], indices:[...indices], compacted:true, stats: entry.chunkStats };
  }

  forgetRoot(root) {
    if (!root) return;
    for (const entry of [...this.entryList]) {
      let node = entry.object;
      let found = false;
      while (node) { if (node === root) { found = true; break; } node = node.parent; }
      if (found) this._destroyEntry(entry);
    }
    this.flushRetired();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entryList]) this._destroyEntry(entry);
    this.entryList.clear(); this.entries.clear();for(const view of this.viewStates.values())this.retireResources([view.uniforms?.buffer]);this.viewStates.clear();
    for (const buffer of Object.values(this.dummy ?? {})) destroyBuffer(buffer);
    try { this.dummy?.uniform?.buffer?.destroy?.(); } catch {                                             }
    try { this.dummy?.view?.buffer?.destroy?.(); } catch {                                          }
    this.dummy = null; this.kernels = null; this.prepared = false;
    this.preparationErrors?.clear();
    this.flushRetired();
  }
}





