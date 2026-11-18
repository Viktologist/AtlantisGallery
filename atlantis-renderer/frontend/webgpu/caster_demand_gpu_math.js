                                                                               
  
                                                                              
                                                                               
                                                              
                                                                                  
                                                                     
  
                                                                     
                                     
                                    
                                                                          
  
                                                                              
                                                       
                           
                           
                                                                          
                                                                      

export const CASTER_DEMAND_SCHEMA = 'aps-caster-demand-gpu/1';
export const CASTER_DEMAND_REVISION = 'aps-caster-demand-gpu-r1';

export const DEMAND_LEVELS = 4;
export const DEMAND_LEVEL_BYTES = 32;
export const DEMAND_BUFFER_BYTES = DEMAND_LEVELS * DEMAND_LEVEL_BYTES;
export const DEMAND_UV_SCALE = 65535;
export const DEMAND_Z_SCALE = 16777215;

export const DEMAND_FLAG_HAS_RECEIVERS = 1;
export const DEMAND_FLAG_LEGACY_FULL = 2;
export const DEMAND_FLAG_EDGE_CONSERVATIVE = 4;
export const DEMAND_FLAG_EXTERNAL_UNION = 8;
export const DEMAND_FLAG_TILE_MASK_VALID = 16;

export const CASTER_DEMAND_WORKGROUP = 64;
export const CASTER_DEMAND_DEFAULT_PAD_TEXELS = 2;
export const CASTER_DEMAND_DEFAULT_SHADOW_SIZE = 2048;
export const CASTER_DEMAND_DEFAULT_DEPTH_PAD = 0.005;
export const TERRAIN_CUBIC_STENCIL_CELLS = 1;

export const UV_MODE_SHADOW = 'shadow';
export const UV_MODE_CLIP = 'clip';

export const FALLBACK = Object.freeze({
  NO_RENDERER: 'no_renderer',
  NO_DEVICE: 'no_gpu_device',
  NO_DEMAND: 'no_demand_buffer',
  BAD_LEVEL: 'invalid_cascade_level',
  BAD_DEMAND: 'invalid_demand_buffer',
  PIPELINE_NOT_READY: 'pipeline_not_ready',
  PRECOMPILING: 'renderer_precompiling',
  NOT_DEPTH: 'not_a_depth_pass',
  NOT_CASTER: 'not_a_shadow_caster',
  TERRAIN_CASTER: 'terrain_caster_owned_by_terrain_path',
  EXISTING_INDIRECT: 'existing_indirect_geometry',
  MATERIAL_ARRAY: 'material_array',
  TRANSPARENT: 'transparent_material',
  ALPHA_TEST: 'alpha_test_material',
  TOPOLOGY: 'non_triangle_topology',
  DEFORMED: 'deformed_or_skinned',
  MANAGED_VEGETATION: 'managed_vegetation',
  NO_POSITION: 'no_position',
  NO_BOUNDS: 'unknown_world_bounds',
  INSTANCED_UNBATCHED: 'instanced_unbatched',
  GEOMETRY_GROUPS: 'geometry_groups',
  DRAW_RANGE: 'draw_range',
  EMPTY_RANGE: 'empty_primitives',
  INVALID_INSTANCES: 'invalid_instance_count',
  APS_PATCH_MISSING: 'apsPatch_missing',
  TERRAIN_BOUNDS: 'terrain_bounds_unavailable',
  DISPATCH_ERROR: 'dispatch_error',
});

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function quantizeUv(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(DEMAND_UV_SCALE, Math.round(clamp01(value) * DEMAND_UV_SCALE)));
}

export function quantizeZ(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(DEMAND_Z_SCALE, Math.round(clamp01(value) * DEMAND_Z_SCALE)));
}

export function dequantizeUv(value) {
  return value / DEMAND_UV_SCALE;
}

export function dequantizeZ(value) {
  return value / DEMAND_Z_SCALE;
}

export function demandWords(source) {
  if (!source) throw Error('Demand source is required');
  if (source instanceof ArrayBuffer) return new Uint32Array(source);
  if (ArrayBuffer.isView(source)) {
    if (source instanceof Uint32Array) return source;
    return new Uint32Array(source.buffer, source.byteOffset, Math.floor(source.byteLength / 4));
  }
  if (typeof source === 'object' && source.array) return demandWords(source.array);
  throw Error('Demand source must be an ArrayBuffer or typed array');
}

export function demandLevelValid(level) {
  return Number.isInteger(level) && level >= 0 && level < DEMAND_LEVELS;
}

                                                                                 
                                                                       
                                                               
export function readDemandLevel(source, level) {
  if (!demandLevelValid(level)) return invalidDemand(level, 'level');
  const words = demandWords(source);
  if (words.length < DEMAND_BUFFER_BYTES / 4) return invalidDemand(level, 'size');
  const o = level * 8;
  const minUQ = words[o], minVQ = words[o + 1], minZQ = words[o + 2], count = words[o + 3];
  const maxUQ = words[o + 4], maxVQ = words[o + 5], maxZQ = words[o + 6], flags = words[o + 7];
  const legacyFull = (flags & DEMAND_FLAG_LEGACY_FULL) !== 0;
  const range = minUQ <= maxUQ && minVQ <= maxVQ && minZQ <= maxZQ;
  const units = maxUQ <= DEMAND_UV_SCALE && maxVQ <= DEMAND_UV_SCALE && maxZQ <= DEMAND_Z_SCALE;
  const valid = !legacyFull && count > 0 && range && units;
  return {
    level, flags, count, legacyFull,
    hasReceivers: count > 0,
    edgeConservative: (flags & DEMAND_FLAG_EDGE_CONSERVATIVE) !== 0,
    externalUnion: (flags & DEMAND_FLAG_EXTERNAL_UNION) !== 0,
    tileMaskValid: (flags & DEMAND_FLAG_TILE_MASK_VALID) !== 0,
    minUQ, minVQ, minZQ, maxUQ, maxVQ, maxZQ,
    minU: dequantizeUv(minUQ), minV: dequantizeUv(minVQ), minZ: dequantizeZ(minZQ),
    maxU: dequantizeUv(maxUQ), maxV: dequantizeUv(maxVQ), maxZ: dequantizeZ(maxZQ),
    valid,
  };
}

function invalidDemand(level, reason) {
  return {
    level, flags: 0, count: 0, legacyFull: false, hasReceivers: false,
    edgeConservative: false, externalUnion: false, tileMaskValid: false,
    minUQ: 0, minVQ: 0, minZQ: 0, maxUQ: 0, maxVQ: 0, maxZQ: 0,
    minU: 0, minV: 0, minZ: 0, maxU: 0, maxV: 0, maxZ: 0,
    valid: false, invalidReason: reason,
  };
}

export function encodeDemandLevels(levels) {
  const out = new Uint32Array(DEMAND_BUFFER_BYTES / 4);
  for (let i = 0; i < Math.min(DEMAND_LEVELS, levels.length); i++) {
    const level = levels[i] ?? {};
    const o = i * 8;
    out[o] = level.minUQ ?? quantizeUv(level.minU ?? 0);
    out[o + 1] = level.minVQ ?? quantizeUv(level.minV ?? 0);
    out[o + 2] = level.minZQ ?? quantizeZ(level.minZ ?? 0);
    out[o + 3] = level.count ?? 0;
    out[o + 4] = level.maxUQ ?? quantizeUv(level.maxU ?? 1);
    out[o + 5] = level.maxVQ ?? quantizeUv(level.maxV ?? 1);
    out[o + 6] = level.maxZQ ?? quantizeZ(level.maxZ ?? 1);
    out[o + 7] = level.flags ?? 0;
  }
  return out;
}

export function matrixArray(viewProj) {
  const m = viewProj?.elements ?? viewProj;
  if (!m || m.length < 16) throw Error('Expected a 4x4 column-major light view-projection');
  return m;
}

export function uvModeValue(mode) {
  return mode === UV_MODE_CLIP ? 1 : 0;
}

export function projectBoundsToLight(bounds, viewProj, mode = UV_MODE_SHADOW) {
  const m = matrixArray(viewProj);
  const min = bounds?.min, max = bounds?.max;
  if (!min || !max || min.length < 3 || max.length < 3) return { valid: false };
  if (![...min.slice(0, 3), ...max.slice(0, 3)].every(Number.isFinite)) return { valid: false };
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return { valid: false };
  let minU = Infinity, minV = Infinity, minZ = Infinity;
  let maxU = -Infinity, maxV = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? max[0] : min[0];
    const y = i & 2 ? max[1] : min[1];
    const z = i & 4 ? max[2] : min[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (![cx, cy, cz].every(Number.isFinite)) return { valid: false };
    const u = cx * 0.5 + 0.5;
    const v = mode === UV_MODE_CLIP ? cy * 0.5 + 0.5 : 0.5 - cy * 0.5;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
  }
  return { valid: true, minU, minV, minZ, maxU, maxV, maxZ };
}

                                                                           
                                                                               
                                                                               
                                                                    
export function lightFrustumKeep(projected, {
  padUv = CASTER_DEMAND_DEFAULT_PAD_TEXELS / CASTER_DEMAND_DEFAULT_SHADOW_SIZE,
  depthPad = CASTER_DEMAND_DEFAULT_DEPTH_PAD,
} = {}) {
  if (!projected?.valid) return false;
  const pad = Number.isFinite(padUv) ? Math.max(0, padUv) : 0;
  const dep = Number.isFinite(depthPad) ? Math.max(0, depthPad) : 0;
  const xy = projected.maxU >= -pad && projected.minU <= 1 + pad
    && projected.maxV >= -pad && projected.minV <= 1 + pad;
  if (!xy) return false;
  return projected.maxZ >= -dep && projected.minZ <= 1 + dep;
}

                                                                         
                                                                            
                                                                       
                                                                                
                                                                                 
                                                                              
                                                                          
export function casterBoundsKeep(bounds, viewProj, demand, {
  padUv = CASTER_DEMAND_DEFAULT_PAD_TEXELS / CASTER_DEMAND_DEFAULT_SHADOW_SIZE,
  depthPad = CASTER_DEMAND_DEFAULT_DEPTH_PAD,
  uvMode = UV_MODE_SHADOW,
  forceFull = false,
} = {}) {
  const pad = Number.isFinite(padUv) ? Math.max(0, padUv) : 0;
  const dep = Number.isFinite(depthPad) ? Math.max(0, depthPad) : 0;
  if (!bounds || bounds.unknown) return { keep: true, reason: 'unknown_bounds_fail_open' };
  const projected = projectBoundsToLight(bounds, viewProj, uvMode);
  if (!projected.valid) return { keep: true, reason: 'projection_fail_open' };
                                                                        
                                                                               
                                                       
  if (!lightFrustumKeep(projected, { padUv: pad, depthPad: dep })) {
    return { keep: false, reason: 'outside_light_frustum', projected };
  }
  if (forceFull) return { keep: true, reason: 'force_full', projected };
  if (!demand || !demand.valid) return { keep: true, reason: 'demand_fail_open', projected };
  const overlap = projected.maxU >= demand.minU - pad
    && projected.minU <= demand.maxU + pad
    && projected.maxV >= demand.minV - pad
    && projected.minV <= demand.maxV + pad;
  if (!overlap) return { keep: false, reason: 'outside_demand_rect', projected };
  const behind = projected.minZ > demand.maxZ + dep;
  if (behind) return { keep: false, reason: 'behind_demanded_receivers', projected };
  return { keep: true, reason: 'possible_contribution', projected };
}

export function compactTerrainPatches({ bounds, patches, viewProj, demand, padUv, depthPad, uvMode, forceFull = false } = {}) {
  if (!bounds || !patches) throw Error('compactTerrainPatches requires bounds and patches');
  const count = Math.floor(bounds.length / 8);
  if (patches.length < count * 4) throw Error('Terrain patch records shorter than bounds');
  const kept = [], rejected = [], selectedPatches = [];
  for (let i = 0; i < count; i++) {
    const b = {
      min: [bounds[i * 8], bounds[i * 8 + 1], bounds[i * 8 + 2]],
      max: [bounds[i * 8 + 4], bounds[i * 8 + 5], bounds[i * 8 + 6]],
      unknown: bounds[i * 8 + 3] > 0.5,
    };
    const decision = casterBoundsKeep(b, viewProj, demand, { padUv, depthPad, uvMode, forceFull });
    if (!decision.keep) { rejected.push(i); continue; }
    kept.push(i);
    selectedPatches.push([
      patches[i * 4], patches[i * 4 + 1], patches[i * 4 + 2], patches[i * 4 + 3],
    ]);
  }
  return { kept, rejected, selectedPatches, count: kept.length, sourceCount: count };
}

                                                                            
  
                                                                           
                                                                              
                                                                              
                                                                          
                                                                               
                                                                               
                                                                            
                                                                               
                                                                          
const terrainBoundFloat = new Float32Array(1);
const terrainBoundBits = new Uint32Array(terrainBoundFloat.buffer);
function outwardTerrainBound(value, upper) {
  terrainBoundFloat[0] = value;
  const rounded = terrainBoundFloat[0];
  if (!Number.isFinite(rounded)) return NaN;
  if (upper ? rounded >= value : rounded <= value) return rounded;
  if (rounded === 0) { terrainBoundBits[0] = upper ? 1 : 0x80000001; return terrainBoundFloat[0]; }
  terrainBoundBits[0] += (rounded > 0) === upper ? 1 : -1;
  return terrainBoundFloat[0];
}

export function buildTerrainDemandBounds({ native, tiles, curved = false, interventionBound = 0, worldFromNative = null } = {}) {
  if (!native || !Array.isArray(tiles)) return null;
  const { shape, data } = native;
  if (!data || !shape || shape.length < 2) return null;
  const [nz, nx] = shape;
  if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 2 || nz < 2 || data.length < nx * nz) return null;
  const displacement = Number.isFinite(interventionBound) && interventionBound > 0 ? interventionBound : 0;
  const bounds = new Float32Array(tiles.length * 8);
  const patches = new Float32Array(tiles.length * 4);
  let unknown = 0;
  let expanded = 0;
  for (let t = 0; t < tiles.length; t++) {
    const tile = tiles[t];
    const patch = tile.patch ?? [0, 0, 64, 0];
    const x = patch[0], z = patch[1];
    const x1 = Math.min(x + 64, nx - 1), z1 = Math.min(z + 64, nz - 1);
    let low = tile.min[1] - displacement, high = tile.max[1] + displacement;
    let bad = !Number.isFinite(low) || !Number.isFinite(high);
    if (curved && !bad) {
      const x0 = Math.max(0, x - TERRAIN_CUBIC_STENCIL_CELLS);
      const x2 = Math.min(nx - 1, x1 + TERRAIN_CUBIC_STENCIL_CELLS);
      const z0 = Math.max(0, z - TERRAIN_CUBIC_STENCIL_CELLS);
      const z2 = Math.min(nz - 1, z1 + TERRAIN_CUBIC_STENCIL_CELLS);
      let cubicLow = Infinity, cubicHigh = -Infinity;
      for (let j = z0; j <= z2; j++) {
        for (let i = x0; i <= x2; i++) {
          const h = data[j * nx + i];
          if (!Number.isFinite(h)) { bad = true; break; }
          if (h < cubicLow) cubicLow = h;
          if (h > cubicHigh) cubicHigh = h;
        }
        if (bad) break;
      }
      if (!bad) {
        const nextLow = Math.min(low, cubicLow - displacement);
        const nextHigh = Math.max(high, cubicHigh + displacement);
        if (nextLow < low || nextHigh > high) expanded++;
        low = nextLow; high = nextHigh;
      }
    }
    if (bad) {
      unknown++;
      low = Number.isFinite(low) ? low : tile.min[1];
      high = Number.isFinite(high) ? high : tile.max[1];
    }
    let minX = tile.min[0], minZ = tile.min[2];
    let maxX = tile.max[0], maxZ = tile.max[2];
    if (![minX, low, minZ, maxX, high, maxZ].every(Number.isFinite)) {
      bad = true; unknown++;
    }
    if (worldFromNative && !bad) {
      const world = transformBox({min:[minX,low,minZ],max:[maxX,high,maxZ]}, worldFromNative);
      if (!world || ![...world.min,...world.max].every(Number.isFinite)) return null;
      [minX,low,minZ] = world.min.map(value=>outwardTerrainBound(value,false));
      [maxX,high,maxZ] = world.max.map(value=>outwardTerrainBound(value,true));
      if (![minX,low,minZ,maxX,high,maxZ].every(Number.isFinite)) return null;
    }
    bounds.set([
      minX, low, minZ, bad ? 1 : 0,
      maxX, high, maxZ, 0,
    ], t * 8);
    patches.set([patch[0], patch[1], patch[2], patch[3]], t * 4);
  }
  return { bounds, patches, count: tiles.length, unknown, expanded, curved: !!curved, interventionBound: displacement };
}

export function makeStaticCommand({ indexed, primitiveCount, instanceCount, start, firstInstance = 0, keep = true } = {}) {
  if (!keep) return new Uint32Array(5);
  if (indexed) return Uint32Array.from([primitiveCount, instanceCount, start, 0, firstInstance]);
  return Uint32Array.from([primitiveCount, instanceCount, start, firstInstance, 0]);
}

function arrayBox(box) {
  if (!box) return null;
  const min = box.min?.toArray ? box.min.toArray() : box.min;
  const max = box.max?.toArray ? box.max.toArray() : box.max;
  if (!min || !max || min.length < 3 || max.length < 3) return null;
  if (![...min.slice(0, 3), ...max.slice(0, 3)].every(Number.isFinite)) return null;
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

function transformBox(box, matrixWorld) {
  if (!box) return null;
  const e = matrixWorld?.elements ?? matrixWorld;
  if (!e || e.length < 16 || ![...e].slice(0, 16).every(Number.isFinite)) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max[0] : box.min[0];
    const y = i & 2 ? box.max[1] : box.min[1];
    const z = i & 4 ? box.max[2] : box.min[2];
    const px = e[0] * x + e[4] * y + e[8] * z + e[12];
    const py = e[1] * x + e[5] * y + e[9] * z + e[13];
    const pz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (![px, py, pz].every(Number.isFinite)) return null;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

                                                                             
                                                                               
                                                                               
                                                                          
export function staticCasterEligibility({ object, geometry, material, batchWorldBox = null, item = null } = {}) {
  if (!object?.isMesh || !geometry || !material) return { eligible: false, reason: FALLBACK.NO_POSITION };
  if (object.castShadow === false) return { eligible: false, reason: FALLBACK.NOT_CASTER };
  if (object.userData?.apsShadowOnly || object.userData?.apsTerrainOccluder) {
    return { eligible: false, reason: FALLBACK.TERRAIN_CASTER };
  }
  if (geometry.indirect) return { eligible: false, reason: FALLBACK.EXISTING_INDIRECT };
  if (Array.isArray(material)) return { eligible: false, reason: FALLBACK.MATERIAL_ARRAY };
  if (material.transparent) return { eligible: false, reason: FALLBACK.TRANSPARENT };
  if ((material.alphaTest ?? 0) > 0) return { eligible: false, reason: FALLBACK.ALPHA_TEST };
  const topology = material.topology ?? 'triangle-list';
  if (topology !== 'triangle-list') return { eligible: false, reason: `${FALLBACK.TOPOLOGY}:${topology}` };
  if (object.userData?.aps_deformed || object.userData?.aps_skinned || object.userData?.aps_animated) {
    return { eligible: false, reason: FALLBACK.DEFORMED };
  }
  if (geometry.attributes?.skinIndex || geometry.attributes?.skinWeight) return { eligible: false, reason: FALLBACK.DEFORMED };
  if (object.userData?.apsVegetationManaged || geometry.userData?.aps_vegetation_lods || object.userData?.apsGrassGenerated) {
    return { eligible: false, reason: FALLBACK.MANAGED_VEGETATION };
  }
  const position = geometry.attributes?.position;
  if (!position || position.count <= 0) return { eligible: false, reason: FALLBACK.NO_POSITION };
  if (geometry.groups?.length) return { eligible: false, reason: FALLBACK.GEOMETRY_GROUPS };
  const range = geometry.drawRange;
  if (range && range.count !== Infinity) return { eligible: false, reason: FALLBACK.DRAW_RANGE };
  let bounds = arrayBox(batchWorldBox);
  if (!bounds && object.isInstancedMesh) return { eligible: false, reason: FALLBACK.INSTANCED_UNBATCHED };
  if (!bounds) {
    if (!geometry.boundingBox) geometry.computeBoundingBox?.();
    bounds = transformBox(arrayBox(geometry.boundingBox), object.matrixWorld);
  }
  if (!bounds) return { eligible: false, reason: FALLBACK.NO_BOUNDS };
  const indexed = !!geometry.index;
  const primitiveTotal = indexed ? geometry.index.count : position.count;
  const start = Number.isInteger(item?.start) ? item.start : 0;
  const requested = item?.count === undefined ? Infinity : item.count;
  const primitiveCount = Math.min(requested, primitiveTotal - start);
  if (!Number.isInteger(primitiveCount) || primitiveCount <= 0) return { eligible: false, reason: FALLBACK.EMPTY_RANGE };
                                                                               
                                                                           
  if (start % 3 !== 0 || primitiveCount % 3 !== 0) return { eligible: false, reason: FALLBACK.TOPOLOGY };
  const instanceCount = object.isInstancedMesh ? object.count : (geometry.instanceCount ?? 1);
  if (!Number.isInteger(instanceCount) || instanceCount <= 0) return { eligible: false, reason: FALLBACK.INVALID_INSTANCES };
  const firstInstance = Number.isInteger(item?.firstInstance) ? item.firstInstance : 0;
  return {
    eligible: true, bounds, indexed, primitiveCount, instanceCount, start, firstInstance,
    instanceObject: !!object.isInstancedMesh,
    primitiveTotal,
  };
}

export function cascadeResourceKey(level) {
  if (!demandLevelValid(level)) throw Error('Cascade level must be 0..3');
  return `aps-caster-demand:level-${level}`;
}

export function padUvFor(texels = CASTER_DEMAND_DEFAULT_PAD_TEXELS, size = CASTER_DEMAND_DEFAULT_SHADOW_SIZE) {
  if (!Number.isFinite(texels) || texels < 0) throw Error('pad texels must be finite and >= 0');
  if (!Number.isFinite(size) || size <= 0) throw Error('shadow size must be finite and > 0');
  return texels / size;
}
