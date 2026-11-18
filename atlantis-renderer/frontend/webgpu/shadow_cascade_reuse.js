                                                                                    
  
                                                        
  
                                                                                
  
                                                                                          
                                                                                
                                                                  
                       
                                                                                         
                                                                                     
                                                                                       
                                                         
           
                                                                                              
                                                                                
  
                                                                                  
                                                                                
                                                                                 
                                                                                  
                                                                                   
                                                                               
                                                                                 
  
                                                                                    
                                                                               
                                                                              
                                                                                    
                                                                                    
                                                                         

import {GPU as DEFAULT_GPU} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/math/index.js';
import {UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Uniforms.js';
import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';

export const SHADOW_CASCADE_REUSE_SCHEMA = 'aps-shadow-cascade-reuse/1';
export const SHADOW_CASCADE_REUSE_REVISION = 'shadow-cascade-reuse-r3-plane-reprojection';
export const SHADOW_CASCADE_REUSE_ENTRY = 'apsShadowReuseSkip';
export const SHADOW_CASCADE_REUSE_MAX_RATIO = 4;
export const SHADOW_CASCADE_REUSE_MAX_SPAN = 9;
export const SHADOW_CASCADE_REUSE_GUARD_COARSE_PIXELS = 1;
export const SHADOW_CASCADE_REUSE_SEED_BIAS = 0;

const TOL = 1e-5;
const EDGE_EPS = 1e-6;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function finiteNumber(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function matrixOf(value) {
  const elements = value?.elements ?? (Array.isArray(value) ? value : null);
  if (!elements || elements.length < 16) return null;
  const copy = Array.from(elements.slice(0, 16));
  if (!copy.every(Number.isFinite)) return null;
  return new Matrix4().fromArray(copy);
}

function pointOf(elements, x, y, z) {
  return [
    elements[0] * x + elements[4] * y + elements[8] * z + elements[12],
    elements[1] * x + elements[5] * y + elements[9] * z + elements[13],
    elements[2] * x + elements[6] * y + elements[10] * z + elements[14],
    elements[3] * x + elements[7] * y + elements[11] * z + elements[15],
  ];
}

                                                                            
export function lightPixelFromClip(size, x, y) {
  const s = Number(size);
  if (!(s > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [(x * 0.5 + 0.5) * s, (0.5 - y * 0.5) * s];
}

export function lightClipFromPixel(size, px, py) {
  const s = Number(size);
  if (!(s > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  return [(px / s) * 2 - 1, 1 - (py / s) * 2];
}

                                                                                
                                                                   
export function mapLightPixel(matrix, size, px, py) {
  const m = matrix?.elements ?? null;
  if (!m) return null;
  const clip = lightClipFromPixel(size, px, py);
  if (!clip) return null;
  const projected = pointOf(m, clip[0], clip[1], 0.5);
  if (!projected.every(Number.isFinite)) return null;
  const w = projected[3];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-20) return null;
  return lightPixelFromClip(size, projected[0] / w, projected[1] / w);
}

export function normalizedRect(scissor, size) {
  const s = Number(size);
  if (!Array.isArray(scissor) || scissor.length !== 4 || !(s > 0)) {
    throw Error('normalizedRect requires [minX,minY,maxX,maxY] and a positive size');
  }
  return [scissor[0] / s, scissor[1] / s, scissor[2] / s, scissor[3] / s];
}

                                                                           
                                                                             
                                    
export function shadowReuseTransform(sourceVP, targetVP) {
  const source = matrixOf(sourceVP);
  const target = matrixOf(targetVP);
  if (!source || !target) return {ok: false, reason: 'nonfinite-vp', supported: false};
  if (!(Math.abs(source.determinant()) > 1e-20) || !(Math.abs(target.determinant()) > 1e-20)) {
    return {ok: false, reason: 'singular-vp', supported: false};
  }
  const inverseSource = source.clone().invert();
  const targetFromSource = new Matrix4().multiplyMatrices(target, inverseSource);
  const sourceFromTarget = targetFromSource.clone().invert();
  if (!matrixOf(targetFromSource) || !matrixOf(sourceFromTarget)) {
    return {ok: false, reason: 'nonfinite-transform', supported: false};
  }
  return {ok: true, targetFromSource, sourceFromTarget, source, target};
}

                                                                                 
                                                                                  
                                                                 
export function analyzeShadowReusePair(sourceCascade, targetCascade) {
  const transform = shadowReuseTransform(sourceCascade?.viewProj, targetCascade?.viewProj);
  if (!transform.ok) return transform;

  const sourceNear = finiteNumber(sourceCascade?.camera?.near);
  const sourceFar = finiteNumber(sourceCascade?.camera?.far);
  const targetNear = finiteNumber(targetCascade?.camera?.near);
  const targetFar = finiteNumber(targetCascade?.camera?.far);
  if ([sourceNear, sourceFar, targetNear, targetFar].every(value => value != null)) {
    const nearTolerance = 1e-6 * Math.max(1, Math.abs(targetNear));
    const farTolerance = 1e-6 * Math.max(1, Math.abs(targetFar));
    if (Math.abs(sourceNear - targetNear) > nearTolerance
      || Math.abs(sourceFar - targetFar) > farTolerance) {
      return {ok: false, reason: 'depth-range-mismatch', supported: false, transform};
    }
  }

  const e = transform.targetFromSource.elements;
                                                                             
                                                                           
  if (Math.abs(e[8]) > TOL || Math.abs(e[9]) > TOL) {
    return {ok: false, reason: 'z-coupling', supported: false, transform};
  }
  if (Math.abs(e[2]) > TOL || Math.abs(e[6]) > TOL
    || Math.abs(e[10] - 1) > TOL || Math.abs(e[14]) > TOL) {
    return {ok: false, reason: 'depth-range-mismatch', supported: false, transform};
  }
  if (Math.abs(e[3]) > TOL || Math.abs(e[7]) > TOL
    || Math.abs(e[11]) > TOL || Math.abs(e[15] - 1) > TOL) {
    return {ok: false, reason: 'non-affine-transform', supported: false, transform};
  }

                                                                             
                                                                                   
  const sx = Math.hypot(e[0], e[1]);
  const sy = Math.hypot(e[4], e[5]);
  const scale = (sx + sy) / 2;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return {ok: false, reason: 'orientation-mismatch', supported: false, transform};
  }
  const axisTolerance = 1e-4 * Math.max(1, scale);
  if (Math.abs(e[1]) > axisTolerance || Math.abs(e[4]) > axisTolerance
    || Math.abs(e[0] - e[5]) > 1e-4 * Math.max(1, Math.abs(e[0]), Math.abs(e[5]))
    || !(e[0] > 0) || !(e[5] > 0)) {
    return {ok: false, reason: 'orientation-mismatch', supported: false, transform};
  }
  if (!(e[0] * e[5] - e[4] * e[1] > 0)) {
    return {ok: false, reason: 'orientation-mismatch', supported: false, transform};
  }
  if (scale > 1 + 1e-4) {
    return {ok: false, reason: 'source-not-finer', supported: false, transform, scale};
  }
  const ratio = 1 / scale;
  if (ratio > SHADOW_CASCADE_REUSE_MAX_RATIO + 1e-4) {
    return {ok: false, reason: 'ratio-exceeds-limit', supported: false, transform, scale, ratio};
  }

  const sourceRadius = finiteNumber(sourceCascade?.radius);
  const targetRadius = finiteNumber(targetCascade?.radius);
  if (sourceRadius != null && targetRadius != null) {
    if (!(sourceRadius > 0) || !(targetRadius > 0)) {
      return {ok: false, reason: 'invalid-radius', supported: false, transform};
    }
    const expected = sourceRadius / targetRadius;
    if (Math.abs(scale - expected) > Math.max(1e-4, expected * 1e-3)) {
      return {ok: false, reason: 'radius-mismatch', supported: false, transform, scale, ratio};
    }
  }

  return {
    ok: true, supported: true, transform,
    targetFromSource: transform.targetFromSource,
    sourceFromTarget: transform.sourceFromTarget,
    targetVP: transform.target,
    scale, ratio,
  };
}

                                                                              
                                                                                 
                                                                                   
export function shadowReuseScissor({
  targetFromSource, size, ratio, guard = SHADOW_CASCADE_REUSE_GUARD_COARSE_PIXELS,
} = {}) {
  const s = Number(size);
  const r = Number(ratio);
  const g = Number(guard);
  if (!(s > 0) || !Number.isInteger(s) || !(r > 0) || !Number.isFinite(r) || !(g >= 0)) {
    return {ok: false, reason: 'invalid-scissor-input'};
  }
  if (!targetFromSource?.elements) return {ok: false, reason: 'missing-transform'};
  const guardFine = r * g;
  if (!(guardFine > 0) || !(s > 2 * guardFine)) {
    return {ok: false, reason: 'guard-exhausted', guardFine};
  }
  const lo = guardFine;
  const hi = s - guardFine;
  const corners = [
    mapLightPixel(targetFromSource, s, lo, lo),
    mapLightPixel(targetFromSource, s, hi, lo),
    mapLightPixel(targetFromSource, s, lo, hi),
    mapLightPixel(targetFromSource, s, hi, hi),
  ];
  if (corners.some(corner => !corner)) {
    return {ok: false, reason: 'nonfinite-footprint', guardFine};
  }
  const snap = value => {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) <= EDGE_EPS ? rounded : value;
  };
  const minX = clamp(Math.ceil(snap(Math.min(...corners.map(corner => corner[0])))), 0, s);
  const minY = clamp(Math.ceil(snap(Math.min(...corners.map(corner => corner[1])))), 0, s);
  const maxX = clamp(Math.floor(snap(Math.max(...corners.map(corner => corner[0])))), 0, s);
  const maxY = clamp(Math.floor(snap(Math.max(...corners.map(corner => corner[1])))), 0, s);
  if (!(maxX > minX) || !(maxY > minY)) {
    return {ok: false, reason: 'empty-coverage', guardFine, bounds: [minX, minY, maxX, maxY]};
  }
  const scissor = [minX, minY, maxX, maxY];
  return {
    ok: true,
    scissor,
    rect: normalizedRect(scissor, s),
    guardFine,
    reusedPixels: (maxX - minX) * (maxY - minY),
  };
}

                                                                                
                                                                                  
                                                                                   
                                                  
export function footprintTexelRange(lo, hi, size, maxSpan = SHADOW_CASCADE_REUSE_MAX_SPAN) {
  const s = Number(size);
  const limit = Number(maxSpan);
  if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length < 2 || hi.length < 2
    || !lo.every(Number.isFinite) || !hi.every(Number.isFinite)
    || !(s > 0) || !Number.isInteger(s) || !Number.isInteger(limit) || limit < 1) {
    return {ok: false, reason: 'invalid-footprint'};
  }
  const first = [Math.floor(lo[0] + EDGE_EPS), Math.floor(lo[1] + EDGE_EPS)];
  const last = [Math.ceil(hi[0] - EDGE_EPS) - 1, Math.ceil(hi[1] - EDGE_EPS) - 1];
  if (first[0] < 0 || first[1] < 0 || last[0] >= s || last[1] >= s) {
    return {ok: false, reason: 'out-of-bounds', first, last};
  }
  if (last[0] < first[0] || last[1] < first[1]) {
    return {ok: false, reason: 'empty-footprint', first, last};
  }
  const span = [last[0] - first[0] + 1, last[1] - first[1] + 1];
  if (span[0] > limit || span[1] > limit) {
    return {ok: false, reason: 'footprint-too-large', first, last, span};
  }
  return {ok: true, first, last, span};
}

                                                                                 
                                                                              
export function minFootprintDepth(values) {
  if (!values || !values.length) return 1;
  let minimum = 1;
  for (const value of values) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    minimum = Math.min(minimum, v);
  }
  return minimum;
}

                                                                          
                                                                                
                                                                                 
                                                          
export const SHADOW_REUSE_COVERAGE_WGSL =            `
fn apsShadowReuseSkip(in: FragInput) -> bool {
  let clip = shadowReuse.targetVP * vec4f(in.P, 1.0);
  if (!(clip.w > 0.0)) { return false; }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let r = shadowReuse.rect;
  return uv.x >= r.x && uv.y >= r.y && uv.x < r.z && uv.y < r.w;
}
`;

                                                                                 
                                                                                 
                                                                             
                                                                                  
                                                                               
                                            
                                                                               
                                                                                 
                                                                               
                                                                               
export function reprojectFootprintDepth(depths,size,range,center,tolerance=5e-7){
  if(!range?.ok)return 1;
  const [x0,y0]=range.first,[x1,y1]=range.last;
  const samples=[];for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)samples.push(depths[y*size+x]);
  const minimum=minFootprintDepth(samples);
  if(minimum===null)return null;
  if(x1<=x0||y1<=y0||!center?.every(Number.isFinite))return minimum;
  const at=(x,y)=>Number(depths[y*size+x]),base=at(x0,y0),dx=at(x0+1,y0)-base,dy=at(x0,y0+1)-base;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const d=at(x,y),expected=base+dx*(x-x0)+dy*(y-y0);
    if(!(d>=0&&d<1)||Math.abs(d-expected)>tolerance)return minimum;
  }
  const depth=base+dx*(center[0]-x0-.5)+dy*(center[1]-y0-.5);
  return depth>=0&&depth<=1?depth:minimum;
}

export const SHADOW_REUSE_SEED_WGSL =            `
struct ShadowReuseSeed {
  sourceFromTarget: mat4x4f,
  params: vec4f,
};
@group(0) @binding(0) var sourceDepth: texture_depth_2d;
@group(0) @binding(1) var<uniform> seedParams: ShadowReuseSeed;

fn apsShadowReuseSourcePixel(px: vec2f) -> vec2f {
  let size = max(seedParams.params.x, 1.0);
  let clip = vec2f(px.x / size * 2.0 - 1.0, 1.0 - px.y / size * 2.0);
  let c = seedParams.sourceFromTarget * vec4f(clip, 0.0, 1.0);
  if (!(abs(c.w) > 1e-20)) { return vec2f(-1e20); }
  let s = c.xy / c.w;
  return vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5) * size;
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) coord: vec4f) -> @builtin(frag_depth) f32 {
  let size = max(seedParams.params.x, 1.0);
  let p = coord.xy;
  let a = apsShadowReuseSourcePixel(p + vec2f(-0.5, -0.5));
  let b = apsShadowReuseSourcePixel(p + vec2f(0.5, -0.5));
  let c = apsShadowReuseSourcePixel(p + vec2f(-0.5, 0.5));
  let d = apsShadowReuseSourcePixel(p + vec2f(0.5, 0.5));
  let lo = min(min(a, b), min(c, d));
  let hi = max(max(a, b), max(c, d));
  if (any(lo != lo) || any(hi != hi)) { return 1.0; }
  if (any(lo < vec2f(0.0)) || any(hi > vec2f(size))) { return 1.0; }
  let first = vec2i(floor(lo + 1e-6));
  let last = vec2i(ceil(hi - 1e-6)) - vec2i(1);
  let limit = vec2i(i32(size));
  if (any(first < vec2i(0)) || any(last >= limit) || any(last < first)) { return 1.0; }
  let maxSpan = i32(max(seedParams.params.y, 1.0));
  if (last.x - first.x >= maxSpan || last.y - first.y >= maxSpan) { return 1.0; }
  var depth = 1.0;
  let anchor=textureLoad(sourceDepth,first,0);
  let hasPlane=all(last>first);
  let stepX=textureLoad(sourceDepth,vec2i(min(first.x+1,last.x),first.y),0)-anchor;
  let stepY=textureLoad(sourceDepth,vec2i(first.x,min(first.y+1,last.y)),0)-anchor;
  var planar=hasPlane && anchor>=0.0 && anchor<1.0;
  for (var y = first.y; y <= last.y; y = y + 1) {
    for (var x = first.x; x <= last.x; x = x + 1) {
      let sampleDepth=textureLoad(sourceDepth,vec2i(x,y),0);
      depth = min(depth, sampleDepth);
      let predicted=anchor+stepX*f32(x-first.x)+stepY*f32(y-first.y);
      planar=planar && sampleDepth>=0.0 && sampleDepth<1.0 && abs(sampleDepth-predicted)<=5e-7;
    }
  }
  if (!(depth >= 0.0) || depth > 1.0) { return 1.0; }
  if(planar){
    let center=apsShadowReuseSourcePixel(p)-vec2f(first)-vec2f(.5);
    let projected=anchor+stepX*center.x+stepY*center.y;
    if(projected>=0.0 && projected<=1.0){return projected;}
  }
  return depth;
}
`;

function coverageFields() {
  return {
    targetVP: ['mat4x4f', new Matrix4()],
    rect: ['vec4f', [0, 0, 1, 1]],
  };
}

function seedFields() {
  return {
    sourceFromTarget: ['mat4x4f', new Matrix4()],
    params: ['vec4f', [1, SHADOW_CASCADE_REUSE_MAX_SPAN, 0, 0]],
  };
}

function pairKey(sourceLevel, targetLevel) {
  return `aps-shadow-reuse:${sourceLevel}->${targetLevel}`;
}

function asLayerView(value, label) {
  if (!value) throw Error(`shadow cascade reuse seed requires a ${label} texture view`);
  if (value.isTexture) {
    const depth = Number(value.depth ?? 1);
                                                                              
                                                                       
                                                                 
    if (value.dimension !== '2d' || depth !== 1) {
      throw Error(`shadow cascade reuse seed ${label} must be an explicit single-layer texture_depth_2d view, not ${value.dimension}(${depth})`);
    }
    return value.view({dimension: '2d'});
  }
  return value;
}

export class ShadowCascadeReuse {
  constructor({GPU: gpu = DEFAULT_GPU} = {}) {
    this.schema = SHADOW_CASCADE_REUSE_SCHEMA;
    this.revision = SHADOW_CASCADE_REUSE_REVISION;
    this.GPU = gpu;
    this.pairs = new Map();
    this.disposed = false;
    this.lastPlan = null;
    this._seedPipeline = null;
    this._seedLayout = null;
    this._seedBgl = null;
    this._seedDevice = null;
  }

  _pair(sourceLevel, targetLevel) {
    const key = pairKey(sourceLevel, targetLevel);
    let pair = this.pairs.get(key);
    if (!pair) {
      const coverageBlock = new UniformBlock('ShadowReuseCoverage', coverageFields(), {label: `${key}:coverage`});
      const seedBlock = new UniformBlock('ShadowReuseSeed', seedFields(), {label: `${key}:seed`});
      const coverageModule = new ShaderModule({
        name: `${key}:coverage`,
        uniforms: coverageBlock,
        uniformName: 'shadowReuse',
        code: SHADOW_REUSE_COVERAGE_WGSL,
      });
      pair = {
        key,
        sourceLevel,
        targetLevel,
        coverageBlock,
        seedBlock,
        coverageModule,
        coverage: {key, module: coverageModule, entry: SHADOW_CASCADE_REUSE_ENTRY},
        device: null,
        coverageBuffer: null,
        seedBuffer: null,
      };
      const upload = (block, getBuffer) => (token) => {
        const buffer = getBuffer();
        if (token !== undefined && token === block._token && buffer) return buffer;
        block._token = token;
        block._pack();
        const current = block.u32;
        const last = block._last;
        let dirty = false;
        for (let i = 0; i < current.length; i++) {
          if (current[i] !== last[i]) { dirty = true; break; }
        }
        if (dirty) {
          last.set(current);
          this.GPU.queue.writeBuffer(buffer, 0, block.data);
        }
        return buffer;
      };
      coverageBlock.upload = upload(coverageBlock, () => pair.coverageBuffer);
      seedBlock.upload = upload(seedBlock, () => pair.seedBuffer);
      this.pairs.set(key, pair);
    }
    return pair;
  }

  _ensureBuffers(pair) {
    const device = this.GPU?.device;
    if (!device) return false;
    if (pair.device !== device || !pair.coverageBuffer || !pair.seedBuffer) {
      pair.coverageBuffer?.destroy?.();
      pair.seedBuffer?.destroy?.();
      pair.coverageBuffer = device.createBuffer({
        label: `${pair.key}:coverage uniform`,
        size: pair.coverageBlock.byteLength,
                                                                              
                                                                               
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      pair.seedBuffer = device.createBuffer({
        label: `${pair.key}:seed uniform`,
        size: pair.seedBlock.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      pair.coverageBlock.buffer = pair.coverageBuffer;
      pair.seedBlock.buffer = pair.seedBuffer;
      pair.coverageBlock._last = new Uint32Array(pair.coverageBlock.byteLength / 4);
      pair.coverageBlock._last.fill(0xffffffff);
      pair.seedBlock._last = new Uint32Array(pair.seedBlock.byteLength / 4);
      pair.seedBlock._last.fill(0xffffffff);
      pair.coverageBlock._token = null;
      pair.seedBlock._token = null;
      pair.device = device;
    }
    return true;
  }

  _flushBlock(block, buffer) {
    const device = this.GPU?.device;
    const queue = this.GPU?.queue ?? device?.queue;
    if (!device || !buffer || typeof queue?.writeBuffer !== 'function') return;
    block._pack();
    queue.writeBuffer(buffer, 0, block.data);
    if (block._last) block._last.set(block.u32);
    block._token = null;
  }

  _writePair(pair, analysis, scissorPlan) {
    pair.coverageBlock.values.targetVP = new Matrix4().fromArray(analysis.targetVP.elements);
    pair.coverageBlock.values.rect = scissorPlan.rect.slice();
    pair.seedBlock.values.sourceFromTarget = new Matrix4().fromArray(analysis.sourceFromTarget.elements);
    pair.seedBlock.values.params = [scissorPlan.size, SHADOW_CASCADE_REUSE_MAX_SPAN, 0, 0];
    if (this._ensureBuffers(pair)) {
      this._flushBlock(pair.coverageBlock, pair.coverageBuffer);
      this._flushBlock(pair.seedBlock, pair.seedBuffer);
    }
  }

                                                                             
                                                                              
  prepareReuse({levels = [], mapSize = 1, cascades = [], reuseRequested = true, vegetationBudget = null} = {}) {
    if (this.disposed) return {supported: false, reason: 'disposed', levels: []};
    const size = Number(mapSize);
    if (!Number.isInteger(size) || size < 1) {
      return {supported: false, reason: 'invalid-map-size', levels: []};
    }
    if (!Array.isArray(cascades) || !cascades.length) {
      return {supported: false, reason: 'missing-cascades', levels: []};
    }
    const requestedLevels = [...new Set(levels)]
      .filter(level => Number.isInteger(level) && level >= 0 && level < cascades.length);
    if (!requestedLevels.length) {
      return {supported: true, levels: [], order: [], mapSize: size};
    }
                                                                                
                                                        
    const order = requestedLevels.slice().sort((a, b) => {
      const ar = finiteNumber(cascades[a]?.radius) ?? Infinity;
      const br = finiteNumber(cascades[b]?.radius) ?? Infinity;
      return ar === br ? a - b : ar - br;
    });
    const out = new Array(cascades.length).fill(null);
    for (let i = 0; i < order.length; i++) {
      const level = order[i];
      const sourceLevel = i > 0 ? order[i - 1] : null;
      const base = {
        cull: {enabled: false, sourceLevel, minU: 0, minV: 1, maxU: 1, maxV: 0},
        coverage: null,
        seedPlan: null,
        coverageRect: null,
        reusedPixels: 0,
        rejected: null,
        seed: false,
        reason: null,
      };
      if (sourceLevel == null) {
        base.reason = 'no-finer-source';
        base.rejected = base.reason;
        out[level] = base;
        continue;
      }
      if (sourceLevel >= level) {
        base.reason = 'source-order-unsupported';
        base.rejected = base.reason;
        out[level] = base;
        continue;
      }
      if (!reuseRequested) {
        base.reason = 'requested-off';
        base.rejected = base.reason;
        out[level] = base;
        continue;
      }
                                                                             
                                                                            
                                                                               
                                                                              
      const grassLevels = vegetationBudget?.grassLevels ?? 0;
      if ((sourceLevel < grassLevels) !== (level < grassLevels)) {
        base.reason = 'grass-policy-mismatch';
        base.rejected = base.reason;
        out[level] = base;
        continue;
      }
      const analysis = analyzeShadowReusePair(cascades[sourceLevel], cascades[level]);
      if (!analysis.ok) {
        base.reason = analysis.reason;
        base.rejected = analysis.reason;
        out[level] = base;
        continue;
      }
      const scissorPlan = shadowReuseScissor({
        targetFromSource: analysis.targetFromSource,
        size,
        ratio: analysis.ratio,
      });
      if (!scissorPlan.ok) {
        base.reason = scissorPlan.reason;
        base.rejected = scissorPlan.reason;
        out[level] = base;
        continue;
      }
      scissorPlan.size = size;
      const pair = this._pair(sourceLevel, level);
      this._writePair(pair, analysis, scissorPlan);
      base.cull = {
        enabled: true,
        sourceLevel,
        minU: scissorPlan.scissor[0],
        minV: scissorPlan.scissor[1],
        maxU: scissorPlan.scissor[2],
        maxV: scissorPlan.scissor[3],
      };
      base.coverage = pair.coverage;
      base.coverageRect = scissorPlan.rect.slice();
      base.reusedPixels = scissorPlan.reusedPixels;
      base.seed = true;
      base.reason = 'reuse';
      base.seedPlan = {
        sourceLevel,
        targetLevel: level,
        size,
        scissor: scissorPlan.scissor.slice(),
        rect: scissorPlan.rect.slice(),
        ratio: analysis.ratio,
        scale: analysis.scale,
        guardFine: scissorPlan.guardFine,
        maxSpan: SHADOW_CASCADE_REUSE_MAX_SPAN,
        sourceFromTarget: analysis.sourceFromTarget.elements.slice(),
        targetFromSource: analysis.targetFromSource.elements.slice(),
        uniformBuffer: pair.key,
      };
      out[level] = base;
    }
    this.lastPlan = {
      frame: this.GPU?.frame ?? null,
      mapSize: size,
      order: order.slice(),
      enabled: out.filter(info => info?.cull?.enabled).map(info => info.seedPlan.targetLevel),
    };
    return {supported: true, levels: out, order: order.slice(), mapSize: size};
  }

  _ensureSeedPipeline() {
    const device = this.GPU?.device;
    if (!device) throw Error('shadow cascade reuse seed requires a live WebGPU device');
    if (this._seedPipeline && this._seedDevice === device) return;
    this._seedPipeline = null;
    this._seedLayout = null;
    this._seedBgl = null;
    const module = device.createShaderModule({
      label: 'APS shadow cascade reuse seed',
      code: SHADOW_REUSE_SEED_WGSL,
    });
    const bgl = device.createBindGroupLayout({
      label: 'APS shadow cascade reuse seed bind group',
      entries: [
        {binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: 'depth', viewDimension: '2d'}},
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: {type: 'uniform'}},
      ],
    });
    const layout = device.createPipelineLayout({
      label: 'APS shadow cascade reuse seed pipeline layout',
      bindGroupLayouts: [bgl],
    });
    const pipeline = device.createRenderPipeline({
      label: 'APS shadow cascade reuse seed pipeline',
      layout,
      vertex: {module, entryPoint: 'vs'},
      fragment: {module, entryPoint: 'fs', targets: []},
      primitive: {topology: 'triangle-list'},
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
        depthBias: SHADOW_CASCADE_REUSE_SEED_BIAS,
        depthBiasSlopeScale: 0,
      },
    });
    this._seedDevice = device;
    this._seedBgl = bgl;
    this._seedLayout = layout;
    this._seedPipeline = pipeline;
  }

                                                                            
                                                                                  
                                                                               
                                                                      
  seed({
    encoder, shadows, level, size, sourceLevel, fineView, coarseView, plan, depthBias,
  } = {}) {
    if (this.disposed) return false;
    void depthBias;
    const mapSize = Number(size);
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw Error('shadow cascade reuse seed requires an integer map size');
    }
    if (!Number.isInteger(level) || !Number.isInteger(sourceLevel) || sourceLevel >= level) {
      throw Error(`shadow cascade reuse seed requires sourceLevel < level (${sourceLevel}->${level})`);
    }
    if (shadows && Number.isFinite(shadows.size) && Number(shadows.size) !== mapSize) {
      throw Error(`shadow cascade reuse seed size ${mapSize} does not match shadow map ${shadows.size}`);
    }
    const pair = this.pairs.get(pairKey(sourceLevel, level));
    if (!pair) throw Error(`shadow cascade reuse pair ${sourceLevel}->${level} was not prepared`);
    const scissor = plan?.seedPlan?.scissor;
    if (!Array.isArray(scissor) || scissor.length !== 4) {
      throw Error('shadow cascade reuse seed requires plan.seedPlan.scissor');
    }
    const [minX, minY, maxX, maxY] = scissor.map(value => Math.round(Number(value)));
    if (![minX, minY, maxX, maxY].every(Number.isFinite)
      || minX < 0 || minY < 0 || maxX > mapSize || maxY > mapSize
      || maxX <= minX || maxY <= minY) {
      throw Error(`shadow cascade reuse seed scissor ${JSON.stringify(scissor)} is outside ${mapSize}`);
    }
    if (!this._ensureBuffers(pair)) {
      throw Error('shadow cascade reuse seed has no allocated pair uniform buffer');
    }
    if (plan?.seedPlan?.sourceFromTarget?.length >= 16) {
      pair.seedBlock.values.sourceFromTarget = new Matrix4().fromArray(plan.seedPlan.sourceFromTarget);
    }
    pair.seedBlock.values.params = [mapSize, SHADOW_CASCADE_REUSE_MAX_SPAN, 0, 0];
    this._flushBlock(pair.seedBlock, pair.seedBuffer);
    const fine = asLayerView(fineView, 'fine');
    const coarse = asLayerView(coarseView, 'coarse');
    if (fine === coarse) throw Error('shadow cascade reuse seed must not self-sample the coarse layer');
    this._ensureSeedPipeline();
    const bindGroup = this.GPU.device.createBindGroup({
      label: `${pair.key}:seed bind group`,
      layout: this._seedBgl,
      entries: [
        {binding: 0, resource: fine},
        {binding: 1, resource: {buffer: pair.seedBuffer}},
      ],
    });
    const recorder = encoder ?? this.GPU.getEncoder();
    const pass = recorder.beginRenderPass({
      label: `APS shadow cascade reuse seed ${sourceLevel}->${level}`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: coarse,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this._seedPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setScissorRect(minX, minY, maxX - minX, maxY - minY);
    pass.draw(3);
    pass.end();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pair of this.pairs.values()) {
      pair.coverageBuffer?.destroy?.();
      pair.seedBuffer?.destroy?.();
      pair.coverageBuffer = null;
      pair.seedBuffer = null;
      pair.device = null;
    }
    this.pairs.clear();
    this._seedPipeline = null;
    this._seedLayout = null;
    this._seedBgl = null;
    this._seedDevice = null;
    this.lastPlan = null;
  }
}

export default ShadowCascadeReuse;
