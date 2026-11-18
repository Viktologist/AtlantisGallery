                                                                    
  
                                                                          
                                                                                
                                                                    
                                                                               
                                                        
  
                                                                 
                                                                              
                                                                                
                                                                            
                                                                                
                       
                                                             
                                                                                
                                                                
                                                                             
                                     
                                                                              
                                                        
                                                                             
                                                    
  
                                                                     
                                                                             
                                                                             
                                                                         
                                                                               
                                                                           
                                                                               
                                                                            
                                                                      
                                                                            
                                                                              
                                                                           
                                                                            
                                                                             
                                                          
export const RECEIVER_DEMAND_SCHEMA = 'aps-receiver-driven-shadows/demand/1';
export const RECEIVER_DEMAND_LEVELS = 4;
export const RECEIVER_DEMAND_STRIDE_BYTES = 32;
export const RECEIVER_DEMAND_BYTES = 128;
export const LIGHT_FRAME_BYTES = 528;
export const EXTERNAL_DEMAND_BYTES = 400;
export const EXTERNAL_DEMAND_MAX_BOXES = 8;
export const UV_QUANT_MAX = 65535;
export const Z_QUANT_MAX = 16777215;

export const RECEIVER_DEMAND_FLAGS = Object.freeze({
  hasReceivers: 1,
  legacyFull: 2,
  edgeConservative: 4,
  externalUnion: 8,
  tileMaskValid: 16,
});

export const RECEIVER_DEMAND_FIELDS = Object.freeze([
  Object.freeze({ offset: 0, name: 'minU', type: 'u32' }),
  Object.freeze({ offset: 4, name: 'minV', type: 'u32' }),
  Object.freeze({ offset: 8, name: 'minZ', type: 'u32' }),
  Object.freeze({ offset: 12, name: 'count', type: 'u32' }),
  Object.freeze({ offset: 16, name: 'maxU', type: 'u32' }),
  Object.freeze({ offset: 20, name: 'maxV', type: 'u32' }),
  Object.freeze({ offset: 24, name: 'maxZ', type: 'u32' }),
  Object.freeze({ offset: 28, name: 'flags', type: 'u32' }),
]);

export function receiverDemandLayout() {
  return {
    schema: RECEIVER_DEMAND_SCHEMA,
    levels: RECEIVER_DEMAND_LEVELS,
    stride_bytes: RECEIVER_DEMAND_STRIDE_BYTES,
    bytes: RECEIVER_DEMAND_BYTES,
    fields: RECEIVER_DEMAND_FIELDS.map((field) => ({ ...field })),
  };
}

export function quantizeU16(value) {
  return Math.min(UV_QUANT_MAX, Math.max(0, Math.round(value * UV_QUANT_MAX)));
}

export function quantizeZ24(value) {
  return Math.min(Z_QUANT_MAX, Math.max(0, Math.round(value * Z_QUANT_MAX)));
}

export function dequantizeU16(value) {
  return value / UV_QUANT_MAX;
}

export function dequantizeZ24(value) {
  return value / Z_QUANT_MAX;
}

export function demandFlags(value) {
  return {
    hasReceivers: (value & RECEIVER_DEMAND_FLAGS.hasReceivers) !== 0,
    legacyFull: (value & RECEIVER_DEMAND_FLAGS.legacyFull) !== 0,
    edgeConservative: (value & RECEIVER_DEMAND_FLAGS.edgeConservative) !== 0,
    externalUnion: (value & RECEIVER_DEMAND_FLAGS.externalUnion) !== 0,
    tileMaskValid: (value & RECEIVER_DEMAND_FLAGS.tileMaskValid) !== 0,
  };
}

export function receiverPadTexels(normalBias, texelWorld) {
  const texel = Math.max(Number(texelWorld) || 0, 1e-9);
  return 24 + 1 + Math.ceil(Math.max(0, Number(normalBias) || 0) / texel) + 1;
}

export function receiverDepthPad(normalBias, occlusionBias, texelWorld) {
  return Math.max(0, Number(normalBias) || 0) + Math.max(0, Number(occlusionBias) || 0) + 2 * Math.max(0, Number(texelWorld) || 0);
}

                                                                         
export function projectWorldToLevel(viewProj, point) {
  const e = viewProj?.elements ?? viewProj;
  if (!e || e.length < 16) throw Error('viewProj must provide 16 column-major elements');
  const [x, y, z] = point;
  const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
  const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (![cx, cy, cz, cw].every(Number.isFinite) || Math.abs(cw) < 1e-12) return null;
  const ndc = [cx / cw, cy / cw, cz / cw];
  return { ndc, u: ndc[0] * 0.5 + 0.5, v: 0.5 - ndc[1] * 0.5, z: ndc[2], w: cw };
}

                                                                               
                                                                           
                                                                        
export function conservativeQuantizedBounds(points, viewProj, {
  mapSize = 2048,
  near = 0.1,
  far = 10000,
  normalBias = 0.1,
  occlusionBias = 0.05,
  texelWorld = 1,
} = {}) {
  let minU = Infinity, minV = Infinity, minZ = Infinity;
  let maxU = -Infinity, maxV = -Infinity, maxZ = -Infinity;
  const projected = [];
  for (const point of points) {
    const p = projectWorldToLevel(viewProj, point);
    if (!p) continue;
    if (p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1 || p.z < -0.001 || p.z > 1.001) continue;
    const qu = quantizeU16(p.u), qv = quantizeU16(p.v), qz = quantizeZ24(p.z);
    minU = Math.min(minU, qu); minV = Math.min(minV, qv); minZ = Math.min(minZ, qz);
    maxU = Math.max(maxU, qu); maxV = Math.max(maxV, qv); maxZ = Math.max(maxZ, qz);
    projected.push({ u: qu, v: qv, z: qz });
  }
  if (!projected.length) {
    return { count: 0, minU: 0, minV: 0, minZ: 0, maxU: 0, maxV: 0, maxZ: 0, projected };
  }
  const padU = Math.ceil(receiverPadTexels(normalBias, texelWorld) / Math.max(mapSize, 1) * UV_QUANT_MAX);
  const padZ = Math.ceil(receiverDepthPad(normalBias, occlusionBias, texelWorld) / Math.max(far - near, 1e-6) * Z_QUANT_MAX);
  return {
    count: projected.length,
    minU: Math.max(0, minU - padU),
    minV: Math.max(0, minV - padU),
    minZ: Math.max(0, minZ - padZ),
    maxU: Math.min(UV_QUANT_MAX, maxU + padU),
    maxV: Math.min(UV_QUANT_MAX, maxV + padU),
    maxZ: Math.min(Z_QUANT_MAX, maxZ + padZ),
    padU,
    padZ,
    projected,
  };
}

export const RECEIVER_DEMAND_RESET_WGSL =           `
struct RawLevel {
  minU: atomic<u32>,
  minV: atomic<u32>,
  minZ: atomic<u32>,
  count: atomic<u32>,
  maxU: atomic<u32>,
  maxV: atomic<u32>,
  maxZ: atomic<u32>,
  flags: atomic<u32>,
};

@group(0) @binding(0) var<storage, read_write> raw: array<RawLevel, 4>;

@compute @workgroup_size(4, 1, 1)
fn main(@builtin(local_invocation_index) lane: u32) {
  if (lane >= 4u) { return; }
  atomicStore(&raw[lane].minU, 65535u);
  atomicStore(&raw[lane].minV, 65535u);
  atomicStore(&raw[lane].minZ, 16777215u);
  atomicStore(&raw[lane].count, 0u);
  atomicStore(&raw[lane].maxU, 0u);
  atomicStore(&raw[lane].maxV, 0u);
  atomicStore(&raw[lane].maxZ, 0u);
  atomicStore(&raw[lane].flags, 0u);
}
`;

export const RECEIVER_DEMAND_REDUCE_WGSL =           `
struct RawLevel {
  minU: atomic<u32>,
  minV: atomic<u32>,
  minZ: atomic<u32>,
  count: atomic<u32>,
  maxU: atomic<u32>,
  maxV: atomic<u32>,
  maxZ: atomic<u32>,
  flags: atomic<u32>,
};

struct LightLevel {
  viewProj: mat4x4f,
  externalRect: vec4f,
  nearFarTexel: vec4f,
  demandPad: vec4f,
};

struct LightFrame {
  basis: mat3x3f,
  sunDir: vec4f,
  map: vec4f,
  levels: array<LightLevel, 4>,
};

@group(0) @binding(0) var xyz: texture_2d<f32>;
@group(0) @binding(1) var<uniform> light: LightFrame;
@group(0) @binding(2) var<storage, read_write> raw: array<RawLevel, 4>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(xyz);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let sample = textureLoad(xyz, vec2i(gid.xy), 0);
  // Alpha is validity, not coverage alpha. Sky/cleared pixels never enter demand.
  if (sample.w < 0.5) { return; }
  let p = sample.xyz;
  // The removed WGSL NaN/Inf helpers are unavailable. An all-ones exponent is
  // exactly Inf or NaN for f32, so test the loaded value's exponent bits.
  let exponent = bitcast<vec3u>(p) & vec3u(0x7f800000u);
  if (any(exponent == vec3u(0x7f800000u))) { return; }

  for (var level = 0u; level < 4u; level = level + 1u) {
    // Exactly the current cascade.viewProj for this level. No derived or
    // previous-frame projection enters the demand.
    let clip = light.levels[level].viewProj * vec4f(p, 1.0);
    if (abs(clip.w) < 1e-7) { continue; }
    let ndc = clip.xyz / clip.w;
    let u = ndc.x * 0.5 + 0.5;
    let v = 0.5 - ndc.y * 0.5;
    let z = ndc.z;
    // Outside the cascade's light-space volume cannot receive that cascade.
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0 || z < -0.001 || z > 1.001) { continue; }
    let qu = u32(clamp(u, 0.0, 1.0) * 65535.0 + 0.5);
    let qv = u32(clamp(v, 0.0, 1.0) * 65535.0 + 0.5);
    let qz = u32(clamp(z, 0.0, 1.0) * 16777215.0 + 0.5);
    atomicMin(&raw[level].minU, qu);
    atomicMin(&raw[level].minV, qv);
    atomicMin(&raw[level].minZ, qz);
    atomicMax(&raw[level].maxU, qu);
    atomicMax(&raw[level].maxV, qv);
    atomicMax(&raw[level].maxZ, qz);
    atomicAdd(&raw[level].count, 1u);
  }
}
`;

export const RECEIVER_DEMAND_FINALIZE_WGSL =           `
struct RawLevel {
  minU: atomic<u32>,
  minV: atomic<u32>,
  minZ: atomic<u32>,
  count: atomic<u32>,
  maxU: atomic<u32>,
  maxV: atomic<u32>,
  maxZ: atomic<u32>,
  flags: atomic<u32>,
};

struct Level {
  minU: u32,
  minV: u32,
  minZ: u32,
  count: u32,
  maxU: u32,
  maxV: u32,
  maxZ: u32,
  flags: u32,
};

struct LightLevel {
  viewProj: mat4x4f,
  externalRect: vec4f,
  nearFarTexel: vec4f,
  demandPad: vec4f,
};

struct LightFrame {
  basis: mat3x3f,
  sunDir: vec4f,
  map: vec4f,
  levels: array<LightLevel, 4>,
};

struct DemandBox {
  min: vec4f,
  max: vec4f,
  flags: vec4f,
};

struct ExternalDemand {
  count: u32,
  legacyFull: u32,
  maxDemandFraction: f32,
  pad: f32,
  boxes: array<DemandBox, 8>,
};

@group(0) @binding(0) var<storage, read_write> raw: array<RawLevel, 4>;
@group(0) @binding(1) var<storage, read_write> demand: array<Level, 4>;
@group(0) @binding(2) var<uniform> light: LightFrame;
@group(0) @binding(3) var<uniform> externalDemandInput: ExternalDemand;

fn quantU(v: f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * 65535.0 + 0.5); }
fn quantZ(v: f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * 16777215.0 + 0.5); }

@compute @workgroup_size(4, 1, 1)
fn main(@builtin(local_invocation_index) lane: u32) {
  if (lane >= 4u) { return; }
  let level = lane;
  let rawCount = atomicLoad(&raw[level].count);
  var minU = atomicLoad(&raw[level].minU);
  var minV = atomicLoad(&raw[level].minV);
  var minZ = atomicLoad(&raw[level].minZ);
  var maxU = atomicLoad(&raw[level].maxU);
  var maxV = atomicLoad(&raw[level].maxV);
  var maxZ = atomicLoad(&raw[level].maxZ);

  var legacy = externalDemandInput.legacyFull != 0u;
  var count = rawCount;
  var finiteNonEmpty = false;
  var boxNonEmpty = false;
  var boxEdge = false;
  var rawEdge = false;
  var extMinU = 65535u;
  var extMinV = 65535u;
  var extMaxU = 0u;
  var extMaxV = 0u;
  var boxMinZ = 16777215u;
  var boxMaxZ = 0u;

  // The same receiver sampling footprint the raw XYZ demand uses. Applying it
  // to the finite external rectangle keeps PCSS filter taps and the receiver
  // normal offset inside the padded receiver domain. It is the only expansion
  // of the finite rectangle besides the CPU's outward quantization padding.
  let depthPad = max(light.levels[level].demandPad.y, 0.0);
  let padTexels = max(light.levels[level].demandPad.x, 0.0);
  let padU = u32(clamp(ceil(padTexels / max(light.map.x, 1.0) * 65535.0), 0.0, 65535.0));
  let padZ = u32(clamp(ceil(depthPad / max(light.levels[level].nearFarTexel.y - light.levels[level].nearFarTexel.x, 1e-6) * 16777215.0), 0.0, 16777215.0));

  // Finite external receiver rectangle from the current cascade's
  // main-frustum intersection. demandPad.w is the per-level presence flag:
  // 0 absent, 1 finite non-empty, 2 finite empty, 3 full-fills-clipmap.
  let extMode = u32(light.levels[level].demandPad.w + 0.5);
  if (extMode == 1u || extMode == 3u) {
    let rect = light.levels[level].externalRect;
    // var, not let: the outward pad below rewrites these quantized bounds.
    var eMinU = quantU(rect.x);
    var eMinV = quantU(rect.y);
    var eMaxU = quantU(rect.z);
    var eMaxV = quantU(rect.w);
    if (eMinU <= eMaxU && eMinV <= eMaxV) {
      finiteNonEmpty = true;
      eMinU = eMinU - min(eMinU, padU);
      eMinV = eMinV - min(eMinV, padU);
      eMaxU = min(65535u, eMaxU + padU);
      eMaxV = min(65535u, eMaxV + padU);
      extMinU = min(extMinU, eMinU);
      extMinV = min(extMinV, eMinV);
      extMaxU = max(extMaxU, eMaxU);
      extMaxV = max(extMaxV, eMaxV);
    }
    if (extMode == 3u) { legacy = true; }
  }

  // Legacy/certified world boxes remain an additional finite union for
  // genuinely different-camera consumers. Their Z is retained when no finite
  // main-camera rectangle is present. Boxes are padded exactly like raw XYZ:
  // a box stores the receiving surface bounds, so any filter tap, normal offset
  // or quantization step outside those bounds still needs the caster.
  let boxCount = min(externalDemandInput.count, 8u);
  for (var b = 0u; b < boxCount; b = b + 1u) {
    let box = externalDemandInput.boxes[b];
    if (box.flags.x < 0.5) { continue; }
    if (box.flags.y > 0.5) { legacy = true; }
    var bMinU = 1e30;
    var bMinV = 1e30;
    var bMinZ = 1e30;
    var bMaxU = -1e30;
    var bMaxV = -1e30;
    var bMaxZ = -1e30;
    for (var c = 0u; c < 8u; c = c + 1u) {
      let corner = vec3f(
        select(box.min.x, box.max.x, (c & 1u) != 0u),
        select(box.min.y, box.max.y, (c & 2u) != 0u),
        select(box.min.z, box.max.z, (c & 4u) != 0u)
      );
      let clip = light.levels[level].viewProj * vec4f(corner, 1.0);
      if (abs(clip.w) < 1e-7) { continue; }
      let ndc = clip.xyz / clip.w;
      bMinU = min(bMinU, ndc.x * 0.5 + 0.5);
      bMinV = min(bMinV, 0.5 - ndc.y * 0.5);
      bMaxU = max(bMaxU, ndc.x * 0.5 + 0.5);
      bMaxV = max(bMaxV, 0.5 - ndc.y * 0.5);
      bMinZ = min(bMinZ, ndc.z);
      bMaxZ = max(bMaxZ, ndc.z);
    }
    if (bMinU <= bMaxU) {
      boxNonEmpty = true;
      if (bMinU <= 0.0 || bMaxU >= 1.0 || bMinV <= 0.0 || bMaxV >= 1.0) { boxEdge = true; }
      // Quantize outward, then apply the identical padU/padZ that raw XYZ and
      // the finite rectangle use. Sub-texel and f32->u32 rounding can only
      // grow the padded rect; a map-border clamp is outward too, and boxEdge
      // still records the untrusted (no finite certificate) case below.
      var qMinU = quantU(bMinU);
      var qMinV = quantU(bMinV);
      var qMaxU = quantU(bMaxU);
      var qMaxV = quantU(bMaxV);
      var qMinZ = quantZ(bMinZ);
      var qMaxZ = quantZ(bMaxZ);
      qMinU = qMinU - min(qMinU, padU);
      qMinV = qMinV - min(qMinV, padU);
      qMaxU = min(65535u, qMaxU + padU);
      qMaxV = min(65535u, qMaxV + padU);
      qMinZ = qMinZ - min(qMinZ, padZ);
      qMaxZ = min(16777215u, qMaxZ + padZ);
      extMinU = min(extMinU, qMinU);
      extMinV = min(extMinV, qMinV);
      extMaxU = max(extMaxU, qMaxU);
      extMaxV = max(extMaxV, qMaxV);
      boxMinZ = min(boxMinZ, qMinZ);
      boxMaxZ = max(boxMaxZ, qMaxZ);
    }
  }

  // Flag 0 means "no finite external rectangle" and must preserve the old
  // box-only behavior: a zero-XYZ level with a legacy/certified box consumer
  // takes the explicit full fallback rather than a zero-count demand.
  if (extMode == 0u && rawCount == 0u && boxNonEmpty) { legacy = true; }

  // Raw opaque XYZ demand and its own map-border conservatism. The edge flag is
  // computed from the padded raw rect before the external union so a finite
  // external rectangle that legitimately touches a clipmap border does not
  // disable demand-only culling.
  if (rawCount == 0u) {
    // Never seed the union at the texture origin: an external-only level must
    // start from its padded external rectangle (or padded box range). Starting
    // at (0,0) turns [0.4,0.6]x[0.5,0.7] into [0,0.6]x[0,0.7] and keeps every
    // caster between the origin and the real receivers. Truly empty demand
    // keeps the old zero fields and count 0.
    if (finiteNonEmpty) {
      minU = extMinU; minV = extMinV; minZ = 0u;
      maxU = extMaxU; maxV = extMaxV; maxZ = 16777215u;
    } else if (boxNonEmpty) {
      minU = extMinU; minV = extMinV; minZ = boxMinZ;
      maxU = extMaxU; maxV = extMaxV; maxZ = boxMaxZ;
    } else {
      minU = 0u; minV = 0u; minZ = 0u; maxU = 0u; maxV = 0u; maxZ = 0u;
    }
  } else {
    minU = minU - min(minU, padU);
    minV = minV - min(minV, padU);
    minZ = minZ - min(minZ, padZ);
    maxU = min(65535u, maxU + padU);
    maxV = min(65535u, maxV + padU);
    maxZ = min(16777215u, maxZ + padZ);
    if (minU == 0u || minV == 0u || maxU == 65535u || maxV == 65535u) { rawEdge = true; }
    // Union with sources that were padded by the exact same padU/padZ.
    if (finiteNonEmpty) {
      minU = min(minU, extMinU);
      minV = min(minV, extMinV);
      maxU = max(maxU, extMaxU);
      maxV = max(maxV, extMaxV);
      // Conservative depth range: a finite XY receiver domain must never remove
      // a caster that is closer to the light than the receivers.
      minZ = 0u;
      maxZ = 16777215u;
    } else if (boxNonEmpty) {
      minU = min(minU, extMinU);
      minV = min(minV, extMinV);
      maxU = max(maxU, extMaxU);
      maxV = max(maxV, extMaxV);
      minZ = min(minZ, boxMinZ);
      maxZ = max(maxZ, boxMaxZ);
    }
  }

  var extArea: f32 = 0.0;
  if (finiteNonEmpty || boxNonEmpty) {
    extArea = (f32(extMaxU - extMinU) / 65535.0) * (f32(extMaxV - extMinV) / 65535.0);
  }
  // A finite external rectangle that fills the clipmap gains nothing from a
  // partial union; take the explicit full fallback for this level only.
  if (!legacy && (finiteNonEmpty || boxNonEmpty) && extArea > externalDemandInput.maxDemandFraction) {
    legacy = true;
  }

  // A finite external domain still needs a non-zero demand count so the caster
  // compaction and the light cull do not treat the level as empty. The value is
  // one synthetic demand unit, not an XYZ pixel count.
  if (rawCount == 0u && (finiteNonEmpty || boxNonEmpty)) { count = 1u; }

  if (legacy) {
    minU = 0u; minV = 0u; minZ = 0u;
    maxU = 65535u; maxV = 65535u; maxZ = 16777215u;
  }

  var flags = 0u;
  if (rawCount > 0u || finiteNonEmpty || boxNonEmpty) { flags = flags | 1u; }
  if (legacy) { flags = flags | 2u; }
  // edgeConservative is the "coverage is not certified" fail-open bit: the
  // light cull skips all demand-only count/XY/Z tests when it is set. A finite
  // non-empty main-frustum x light-clip rectangle certifies that every
  // main-view receiver (including every raw opaque pixel) lies inside the
  // padded union, and box consumers are fully described by their known world
  // bounds. Border contact of that union is then known coverage, not an
  // unknown extension, so setting bit 4 would only disable culling wholesale
  // (water/direct PCSS). Keep the bit for absent (0) and explicitly empty (2)
  // finite modes, opaque-only demand and legacy-only box fallbacks; no paired
  // light_cull_wgsl change is required.
  if (!finiteNonEmpty && (rawEdge || boxEdge)) { flags = flags | 4u; }
  if (finiteNonEmpty || boxNonEmpty) { flags = flags | 8u; }

  demand[level].minU = minU;
  demand[level].minV = minV;
  demand[level].minZ = minZ;
  demand[level].count = count;
  demand[level].maxU = maxU;
  demand[level].maxV = maxV;
  demand[level].maxZ = maxZ;
  demand[level].flags = flags;
}
`;

export function createReceiverShadowWGSL() {
  return {
    reset: RECEIVER_DEMAND_RESET_WGSL,
    reduce: RECEIVER_DEMAND_REDUCE_WGSL,
    finalize: RECEIVER_DEMAND_FINALIZE_WGSL,
  };
}
