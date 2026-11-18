                                           
  
                   
                                        
                                                                                
                                                                   
                                                                   
                                                                   
                                                                         
  
                                                                            
                                                                             
                                                                             
                                                             
  
                                                  
                                                                          
                                                          
                                               
                                                                           
                            
                                                                            
                                                                             
                                                                            
                                                  
import { GPU, FrameUniforms, G, setFrameCamera } from '../../vendor/tidewater/src/engine/webgpu.js';
import {
  EXTERNAL_DEMAND_BYTES,
  EXTERNAL_DEMAND_MAX_BOXES,
  LIGHT_FRAME_BYTES,
  RECEIVER_DEMAND_BYTES,
  RECEIVER_DEMAND_FLAGS,
  RECEIVER_DEMAND_LEVELS,
  RECEIVER_DEMAND_STRIDE_BYTES,
  createReceiverShadowWGSL,
  receiverDepthPad,
  receiverPadTexels,
} from './receiver_shadow_wgsl.js';
import {
  RECEIVER_XYZ_LABEL,
  receiverXYZPass,
  receiverXYZFilter,
} from './receiver_xyz_pipeline.js';

const CS = GPUShaderStage.COMPUTE;

function readVec3OrNull(value) {
  if (!value) return null;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value.length >= 3 && value[0] !== undefined && [value[0], value[1], value[2]].every(Number.isFinite) ? [value[0], value[1], value[2]] : null;
  if (typeof value.toArray === 'function') return readVec3OrNull(value.toArray());
  const out = [value.x, value.y, value.z];
  return out.every(Number.isFinite) ? out : null;
}

function readVec3(value, fallback = [0, 1, 0]) {
  return readVec3OrNull(value) ?? fallback.slice();
}

function normalizeBasisFromSun(sunDir) {
  const [sx, sy, sz] = readVec3(sunDir);
  const length = Math.hypot(sx, sy, sz) || 1;
  const l = [sx / length, sy / length, sz / length];
  const up = Math.abs(l[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  let x = [
    up[1] * l[2] - up[2] * l[1],
    up[2] * l[0] - up[0] * l[2],
    up[0] * l[1] - up[1] * l[0],
  ];
  const xl = Math.hypot(...x) || 1;
  x = x.map((v) => v / xl);
  const y = [
    l[1] * x[2] - l[2] * x[1],
    l[2] * x[0] - l[0] * x[2],
    l[0] * x[1] - l[1] * x[0],
  ];
  return [x, y, l];
}

function matrixElements(viewProj) {
  const e = viewProj?.elements ?? viewProj;
  if (!e || e.length < 16 || !Array.from(e).slice(0, 16).every(Number.isFinite)) {
    throw Error('ReceiverShadowPipeline: cascade.viewProj must be a finite 4x4 matrix');
  }
  return Array.from(e).slice(0, 16);
}

const EXTERNAL_RECT_FLAGS = Object.freeze({absent: 0, finite: 1, empty: 2, full: 3});

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

                                                                             
                                                                           
            
function readExternalRect(rects, level) {
  const absent = {flag: 0, minU: 0, minV: 0, maxU: 0, maxV: 0, valid: true, reason: null};
  if (rects === undefined || rects === null) return absent;
  if (!Array.isArray(rects)) return {...absent, valid: false, reason: 'externalRects_not_array'};
  const raw = rects[level];
  if (raw === undefined || raw === null) return absent;
  const flag = Number(raw.flag);
  if (!Number.isInteger(flag) || flag < 0 || flag > 3) return {...absent, valid: false, reason: 'invalid_flag'};
  if (flag === EXTERNAL_RECT_FLAGS.absent) return absent;
  if (flag === EXTERNAL_RECT_FLAGS.empty) return {flag, minU: 1, minV: 1, maxU: 0, maxV: 0, valid: true, reason: null};
  if (flag === EXTERNAL_RECT_FLAGS.full) return {flag, minU: 0, minV: 0, maxU: 1, maxV: 1, valid: true, reason: null};
  const values = [Number(raw.minU), Number(raw.minV), Number(raw.maxU), Number(raw.maxV)];
  if (!values.every(Number.isFinite)) return {...absent, valid: false, reason: 'nonfinite_rect'};
  const [minU, minV, maxU, maxV] = values;
  if (minU > maxU || minV > maxV) return {...absent, valid: false, reason: 'inverted_rect'};
  return {
    flag,
    minU: clamp01(minU),
    minV: clamp01(minV),
    maxU: clamp01(maxU),
    maxV: clamp01(maxV),
    valid: true,
    reason: null,
  };
}

function componentNormalBias(value, index) {
  if (Array.isArray(value)) return Number.isFinite(value[index]) ? value[index] : (Number.isFinite(value[0]) ? value[0] : 0.1);
  return Number.isFinite(value) ? value : 0.1;
}

function viewportSize(viewer) {
  const canvas = viewer?.canvas;
  let width = Number.isFinite(canvas?.width) ? canvas.width : 0;
  let height = Number.isFinite(canvas?.height) ? canvas.height : 0;
  if (!width || !height) {
    const resolution = FrameUniforms.fields.resolution.value;
    width = width || Math.max(1, Math.floor(resolution?.x ?? 1));
    height = height || Math.max(1, Math.floor(resolution?.y ?? 1));
  }
  return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
}

export class ReceiverShadowPipeline {
  constructor(options = {}) {
    this.label = options.label ?? 'aps receiver shadow';
    this.layerMask = options.layerMask ?? 1;
    this.normalBias = options.normalBias ?? null;
    this.occlusionBias = Number.isFinite(options.occlusionBias_m) ? options.occlusionBias_m : 0.05;
    this.maxDemandFraction = Number.isFinite(options.maxDemandFraction) ? options.maxDemandFraction : 0.9;
    this.disposed = false;
    this.device = null;
    this.width = 0;
    this.height = 0;
    this.lastError = null;
    this._options = {};
    this._cascades = null;
    this._viewer = null;
    this._destroyTextures();
    this._destroyBuffers();
  }

  get demandBuffer() { return this._demandBuffer ?? null; }
  get xyzTexture() { return this._xyzTexture ?? null; }
  get receiverDepthTexture() { return this._depthTexture ?? null; }
  get enabled() { return this.disposed !== true && !!this._demandBuffer && !!this._pipelines && !!this._bindGroups; }

  metadata() {
    return {
      schema: 'aps-receiver-driven-shadows/receiver-pipeline/1',
      enabled: this.enabled,
      width: this.width,
      height: this.height,
      xyz: { format: 'rgba32float', valid_component: 'w', clear: [0, 0, 0, 0] },
      depth: {
        format: 'depth32float',
        compare: this._lastXYZ?.reversed_depth === false ? 'less-equal (main forward-Z)' : 'greater-equal (main reversed-Z)',
      },
      demand: {
        bytes: RECEIVER_DEMAND_BYTES,
        stride_bytes: RECEIVER_DEMAND_STRIDE_BYTES,
        levels: RECEIVER_DEMAND_LEVELS,
        buffer: this._demandBuffer ? RECEIVER_DEMAND_BYTES : 0,
        quantization: { uv: 65535, z: 16777215 },
        flags: { ...RECEIVER_DEMAND_FLAGS },
      },
      light_frame_bytes: LIGHT_FRAME_BYTES,
      external_demand_bytes: EXTERNAL_DEMAND_BYTES,
      external_boxes_max: EXTERNAL_DEMAND_MAX_BOXES,
      no_frame_loop_readback: true,
      last_error: this.lastError,
      last_xyz: this._lastXYZ ?? null,
      last_demand: this._lastDemand ?? null,
      last_light_frame: this._lastLightFrame ?? null,
    };
  }

  prepare(viewer, cascades, options = {}) {
    this._assertLive();
    if (!viewer) throw Error('ReceiverShadowPipeline.prepare requires a viewer');
    if (!Array.isArray(cascades) || cascades.length !== RECEIVER_DEMAND_LEVELS) {
      throw Error(`ReceiverShadowPipeline requires exactly ${RECEIVER_DEMAND_LEVELS} cascades`);
    }
    this._viewer = viewer;
    this._cascades = cascades;
    this._options = { ...options };
    try {
      const { width, height } = viewportSize(viewer);
      this._ensureDevice();
      if (width !== this.width || height !== this.height) this.resize(width, height);
      this._ensurePipelines();
      this._writeLightFrame(cascades, options, viewer);
      this._writeExternalDemand(options);
      this.lastError = null;
      return this.metadata();
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  renderXYZ(viewer, cascades, options = {}) {
    this.prepare(viewer, cascades, options);
    return this._encodeXYZ(options);
  }

  reduce(cascades = null, options = {}) {
    this._assertLive();
    if (!this._viewer) throw Error('ReceiverShadowPipeline.reduce requires prepare/renderXYZ first');
    try {
      const resolved = { ...this._options, ...options };
      const levels = cascades ?? this._cascades;
      this._writeLightFrame(levels, resolved, this._viewer);
      this._writeExternalDemand(resolved);
      this._encodeDemand();
      this.lastError = null;
      return this.metadata();
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  render(viewer, cascades, options = {}) {
    this.prepare(viewer, cascades, options);
    const xyz = this._encodeXYZ(options);
    const demand = this.reduce(cascades, options);
    return { ...demand, xyz };
  }

  resize(width, height) {
    this._assertLive();
    const device = this._ensureDevice();
    const w = Math.max(1, Math.floor(Number(width) || 1));
    const h = Math.max(1, Math.floor(Number(height) || 1));
    const max = device.limits?.maxTextureDimension2D ?? GPU.limits?.maxTextureDimension2D ?? 8192;
    if (w > max || h > max) throw RangeError(`ReceiverShadowPipeline: ${w}x${h} exceeds maxTextureDimension2D ${max}`);
    if (w === this.width && h === this.height && this._xyzTexture) return { width: w, height: h };
    this._destroyTextures();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this._xyzTexture = device.createTexture({
      label: `${this.label} receiver XYZ rgba32float`,
      size: { width: w, height: h },
      format: 'rgba32float',
      usage,
    });
    this._depthTexture = device.createTexture({
      label: `${this.label} receiver depth`,
      size: { width: w, height: h },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._xyzView = this._xyzTexture.createView();
    this._depthView = this._depthTexture.createView();
    this.width = w;
    this.height = h;
    this._lastXYZ = null;
    this._lastDemand = null;
    this._destroyBindGroups();
    return { width: w, height: h };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._destroyTextures();
    this._destroyBuffers();
    this._pipelines = null;
    this._bindGroups = null;
    this._layouts = null;
    this._modules = null;
    this._viewer = null;
    this._cascades = null;
    this._lastXYZ = null;
    this._lastDemand = null;
    this._lastExternal = null;
    this._lastLightFrame = null;
    this._lastExternalRects = null;
  }

  _assertLive() {
    if (this.disposed) throw Error('ReceiverShadowPipeline has been disposed');
  }

  _ensureDevice() {
    const device = GPU.device;
    if (!device) throw Error('ReceiverShadowPipeline requires an initialized WebGPU device');
    if (this.device && this.device !== device) {
      this._destroyTextures();
      this._destroyBuffers();
      this._pipelines = null;
      this._bindGroups = null;
      this._layouts = null;
      this._modules = null;
      this.width = 0;
      this.height = 0;
    }
    this.device = device;
    this._ensureBuffers();
    return device;
  }

  _ensureBuffers() {
    const device = this.device;
    if (this._demandBuffer) return;
    const maxBuffer = device.limits?.maxBufferSize ?? GPU.limits?.maxBufferSize ?? 1 << 28;
    for (const bytes of [RECEIVER_DEMAND_BYTES, LIGHT_FRAME_BYTES, EXTERNAL_DEMAND_BYTES]) {
      if (bytes > maxBuffer) throw RangeError(`ReceiverShadowPipeline: uniform/storage block ${bytes} exceeds maxBufferSize ${maxBuffer}`);
    }
    this._rawDemandBuffer = device.createBuffer({
      label: `${this.label} atomic receiver demand`,
      size: RECEIVER_DEMAND_BYTES,
      usage: GPUBufferUsage.STORAGE,
    });
    this._demandBuffer = device.createBuffer({
      label: `${this.label} ReceiverDemand`,
      size: RECEIVER_DEMAND_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this._lightFrameBuffer = device.createBuffer({
      label: `${this.label} LightFrame`,
      size: LIGHT_FRAME_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._externalBuffer = device.createBuffer({
      label: `${this.label} ExternalDemand`,
      size: EXTERNAL_DEMAND_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._lightFrameData = new Float32Array(LIGHT_FRAME_BYTES / 4);
    this._externalData = new ArrayBuffer(EXTERNAL_DEMAND_BYTES);
    this._externalU32 = new Uint32Array(this._externalData);
    this._externalF32 = new Float32Array(this._externalData);
    this._destroyBindGroups();
  }

  _ensurePipelines() {
    if (!this._xyzView) throw Error('ReceiverShadowPipeline has no XYZ render target');
    const device = this.device;
    if (!this._layouts) {
      const block = (binding, type, extra = {}) => ({ binding, visibility: CS, buffer: { type, ...extra } });
      this._layouts = {
        reset: device.createBindGroupLayout({
          label: `${this.label} demand reset layout`,
          entries: [block(0, 'storage', { minBindingSize: RECEIVER_DEMAND_BYTES })],
        }),
        reduce: device.createBindGroupLayout({
          label: `${this.label} demand reduce layout`,
          entries: [
            { binding: 0, visibility: CS, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
            block(1, 'uniform', { minBindingSize: LIGHT_FRAME_BYTES }),
            block(2, 'storage', { minBindingSize: RECEIVER_DEMAND_BYTES }),
          ],
        }),
        finalize: device.createBindGroupLayout({
          label: `${this.label} demand finalize layout`,
          entries: [
            block(0, 'storage', { minBindingSize: RECEIVER_DEMAND_BYTES }),
            block(1, 'storage', { minBindingSize: RECEIVER_DEMAND_BYTES }),
            block(2, 'uniform', { minBindingSize: LIGHT_FRAME_BYTES }),
            block(3, 'uniform', { minBindingSize: EXTERNAL_DEMAND_BYTES }),
          ],
        }),
      };
    }
    if (!this._pipelines) {
      const wgsl = createReceiverShadowWGSL();
      const modules = {
        reset: device.createShaderModule({ label: `${this.label} demand reset`, code: wgsl.reset }),
        reduce: device.createShaderModule({ label: `${this.label} demand reduce`, code: wgsl.reduce }),
        finalize: device.createShaderModule({ label: `${this.label} demand finalize`, code: wgsl.finalize }),
      };
      const make = (name, module) => device.createComputePipeline({
        label: `${this.label} ${name}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this._layouts[name]] }),
        compute: { module, entryPoint: 'main' },
      });
      this._modules = modules;
      this._pipelines = {
        reset: make('reset', modules.reset),
        reduce: make('reduce', modules.reduce),
        finalize: make('finalize', modules.finalize),
      };
    }
    if (!this._bindGroups) {
      this._bindGroups = {
        reset: device.createBindGroup({
          label: `${this.label} reset bind group`,
          layout: this._layouts.reset,
          entries: [{ binding: 0, resource: { buffer: this._rawDemandBuffer } }],
        }),
        reduce: device.createBindGroup({
          label: `${this.label} reduce bind group`,
          layout: this._layouts.reduce,
          entries: [
            { binding: 0, resource: this._xyzView },
            { binding: 1, resource: { buffer: this._lightFrameBuffer } },
            { binding: 2, resource: { buffer: this._rawDemandBuffer } },
          ],
        }),
        finalize: device.createBindGroup({
          label: `${this.label} finalize bind group`,
          layout: this._layouts.finalize,
          entries: [
            { binding: 0, resource: { buffer: this._rawDemandBuffer } },
            { binding: 1, resource: { buffer: this._demandBuffer } },
            { binding: 2, resource: { buffer: this._lightFrameBuffer } },
            { binding: 3, resource: { buffer: this._externalBuffer } },
          ],
        }),
      };
    }
  }

  _writeLightFrame(cascades, options, viewer) {
    if (!Array.isArray(cascades) || cascades.length !== RECEIVER_DEMAND_LEVELS) {
      throw Error(`ReceiverShadowPipeline requires exactly ${RECEIVER_DEMAND_LEVELS} cascades`);
    }
    const sunDir = readVec3(options.sunDir ?? viewer?.lighting?.sunDir?.value ?? viewer?.sunDir ?? G.sunDir?.value, [0, 1, 0]);
    const basis = normalizeBasisFromSun(sunDir);
    const shadowMapSize = Number.isFinite(options.shadowMapSize) && options.shadowMapSize > 0
      ? options.shadowMapSize
      : (Number.isFinite(viewer?.shadows?.size) && viewer.shadows.size > 0 ? viewer.shadows.size : 2048);
    const data = this._lightFrameData;
    data.fill(0);
                                                                              
                                                                            
    const biasSetting = options.normalBias ?? this.normalBias ?? viewer?.shadows?.normalBias ?? null;
    for (let column = 0; column < 3; column++) data.set(basis[column], column * 4);
    data.set([sunDir[0], sunDir[1], sunDir[2], 0], 12);
    data.set([shadowMapSize, RECEIVER_DEMAND_LEVELS, this.width, this.height], 16);
    const externalRects = options.externalRects ?? null;
    const levelMetadata = [];
    for (let level = 0; level < RECEIVER_DEMAND_LEVELS; level++) {
      const cascade = cascades[level];
      const base = 20 + level * 28;
      const vp = matrixElements(cascade.viewProj);
      data.set(vp, base);
      const radius = Number.isFinite(cascade.radius) && cascade.radius > 0 ? cascade.radius : 1;
      const texelWorld = Number.isFinite(cascade.texel) && cascade.texel > 0 ? cascade.texel : (2 * radius / Math.max(shadowMapSize, 1));
      const near = Number.isFinite(cascade.camera?.near) ? cascade.camera.near : (Number.isFinite(cascade.near) ? cascade.near : 0.1);
      const far = Number.isFinite(cascade.camera?.far) ? cascade.camera.far : (Number.isFinite(cascade.far) ? cascade.far : 10000);
      const normalBias = componentNormalBias(cascade.normalBias ?? biasSetting, level);
      const padTexels = receiverPadTexels(normalBias, texelWorld);
      const depthPad = receiverDepthPad(normalBias, options.occlusionBias_m ?? this.occlusionBias, texelWorld);
                                                                             
                                                                                  
      const externalRect = readExternalRect(externalRects, level);
      data.set([externalRect.minU, externalRect.minV, externalRect.maxU, externalRect.maxV], base + 16);
      data.set([near, far, texelWorld, normalBias], base + 20);
      data.set([padTexels, depthPad, level, externalRect.flag], base + 24);
      let effective = null;
      if (externalRect.flag === EXTERNAL_RECT_FLAGS.finite) {
        const padUnits = Math.ceil(padTexels / Math.max(shadowMapSize, 1) * 65535);
        const qMinU = Math.round(externalRect.minU * 65535);
        const qMinV = Math.round(externalRect.minV * 65535);
        const qMaxU = Math.round(externalRect.maxU * 65535);
        const qMaxV = Math.round(externalRect.maxV * 65535);
        const effMinU = Math.max(0, qMinU - padUnits);
        const effMinV = Math.max(0, qMinV - padUnits);
        const effMaxU = Math.min(65535, qMaxU + padUnits);
        const effMaxV = Math.min(65535, qMaxV + padUnits);
        const areaFraction = ((effMaxU - effMinU) / 65535) * ((effMaxV - effMinV) / 65535);
        const maxDemandFraction = Math.min(1, Math.max(0, Number.isFinite(options.maxDemandFraction) ? options.maxDemandFraction : this.maxDemandFraction));
        effective = {
          gpu_pad_texels: padTexels,
          gpu_pad_units: padUnits,
          min_u: effMinU / 65535,
          min_v: effMinV / 65535,
          max_u: effMaxU / 65535,
          max_v: effMaxV / 65535,
          area_fraction: areaFraction,
          max_demand_fraction: maxDemandFraction,
          mode: areaFraction > maxDemandFraction ? 'full_fills_clipmap' : 'finite_frustum',
        };
      }
      levelMetadata.push({
        level,
        near: Number.isFinite(cascade.camera?.near) ? cascade.camera.near : (cascade.near ?? null),
        far: Number.isFinite(cascade.camera?.far) ? cascade.camera.far : (cascade.far ?? null),
        texel_world: cascade.texel ?? null,
        view_proj_source: 'cascade.viewProj',
        external_rect: {
          flag: externalRect.flag,
          min_u: externalRect.minU,
          min_v: externalRect.minV,
          max_u: externalRect.maxU,
          max_v: externalRect.maxV,
          valid: externalRect.valid,
          reason: externalRect.reason,
          uniform_offset_bytes: (base + 16) * 4,
          demand_pad_w_offset_bytes: (base + 27) * 4,
          effective,
        },
      });
    }
    GPU.queue.writeBuffer(this._lightFrameBuffer, 0, data);
    this._lastLightFrame = {
      shadow_map_size: shadowMapSize,
      sun_dir: sunDir,
      bytes: LIGHT_FRAME_BYTES,
      external_rect_contract: 'LightLevel.externalRect + demandPad.w (0 absent, 1 finite, 2 empty, 3 full)',
      levels: levelMetadata,
    };
    this._lastExternalRects = levelMetadata.map((level) => ({...level.external_rect}));
  }

  _writeExternalDemand(options) {
    const u32 = this._externalU32;
    const f32 = this._externalF32;
    u32.fill(0);
    let legacyFull = options.legacyFull === true || options.legacyFull === 1;
    const externalRects = options.externalRects;
    const externalRectState = [];
    if (externalRects !== undefined && externalRects !== null) {
      if (!Array.isArray(externalRects)) {
        legacyFull = true;
        externalRectState.push({level: -1, valid: false, reason: 'externalRects_not_array'});
      } else {
        for (let level = 0; level < RECEIVER_DEMAND_LEVELS; level++) {
          const rect = readExternalRect(externalRects, level);
          externalRectState.push({level, ...rect});
          if (!rect.valid) legacyFull = true;
        }
      }
    }
    const input = Array.isArray(options.externalBoxes) ? options.externalBoxes : [];
    if (input.length > EXTERNAL_DEMAND_MAX_BOXES) legacyFull = true;
    const boxes = [];
    for (const raw of input.slice(0, EXTERNAL_DEMAND_MAX_BOXES)) {
      if (!raw) continue;
      const unbounded = raw.unbounded === true || raw.unbounded === 1 || raw.flags?.unbounded === true || raw.flags?.unbounded === 1;
      const min = raw.min ?? raw.aabb?.min;
      const max = raw.max ?? raw.aabb?.max;
      if (unbounded) { legacyFull = true; continue; }
      const boxMin = readVec3OrNull(min);
      const boxMax = readVec3OrNull(max);
      if (!boxMin || !boxMax) { legacyFull = true; continue; }
      if (boxMin.some((value, index) => value > boxMax[index])) { legacyFull = true; continue; }
      const kind = Number.isFinite(raw.kind) ? raw.kind : (Number.isFinite(raw.flags?.kind) ? raw.flags.kind : 1);
      boxes.push({ min: boxMin, max: boxMax, kind });
    }
    const maxDemandFraction = Math.min(1, Math.max(0, Number.isFinite(options.maxDemandFraction) ? options.maxDemandFraction : this.maxDemandFraction));
    u32[0] = boxes.length;
    u32[1] = legacyFull ? 1 : 0;
    f32[2] = maxDemandFraction;
    f32[3] = 0;
    for (let index = 0; index < boxes.length; index++) {
      const base = 4 + index * 12;
      const box = boxes[index];
      f32.set([box.min[0], box.min[1], box.min[2], 0], base);
      f32.set([box.max[0], box.max[1], box.max[2], 0], base + 4);
      f32.set([1, 0, box.kind, 0], base + 8);
    }
    GPU.queue.writeBuffer(this._externalBuffer, 0, this._externalData);
    this._lastExternal = {
      count: boxes.length,
      legacy_full: legacyFull,
      max_demand_fraction: maxDemandFraction,
      external_rects: externalRectState,
    };
  }

  _encodeXYZ(options) {
    const viewer = this._viewer;
    if (!viewer) throw Error('ReceiverShadowPipeline.renderXYZ requires prepare');
    const renderer = viewer.sceneRenderer?.meshRenderer ?? viewer.meshRenderer;
    const scene = viewer.scene;
    const camera = viewer.camera;
    if (!renderer || !scene || !camera) throw Error('ReceiverShadowPipeline: viewer is missing renderer/scene/camera');
    const reversedDepth = camera.reversedDepth !== false;
    setFrameCamera(camera, this.width, this.height, { block: FrameUniforms });
    let pass = receiverXYZPass({
      xyzView: this._xyzView,
      depthView: this._depthView,
      camera,
      frameBlock: FrameUniforms,
      width: this.width,
      height: this.height,
      reversedDepth,
      label: options.label ?? RECEIVER_XYZ_LABEL,
      layerMask: options.layerMask ?? this.layerMask,
      filter: options.filter ?? receiverXYZFilter,
    });
    const hook = options.prepareReceiver ?? viewer.prepareReceiver ?? renderer.prepareReceiver;
    if (typeof hook === 'function') {
      const override = hook({ viewer, renderer, scene, camera, cascades: this._cascades, pass });
      if (override && typeof override === 'object') pass = { ...pass, ...override };
    }
                                                                              
                                                             
    pass.kind = 'depth';
    pass.apsReceiverXYZ = true;
    pass.defines = { ...(pass.defines || {}), APS_RECEIVER_XYZ: 1 };
    const before = { draws: renderer.stats?.draws ?? 0, triangles: renderer.stats?.triangles ?? 0 };
                                                                              
                                                                               
                                                                                 
    const priorSync = renderer.syncPipelines;
    renderer.syncPipelines = true;
    try {
      renderer.render(scene, pass);
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      throw error;
    } finally {
      renderer.syncPipelines = priorSync;
    }
    this._lastXYZ = {
      frame: GPU.frame,
      label: pass.label,
      width: this.width,
      height: this.height,
      reversed_depth: reversedDepth,
      draws: (renderer.stats?.draws ?? 0) - before.draws,
      triangles: (renderer.stats?.triangles ?? 0) - before.triangles,
      source: 'camera-space vertex world position',
    };
    return this._lastXYZ;
  }

  _encodeDemand() {
    if (!this._pipelines || !this._bindGroups) throw Error('ReceiverShadowPipeline pipelines are not ready');
    const encoder = GPU.getEncoder();
    const reset = encoder.beginComputePass({ label: `${this.label} demand reset` });
    reset.setPipeline(this._pipelines.reset);
    reset.setBindGroup(0, this._bindGroups.reset);
    reset.dispatchWorkgroups(1);
    reset.end();

    const workgroupsX = Math.ceil(this.width / 8);
    const workgroupsY = Math.ceil(this.height / 8);
    const limit = this.device.limits?.maxComputeWorkgroupsPerDimension ?? GPU.limits?.maxComputeWorkgroupsPerDimension ?? 65535;
    if (workgroupsX > limit || workgroupsY > limit) {
      throw RangeError(`ReceiverShadowPipeline: demand dispatch ${workgroupsX}x${workgroupsY} exceeds maxComputeWorkgroupsPerDimension ${limit}`);
    }
    const reduce = encoder.beginComputePass({ label: `${this.label} demand reduce` });
    reduce.setPipeline(this._pipelines.reduce);
    reduce.setBindGroup(0, this._bindGroups.reduce);
    reduce.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
    reduce.end();

    const finalize = encoder.beginComputePass({ label: `${this.label} demand finalize` });
    finalize.setPipeline(this._pipelines.finalize);
    finalize.setBindGroup(0, this._bindGroups.finalize);
    finalize.dispatchWorkgroups(1);
    finalize.end();

    this._lastDemand = {
      frame: GPU.frame,
      width: this.width,
      height: this.height,
      levels: RECEIVER_DEMAND_LEVELS,
      bytes: RECEIVER_DEMAND_BYTES,
      dispatch: [workgroupsX, workgroupsY],
      external: this._lastExternal ?? null,
      view_proj_source: 'cascade.viewProj',
      no_readback: true,
    };
  }

  _destroyTextures() {
    try { this._xyzTexture?.destroy(); } catch {}
    try { this._depthTexture?.destroy(); } catch {}
    this._xyzTexture = null;
    this._depthTexture = null;
    this._xyzView = null;
    this._depthView = null;
  }

  _destroyBuffers() {
    for (const key of ['_rawDemandBuffer', '_demandBuffer', '_lightFrameBuffer', '_externalBuffer']) {
      try { this[key]?.destroy(); } catch {}
      this[key] = null;
    }
    this._lightFrameData = null;
    this._externalData = null;
    this._externalU32 = null;
    this._externalF32 = null;
  }

  _destroyBindGroups() {
    this._bindGroups = null;
  }
}
