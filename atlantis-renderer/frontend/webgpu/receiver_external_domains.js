                                                             
  
                                                      
  
                                                                             
                                                                        
                                                                           
                                                                         
                     
  
                                                                    
                                                                     
  
                                                                      
  
                                                                               
                                                                        
                                                                     
                                                                      
                                                                            
                                                                                
                                                                           
                
  
                                                                                
                                                                              
                                                                          
              
  
                                                                             
                                                                        
                                                                                
                                                                             
                                 

export const RECEIVER_EXTERNAL_DOMAIN_SCHEMA = 'aps-receiver-driven-shadows/external-domain/1';
export const RECEIVER_EXTERNAL_DOMAIN_REVISION = 'rds-finite-receiver-domains-r1';

export const LIGHT_CLIP_MIN = Object.freeze([-1, -1, 0]);
export const LIGHT_CLIP_MAX = Object.freeze([1, 1, 1]);
export const EXTERNAL_DOMAIN_UV_QUANT = 65535;
                                                                           
                                                     
export const EXTERNAL_DOMAIN_UV_PADDING = 2 / EXTERNAL_DOMAIN_UV_QUANT;
export const EXTERNAL_DOMAIN_FULL_FRACTION = 0.85;

const FACES = Object.freeze([
  Object.freeze([0, 4, 6, 2]),
  Object.freeze([1, 3, 7, 5]),
  Object.freeze([0, 4, 5, 1]),
  Object.freeze([2, 3, 7, 6]),
  Object.freeze([0, 1, 3, 2]),
  Object.freeze([4, 6, 7, 5]),
]);

const EDGES = Object.freeze([
  Object.freeze([0, 1]), Object.freeze([0, 2]), Object.freeze([0, 4]),
  Object.freeze([1, 3]), Object.freeze([1, 5]), Object.freeze([2, 3]),
  Object.freeze([2, 6]), Object.freeze([3, 7]), Object.freeze([4, 5]),
  Object.freeze([4, 6]), Object.freeze([5, 7]), Object.freeze([6, 7]),
]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finite3(point) {
  return Array.isArray(point) && point.length >= 3
    && finiteNumber(point[0]) && finiteNumber(point[1]) && finiteNumber(point[2]);
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function length3(a) { return Math.hypot(a[0], a[1], a[2]); }

function elementsOf(matrix) {
  const elements = matrix?.elements ?? matrix;
  if (!elements || elements.length < 16) return null;
  const out = Array.from(elements).slice(0, 16);
  return out.every(finiteNumber) ? out : null;
}

                                                                          
                                                                   
export function invert4x4(matrix) {
  const e = elementsOf(matrix);
  if (!e) return null;
  const a00 = e[0], a01 = e[1], a02 = e[2], a03 = e[3];
  const a10 = e[4], a11 = e[5], a12 = e[6], a13 = e[7];
  const a20 = e[8], a21 = e[9], a22 = e[10], a23 = e[11];
  const a30 = e[12], a31 = e[13], a32 = e[14], a33 = e[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!finiteNumber(det) || Math.abs(det) < 1e-30) return null;
  const id = 1 / det;
  const out = [
    (a11 * b11 - a12 * b10 + a13 * b09) * id,
    (a02 * b10 - a01 * b11 - a03 * b09) * id,
    (a31 * b05 - a32 * b04 + a33 * b03) * id,
    (a22 * b04 - a21 * b05 - a23 * b03) * id,
    (a12 * b08 - a10 * b11 - a13 * b07) * id,
    (a00 * b11 - a02 * b08 + a03 * b07) * id,
    (a32 * b02 - a30 * b05 - a33 * b01) * id,
    (a20 * b05 - a22 * b02 + a23 * b01) * id,
    (a10 * b10 - a11 * b08 + a13 * b06) * id,
    (a01 * b08 - a00 * b10 - a03 * b06) * id,
    (a30 * b04 - a31 * b02 + a33 * b00) * id,
    (a21 * b02 - a20 * b04 - a23 * b00) * id,
    (a11 * b07 - a10 * b09 - a12 * b06) * id,
    (a00 * b09 - a01 * b07 + a02 * b06) * id,
    (a31 * b01 - a30 * b03 - a32 * b00) * id,
    (a20 * b03 - a21 * b01 + a22 * b00) * id,
  ];
  return out.every(finiteNumber) ? out : null;
}

export function transformPoint4(matrix, point, w = 1) {
  const e = elementsOf(matrix);
  if (!e || !finite3(point) || !finiteNumber(w)) return null;
  const x = point[0], y = point[1], z = point[2];
  const out = [
    e[0] * x + e[4] * y + e[8] * z + e[12] * w,
    e[1] * x + e[5] * y + e[9] * z + e[13] * w,
    e[2] * x + e[6] * y + e[10] * z + e[14] * w,
    e[3] * x + e[7] * y + e[11] * z + e[15] * w,
  ];
  return out.every(finiteNumber) ? out : null;
}

                                                                              
                                                    
export function projectPointToLightUv(viewProj, point) {
  const clip = transformPoint4(viewProj, point, 1);
  if (!clip) return null;
  const w = clip[3];
  if (!finiteNumber(w) || Math.abs(w) < 1e-12) return null;
  const ndcX = clip[0] / w, ndcY = clip[1] / w, ndcZ = clip[2] / w;
  if (![ndcX, ndcY, ndcZ].every(finiteNumber)) return null;
  return {u: ndcX * 0.5 + 0.5, v: 0.5 - ndcY * 0.5, z: ndcZ, ndc: [ndcX, ndcY, ndcZ], w};
}

function planeFromFace(vertices, face, centroid) {
  const p0 = vertices[face[0]], p1 = vertices[face[1]], p2 = vertices[face[2]], p3 = vertices[face[3]];
                                                                                
                                          
  let normal = cross(sub(p2, p0), sub(p3, p1));
  let len = length3(normal);
  if (!(len > 0) || !finiteNumber(len)) {
    normal = cross(sub(p1, p0), sub(p2, p0));
    len = length3(normal);
  }
  if (!(len > 0) || !finiteNumber(len)) return null;
  normal = scale(normal, 1 / len);
  let d = -dot(normal, p0);
  if (!finiteNumber(d)) return null;
                                                                            
                     
  if (dot(normal, centroid) + d < 0) {
    normal = scale(normal, -1);
    d = -d;
  }
  return {n: normal, d};
}

                                                                
                                                             
                                                                   
export function hexahedronFromCorners(corners, source = 'hexahedron') {
  if (!Array.isArray(corners) || corners.length !== 8 || !corners.every(finite3)) return null;
  const vertices = corners.map((point) => point.slice(0, 3));
  let cx = 0, cy = 0, cz = 0;
  for (const point of vertices) { cx += point[0]; cy += point[1]; cz += point[2]; }
  const centroid = [cx / 8, cy / 8, cz / 8];
  if (!finite3(centroid)) return null;
  let maxRadius = 0;
  for (const point of vertices) maxRadius = Math.max(maxRadius, length3(sub(point, centroid)));
  if (!(maxRadius > 0) || !finiteNumber(maxRadius)) return null;
  const planes = [];
  for (const face of FACES) {
    const plane = planeFromFace(vertices, face, centroid);
    if (!plane) return null;
    planes.push(plane);
  }
  const tolerance = Math.max(1e-7, maxRadius * 1e-9);
  return {
    source,
    vertices,
    planes,
    centroid,
    scale: maxRadius,
    tolerance,
    finite: true,
  };
}

                                                                              
                                                          
export function segmentPlaneIntersection(a, b, plane) {
  const fa = dot(plane.n, a) + plane.d;
  const fb = dot(plane.n, b) + plane.d;
  if (!finiteNumber(fa) || !finiteNumber(fb)) return null;
  if (fa > 0 && fb > 0) return null;
  if (fa < 0 && fb < 0) return null;
  const denominator = fa - fb;
  if (!finiteNumber(denominator) || Math.abs(denominator) < 1e-15) return null;
  const t = fa / denominator;
  if (!(t >= -1e-9 && t <= 1 + 1e-9)) return null;
  const tc = clamp(t, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * tc,
    a[1] + (b[1] - a[1]) * tc,
    a[2] + (b[2] - a[2]) * tc,
  ];
}

export function pointInsidePolyhedron(point, polyhedron, tolerance = null) {
  if (!finite3(point) || !polyhedron?.planes) return false;
  const tol = finiteNumber(tolerance) ? tolerance : polyhedron.tolerance;
  for (const plane of polyhedron.planes) {
    const value = dot(plane.n, point) + plane.d;
    if (!finiteNumber(value) || value < -tol) return false;
  }
  return true;
}

function dedupePoints(points, epsilon) {
  const unique = [];
  const epsilon2 = epsilon * epsilon;
  for (const point of points) {
    let duplicate = false;
    for (const other of unique) {
      const dx = point[0] - other[0], dy = point[1] - other[1], dz = point[2] - other[2];
      if (dx * dx + dy * dy + dz * dz <= epsilon2) { duplicate = true; break; }
    }
    if (!duplicate) unique.push(point.slice(0, 3));
  }
  return unique;
}

                                                                
                                                          
                                                                    
                                                                    
                                                                              
                                                               
export function intersectConvexPolyhedra(a, b, {tolerance = null} = {}) {
  if (!a?.finite || !b?.finite || !Array.isArray(a.vertices) || !Array.isArray(b.vertices)) {
    return {empty: true, vertices: [], tolerance: 0, reason: 'invalid_polyhedron'};
  }
  const tol = finiteNumber(tolerance)
    ? Math.max(tolerance, a.tolerance ?? 0, b.tolerance ?? 0)
    : Math.max(a.tolerance ?? 0, b.tolerance ?? 0);
  const points = [];
  const accept = (point) => {
    if (pointInsidePolyhedron(point, a, tol) && pointInsidePolyhedron(point, b, tol)) {
      points.push(point.slice(0, 3));
    }
  };
  for (const vertex of a.vertices) if (pointInsidePolyhedron(vertex, b, tol)) points.push(vertex.slice(0, 3));
  for (const vertex of b.vertices) if (pointInsidePolyhedron(vertex, a, tol)) points.push(vertex.slice(0, 3));
  for (const edge of EDGES) {
    const va = a.vertices[edge[0]], vb = a.vertices[edge[1]];
    for (const plane of b.planes) {
      const point = segmentPlaneIntersection(va, vb, plane);
      if (point) accept(point);
    }
  }
  for (const edge of EDGES) {
    const va = b.vertices[edge[0]], vb = b.vertices[edge[1]];
    for (const plane of a.planes) {
      const point = segmentPlaneIntersection(va, vb, plane);
      if (point) accept(point);
    }
  }
  const vertices = dedupePoints(points, Math.max(tol * 4, 1e-9 * Math.max(a.scale, b.scale, 1)));
  return {
    empty: vertices.length === 0,
    vertices,
    tolerance: tol,
    reason: vertices.length ? 'intersection' : 'empty_intersection',
  };
}

                                                                             
                                                                              
                                                                              
          
export function mainCameraFrustumPolyhedron(camera) {
  if (!camera) return null;
  try { camera.updateMatrixWorld?.(); } catch {}
  const projectionInverse = camera.projectionMatrixInverse?.elements
    ? camera.projectionMatrixInverse
    : (Array.isArray(camera.projectionMatrixInverse) && camera.projectionMatrixInverse.length >= 16
      ? camera.projectionMatrixInverse
      : (camera.projectionMatrix ? invert4x4(camera.projectionMatrix) : null));
  if (!projectionInverse) return null;
  const world = camera.matrixWorld?.elements;
  if (!world || world.length < 16 || !Array.from(world).slice(0, 16).every(finiteNumber)) return null;
  const corners = [];
  for (let index = 0; index < 8; index++) {
    const ndc = [
      (index & 1) ? 1 : -1,
      (index & 2) ? 1 : -1,
      (index & 4) ? 1 : 0,
    ];
    const view = transformPoint4(projectionInverse, ndc, 1);
    if (!view) return null;
    const w = view[3];
    if (!finiteNumber(w) || Math.abs(w) < 1e-12) return null;
    const cameraPoint = [view[0] / w, view[1] / w, view[2] / w];
    if (!cameraPoint.every(finiteNumber)) return null;
    const worldPoint = transformPoint4(world, cameraPoint, 1);
    if (!worldPoint) return null;
    const ww = worldPoint[3];
    if (!finiteNumber(ww) || Math.abs(ww) < 1e-12) return null;
    const point = [worldPoint[0] / ww, worldPoint[1] / ww, worldPoint[2] / ww];
    if (!point.every(finiteNumber)) return null;
    corners.push(point);
  }
  return hexahedronFromCorners(corners, 'main_camera_frustum');
}

                                                                
                                                                            
export function lightClipPolyhedron(viewProj) {
  const inverse = invert4x4(viewProj);
  if (!inverse) return null;
  const corners = [];
  for (let index = 0; index < 8; index++) {
    const clip = [
      (index & 1) ? LIGHT_CLIP_MAX[0] : LIGHT_CLIP_MIN[0],
      (index & 2) ? LIGHT_CLIP_MAX[1] : LIGHT_CLIP_MIN[1],
      (index & 4) ? LIGHT_CLIP_MAX[2] : LIGHT_CLIP_MIN[2],
    ];
    const world = transformPoint4(inverse, clip, 1);
    if (!world) return null;
    const w = world[3];
    if (!finiteNumber(w) || Math.abs(w) < 1e-12) return null;
    const point = [world[0] / w, world[1] / w, world[2] / w];
    if (!point.every(finiteNumber)) return null;
    corners.push(point);
  }
  return hexahedronFromCorners(corners, 'light_clip_volume');
}

                                                                               
                                                         
export function projectVertexRect(viewProj, vertices, {uvPadding = EXTERNAL_DOMAIN_UV_PADDING} = {}) {
  if (!Array.isArray(vertices) || !vertices.length) {
    return {empty: true, invalid: false, minU: 1, minV: 1, maxU: 0, maxV: 0, areaFraction: 0, projected: []};
  }
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  const projected = [];
  for (const vertex of vertices) {
    const p = projectPointToLightUv(viewProj, vertex);
    if (!p) return {empty: false, invalid: true, minU: 0, minV: 0, maxU: 0, maxV: 0, areaFraction: 0, projected: []};
    minU = Math.min(minU, p.u); minV = Math.min(minV, p.v);
    maxU = Math.max(maxU, p.u); maxV = Math.max(maxV, p.v);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    projected.push(p);
  }
  const pad = Math.max(0, Number(uvPadding) || 0);
  const loU = clamp01(minU - pad), loV = clamp01(minV - pad);
  const hiU = clamp01(maxU + pad), hiV = clamp01(maxV + pad);
  if (![loU, loV, hiU, hiV, minZ, maxZ].every(finiteNumber) || loU > hiU || loV > hiV) {
    return {empty: false, invalid: true, minU: 0, minV: 0, maxU: 0, maxV: 0, areaFraction: 0, projected};
  }
  return {
    empty: false,
    invalid: false,
    rawMinU: minU, rawMinV: minV, rawMaxU: maxU, rawMaxV: maxV,
    minU: loU, minV: loV, maxU: hiU, maxV: hiV,
    minZ, maxZ,
    areaFraction: Math.max(0, hiU - loU) * Math.max(0, hiV - loV),
    projected,
  };
}

                                                                          
                          
export function computeFiniteReceiverDomains({
  camera,
  cascades,
  uvPadding = EXTERNAL_DOMAIN_UV_PADDING,
  maxDemandFraction = EXTERNAL_DOMAIN_FULL_FRACTION,
  source = 'main_camera_frustum_x_light_clip',
} = {}) {
  const base = {
    schema: RECEIVER_EXTERNAL_DOMAIN_SCHEMA,
    revision: RECEIVER_EXTERNAL_DOMAIN_REVISION,
    source,
    usable: false,
    reason: null,
    levels: [],
    camera_frustum_vertices: 0,
    uv_padding: uvPadding,
    max_demand_fraction: maxDemandFraction,
    conservative_for_all_water_times: true,
  };
  if (!camera) return {...base, reason: 'main_camera_missing'};
  const frustum = mainCameraFrustumPolyhedron(camera);
  if (!frustum) return {...base, reason: 'main_camera_frustum_nonfinite'};
  if (!Array.isArray(cascades) || cascades.length !== 4) return {...base, reason: 'light_cascades_missing'};
  const levels = [];
  for (let level = 0; level < 4; level++) {
    const cascade = cascades[level];
    const clip = lightClipPolyhedron(cascade?.viewProj);
    if (!clip) {
      return {...base, reason: `light_clip_volume_nonfinite:${level}`, camera_frustum_vertices: frustum.vertices.length};
    }
    const intersection = intersectConvexPolyhedra(frustum, clip);
    if (intersection.empty) {
      levels.push({
        level,
        mode: 'finite_frustum_empty',
        empty: true,
        valid: true,
        minU: 1, minV: 1, maxU: 0, maxV: 0,
        areaFraction: 0,
        vertices: 0,
        light_vertices: clip.vertices.length,
        reason: intersection.reason,
      });
      continue;
    }
    const rect = projectVertexRect(cascade.viewProj, intersection.vertices, {uvPadding});
    if (rect.invalid) {
      return {...base, reason: `light_project_nonfinite:${level}`, camera_frustum_vertices: frustum.vertices.length};
    }
    const fills = rect.areaFraction > maxDemandFraction;
    levels.push({
      level,
      mode: fills ? 'full_fills_clipmap' : 'finite_frustum',
      empty: rect.empty === true,
      valid: true,
      minU: rect.minU,
      minV: rect.minV,
      maxU: rect.maxU,
      maxV: rect.maxV,
      rawMinU: rect.rawMinU,
      rawMinV: rect.rawMinV,
      rawMaxU: rect.rawMaxU,
      rawMaxV: rect.rawMaxV,
      areaFraction: rect.areaFraction,
      fills,
      vertices: intersection.vertices.length,
      light_vertices: clip.vertices.length,
                                                                                 
                                                 
      intersection_vertices: intersection.vertices,
      reason: intersection.reason,
    });
  }
  return {
    ...base,
    usable: true,
    reason: null,
    camera_frustum_vertices: frustum.vertices.length,
    levels,
  };
}

function matrixKey(matrix) {
  const e = elementsOf(matrix);
  return e ? e : null;
}

                                                                             
                                                                               
                                                                   
export function externalDomainCacheKey({
  camera,
  cascades,
  consumerSignature = null,
  viewport = null,
  uvPadding = EXTERNAL_DOMAIN_UV_PADDING,
  maxDemandFraction = EXTERNAL_DOMAIN_FULL_FRACTION,
} = {}) {
  return JSON.stringify([
    matrixKey(camera?.matrixWorld),
    matrixKey(camera?.projectionMatrix),
    matrixKey(camera?.projectionMatrixInverse),
    Array.isArray(cascades) ? cascades.map((cascade) => matrixKey(cascade?.viewProj)) : null,
    viewport ? [viewport.width ?? null, viewport.height ?? null] : null,
    consumerSignature ?? null,
    uvPadding,
    maxDemandFraction,
  ]);
}

export function encodeExternalRect(level) {
  if (!level || level.valid !== true) return {flag: 0, minU: 0, minV: 0, maxU: 0, maxV: 0};
  if (level.empty === true) return {flag: 2, minU: 1, minV: 1, maxU: 0, maxV: 0};
  if (level.mode === 'full_fills_clipmap') return {flag: 3, minU: 0, minV: 0, maxU: 1, maxV: 1};
  return {flag: 1, minU: level.minU, minV: level.minV, maxU: level.maxU, maxV: level.maxV};
}

export function describeFiniteDomainLevels(domains) {
  return (domains?.levels ?? []).map((level) => ({
    level: level.level,
    mode: level.mode,
    valid: level.valid === true,
    empty: level.empty === true,
    area_fraction: Number.isFinite(level.areaFraction) ? level.areaFraction : null,
    min_u: Number.isFinite(level.minU) ? level.minU : null,
    min_v: Number.isFinite(level.minV) ? level.minV : null,
    max_u: Number.isFinite(level.maxU) ? level.maxU : null,
    max_v: Number.isFinite(level.maxV) ? level.maxV : null,
    vertices: level.vertices ?? 0,
  }));
}
