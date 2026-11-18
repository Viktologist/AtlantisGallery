                                                                          
                                                                          
                                                                           
                                                                              
                          

export const STATIC_DRAW_VIEW_LIMIT = 4;
export const STATIC_DRAW_ID_REGIONS = STATIC_DRAW_VIEW_LIMIT + 1;                            
export const STATIC_CHUNK_MIN_INDICES = 3072;
export const STATIC_CHUNK_MAX_TRIANGLES = 1024;
export const STATIC_CHUNK_MAX_CHUNKS = 2048;

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function matrixElements(matrix) {
  if (!matrix) return IDENTITY;
  const elements = matrix.elements ?? matrix;
  if (!elements || elements.length < 16) throw Error('Expected a 4x4 column-major matrix');
  return elements;
}

export function multiplyMat4(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function matrixKey(matrix) {
  return matrixElements(matrix).slice(0, 16).join(',');
}

                                                                            
                                                                              
                                                                               
                                                                             
                        
export function matrixSnapshot(matrix) {
  return Float64Array.from(matrixElements(matrix));
}

export function sameMatrixSnapshot(snapshot, matrix) {
  if (!snapshot) return false;
  const elements = matrixElements(matrix);
  for (let i = 0; i < 16; i++) if (snapshot[i] !== elements[i]) return false;
  return true;
}

                                                                              
                                                                           
export function frustumPlanes(viewProjection) {
  const m = matrixElements(viewProjection);
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const planes = [
    add(r3, r0),                 
    sub(r3, r0),                 
    add(r3, r1),                   
    sub(r3, r1),               
    r2,                         
    sub(r3, r2),               
  ];
  const out = new Float32Array(24);
  planes.forEach((p, i) => out.set(p, i * 4));
  return out;
}

export function aabbVisible(planes, min, max) {
  const cx = (min[0] + max[0]) * 0.5, cy = (min[1] + max[1]) * 0.5, cz = (min[2] + max[2]) * 0.5;
  const ex = (max[0] - min[0]) * 0.5, ey = (max[1] - min[1]) * 0.5, ez = (max[2] - min[2]) * 0.5;
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    const radius = Math.abs(a) * ex + Math.abs(b) * ey + Math.abs(c) * ez;
                                                                                
    if (a * cx + b * cy + c * cz + d + radius < -1e-4) return false;
  }
  return true;
}

function fallback(reason, extra = {}) {
  return { mode: 'fallback', reason, ...extra };
}

function opaqueStaticMaterial(material) {
  if (!material || Array.isArray(material)) return 'material_array_or_missing';
  if (material.transparent) return 'transparent';
  if ((material.alphaTest ?? 0) > 0) return 'alpha_test';
  const topology = material.topology ?? 'triangle-list';
  if (topology !== 'triangle-list') return 'topology_' + topology;
  const source = material.userData?.sourceMaterial;
  if (source?.extensions?.KHR_materials_transmission || source?.extensions?.KHR_materials_volume) return 'transmission';
  if (source?.alphaMode && source.alphaMode !== 'OPAQUE') return 'alpha_' + source.alphaMode;
  return null;
}

function staticGeometry(object, geometry) {
  if (!object || !geometry) return false;
  if (object.userData?.aps_static_visibility_disabled) return false;
  if (object.userData?.aps_vegetation_lods || object.userData?.apsGrassGenerated) return false;
  if (geometry.attributes?.skinIndex || geometry.attributes?.skinWeight) return false;
  if (object.userData?.aps_deformed || object.userData?.aps_skinned || object.userData?.aps_animated) return false;
  return true;
}

function sharedGeometry(geometry) {
  if (!geometry || !geometry.index || !geometry.attributes?.position) return 'index_or_position_missing';
  if (geometry.groups?.length) return 'geometry_groups';
  const range = geometry.drawRange;
  if (range && range.count !== Infinity) return 'draw_range';
  if (geometry.index.count % 3 !== 0 || geometry.index.count < 3) return 'non_triangle_index';
  return null;
}

                                                                           
                                                                                
                                                                 
export function staticDrawEligibility({ object, geometry, material, minChunkIndices = STATIC_CHUNK_MIN_INDICES, requireInstanceBinding = true } = {}) {
  if (!object?.isMesh || !geometry || !material) return fallback('not_mesh');
  if (!staticGeometry(object, geometry)) return fallback('non_static_or_deformed');
  const materialReason = opaqueStaticMaterial(material);
  if (materialReason) return fallback(materialReason);
  const sharedReason = sharedGeometry(geometry);
  if (sharedReason) return fallback(sharedReason);
  if (object.isInstancedMesh) {
    if (!Number.isInteger(object.count) || object.count <= 0) return fallback('empty_instances');
                                                                        
                                                                                
                                                                             
                                                                                 
    const merged = !!object.userData?.aps_merged_model_prototype;
    const source = !!object.userData?.aps_static_source_instance;
    if (!merged && !source) return fallback('unmanaged_instanced_mesh');
    if (!object.userData?.aps_static_instance_id) return fallback('missing_instance_id_region');
    if (requireInstanceBinding && !material.bindings?.apsStaticInstanceIds) return fallback('missing_instance_id_binding');
    if (merged && !material.bindings?.apsModelMaterialPalette) return fallback('missing_palette_binding');
    if (source && !merged && !Array.isArray(object.drawParams)) return fallback('missing_source_draw_params');
    return { mode: 'instances' };
  }
  const staticMarker = object.userData?.aps_static_roof || object.userData?.aps_bsp_source_parts
    || object.userData?.aps_native_static_geometry || geometry.userData?.aps_source_parts;
  if (!staticMarker) return fallback('not_tagged_static');
  if (geometry.index.count < minChunkIndices) return fallback('small_static_mesh');
  return { mode: 'chunks' };
}

function gridCell(value, min, size) {
  return Math.max(0, Math.floor((value - min) / size));
}

                                                                              
                                                                               
                                                                         
export function buildChunkedIndex({
  index, positions, positionItemSize = 3, matrixWorld = null,
  maxTrianglesPerChunk = STATIC_CHUNK_MAX_TRIANGLES, maxChunks = STATIC_CHUNK_MAX_CHUNKS,
} = {}) {
  if (!index || !positions) throw Error('buildChunkedIndex requires index and positions');
  const source = index instanceof Uint32Array ? index : new Uint32Array(index);
  if (source.length % 3 !== 0 || source.length === 0) throw Error('Static chunking requires nonempty triangle indices');
  const vertexCount = Math.floor(positions.length / positionItemSize);
  const triangleCount = source.length / 3;
  const world = new Float32Array(vertexCount * 3);
  const m = matrixElements(matrixWorld);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const p = transformPoint(m, positions[i * positionItemSize], positions[i * positionItemSize + 1], positions[i * positionItemSize + 2]);
    if (!p.every(Number.isFinite)) throw Error('Nonfinite static vertex while chunking');
    world[i * 3] = p[0]; world[i * 3 + 1] = p[1]; world[i * 3 + 2] = p[2];
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const target = Math.max(1, Math.ceil(triangleCount / Math.max(1, maxTrianglesPerChunk)));
  const grid = Math.max(1, Math.ceil(Math.cbrt(target)));
  const cellSize = Math.max(extent / grid, 1e-6);
  const cells = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const a = source[t * 3], b = source[t * 3 + 1], c = source[t * 3 + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) throw Error('Static index exceeds vertex count');
    const cx = (world[a * 3] + world[b * 3] + world[c * 3]) / 3;
    const cy = (world[a * 3 + 1] + world[b * 3 + 1] + world[c * 3 + 1]) / 3;
    const cz = (world[a * 3 + 2] + world[b * 3 + 2] + world[c * 3 + 2]) / 3;
    const ix = gridCell(cx, minX, cellSize), iy = gridCell(cy, minY, cellSize), iz = gridCell(cz, minZ, cellSize);
    const key = `${ix}:${iy}:${iz}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = { ix, iy, iz, triangles: [] });
    cell.triangles.push(t);
  }
  let groups = [...cells.values()].sort((a, b) => a.ix - b.ix || a.iy - b.iy || a.iz - b.iz);
  while (groups.length > maxChunks) {
    const merged = [];
    for (let i = 0; i < groups.length; i += 2) {
      const first = groups[i], second = groups[i + 1];
      if (!second) { merged.push(first); continue; }
      merged.push({ ix: Math.min(first.ix, second.ix), iy: Math.min(first.iy, second.iy), iz: Math.min(first.iz, second.iz), triangles: first.triangles.concat(second.triangles) });
    }
    groups = merged;
  }
  const out = new Uint32Array(source.length);
  const seen = new Uint8Array(triangleCount);
  const chunks = [];
  let offset = 0;
  for (const group of groups) {
    const firstIndex = offset;
    let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    for (const t of group.triangles) {
      if (seen[t]) throw Error('Static triangle duplicated across chunks');
      seen[t] = 1;
      for (let k = 0; k < 3; k++) {
        const vertex = source[t * 3 + k];
        out[offset++] = vertex;
        const x = world[vertex * 3], y = world[vertex * 3 + 1], z = world[vertex * 3 + 2];
        if (x < cminX) cminX = x; if (x > cmaxX) cmaxX = x;
        if (y < cminY) cminY = y; if (y > cmaxY) cmaxY = y;
        if (z < cminZ) cminZ = z; if (z > cmaxZ) cmaxZ = z;
      }
    }
    chunks.push({
      key: `${group.ix}:${group.iy}:${group.iz}`,
      firstIndex, indexCount: group.triangles.length * 3, triangles: group.triangles.length,
      min: [cminX, cminY, cminZ], max: [cmaxX, cmaxY, cmaxZ],
    });
  }
  let covered = 0;
  for (let i = 0; i < triangleCount; i++) covered += seen[i];
  const exact = covered === triangleCount && offset === source.length;
  if (!exact) throw Error(`Static chunk coverage mismatch: ${covered}/${triangleCount} triangles, ${offset}/${source.length} indices`);
  return {
    index: out, chunks,
    stats: {
      source_vertices: vertexCount, source_triangles: triangleCount,
      chunk_triangles: chunks.reduce((n, chunk) => n + chunk.triangles, 0),
      chunk_indices: offset, chunk_count: chunks.length, exact_triangle_coverage: exact,
      cell_size_m: cellSize, grid,
    },
  };
}

export function instanceSourceData({ instanceMatrix, count, geometryBox, matrixWorld } = {}) {
  const array = instanceMatrix?.array ?? instanceMatrix;
  if (!array || count <= 0 || array.length < count * 16) throw Error('Instance source data requires count * 16 matrices');
  const box = geometryBox;
  const toArray = (value) => Array.isArray(value) || ArrayBuffer.isView(value) ? value : (value?.toArray?.() ?? [value?.x, value?.y, value?.z]);
  const bmin = toArray(box?.min), bmax = toArray(box?.max);
  if (!bmin || bmin.length < 3 || !bmax || bmax.length < 3 || ![...bmin, ...bmax].every(Number.isFinite)) throw Error('Instance source data requires a source geometry box');
  const objectMatrix = matrixElements(matrixWorld);
  const matrices = new Float32Array(count * 16);
  matrices.set(array.subarray(0, count * 16));
  const bounds = new Float32Array(count * 8);
  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const local = matrices.subarray(i * 16, i * 16 + 16);
    const world = multiplyMat4(objectMatrix, local);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? bmax[0] : bmin[0];
      const y = corner & 2 ? bmax[1] : bmin[1];
      const z = corner & 4 ? bmax[2] : bmin[2];
      const p = transformPoint(world, x, y, z);
      if (!p.every(Number.isFinite)) throw Error('Nonfinite instance bound');
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
    }
    bounds.set([minX, minY, minZ, 0, maxX, maxY, maxZ, 0], i * 8);
    ids[i] = i;
  }
  return { matrices, bounds, ids, count };
}

                                                                             
                                                                              
export function compactInstances({ bounds, matrices, count, planes } = {}) {
  if (!bounds || !matrices || !planes) throw Error('compactInstances requires bounds, matrices and planes');
  const visible = [], compactMatrices = new Float32Array(count * 16), compactIds = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const min = [bounds[i * 8], bounds[i * 8 + 1], bounds[i * 8 + 2]];
    const max = [bounds[i * 8 + 4], bounds[i * 8 + 5], bounds[i * 8 + 6]];
    if (!aabbVisible(planes, min, max)) continue;
    const slot = visible.length;
    compactIds[slot] = i;
    compactMatrices.set(matrices.subarray(i * 16, i * 16 + 16), slot * 16);
    visible.push(i);
  }
  return { visible, compactMatrices: compactMatrices.slice(0, visible.length * 16), compactIds: compactIds.slice(0, visible.length), count: visible.length };
}

export function paletteMaterialId(palette, paletteOffset, partCount, sourceInstance, slot) {
  if (!palette || !Number.isInteger(paletteOffset) || !Number.isInteger(partCount) || !Number.isInteger(sourceInstance) || !Number.isInteger(slot)) return null;
  if (sourceInstance < 0 || slot < 0 || slot >= partCount) return null;
  return palette[paletteOffset + sourceInstance * partCount + slot] ?? null;
}

export function chunkIndexCoverage(sourceIndex, chunkedIndex, chunks) {
  if (!sourceIndex || !chunkedIndex || !Array.isArray(chunks)) return { exact: false, reason: 'missing_input' };
  if (sourceIndex.length !== chunkedIndex.length) return { exact: false, reason: 'length_mismatch', source: sourceIndex.length, chunked: chunkedIndex.length };
  let expected = 0;
  for (const chunk of chunks) {
    if (chunk.firstIndex !== expected || chunk.indexCount % 3 !== 0 || chunk.indexCount <= 0) return { exact: false, reason: 'chunk_range', chunk };
    expected += chunk.indexCount;
  }
  if (expected !== sourceIndex.length) return { exact: false, reason: 'range_total', expected, source: sourceIndex.length };
  const key = (i) => {
    const a = sourceIndex[i], b = sourceIndex[i + 1], c = sourceIndex[i + 2];
    const s = [a, b, c].sort((x, y) => x - y);
    return `${s[0]}:${s[1]}:${s[2]}`;
  };
  const counts = new Map();
  for (let i = 0; i < sourceIndex.length; i += 3) {
    const k = key(i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (let i = 0; i < chunkedIndex.length; i += 3) {
    const a = chunkedIndex[i], b = chunkedIndex[i + 1], c = chunkedIndex[i + 2];
    const s = [a, b, c].sort((x, y) => x - y);
    const kk = `${s[0]}:${s[1]}:${s[2]}`;
    const count = counts.get(kk) ?? 0;
    if (!count) return { exact: false, reason: 'triangle_multiset', index: i, key: kk };
    counts.set(kk, count - 1);
  }
  for (const count of counts.values()) if (count !== 0) return { exact: false, reason: 'triangle_leftover' };
  return { exact: true, triangles: sourceIndex.length / 3, chunks: chunks.length };
}
